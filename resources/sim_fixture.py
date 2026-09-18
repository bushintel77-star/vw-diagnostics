"""TEST FIXTURE ONLY — never imported by the product run path.

SimulatedTransport fabricates plausible VW ECU data so the monitor's
session loop, NDJSON event stream and the uds.py DID encode/decode codec
can be exercised without hardware (j2534_monitor.py --selftest, CI).

It is deliberately kept out of j2534_monitor.py so the shipped monitor
can never select it: the product only ever talks to a real J2534
pass-thru device, and fabricated vehicle data must never reach the UI.
"""

import math
import random

import uds as _uds


class SimulatedTransport:
    """Fabricates plausible VW ECU data for tests (codec + event stream)."""

    mode = "simulate"
    device = "Simulated J2534 pass-thru (test fixture — no hardware)"

    def __init__(self):
        self._sim_did_map = None

    INFO = {
        "protocol": "ISO 15765-4 (CAN 500 kbps)",
        "requestId": "0x7E0",
        "responseId": "0x7E8",
        "ecuName": "Engine Control Module — Bosch EDC17 (3.0 V6 TDI, DDXC / TDI550)",
        "partNumber": "2H0906027",
        "swVersion": "6177",
        "hwVersion": "H14",
        "coding": "0011721",
        "vin": "WV1ZZZ2H0JW123456",
    }

    # freezeFrame = conditions captured when each fault set (UDS freeze frame)
    DTCS = [
        {
            "code": "P0299",
            "status": "Stored",
            "description": "Turbocharger/supercharger underboost condition",
            "mileageKm": 186410,
            "freezeFrame": {"rpm": 2210, "coolantTempC": 88, "engineLoadPct": 71, "speedKph": 96},
        },
        {
            "code": "P0671",
            "status": "Stored",
            "description": "Cylinder 1 glow plug circuit malfunction",
            "mileageKm": 186044,
            "freezeFrame": {"rpm": 795, "coolantTempC": 6, "engineLoadPct": 12, "speedKph": 0},
        },
        {
            "code": "P2002",
            "status": "Pending",
            "description": "Diesel particulate filter efficiency below threshold (Bank 1)",
            "mileageKm": 186905,
            "freezeFrame": {"rpm": 2080, "coolantTempC": 84, "engineLoadPct": 41, "speedKph": 104},
        },
        {
            "code": "P2015",
            "status": "Stored",
            "description": "Intake manifold runner position sensor (Bank 1): implausible signal",
            "mileageKm": 185772,
            "freezeFrame": {"rpm": 1490, "coolantTempC": 84, "engineLoadPct": 31, "speedKph": 43},
        },
    ]

    def read_info(self) -> dict:
        return self.INFO

    # Canned DID-probe result mirroring uds.DID_MAP/DID_CANDIDATES — every
    # channel answers in the happy simulated world. DIDs follow the corrected
    # ISO 15031-5 mirror (speed 0x0D, intake temp 0x0F, boost via 0xF4A3).
    SIM_DID_ENTRIES = [
        {"channel": "rpm", "did": "0xF40C", "ok": True, "value": 790, "note": "standard set"},
        {"channel": "speedKph", "did": "0xF40D", "ok": True, "value": 0, "note": "standard set"},
        {"channel": "coolantTempC", "did": "0xF405", "ok": True, "value": 90, "note": "standard set"},
        {"channel": "intakeTempC", "did": "0xF40F", "ok": True, "value": 32, "note": "standard set"},
        {"channel": "engineLoadPct", "did": "0xF404", "ok": True, "value": 24, "note": "standard set"},
        {"channel": "batteryV", "did": "0xF448", "ok": True, "value": 14.0, "note": "standard set (unconfirmed on DDXC)"},
        {"channel": "railPressureBar", "did": "0xF484", "ok": True, "value": 300, "note": "community EDC17 table (x0.1 bar)"},
        {"channel": "boostPressureKpa", "did": "0xF4A3", "ok": True, "value": 100, "note": "charge pressure (x0.03 kPa, community table)"},
        {"channel": "pedalPct", "did": "0xF4A1", "ok": True, "value": 0, "note": "accelerator position (x100/255 %)"},
    ]

    def probe_dids(self) -> list:
        return [dict(entry) for entry in self.SIM_DID_ENTRIES]

    SIM_BACKUP_BYTES = 65536  # placeholder size — a real EDC17 image is MBs

    def total_backup_bytes(self) -> int | None:
        return self.SIM_BACKUP_BYTES

    def read_backup_chunks(self, block: int = 4096):
        """Yield the placeholder 'stock image'. In simulation there is no
        ECU to read, so the backup is a deterministic pattern the Node host
        assembles and writes — exercising the exact event/persistence path
        the real read will use."""
        sent = 0
        seed = 0
        while sent < self.SIM_BACKUP_BYTES:
            take = min(block, self.SIM_BACKUP_BYTES - sent)
            yield bytes((seed + j) % 251 for j in range(take))
            sent += take
            seed += 7

    def read_dtcs(self) -> list:
        return [dict(dtc) for dtc in self.DTCS]

    def clear_dtcs(self) -> int:
        count = len(self.DTCS)
        self.DTCS = []
        return count

    def remove_codes(self, codes: list) -> int:
        """Codes the ECU stops reporting after a component is coded out."""
        removed = [dtc for dtc in self.DTCS if dtc["code"] in codes]
        self.DTCS = [dtc for dtc in self.DTCS if dtc["code"] not in codes]
        return len(removed)

    def sample(self, t: float) -> dict:
        """t = seconds since session start; 3.0 V6 TDI idling on a bench."""

        def noise(spread: float) -> float:
            # simulated sensor jitter only -- nothing security-sensitive
            return random.uniform(-spread, spread)

        def clamp(value: float, lo: float, hi: float) -> float:
            return max(lo, min(hi, value))

        warmup = min(t / 120.0, 1.0)  # coolant reaches operating temp in ~2 min
        raw = {
            "rpm": round(clamp(790 + 35 * math.sin(t * 0.9) + noise(15), 660, 900)),
            "speedKph": 0,
            "coolantTempC": round(clamp(18 + 74 * warmup + noise(0.4), 12, 95)),
            "intakeTempC": round(clamp(26 + 3 * math.sin(t * 0.2) + noise(0.3), 15, 45)),
            "boostPressureKpa": round(clamp(99 + 2.0 * math.sin(t * 0.7) + noise(1.0), 95, 104)),
            "pedalPct": round(clamp(0 + 1.5 * math.sin(t * 1.3) + noise(0.4), 0, 3), 1),
            "engineLoadPct": round(clamp(21 + 6 * math.sin(t * 0.5) + noise(1.5), 12, 38)),
            "batteryV": round(14.0 + 0.2 * math.sin(t * 0.11) + noise(0.03), 2),
            "railPressureBar": round(clamp(290 + 25 * math.sin(t * 0.8) + noise(8), 250, 340)),
        }
        return self._through_did_codec(raw)

    def _through_did_codec(self, raw: dict) -> dict:
        """Encode every channel into its DID payload and decode it back
        through the same scalars the real transport uses. The fixture
        therefore exercises the DID mapping instead of bypassing it —
        a wrong DID or width surfaces here first, in the safe world."""
        if self._sim_did_map is None:
            sim_map = dict(_uds.DID_MAP)
            for channel in _uds.DID_CANDIDATES:
                sim_map[channel] = _uds.DID_CANDIDATES[channel][0][:3]
            self._sim_did_map = sim_map
        decoded = {}
        for name, (_did, nbytes, scaler) in self._sim_did_map.items():
            try:
                payload = _uds.DID_ENCODERS[name](raw[name])
                decoded[name] = scaler(payload) if len(payload) == nbytes else None
            except (KeyError, ValueError, OverflowError):
                decoded[name] = None
        return decoded
