"""UDS (ISO 14229) over J2534 protocol layer for the VW 3.0 V6 TDI (EDC17).

Layers:
  - IsoTp framing helpers (ISO 15765-2). With the J2534 ISO15765 protocol
    flag the pass-thru device performs segmentation itself; these helpers
    exist for raw-CAN fallback and for offline self-tests.
  - UdsClient: session control, DID reads, DTC read/clear via 0x22/0x19/0x14.
  - J2534Transport: wraps the pyj2534 package (PassThruOpen/Connect/Filter/
    Write/Read). All hardware calls raise with actionable messages until a
    pass-thru device is installed.
  - DID_MAP: live-channel -> DID mapping with scaling. Starter set uses the
    standard VAG 0xF4xx (J1979-style) DIDs -- verify against the DDXC label
    data once the ECU is connected.

Run `python uds.py --selftest` to exercise the pure protocol layer offline.
"""

import sys

REQUEST_ID = 0x7E0
RESPONSE_ID = 0x7E8


# ---------------------------------------------------------------------------
# ISO-TP (ISO 15765-2)
# ---------------------------------------------------------------------------

def tp_encode(data: bytes) -> list[bytes]:
    """Split a UDS PDU into 8-byte ISO-TP frames (SF, or FF+CFs)."""
    if len(data) <= 7:
        return [(bytes([len(data)]) + data).ljust(8, b"\x00")]
    frames = [(bytes([0x10, len(data)]) + data[:6]).ljust(8, b"\x00")]
    sequence = 1
    offset = 6
    while offset < len(data):
        chunk = data[offset:offset + 7]
        frames.append((bytes([0x20 | sequence]) + chunk).ljust(8, b"\x00"))
        sequence = (sequence + 1) & 0x0F or 1
        offset += 7
    return frames


class TpDecoder:
    """Reassembles consecutive-frame streams into PDUs."""

    def __init__(self) -> None:
        self._buffer = bytearray()
        self._expected = 0

    def feed(self, frame: bytes) -> bytes | None:
        if not frame:
            return None
        pci = frame[0] >> 4
        if pci == 0x0:  # single frame
            length = frame[0] & 0x0F
            self._buffer, self._expected = bytearray(), 0
            return bytes(frame[1:1 + length])
        if pci == 0x1:  # first frame
            self._expected = ((frame[0] & 0x0F) << 8) | frame[1]
            self._buffer = bytearray(frame[2:2 + 6])
            return None
        if pci == 0x2:  # consecutive frame
            if not self._expected:
                return None
            self._buffer.extend(frame[1:8])
            if len(self._buffer) >= self._expected:
                result = bytes(self._buffer[:self._expected])
                self._buffer, self._expected = bytearray(), 0
                return result
            return None
        return None  # flow control frames are not ours to consume


# ---------------------------------------------------------------------------
# UDS client (ISO 14229) over a byte-transport
# ---------------------------------------------------------------------------

class TransportError(RuntimeError):
    pass


class UdsClient:
    """Sends UDS requests over `transport` (write(bytes) / read() -> bytes)."""

    def __init__(self, transport, request_id: int = REQUEST_ID,
                 response_id: int = RESPONSE_ID, timeout_ms: int = 1000):
        self.transport = transport
        self.request_id = request_id
        self.response_id = response_id
        self.timeout_ms = timeout_ms

    def _transact(self, request: bytes) -> bytes:
        self.transport.write(self.request_id, request)
        response = self.transport.read(self.response_id, self.timeout_ms)
        if response is None:
            raise TransportError(f"no response to {request.hex()} (timeout {self.timeout_ms} ms)")
        if response[0] == 0x7F:
            code = response[2] if len(response) > 2 else 0
            raise TransportError(f"negative response 0x{code:02X} to service 0x{request[0]:02X}")
        return response

    def enter_session(self, session: int = 0x03) -> None:
        self._transact(bytes([0x10, session]))

    def read_did(self, did: int) -> bytes:
        response = self._transact(bytes([0x22, (did >> 8) & 0xFF, did & 0xFF]))
        return response[3:]  # strip 62 DID_H DID_L

    def read_vin(self) -> str:
        raw = self.read_did(0xF190)
        return raw.decode("ascii", errors="replace").strip("\x00")

    def read_dtcs(self) -> list[dict]:
        """UDS 0x19 0x02 (reportDTCByStatusMask, mask 0xFF).

        Records are 3 bytes each: DTC high, DTC low, status."""
        response = self._transact(bytes([0x19, 0x02, 0xFF]))
        records = []
        index = 3  # 59 02 <availability>
        while index + 3 <= len(response):
            number = (response[index] << 8) | response[index + 1]
            status = response[index + 2]
            records.append({
                "code": format_dtc(number),
                "rawStatus": status,
                "statusByte": status,
            })
            index += 3
        return records

    def clear_dtcs(self) -> None:
        self._transact(bytes([0x14, 0xFF, 0xFF, 0xFF]))

    def read_live(self, did_map: dict) -> dict:
        values = {}
        for name, (did, scaler) in did_map.items():
            try:
                values[name] = scaler(self.read_did(did))
            except TransportError:
                values[name] = None
        return values

    # ------------------------------------------------------------------
    # Flash / write-path primitives (protocol scaffolding). Nothing in the
    # dashboard triggers these: the stock-read/backup flow needs security
    # access + the DDXC calibration region address (label file), and writes
    # additionally need a checksum-corrected image. They exist so those
    # paths have a tested protocol layer on the day the hardware arrives.
    # ------------------------------------------------------------------

    def read_memory_by_address(self, address: int, size: int) -> bytes:
        """UDS 0x23: read arbitrary ECU memory (3-byte address, 2-byte count)."""
        request = (bytes([0x23, 0x20, 0x02])
                   + address.to_bytes(3, "big") + size.to_bytes(2, "big"))
        response = self._transact(request)
        return response[3:]  # strip 63 + address format

    def request_security_seed(self, level: int) -> bytes:
        response = self._transact(bytes([0x27, level]))
        return response[2:]

    def send_security_key(self, level: int, key: bytes) -> None:
        self._transact(bytes([0x27, level + 1]) + key)

    def security_access(self, level: int, key_algo=None) -> bytes:
        """Full 0x27 handshake. key_algo(seed) -> key. Without an algorithm
        the seed is fetched and access stays LOCKED — EDC17 seed/key schemes
        are OEM-secret per level and must be supplied deliberately."""
        seed = self.request_security_seed(level)
        if key_algo is None:
            raise TransportError(
                f"security access level 0x{level:02X}: seed {seed.hex()} received, but "
                "no key algorithm is installed — add one in uds.py to unlock the write path"
            )
        self.send_security_key(level, key_algo(seed))
        return seed

    def request_upload(self, address: int, size: int) -> int:
        """UDS 0x35: prepare the ECU to serve `size` bytes from `address`
        (4-byte addressing). Returns the announced block size in bytes."""
        request = (bytes([0x35, 0x00, 0x44])
                   + address.to_bytes(4, "big") + size.to_bytes(4, "big"))
        response = self._transact(request)
        fmt = response[2] if len(response) > 2 else 0x20
        width = fmt >> 4 or 2
        return int.from_bytes(response[3:3 + width], "big")

    def transfer_read(self, block: int) -> bytes:
        """UDS 0x36 read side: fetch data block `block` (1-based counter)."""
        response = self._transact(bytes([0x36, block & 0xFF]))
        return response[2:]  # strip 76 + block sequence

    def transfer_write(self, block: int, data: bytes) -> bytes:
        """UDS 0x36 write side: send data block `block`; returns the echo."""
        response = self._transact(bytes([0x36, block & 0xFF]) + data)
        return response[2:]

    def request_transfer_exit(self) -> None:
        self._transact(bytes([0x37]))

    def routine_control(self, rid: int, action: str = "start") -> bytes:
        """UDS 0x31 (erase flash, check checksums, SW-compatibility...)."""
        sub = {"start": 0x01, "stop": 0x02, "result": 0x03}[action]
        response = self._transact(bytes([0x31, sub, (rid >> 8) & 0xFF, rid & 0xFF]))
        return response[4:]  # strip 31 sub rid

    def read_flash(self, address: int, size: int):
        """Generator over flash/calibration content via 0x35 + 0x36 + 0x37."""
        self.request_upload(address, size)
        block = 1
        remaining = size
        try:
            while remaining > 0:
                data = self.transfer_read(block)
                if not data:
                    raise TransportError(f"empty data block {block} at offset {size - remaining}")
                yield data
                remaining -= len(data)
                block = (block + 1) & 0xFF or 1
        finally:
            self.request_transfer_exit()


def format_dtc(number: int) -> str:
    """Map a 2-byte UDS DTC number to its P/C/B/U text form."""
    prefix = "PCBU"[(number >> 14) & 0x03]
    return f"{prefix}{number & 0x3FFF:04X}"


# ---------------------------------------------------------------------------
# Live-channel DID map + diesel candidates.
#
# DID_MAP holds the standard VAG 0xF4xx (J1979-style) set. The three
# diesel-critical channels (rail pressure, boost, pedal) are NOT in that
# standard set and vary by ECU version, so they live in DID_CANDIDATES:
# ordered (did, scaler, note) guesses from community EDC17 tables. On the
# first live connect probe_dids()/probe_candidates() ask the ECU which ones
# it actually answers and the winner is adopted for the session — the map
# is learned from the vehicle instead of hardcoded on faith.
# ---------------------------------------------------------------------------

DID_MAP = {
    "rpm": (0xF40C, lambda b: ((b[0] << 8) | b[1]) * 0.25),
    "speedKph": (0xF40B, lambda b: b[0]),
    "coolantTempC": (0xF405, lambda b: b[0] - 40),
    "intakeTempC": (0xF40D, lambda b: b[0] - 40),
    "engineLoadPct": (0xF404, lambda b: b[0] * 100 / 255),
    "batteryV": (0xF448, lambda b: b[0] * 0.1),  # TODO: confirm on DDXC
}

DID_CANDIDATES = {
    "railPressureBar": [
        (0xF484, lambda b: ((b[0] << 8) | b[1]) * 0.1, "community EDC17 table (x0.1 bar)"),
        (0xF485, lambda b: ((b[0] << 8) | b[1]) * 0.1, "alternate rail DID (x0.1 bar)"),
    ],
    "boostPressureKpa": [
        (0xF40E, lambda b: ((b[0] << 8) | b[1]) * 0.03, "absolute charge pressure (x0.03 kPa)"),
        (0xF4A3, lambda b: ((b[0] << 8) | b[1]) * 0.03, "alternate boost DID (x0.03 kPa)"),
    ],
    "pedalPct": [
        (0xF4A1, lambda b: b[0] * 100 / 255, "accelerator position (x100/255 %)"),
        (0xF492, lambda b: b[0] * 100 / 255, "alternate pedal DID (x100/255 %)"),
    ],
}


def probe_dids(client, did_map: dict | None = None) -> list[dict]:
    """Probe every mapped DID with 0x22; report which the ECU answers.

    Returns [{channel, did, ok, value, note}] — `value` is the scaled
    reading when the DID answers, None otherwise."""
    did_map = did_map if did_map is not None else DID_MAP
    results = []
    for name, (did, scaler) in did_map.items():
        try:
            value = scaler(client.read_did(did))
            results.append({"channel": name, "did": did, "ok": True, "value": value,
                            "note": "standard set"})
        except TransportError:
            results.append({"channel": name, "did": did, "ok": False, "value": None,
                            "note": "no response / unsupported"})
    return results


def probe_candidates(client, channel: str) -> tuple[tuple | None, list[dict]]:
    """Try DID_CANDIDATES[channel] in order; the first DID the ECU answers
    wins. Returns ((did, scaler) adopted or None, [attempt entries])."""
    adopted = None
    attempts = []
    for did, scaler, note in DID_CANDIDATES.get(channel, []):
        try:
            value = scaler(client.read_did(did))
        except TransportError:
            attempts.append({"channel": channel, "did": did, "ok": False,
                             "value": None, "note": note})
            continue
        attempts.append({"channel": channel, "did": did, "ok": True,
                         "value": value, "note": note})
        adopted = (did, scaler)
        break
    return adopted, attempts


# ---------------------------------------------------------------------------
# J2534 pass-thru transport (requires pyj2534 + vendor DLL + device)
# ---------------------------------------------------------------------------

class J2534Transport:
    """Byte transport over a J2534 pass-thru device using the ISO15765
    protocol, which performs ISO-TP segmentation in firmware."""

    def __init__(self, device_name: str | None = None):
        self.device_name = device_name
        self._lib = None
        self._device = None
        self._channel = None

    def open(self, bitrate: int = 500000) -> None:
        try:
            import pyj2534
        except ImportError as exc:
            raise TransportError(
                "pyj2534 is not installed (pip install pyj2534) and/or the "
                "vendor J2534 DLL is not registered"
            ) from exc
        self._lib = pyj2534.J2534()
        # TODO: enumerate with listAvailiableDevices when multiple DLLs exist
        self._device = self._lib.passThruOpen(self.device_name)
        protocol = pyj2534.ISO15765
        flags = pyj2534.ISO15765_FRAME_PAD
        self._channel = self._lib.passThruConnect(self._device, protocol, flags, bitrate)
        self._lib.passThruStartMsgFilter(
            self._channel,
            filter_type=pyj2534.FLOW_CONTROL_FILTER,
            mask_id=self.response_id_needed(),  # see note: tx/rx pair below
            pattern_id=REQUEST_ID,
        )

    def response_id_needed(self) -> int:
        return RESPONSE_ID

    def write(self, can_id: int, data: bytes) -> None:
        self._lib.passThruWriteMsgs(self._channel, [(can_id, data)])

    def read(self, can_id: int, timeout_ms: int) -> bytes | None:
        msgs = self._lib.passThruReadMsgs(self._channel, 1, timeout_ms)
        if not msgs:
            return None
        return msgs[0].data

    def close(self) -> None:
        if self._channel is not None:
            self._lib.passThruDisconnect(self._channel)
            self._channel = None
        if self._device is not None:
            self._lib.passThruClose(self._device)
            self._device = None


# ---------------------------------------------------------------------------
# Offline self-test
# ---------------------------------------------------------------------------

def _selftest() -> int:
    failures = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        if condition:
            print(f"  PASS {name}")
        else:
            failures.append(name)
            print(f"  FAIL {name} {detail}")

    print("uds.py self-test")

    # ISO-TP: single frame
    frames = tp_encode(bytes([0x22, 0xF4, 0x0C]))
    check("tp single-frame encode", frames == [bytes.fromhex("0322F40C00000000")], f"got {frames[0].hex()}")

    # ISO-TP: multi-frame (17-byte VIN response)
    payload = bytes([0x62, 0xF1, 0x90]) + b"WV1ZZZ2H0JW123456"
    frames = tp_encode(payload)
    decoder = TpDecoder()
    reassembled = None
    for frame in frames:
        reassembled = decoder.feed(frame) or reassembled
    check("tp multi-frame roundtrip", reassembled == payload,
          f"got {reassembled.hex() if reassembled else None}")

    # DTC formatting
    check("dtc P0299", format_dtc(0x0299) == "P0299", format_dtc(0x0299))
    check("dtc P2002", format_dtc(0x2002) == "P2002", format_dtc(0x2002))
    check("dtc U0100", format_dtc(0xC100) == "U0100", format_dtc(0xC100))

    # DTC record parsing via a canned 59 response
    class FakeTransport:
        def __init__(self, response): self.response = response
        def write(self, can_id, data): pass
        def read(self, can_id, timeout): return self.response
    client = UdsClient(FakeTransport(bytes.fromhex("5902FF" + "0299" + "2F")))
    records = client.read_dtcs()
    check("dtc parse", len(records) == 1 and records[0]["code"] == "P0299", str(records))

    # VIN decode
    client = UdsClient(FakeTransport(payload))
    check("vin decode", client.read_vin() == "WV1ZZZ2H0JW123456", client.read_vin())

    # Scaling math
    check("rpm scale", DID_MAP["rpm"][1](bytes([0x0C, 0x30])) == 780.0)      # 3120 * 0.25
    check("coolant scale", DID_MAP["coolantTempC"][1](bytes([0x8A])) == 98)  # 138 - 40
    check("rail candidate scale", DID_CANDIDATES["railPressureBar"][0][1](bytes([0x0B, 0xB8])) == 300.0)
    check("boost candidate scale", DID_CANDIDATES["boostPressureKpa"][0][1](bytes([0x27, 0x10])) == 300.0)
    check("pedal candidate scale", DID_CANDIDATES["pedalPct"][0][1](bytes([0xFF])) == 100.0)

    # Multi-response transport for probe / flash primitives
    class RecordingTransport(FakeTransport):
        def __init__(self, responses):
            self.responses = list(responses)
            self.requests = []
        def write(self, can_id, data): self.requests.append(bytes(data))
        def read(self, can_id, timeout): return self.responses.pop(0)

    # DID probing: one DID answers, one is rejected (0x7F 22 31)
    client = UdsClient(RecordingTransport([
        bytes.fromhex("62F40C0C30"),
        bytes.fromhex("7F2231"),
    ]))
    probe = probe_dids(client, {"rpm": DID_MAP["rpm"], "speedKph": DID_MAP["speedKph"]})
    check("probe positive", probe[0]["ok"] and probe[0]["value"] == 780.0, str(probe[0]))
    check("probe negative", not probe[1]["ok"] and probe[1]["value"] is None, str(probe[1]))

    # Candidate adoption: first rejected, second answers
    client = UdsClient(RecordingTransport([
        bytes.fromhex("7F2231"),
        bytes.fromhex("62F4850BB8"),
    ]))
    adopted, attempts = probe_candidates(client, "railPressureBar")
    check("candidate adoption", adopted is not None
          and adopted[0] == DID_CANDIDATES["railPressureBar"][1][0]
          and attempts[1]["ok"] and attempts[1]["value"] == 300.0, str(attempts))

    # 0x23 read-memory-by-address encoding
    recorder = RecordingTransport([bytes.fromhex("632002AABBCCDD")])
    client = UdsClient(recorder)
    data = client.read_memory_by_address(0x010203, 4)
    check("0x23 encode + parse",
          recorder.requests[0] == bytes.fromhex("232002" + "010203" + "0004")
          and data == bytes.fromhex("AABBCCDD"),
          f"req={recorder.requests[0].hex()} data={data.hex()}")

    # Security access: seed parses; no algorithm -> locked with clear message
    client = UdsClient(RecordingTransport([bytes.fromhex("6701DEAD")]))
    check("0x27 seed parse", client.request_security_seed(0x01) == bytes.fromhex("DEAD"))
    client = UdsClient(RecordingTransport([bytes.fromhex("6701DEAD")]))
    try:
        client.security_access(0x01)
        check("0x27 locked without algo", False, "no exception raised")
    except TransportError as exc:
        check("0x27 locked without algo", "no key algorithm" in str(exc), str(exc))

    # 0x35/0x36/0x37 upload (read-out) sequence
    recorder = RecordingTransport([
        bytes.fromhex("75200100FF"),   # upload accepted, block size 0x00FF
        bytes.fromhex("7601" + "AABBCC"),
        bytes.fromhex("7602" + "DDEEFF"),
        bytes.fromhex("77"),           # transfer exit
    ])
    client = UdsClient(recorder)
    chunks = list(client.read_flash(0x00800000, 6))
    check("0x35 request encode", recorder.requests[0] == bytes.fromhex("350044" + "00800000" + "00000006"),
          recorder.requests[0].hex())
    check("0x36 block counters", recorder.requests[1][1] == 0x01 and recorder.requests[2][1] == 0x02)
    check("read_flash reassembly", b"".join(chunks) == bytes.fromhex("AABBCCDDEEFF"))
    check("0x37 exit sent", recorder.requests[3] == bytes.fromhex("37"))

    # Routine control (erase/checksum routines)
    recorder = RecordingTransport([bytes.fromhex("71010203E7")])
    client = UdsClient(recorder)
    status = client.routine_control(0x0203, "start")
    check("0x31 encode + parse",
          recorder.requests[0] == bytes.fromhex("31010203") and status == bytes.fromhex("E7"),
          recorder.requests[0].hex())

    print(f"{len(failures)} failure(s)" if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
