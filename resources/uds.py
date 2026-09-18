"""UDS (ISO 14229) over J2534 protocol layer for the VW 3.0 V6 TDI (EDC17).

Layers:
  - IsoTp framing helpers (ISO 15765-2). With the J2534 ISO15765 protocol
    flag the pass-thru device performs segmentation itself; these helpers
    exist for raw-CAN fallback and for offline self-tests.
  - UdsClient: session control, DID reads, DTC read/clear via 0x22/0x19/0x14.
  - J2534Transport: wraps the pyj2534 package (PassThruOpen/Connect/Filter/
    Write/Read). All hardware calls raise with actionable messages until a
    pass-thru device is installed.
  - DID_MAP: live-channel -> DID mapping with scaling. The 0xF4xx range
    mirrors ISO 15031-5 / SAE J1979 service-01 PIDs (DID = 0xF400 + PID),
    so the low byte MUST match the standard PID table:
      04 calculated load, 05 coolant, 0B intake MAP, 0C rpm,
      0D vehicle speed, 0E timing advance, 0F intake air temp.
    Entries are (did, nbytes, scaler); decodes are width-checked so a
    wrong-width answer nulls one channel instead of over-reading. Verify
    the batteryV DID against the DDXC label data once the ECU is connected.

Run `python uds.py --selftest` to exercise the pure protocol layer offline.
"""

import sys

REQUEST_ID = 0x7E0
RESPONSE_ID = 0x7E8
# TCU (ZF 8HP70): ODIS LL_TransContrModulUDS pair — request 0x7E1,
# response 0x7E9. One ECU pair per transport instance; the engine pair
# (LL_EnginContrModul1UDS) stays the default.
TCU_REQUEST_ID = 0x7E1
TCU_RESPONSE_ID = 0x7E9

# ISO 14229: while an ECU works on a request it may answer 0x7F <sid>
# 0x78 (requestCorrectlyReceived-ResponsePending) — a keep-alive, not an
# error. VAG ECUs do this routinely. The tester keeps waiting on the
# extended P2* timeout; the pending count is bounded so a stuck ECU
# can't hang the session forever.
P2_STAR_TIMEOUT_MS = 5000
MAX_PENDING_FRAMES = 10


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
                 response_id: int = RESPONSE_ID, timeout_ms: int = 1000,
                 p2_star_timeout_ms: int = P2_STAR_TIMEOUT_MS,
                 max_pending_frames: int = MAX_PENDING_FRAMES):
        self.transport = transport
        self.request_id = request_id
        self.response_id = response_id
        self.timeout_ms = timeout_ms
        self.p2_star_timeout_ms = p2_star_timeout_ms
        self.max_pending_frames = max_pending_frames

    def _transact(self, request: bytes) -> bytes:
        self.transport.write(self.request_id, request)
        timeout_ms = self.timeout_ms
        pending = 0
        while True:
            response = self.transport.read(self.response_id, timeout_ms)
            if response is None:
                raise TransportError(
                    f"no response to {request.hex()} (timeout {timeout_ms} ms)")
            if response[0] != 0x7F:
                return response
            if len(response) < 3:
                raise TransportError(
                    f"malformed negative response to service "
                    f"0x{request[0]:02X}: {response.hex()}")
            service = response[1]
            code = response[2]
            if code == 0x78 and service == request[0]:
                # ResponsePending for OUR service — wait on P2* for the
                # real answer, bounded by max_pending_frames.
                pending += 1
                if pending > self.max_pending_frames:
                    raise TransportError(
                        f"ECU still busy after {self.max_pending_frames} "
                        f"responsePending (0x78) frames for service "
                        f"0x{request[0]:02X} — giving up")
                timeout_ms = self.p2_star_timeout_ms
                continue
            raise TransportError(
                f"negative response 0x{code:02X} (service 0x{service:02X}) "
                f"to service 0x{request[0]:02X}")

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
        """Read every mapped DID. Width is validated before scaling; any
        per-channel failure (timeout, NRC, wrong width, decode error) nulls
        that channel only — one bad DID can never kill the session."""
        values = {}
        for name, (did, nbytes, scaler) in did_map.items():
            try:
                payload = self.read_did(did)
                if len(payload) < nbytes:
                    raise ValueError(
                        f"wrong width: got {len(payload)} bytes, want {nbytes}")
                values[name] = scaler(payload)
            except (TransportError, IndexError, ValueError):
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


def decode_dtc_status(status: int) -> dict:
    """Decode the ISO 14229 DTC status byte carried in 0x19 responses.

    The bits callers actually care about:
      'confirmed' (bit 3) — the stored fault;
      'pending'   (bit 2) — the fault maturing toward confirmation;
      'testFailed'(bit 0) — the last test failed. NOT the same thing as
        a stored code: a fault can be confirmed without currently
        failing, and failing without yet being confirmed. Ad-hoc
        `status & 0x01` checks conflate the two — use this helper.
      'warningIndicator' (bit 7, warningIndicatorRequested) — what
        actually corresponds to an illuminated MIL; the warning-lights
        panel should key on this, not on any stored-code presence.
    """
    return {
        "testFailed": bool(status & 0x01),
        "testFailedThisOperationCycle": bool(status & 0x02),
        "pending": bool(status & 0x04),
        "confirmed": bool(status & 0x08),
        "testNotCompletedSinceLastClear": bool(status & 0x10),
        "testFailedSinceLastClear": bool(status & 0x20),
        "testNotCompletedThisOperationCycle": bool(status & 0x40),
        "warningIndicator": bool(status & 0x80),
    }


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

# (did, nbytes, scaler). Low bytes are ISO 15031-5 / SAE J1979 PIDs:
#   0x04 calculated load, 0x05 coolant (-40), 0x0C rpm (/4),
#   0x0D vehicle speed, 0x0F intake air temp (-40).
DID_MAP = {
    "rpm": (0xF40C, 2, lambda b: ((b[0] << 8) | b[1]) * 0.25),
    "speedKph": (0xF40D, 1, lambda b: b[0]),
    "coolantTempC": (0xF405, 1, lambda b: b[0] - 40),
    "intakeTempC": (0xF40F, 1, lambda b: b[0] - 40),
    "engineLoadPct": (0xF404, 1, lambda b: b[0] * 100 / 255),
    "batteryV": (0xF448, 1, lambda b: b[0] * 0.1),  # TODO: confirm on DDXC
}

# Inverse scalers (value -> DID payload bytes). Used by the test fixture
# transport (resources/sim_fixture.py) so fixture traffic flows through
# the SAME decode path as real hardware — the mapping itself is
# exercised, not bypassed.
DID_ENCODERS = {
    "rpm": lambda v: (lambda raw: bytes([raw >> 8, raw & 0xFF]))(int(round(v * 4))),
    "speedKph": lambda v: bytes([int(v) & 0xFF]),
    "coolantTempC": lambda v: bytes([int(round(v + 40)) & 0xFF]),
    "intakeTempC": lambda v: bytes([int(round(v + 40)) & 0xFF]),
    "engineLoadPct": lambda v: bytes([int(round(v * 255 / 100)) & 0xFF]),
    "batteryV": lambda v: bytes([int(round(v * 10)) & 0xFF]),
    "railPressureBar": lambda v: (lambda raw: bytes([raw >> 8, raw & 0xFF]))(int(round(v * 10))),
    "boostPressureKpa": lambda v: (lambda raw: bytes([raw >> 8, raw & 0xFF]))(int(round(v / 0.03))),
    "pedalPct": lambda v: bytes([int(round(v * 255 / 100)) & 0xFF]),
}

# (did, nbytes, scaler, note). Probed in order at first live connect;
# adoption now REQUIRES the response width to match nbytes.
# 0xF40E is deliberately absent from boost candidates: PID 0x0E is
# timing advance (1 byte) per ISO 15031-5, and a 2-byte read of it
# either crashes or mislabels timing as pressure.
DID_CANDIDATES = {
    "railPressureBar": [
        (0xF484, 2, lambda b: ((b[0] << 8) | b[1]) * 0.1, "community EDC17 table (x0.1 bar)"),
        (0xF485, 2, lambda b: ((b[0] << 8) | b[1]) * 0.1, "alternate rail DID (x0.1 bar)"),
    ],
    "boostPressureKpa": [
        (0xF4A3, 2, lambda b: ((b[0] << 8) | b[1]) * 0.03, "charge pressure (x0.03 kPa, community table)"),
        (0xF40B, 1, lambda b: float(b[0]), "J1979 intake MAP fallback (x1 kPa) — SATURATES at 255 kPa, cannot show stage-1 boost"),
    ],
    "pedalPct": [
        (0xF4A1, 1, lambda b: b[0] * 100 / 255, "accelerator position (x100/255 %)"),
        (0xF492, 1, lambda b: b[0] * 100 / 255, "alternate pedal DID (x100/255 %)"),
    ],
}


def probe_dids(client, did_map: dict | None = None) -> list[dict]:
    """Probe every mapped DID with 0x22; report which the ECU answers.

    A DID only passes when it answers AND the response width matches the
    map — a mislabelled DID answers politely, so width is the cheapest
    semantic check available without the truck running a known state.

    Returns [{channel, did, ok, value, note}] — `value` is the scaled
    reading when the DID passes, None otherwise."""
    did_map = did_map if did_map is not None else DID_MAP
    results = []
    for name, (did, nbytes, scaler) in did_map.items():
        try:
            payload = client.read_did(did)
            if len(payload) != nbytes:
                results.append({"channel": name, "did": did, "ok": False,
                                "value": None,
                                "note": f"answered but wrong width "
                                        f"(got {len(payload)}, want {nbytes}) — rejected"})
                continue
            results.append({"channel": name, "did": did, "ok": True, "value": scaler(payload),
                            "note": "standard set"})
        except TransportError:
            results.append({"channel": name, "did": did, "ok": False, "value": None,
                            "note": "no response / unsupported"})
    return results


def probe_candidates(client, channel: str) -> tuple[tuple | None, list[dict]]:
    """Try DID_CANDIDATES[channel] in order; the first DID that answers
    with the expected width is adopted. Returns ((did, nbytes, scaler)
    adopted or None, [attempt entries])."""
    adopted = None
    attempts = []
    for did, nbytes, scaler, note in DID_CANDIDATES.get(channel, []):
        try:
            payload = client.read_did(did)
        except TransportError:
            attempts.append({"channel": channel, "did": did, "ok": False,
                             "value": None, "note": note})
            continue
        if len(payload) != nbytes:
            attempts.append({"channel": channel, "did": did, "ok": False,
                             "value": None,
                             "note": note + " — answered but wrong width "
                                     f"(got {len(payload)}, want {nbytes}), rejected"})
            continue
        attempts.append({"channel": channel, "did": did, "ok": True,
                         "value": scaler(payload), "note": note})
        adopted = (did, nbytes, scaler)
        break
    return adopted, attempts


# ---------------------------------------------------------------------------
# J2534 pass-thru transport (requires pyj2534 + vendor DLL + device)
# ---------------------------------------------------------------------------

class J2534Transport:
    """Byte transport over a J2534 pass-thru device using the ISO15765
    protocol, which performs ISO-TP segmentation in firmware."""

    def __init__(self, device_name: str | None = None,
                 request_id: int = REQUEST_ID,
                 response_id: int = RESPONSE_ID):
        self.device_name = device_name
        self.request_id = request_id
        self.response_id = response_id
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
            mask_id=self.response_id_needed(),
            pattern_id=self.request_id,
        )

    def response_id_needed(self) -> int:
        return self.response_id

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

    # Scaling math (map entries are (did, nbytes, scaler) — scaler is index 2)
    check("rpm scale", DID_MAP["rpm"][2](bytes([0x0C, 0x30])) == 780.0)      # 3120 * 0.25
    check("coolant scale", DID_MAP["coolantTempC"][2](bytes([0x8A])) == 98)  # 138 - 40
    check("rail candidate scale", DID_CANDIDATES["railPressureBar"][0][2](bytes([0x0B, 0xB8])) == 300.0)
    check("boost candidate scale", DID_CANDIDATES["boostPressureKpa"][0][2](bytes([0x27, 0x10])) == 300.0)
    check("pedal candidate scale", DID_CANDIDATES["pedalPct"][0][2](bytes([0xFF])) == 100.0)

    # Corrected J1979 mirror: speed = PID 0x0D, intake temp = PID 0x0F,
    # and timing-advance (0x0E) must never appear as a boost candidate
    check("speed did+scale", DID_MAP["speedKph"][0] == 0xF40D
          and DID_MAP["speedKph"][2](bytes([0x64])) == 100)
    check("intake did+scale", DID_MAP["intakeTempC"][0] == 0xF40F
          and DID_MAP["intakeTempC"][2](bytes([0x46])) == 30)  # 70 - 40
    check("0xF40E not a boost candidate",
          all(c[0] != 0xF40E for c in DID_CANDIDATES["boostPressureKpa"]))

    # Multi-response transport for probe / flash primitives
    class RecordingTransport(FakeTransport):
        def __init__(self, responses):
            self.responses = list(responses)
            self.requests = []
            self.timeouts = []
        def write(self, can_id, data): self.requests.append(bytes(data))
        def read(self, can_id, timeout):
            self.timeouts.append(timeout)
            return self.responses.pop(0)

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

    # Candidate rejection on wrong width: first candidate answers 1 byte
    # where 2 are expected -> rejected, second (correct width) adopted
    client = UdsClient(RecordingTransport([
        bytes.fromhex("62F484" + "2C"),        # 0xF484 answers with 1 byte
        bytes.fromhex("62F485" + "0BB8"),      # 0xF485 answers correctly
    ]))
    adopted, attempts = probe_candidates(client, "railPressureBar")
    check("candidate wrong-width rejection", adopted is not None
          and adopted[0] == 0xF485 and not attempts[0]["ok"]
          and "wrong width" in attempts[0]["note"], str(attempts))

    # Width guard: a 1-byte answer to the 2-byte rpm DID nulls the channel
    # instead of raising out of read_live
    client = UdsClient(RecordingTransport([bytes.fromhex("62F40C" + "0C")]))
    live = client.read_live({"rpm": DID_MAP["rpm"]})
    check("read_live width guard", live["rpm"] is None, str(live))

    # Probe rejects a wrong-width answer even though the DID responds
    client = UdsClient(RecordingTransport([bytes.fromhex("62F40D" + "6400")]))
    probe = probe_dids(client, {"speedKph": DID_MAP["speedKph"]})
    check("probe width rejection", not probe[0]["ok"] and "wrong width" in probe[0]["note"],
          str(probe[0]))

    # Encoder round-trip: value -> DID payload -> decode recovers the value
    # (this is the path the test fixture transport runs on every sample)
    roundtrip = {
        "rpm": (780.0, DID_MAP["rpm"][2]),
        "speedKph": (100, DID_MAP["speedKph"][2]),
        "coolantTempC": (98, DID_MAP["coolantTempC"][2]),
        "intakeTempC": (30, DID_MAP["intakeTempC"][2]),
        "engineLoadPct": (35, DID_MAP["engineLoadPct"][2]),
        "batteryV": (14.0, DID_MAP["batteryV"][2]),
        "railPressureBar": (300.0, DID_CANDIDATES["railPressureBar"][0][2]),
        "boostPressureKpa": (102.5, DID_CANDIDATES["boostPressureKpa"][0][2]),
        "pedalPct": (12.5, DID_CANDIDATES["pedalPct"][0][2]),
    }
    roundtrip_ok = True
    for chan, (value, decode) in roundtrip.items():
        back = decode(DID_ENCODERS[chan](value))
        if abs(back - value) > 1.0:
            roundtrip_ok = False
            print(f"    roundtrip FAIL {chan}: {value} -> {back}")
    check("encoder round-trip (all channels)", roundtrip_ok)

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

    # NRC 0x78 (responsePending): keep waiting on P2*, then take the real
    # response. VAG ECUs emit this routinely (e.g. before a 0x22 answer).
    recorder = RecordingTransport([
        bytes.fromhex("7F2278"),            # pending for our 0x22
        bytes.fromhex("62F40C0C30"),        # the real answer
    ])
    client = UdsClient(recorder)
    payload = client.read_did(0xF40C)
    check("0x78 pending then real response", payload == bytes.fromhex("0C30"),
          payload.hex())
    check("0x78 wait uses P2* timeout",
          recorder.timeouts == [1000, P2_STAR_TIMEOUT_MS], str(recorder.timeouts))

    # Repeated pending frames are still tolerated
    recorder = RecordingTransport([
        bytes.fromhex("7F2278"), bytes.fromhex("7F2278"), bytes.fromhex("7F2278"),
        bytes.fromhex("62F40C0C30"),
    ])
    client = UdsClient(recorder)
    check("0x78 repeated pending tolerated",
          client.read_did(0xF40C) == bytes.fromhex("0C30"))

    # ...but bounded: a stuck ECU can't pend forever
    recorder = RecordingTransport([bytes.fromhex("7F2278")] * 20)
    client = UdsClient(recorder, max_pending_frames=3)
    try:
        client.read_did(0xF40C)
        check("0x78 unbounded pending raises", False, "no exception")
    except TransportError as exc:
        check("0x78 unbounded pending raises",
              "responsePending" in str(exc) and len(recorder.responses) == 16,
              str(exc))

    # A pending echo for a DIFFERENT service is not ours — raise, don't swallow
    client = UdsClient(RecordingTransport([bytes.fromhex("7F2E78")]))
    try:
        client.read_did(0xF40C)
        check("0x78 wrong-service echo raises", False, "no exception")
    except TransportError as exc:
        check("0x78 wrong-service echo raises", "0x78" in str(exc), str(exc))

    # Every other NRC still raises immediately
    client = UdsClient(RecordingTransport([bytes.fromhex("7F2231")]))
    try:
        client.read_did(0xF40C)
        check("NRC 0x31 still raises", False, "no exception")
    except TransportError as exc:
        check("NRC 0x31 still raises", "0x31" in str(exc), str(exc))

    # DTC status byte decode: bit 3 = confirmed (stored), bit 2 = pending,
    # bit 0 = testFailed — NOT interchangeable (ISO 14229 statusOfDTC).
    s = decode_dtc_status(0x09)  # 0000_1001: confirmed + testFailed
    check("dtc status confirmed+testFailed",
          s["confirmed"] and s["testFailed"] and not s["pending"], str(s))
    s = decode_dtc_status(0x04)  # pending only, not yet stored
    check("dtc status pending-only",
          s["pending"] and not s["confirmed"] and not s["testFailed"], str(s))
    s = decode_dtc_status(0x08)  # stored, not currently failing
    check("dtc status stored-not-failing",
          s["confirmed"] and not s["testFailed"], str(s))
    s = decode_dtc_status(0x88)  # confirmed + warningIndicatorRequested (MIL)
    check("dtc status warning indicator (MIL)",
          s["warningIndicator"] and s["confirmed"], str(s))

    # J2534 flow-control filter uses the pair it was configured with:
    # engine 0x7E0/0x7E8 by default, TCU 0x7E1/0x7E9 when asked.
    import types as _types
    fake = _types.ModuleType("pyj2534")
    fake.ISO15765 = 6
    fake.ISO15765_FRAME_PAD = 0x40
    fake.FLOW_CONTROL_FILTER = 0x03
    fake.filters = []

    class _FakeJ2534:
        def passThruOpen(self, name): return object()
        def passThruConnect(self, dev, proto, flags, bitrate): return object()
        def passThruStartMsgFilter(self, chan, filter_type, mask_id, pattern_id):
            fake.filters.append((mask_id, pattern_id))
    fake.J2534 = _FakeJ2534
    sys.modules["pyj2534"] = fake
    try:
        engine_transport = J2534Transport()
        engine_transport.open()
        tcu_transport = J2534Transport(request_id=TCU_REQUEST_ID,
                                       response_id=TCU_RESPONSE_ID)
        tcu_transport.open()
    finally:
        del sys.modules["pyj2534"]
    check("j2534 filter defaults to engine pair",
          fake.filters[0] == (0x7E8, 0x7E0), str(fake.filters))
    check("j2534 filter honours TCU pair",
          fake.filters[1] == (0x7E9, 0x7E1), str(fake.filters))

    print(f"{len(failures)} failure(s)" if failures else "all checks passed")
    return 1 if failures else 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
