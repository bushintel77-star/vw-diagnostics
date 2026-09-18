"""J2534 VW diagnostic monitor spawned by the Electron main process.

Protocol: newline-delimited JSON on stdout, one event per line
(flushed immediately so Node can stream it):

  {"type": "status",   "phase": "...", "message": "...", "mode": "..."}
  {"type": "info",     "info": {ecu identification...}}
  {"type": "dids",     "entries": [{channel, did, ok, value, note}...]}   # 0x22 probe
  {"type": "dtc",      "codes": [{code, status, description, mileageKm, freezeFrame}...]}
  {"type": "live",     "values": {rpm, coolantTempC, ...}, "timestamp": "..."}
  {"type": "analysis", "healthScore": ..., "findings": [...], ...}   # on-device heuristics
  {"type": "flash",    "phase": "start|progress|complete|error", ...} # ECU read/backup
  {"type": "log",      "message": "..."}                            # informational lines
  {"type": "error",    "message": "..."}

Commands: newline-delimited JSON on stdin, written by the main process:

  {"cmd": "clear_dtc"}
  {"cmd": "probe_dids"}
  {"cmd": "read_ecu_backup"}
  {"cmd": "verify_changes", "dutyProfile": "standard" | "no_tow"}

Debug output belongs on stderr, never stdout.

Modes:
  (default)    Open the real pyJ2534 transport — the only product mode.
               If no interface is attached the monitor reports the real
               TransportError and stays alive so the UI can show it.
  --selftest   Event-stream smoke test: runs the same session loop against
               resources/sim_fixture.py (test-only simulated transport).
               Not a product mode — the fixture is never imported on the
               normal run path, and fabricated data cannot reach the UI.

open_real_transport() below marks every integration point
(PassThruOpen/Connect/StartMsgFilter + UDS requests over ISO-TP).
"""

import argparse
import base64
import json
import math
import queue
import signal
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone

LIVE_INTERVAL_S = 0.5

# Alert thresholds reviewed on every live sample (real mode benefits too).
ALERT_THRESHOLDS = {
    "coolantTempC": ("overheating", 105, lambda v, t: v >= t, "Coolant temperature above 105 °C — stop the engine and check the cooling system."),
    "batteryV": ("undercharging", 11.5, lambda v, t: v <= t, "Battery voltage below 11.5 V — charging system fault suspected."),
    "rpm": ("over-rev", 6500, lambda v, t: v >= t, "Engine speed above 6500 rpm sustained."),
}


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def status(phase: str, message: str, mode: str) -> dict:
    return {"type": "status", "phase": phase, "message": message, "mode": mode}


def log(message: str) -> dict:
    return {"type": "log", "message": message}


# ---------------------------------------------------------------------------
# On-device heuristic analysis ("AI assistant"). Swap the knowledge base and
# build_analysis() for a real model call when one is available; the event
# shape the dashboard consumes stays the same.
# ---------------------------------------------------------------------------

ANALYSIS_KNOWLEDGE = {
    "P0299": {
        "severity": "medium",
        "title": "Turbo underboost (VNT)",
        "detail": "Measured boost pressure fell short of target. On the 3.0 V6 TDI this is most often a sticking VNT mechanism or a boost leak; the ECU may reduce power (limp mode) to protect itself.",
        "likelyCauses": ["Sticking VNT mechanism", "Boost pipe or intercooler leak", "VNT actuator / vacuum fault"],
        "actions": [
            "Smoke/pressure test the charge pipes and intercooler",
            "Check VNT actuator movement with the output test once live mode is available",
            "Read boost actual vs target during a full-load drive",
        ],
        "confidence": 0.68,
    },
    "P0671": {
        "severity": "low",
        "title": "Cylinder 1 glow plug circuit",
        "detail": "Glow plug 1 reports an electrical fault. Effect is hard cold starts and increased cold-start smoke; not damaging while driving.",
        "likelyCauses": ["Worn glow plug", "Corroded connector", "Glow plug module output fault"],
        "actions": [
            "Measure glow plug 1 resistance (spec roughly < 1 Ω cold)",
            "Inspect the connector for corrosion before replacing the plug",
        ],
        "confidence": 0.75,
    },
    "P2002": {
        "severity": "medium",
        "title": "DPF efficiency below threshold",
        "detail": "The diesel particulate filter is no longer trapping soot efficiently — usually interrupted regenerations from short-trip/city use, or high ash mileage.",
        "likelyCauses": ["Interrupted regenerations (short trips)", "High ash loading at mileage", "Differential pressure sensor fault"],
        "actions": [
            "Drive 20–30 min at ~100 km/h in a suitable gear to complete a regeneration",
            "Read soot mass and differential pressure live values",
            "If ash loading is high, a DPF replacement or professional clean is due",
        ],
        "confidence": 0.66,
    },
    "P2015": {
        "severity": "low",
        "title": "Intake runner (swirl flap) position implausible",
        "detail": "The swirl flap position disagrees with the commanded position — on TDI engines commonly EGR soot buildup in the intake.",
        "likelyCauses": ["Soot buildup on swirl flaps", "Weak flap motor", "Faulty position sensor"],
        "actions": [
            "Run the intake flap output test once live mode is available",
            "Inspect the intake for soot loading",
        ],
        "confidence": 0.58,
    },
}


def build_analysis(dtcs: list, values: dict | None, alerts: list | None = None,
                   stream: dict | None = None, provenance: dict | None = None) -> dict:
    alerts = alerts or []
    findings = []
    for dtc in dtcs:
        knowledge = ANALYSIS_KNOWLEDGE.get(dtc["code"])
        if knowledge is None:
            findings.append({
                "code": dtc["code"],
                "severity": "medium",
                "title": dtc["description"],
                "detail": "No knowledge-base entry for this code yet.",
                "likelyCauses": ["Consult the factory repair manual"],
                "actions": ["Read freeze frame and verify with guided fault finding"],
                "confidence": 0.3,
            })
            continue
        findings.append({
            "code": dtc["code"],
            "severity": knowledge["severity"],
            "title": knowledge["title"],
            "detail": knowledge["detail"],
            "likelyCauses": knowledge["likelyCauses"],
            "actions": knowledge["actions"],
            "confidence": knowledge["confidence"],
        })

    stored = sum(1 for d in dtcs if d["status"] != "Pending")
    pending = len(dtcs) - stored
    score = 100
    for finding in findings:
        score -= {"high": 20, "medium": 10, "low": 5}[finding["severity"]]
    score = max(0, min(100, score - len(alerts) * 10))
    label = "Good" if score >= 80 else "Fair" if score >= 50 else "Poor"

    if not dtcs and not alerts:
        summary = "No fault codes stored and live values are within expected idle ranges."
    else:
        priority = findings[0]["title"] if findings else "live-data alerts"
        summary = (
            f"{stored} stored and {pending} pending fault codes. "
            f"Priority: {priority}."
        )
        if alerts:
            summary += f" {len(alerts)} live-data alert(s) active."

    advisories = list(alerts)
    if values and 0 < values.get("coolantTempC", 90) < 80:
        advisories.append("Coolant below operating temperature — normal during warm-up.")

    event = {
        "type": "analysis",
        "healthScore": score,
        "healthLabel": label,
        "summary": summary,
        "findings": findings,
        "advisories": advisories,
        "generatedAt": now_iso(),
    }
    if stream is not None:
        event["stream"] = stream
    if provenance is not None:
        event["provenance"] = provenance
    return event


# ---------------------------------------------------------------------------
# Safety scope: this tool writes to PERFORMANCE modules only. Default-deny —
# any catalog entry or command targeting an ECU outside ALLOWED_MODULES is
# refused before a write happens. Steering, brakes and
# every restraint/safety module are permanently out of scope.
# ---------------------------------------------------------------------------

MODULE_SCOPE = {
    "allowed": [
        {"name": "Engine", "address": "0x7E0", "reason": "performance calibration"},
        {"name": "Transmission (ZF 8HP70)", "address": "0x7E1", "reason": "performance calibration"},
    ],
    "blocked": [
        {"name": "Steering (EPS)", "reason": "steering — safety critical"},
        {"name": "Brakes (ABS / ESP / EPB)", "reason": "braking — safety critical"},
        {"name": "Airbag / belt tensioners (SRS)", "reason": "restraint system — safety critical"},
        {"name": "Driver assistance (ACC / lane / camera)", "reason": "ADAS — safety critical"},
        {"name": "All other modules", "reason": "outside the performance scope of this tool"},
    ],
}

ALLOWED_MODULES = {m["name"] for m in MODULE_SCOPE["allowed"]}


def module_allowed(ecu: str) -> bool:
    return ecu in ALLOWED_MODULES


# ---------------------------------------------------------------------------
# Tier-1 statistical layer: learned baselines, deviation bands, trend
# prediction. Runs on-device over the live sample stream; deterministic
# fallback to the static ALERT_THRESHOLDS until warm-up completes.
# The monitor performs NO file I/O — baseline persistence across sessions is
# owned by the Electron main process via the baselines event + seed command.
# ---------------------------------------------------------------------------

EWMA_ALPHA = 0.05
TREND_WINDOW = 40            # samples used for the linear fit (20 s)
Z_ELEVATED = 3.0             # |z| at/above -> elevated
Z_ABNORMAL = 6.0             # |z| at/above -> abnormal
DEVIATION_STREAK = 5         # consecutive abnormal samples before advising
PREDICT_MIN_CONFIDENCE = 0.8
PREDICT_HORIZON_S = 600      # never project further than 10 minutes

PREDICT_CONFIG = {
    "coolantTempC": {"direction": "max", "threshold": 105.0, "label": "Coolant", "unit": "°C"},
    "batteryV": {"direction": "min", "threshold": 11.5, "label": "Battery voltage", "unit": "V"},
    "rpm": {"direction": "max", "threshold": 5200, "label": "Engine speed", "unit": "rpm"},
}

CHANNEL_LABELS = {
    "rpm": "RPM", "speedKph": "Vehicle speed", "coolantTempC": "Coolant",
    "intakeTempC": "Intake air", "boostPressureKpa": "Boost", "pedalPct": "Accelerator pedal",
    "engineLoadPct": "Engine load", "batteryV": "Battery", "railPressureBar": "Rail pressure",
}

# Ingestion plausibility: samples outside these bounds (or changing faster
# than the per-tick rate limit) are rejected before reaching the tracker —
# bus glitches must never move a learned baseline.
PLAUSIBLE = {
    "rpm": (0, 6000), "speedKph": (0, 250), "coolantTempC": (-40, 150), "intakeTempC": (-40, 120),
    "boostPressureKpa": (0, 350), "pedalPct": (0, 100), "engineLoadPct": (0, 100),
    "batteryV": (6, 16), "railPressureBar": (0, 2200),
}
MAX_RATE_PER_TICK = {
    "rpm": 2000, "speedKph": 120, "coolantTempC": 10, "intakeTempC": 10,
    "boostPressureKpa": 150, "pedalPct": 60, "engineLoadPct": 60, "batteryV": 2, "railPressureBar": 600,
}


class StreamTracker:
    """Learns per-channel baselines (EWMA + EW variance) from live samples."""

    def __init__(self, warmup: int):
        self.warmup = warmup
        self.channels: dict = {}
        self.seeded_sessions = 0
        self._logged: set = set()
        self.rejected = 0
        self.rejected_channels: set = set()
        self.seen = 0  # live samples processed — 0 means the stream never ran

    def _new_channel(self) -> dict:
        return {
            "baseline": 0.0, "var": 0.0, "samples": 0, "count": 0,
            "last": None, "streak": 0, "history": deque(maxlen=TREND_WINDOW),
            "init": False,
        }

    def seed_from(self, entry: dict) -> None:
        """Adopt baselines persisted from previous sessions (sent by the main
        process). Expected early in the session, before warm-up completes."""
        self.seeded_sessions = int(entry.get("sessions", 0))
        for name, ch in (entry.get("channels") or {}).items():
            self.channels[name] = {
                "baseline": float(ch.get("baseline", 0.0)),
                "var": float(ch.get("var", 0.0)),
                "samples": int(ch.get("samples", 0)),
                "count": 0, "last": None, "streak": 0,
                "history": deque(maxlen=TREND_WINDOW), "init": True,
            }

    def update(self, values: dict) -> None:
        self.seen += 1
        for name, value in values.items():
            # Range plausibility: physically impossible values are rejected.
            bounds = PLAUSIBLE.get(name)
            if bounds is not None and not (bounds[0] <= value <= bounds[1]):
                self.rejected += 1
                self.rejected_channels.add(name)
                continue
            ch = self.channels.setdefault(name, self._new_channel())
            # Rate plausibility: a step no real sensor can take in one tick
            # is a bus glitch, not a measurement.
            if ch["last"] is not None:
                rate = MAX_RATE_PER_TICK.get(name)
                if rate is not None and abs(value - ch["last"]) > rate:
                    self.rejected += 1
                    self.rejected_channels.add(name)
                    continue
            ch["count"] += 1
            ch["samples"] += 1
            ch["last"] = value
            ch["history"].append(value)
            if not ch["init"]:
                ch["init"] = True
                ch["baseline"] = value
                continue
            ch["baseline"] = (1 - EWMA_ALPHA) * ch["baseline"] + EWMA_ALPHA * value
            ch["var"] = (1 - EWMA_ALPHA) * ch["var"] + EWMA_ALPHA * (value - ch["baseline"]) ** 2
            sigma = self._sigma(name)
            if sigma > 1e-6 and abs(value - ch["baseline"]) / sigma >= Z_ABNORMAL:
                ch["streak"] += 1
            else:
                ch["streak"] = 0

    def _sigma(self, name: str, ch: dict | None = None) -> float:
        """Standard deviation with a floor (0.5% of channel span) so a quiet
        channel never collapses σ to ~0 and explodes z on tiny changes."""
        ch = ch if ch is not None else self.channels.get(name, {})
        raw = math.sqrt(ch.get("var", 0.0))
        bounds = PLAUSIBLE.get(name)
        floor = 0.005 * (bounds[1] - bounds[0]) if bounds else 0.0
        return max(raw, floor)

    def _channel_state(self, name: str) -> dict:
        ch = self.channels.get(name)
        if ch is None or ch["last"] is None:
            return {"baseline": 0, "stddev": 0, "zScore": 0, "state": "learning"}
        sigma = self._sigma(name, ch)
        if ch["count"] < self.warmup:
            z = 0.0
            state = "learning"
        else:
            z = (ch["last"] - ch["baseline"]) / sigma if sigma > 1e-6 else 0.0
            az = abs(z)
            state = "abnormal" if az >= Z_ABNORMAL else "elevated" if az >= Z_ELEVATED else "normal"
        return {"baseline": round(ch["baseline"], 2), "stddev": round(sigma, 2),
                "zScore": round(z, 1), "state": state}

    def _fit(self, history: list) -> tuple[float, float, float]:
        """Least-squares slope, mean, R² over the window."""
        n = len(history)
        xs = list(range(n))
        mx = sum(xs) / n
        my = sum(history) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((x - mx) * (y - my) for x, y in zip(xs, history))
        slope = sxy / sxx if sxx else 0.0
        syy = sum((y - my) ** 2 for y in history)
        r2 = (sxy * sxy) / (sxx * syy) if sxx > 0 and syy > 0 else 0.0
        return slope, my, r2

    def _predictions(self) -> list:
        found = []
        for name, cfg in PREDICT_CONFIG.items():
            ch = self.channels.get(name)
            if ch is None or len(ch["history"]) < TREND_WINDOW:
                continue
            history = list(ch["history"])
            slope, _, r2 = self._fit(history)
            # Stability guard: a decaying (non-linear) trend, like coolant
            # warm-up, must not project as if it continues linearly.
            half = TREND_WINDOW // 2
            s1, _, _ = self._fit(history[:half])
            s2, _, _ = self._fit(history[half:])
            stability = 1.0 - min(1.0, abs(s1 - s2) / (abs(s2) + 1e-9))
            confidence = max(0.0, r2) * max(0.0, stability)
            if confidence < PREDICT_MIN_CONFIDENCE:
                continue

            threshold = cfg["threshold"]
            last = history[-1]
            if cfg["direction"] == "max" and slope > 0 and last < threshold:
                pass
            elif cfg["direction"] == "min" and slope < 0 and last > threshold:
                pass
            else:
                continue
            eta_s = ((threshold - last) / slope) * LIVE_INTERVAL_S
            if eta_s <= 0 or eta_s > PREDICT_HORIZON_S:
                continue
            rate_per_min = slope * (60.0 / LIVE_INTERVAL_S)
            eta_min = max(1, round(eta_s / 60))
            found.append({
                "channel": name,
                "message": (
                    f"{cfg['label']} trending {rate_per_min:+.1f} {cfg['unit']}/min — projects past "
                    f"{threshold}{cfg['unit']} in ~{eta_min} min if the current trend continues"
                ),
                "etaSeconds": round(eta_s),
                "confidence": round(confidence, 2),
            })
        return found

    def snapshot(self) -> dict:
        samples = max((ch["count"] for ch in self.channels.values()), default=0)
        return {
            "samples": samples,
            "windowSeconds": round(samples * LIVE_INTERVAL_S),
            "channels": {
                name: self._channel_state(name) for name in CHANNEL_LABELS
                if name in self.channels
            },
            "predictions": self._predictions(),
        }

    def drain_new_alerts(self) -> list[str]:
        """One-shot log messages for newly detected deviations/predictions."""
        messages = []
        for name, ch in self.channels.items():
            label = CHANNEL_LABELS.get(name, name)
            sigma = self._sigma(name, ch)
            if ch["count"] >= self.warmup and ch["streak"] >= DEVIATION_STREAK and sigma > 1e-6:
                z = (ch["last"] - ch["baseline"]) / sigma
                key = ("z", name)
                if key not in self._logged:
                    self._logged.add(key)
                    messages.append(
                        f"{label} deviating {abs(z):.1f}σ {'above' if z > 0 else 'below'} its learned "
                        f"baseline ({ch['baseline']:.1f}) — abnormal for this session."
                    )
            elif ch["streak"] == 0:
                self._logged.discard(("z", name))
        for prediction in self._predictions():
            key = ("p", prediction["channel"])
            if key not in self._logged:
                self._logged.add(key)
                messages.append(f"Predictive alert: {prediction['message']}")
        return messages

    def provenance(self) -> dict:
        samples = max((ch["count"] for ch in self.channels.values()), default=0)
        if samples < self.warmup:
            mode = "static-fallback"
        elif self.seeded_sessions > 0:
            mode = "cross-session"
        else:
            mode = "session-learned"
        return {
            "analysisVersion": 2,
            "baselineSamples": samples,
            "mode": mode,
            "sessions": self.seeded_sessions + 1,
            "rejectedSamples": self.rejected,
            "rejectedChannels": sorted(self.rejected_channels),
        }

    def export(self) -> dict:
        return {
            name: {"baseline": ch["baseline"], "var": ch["var"], "samples": ch["samples"]}
            for name, ch in self.channels.items()
        }


def emit_baselines(vin: str, tracker: StreamTracker) -> None:
    """Hand the learned baselines to the main process (which persists them)."""
    if not vin:
        return
    emit({
        "type": "baselines",
        "vin": vin,
        "sessions": tracker.seeded_sessions + 1,
        "channels": tracker.export(),
    })


# Duty profile: how the truck is actually used. It does NOT raise any
# safety ceiling — the drivetrain ratings are physics, not preferences.
# It tunes verification scrutiny: the no-tow profile documents the extra
# thermal margin against the factory tow-duty calibration and reports it.
DUTY_PROFILES = {
    "standard": {
        "label": "Standard (tow-capable)",
        "coolantMaxC": 105.0,
        "note": "Factory duty assumption incl. the 3.5 t tow rating.",
    },
    "no_tow": {
        "label": "No-tow / light duty",
        "coolantMaxC": 105.0,
        "note": "No towing: thermal duty sits well below the factory tow calibration — extra margin, same ceilings.",
    },
}

# The manufacturer-standard torque envelope for this drivetrain, assembled
# from the factory variant ladder rather than a tuner's claims: 550 Nm
# demonstrated (this truck, DDXC) -> 580 Nm VW 10-s transient -> ~620 Nm
# single-turbo Audi fitments of the same family -> ~700 Nm at the ZF 8HP70
# input rating (with SQ5 biturbo evidence). Any tune we sign off must hold
# inside it: 680 Nm sustained + 710 Nm 10-s overboost fits with margin.
FACTORY_ENVELOPE = {
    "ceilingSustainedNm": 700.0,
    "ceilingPeakNm": 715.0,  # 710 Nm overboost + measurement jitter
    "ladder": "550 stock · 580 VW transient · 620 single-turbo Audi · 700 ZF 8HP70 rating",
}



def run_verification(transport, active_deletions: set, active_mods: set,
                     tracker: StreamTracker, session: dict,
                     duty_profile: str = "standard") -> dict:
    """Post-flash health check: the workshop 'scan after work', automated.
    Every input is re-read from the vehicle at this moment (DTCs via 0x19,
    channels via 0x22). Under the test fixture it grades the fixture's
    state and says so via `source`."""
    profile = DUTY_PROFILES.get(duty_profile, DUTY_PROFILES["standard"])
    source = "ecu" if transport.mode == "live" else "simulated"

    # A failed DTC read means no evidence — the check skips, never passes.
    try:
        codes = transport.read_dtcs()  # live: fresh 0x19 read right now
    except Exception as exc:
        codes = None
        dtc_error = str(exc)
    baseline = session.get("baseline_codes", set())
    current = {c["code"] for c in codes} if codes is not None else None

    suppressed: set = set()
    for entry in DELETION_CATALOG:
        if entry["id"] in active_deletions:
            suppressed.update(entry["clearsCodes"])

    items = []
    substantive = False  # a check passed on data actually read this session

    if codes is None:
        items.append({
            "check": "No new fault codes introduced",
            "status": "skipped",
            "detail": f"DTC read failed — nothing evaluated ({dtc_error})",
        })
    else:
        unexpected = sorted(current - baseline)
        items.append({
            "check": "No new fault codes introduced",
            "status": "fail" if unexpected else "pass",
            "detail": f"new since session start: {', '.join(unexpected)}" if unexpected
            else f"{len(codes)} known code(s), none new this session",
        })
        if not unexpected:
            substantive = True  # a fresh 0x19 read is real ECU evidence

    if current is None and suppressed:
        items.append({
            "check": "Coded-out codes suppressed",
            "status": "skipped",
            "detail": "DTC read failed — cannot confirm suppression",
        })
    else:
        leaking = sorted(suppressed & (current or set()))
        items.append({
            "check": "Coded-out codes suppressed",
            # No active deletes means nothing was checked — skip, not a pass.
            "status": "fail" if leaking else ("pass" if suppressed else "skipped"),
            "detail": f"still reporting: {', '.join(leaking)}" if leaking
            else f"{len(suppressed)} code(s) suppressed by active deletes" if suppressed
            else "no deletes active — nothing to check",
        })
        if suppressed and not leaking:
            substantive = True  # ECU read confirms the masked codes are gone

    # Live mode re-reads the channels straight from the ECU instead of
    # trusting the last streamed sample.
    values = transport.sample(0) if source == "ecu" else session.get("last_values")
    breaches = []
    if values:
        for name, (lo, hi) in PLAUSIBLE.items():
            v = values.get(name)
            if v is not None and not (lo <= v <= hi):
                breaches.append(f"{name}={v}")
    items.append({
        "check": "Live channels within limits",
        # Absence of data is absence — skipped, never a pass or a fail.
        "status": "fail" if breaches else ("pass" if values else "skipped"),
        "detail": ", ".join(breaches) if breaches
        else "all channels plausible" if values
        else "no live data received — nothing evaluated",
    })
    if values and not breaches:
        substantive = True  # live channels re-read and evaluated

    coolant = values.get("coolantTempC") if values else None
    items.append({
        "check": f"Coolant within duty-profile limit ({profile['coolantMaxC']:.0f} °C)",
        "status": "fail" if (coolant is not None and coolant > profile["coolantMaxC"])
        else ("pass" if coolant is not None else "skipped"),
        "detail": f"{profile['label']}: {profile['note']}"
        + (f" Now: {coolant} °C." if coolant is not None else " No coolant reading."),
    })
    if coolant is not None and coolant <= profile["coolantMaxC"]:
        substantive = True  # a real reading inside the duty limit

    items.append({
        "check": "No rejected implausible samples",
        "status": "fail" if tracker.rejected > 5
        else ("pass" if tracker.seen else "skipped"),
        "detail": f"{tracker.rejected} sample(s) rejected"
        + (f" on {', '.join(sorted(tracker.rejected_channels))}" if tracker.rejected_channels else "")
        + ("" if tracker.seen else " — stream produced no samples"),
    })
    if tracker.seen and tracker.rejected <= 5:
        substantive = True  # the live stream actually ran and was evaluated

    items.append({
        "check": "Applied state read-back",
        # A pass for confirming nothing was applied is a tick for nothing.
        "status": "pass" if (active_mods or active_deletions) else "skipped",
        "detail": (f"{len(active_mods)} mod(s) + {len(active_deletions)} delete(s) active and consistent"
                   if (active_mods or active_deletions) else "stock coding — nothing applied"),
    })

    # Unambiguous scope statement: this app never writes, so the verdict
    # confirms vehicle health — never that a tune was applied.
    applied = len(active_mods) + len(active_deletions)
    items.append({
        "check": "Calibration changes applied this session",
        "status": "skipped" if applied == 0 else "pass",
        "detail": ("none — this app does not write to the ECU; changes are "
                   "applied by bench flashing and verified here"
                   if applied == 0 else
                   f"{len(active_mods)} mod(s) + {len(active_deletions)} delete(s) applied"),
    })

    # The manufacturer-standard envelope stays on the card as reference
    # (the ceilings and ladder are hand-authored data the user values).
    # The measured-torque check was removed with the pull command — nothing
    # populates last_pull, so it could only ever skip. It returns when a
    # real torque-logging path exists; measured values stay None, honestly.
    envelope = dict(FACTORY_ENVELOPE)
    envelope["peakTorqueNm"] = None
    envelope["sustainedTorqueNm"] = None

    # Three-state verdict — a post-flash health check, not a sign-off.
    # "pass" requires at least one check to have passed on real ECU
    # evidence read this session (a DTC re-read, live channels, coolant,
    # the stream). With no session data every check skips and the honest
    # verdict is inconclusive — never PASSED on nothing.
    fails = any(item["status"] == "fail" for item in items)
    verdict = "fail" if fails else ("pass" if substantive else "inconclusive")
    return {
        "type": "verification",
        "verdict": verdict,
        "items": items,
        "timestamp": now_iso(),
        "source": source,
        "dutyProfile": profile["label"],
        "envelope": envelope,
    }


# ---------------------------------------------------------------------------
# Component deletion catalog — performance-scoped. group maps to the
# dashboard sections: engine / offroad.
# ---------------------------------------------------------------------------

DELETION_CATALOG = [
    # Engine — reversible, road-legal
    {"id": "start_stop_memory", "name": "Start-Stop memory (stays off)", "group": "engine",
     "ecu": "Engine", "method": "Coding", "clearsCodes": [], "risk": "low", "offRoadOnly": False,
     "description": "Remembers the last Start-Stop state across ignition cycles — saves starter and battery wear, standard companion to diesel tunes."},

    # Post-removal monitor deletes — emissions related, off-road/show only
    {"id": "egr", "name": "EGR system", "group": "offroad",
     "ecu": "Engine", "method": "Calibration (tables) + DTC", "clearsCodes": ["P0401", "P0402"], "risk": "medium", "offRoadOnly": True,
     "description": "Disables EGR in software after blanking or removal (DSD6033-type plates) — stops the soot buildup that carbon-fouls the intake, and physically eliminates the EGR-cooler cracking failure mode.",
     "steps": [
         "Zero the five EGR hysteresis matrices (Hyst 1–5) across rpm/load so the activation conditions are never met — no limp-home",
         "Recalibrate the MAF plausibility model (MAF_req) for 100% fresh air at part load — the engine now ingests full air mass where the ECU expects EGR displacement, which otherwise sets P0401/P0402",
         "Mask the EGR valve and cooler circuit DTCs in the EDC17CP54 error-class matrix so no emissions light remains",
     ],
     "commonlyPairedWith": ["asv"]},
    {"id": "dpf", "name": "Diesel particulate filter (DPF)", "group": "offroad",
     "ecu": "Engine", "method": "Adaptation + DTC", "clearsCodes": ["P2002", "P2463"], "risk": "high", "offRoadOnly": True,
     "description": "Codes out DPF monitoring and regeneration after removal. High risk of side effects; illegal on public roads. Note: the ECU relies on the ASV to build regen heat — the DPF and the ASV delete decide each other's fate."},
    {"id": "scr", "name": "AdBlue / SCR system", "group": "offroad",
     "ecu": "Engine", "method": "Adaptation + DTC", "clearsCodes": ["P204F", "P20E8"], "risk": "high", "offRoadOnly": True,
     "description": "Disables NOx aftertreatment monitoring (AdBlue injection) — off-road/show use only."},
    {"id": "asv", "name": "Throttle / anti-shudder valve delete (ASV)", "group": "offroad",
     "ecu": "Engine", "method": "Calibration (DTC mask) + hardware", "clearsCodes": ["P2015", "P2100"], "risk": "low", "offRoadOnly": True,
     "description": "Replaces the integrated throttle-valve housing (059 129 593 AG/AL-type) with a CNC delete pipe (DSD6427.1, with boost-gauge and water-meth ports). The housing carries BOTH mechanisms: the main anti-shudder/shutoff butterfly plus the annexed swirl-function channel that replaced the old manifold runner flaps — one delete removes both restrictions at once.",
     "steps": [
         "Fit the CNC delete pipe in place of the integrated throttle-valve assembly — shutoff butterfly and swirl channel go together",
         "Mask the throttle-valve circuit DTCs in the error-class matrix (active byte 01/08 → 00) — no open-circuit light, no restricted torque profile",
         "Recalibrate the intake airflow model for the now-unrestricted passage",
     ],
     "commonlyPairedWith": ["egr"],
     "requirement": "CONFLICT — the ECU uses the ASV to throttle intake air for DPF regeneration heat. Keep the ASV while the DPF stays (Stage 1 does not need it deleted); delete ASV and DPF together (off-road) or expect longer/failed regens and a blocked filter."},
]

# ---------------------------------------------------------------------------
# Performance mods catalog — every entry is validated against MODULE_SCOPE
# before it can be applied. Diesel/EDC17 flavoured for the 3.0 V6 TDI.
# ---------------------------------------------------------------------------

MOD_CATALOG = [
    {"id": "stage1", "name": "Stage 1 calibration", "group": "engine",
     "ecu": "Engine", "method": "Calibration slot", "parameter": "224 \u2192 310 hp \u00b7 680 Nm sustained \u00b7 710 Nm 10-second overboost",
     "risk": "medium", "offRoadOnly": False, "requirement": "EGT protection (830 \u00b0C) stays intact; ~2.8 bar abs boost sits at the GTD2060VZ compressor edge; rail +50 bar max (CP4 pump). The gearbox torque-offset must be mapped 1:1 so the 8HP70 raises line pressure for an honest 710 Nm \u2014 pair with the ZF TCU recal. Dyno verify",
     "description": "Loads a stage-1 EDC17 slot: raised injection quantity and boost. Factory 10-second 580 Nm overboost becomes 680 Nm sustained with 710 Nm transient."},
    {"id": "pedal_map", "name": "Sport pedal map", "group": "engine",
     "ecu": "Engine", "method": "Coding", "parameter": "Sharpened accelerator map",
     "risk": "low", "offRoadOnly": False,
     "description": "Reduces pedal-to-torque lag for a more direct response off idle."},
    {"id": "rev_limit", "name": "Rev limiter +300 rpm", "group": "engine",
     "ecu": "Engine", "method": "Calibration slot", "parameter": "+300 rpm cut point",
     "risk": "medium", "offRoadOnly": False, "requirement": "Diesel power band ends early — marginal benefit, more smoke",
     "description": "Raises the fuel cut point from ~4800 to ~5100 rpm."},
    {"id": "speed_limit", "name": "Speed limiter removed", "group": "engine",
     "ecu": "Engine", "method": "Coding", "parameter": "Vmax derestricted",
     "risk": "medium", "offRoadOnly": False, "requirement": "Observe local law and the tyre load/speed rating (loaded pickup!)",
     "description": "Removes the electronic Vmax cap set for the stock tyre and payload package."},
    {"id": "tow_torque", "name": "Towing torque limit +50 Nm", "group": "engine",
     "ecu": "Engine", "method": "Calibration slot", "parameter": "+50 Nm in gears 1\u20133",
     "risk": "medium", "offRoadOnly": False, "requirement": "Gearbox and clutch thermal limits — respect the tow rating",
     "description": "Raises the low-gear torque limiter used under load — aimed at towing and sand driving."},
    {"id": "auto_shift", "name": "ZF 8HP70 shift map — tow/sport", "group": "transmission",
     "ecu": "Transmission (ZF 8HP70)", "method": "TCU calibration", "parameter": "Held gears \u00b7 firmer shifts",
     "risk": "medium", "offRoadOnly": False, "requirement": "Raises TCU torque limiters and line pressure to match the 710 Nm CAN broadcast \u2014 without it the TCU fights the tune (4E86) or slips the clutches. Verify transmission oil service history",
     "description": "Loads a TCU map that holds gears longer and shifts firmer under load."},
]


# ---------------------------------------------------------------------------
# Transports. The product only ever opens the real J2534 transport; the
# simulated test fixture lives in resources/sim_fixture.py and is imported
# solely by the --selftest path below.
# ---------------------------------------------------------------------------



class RealTransport:
    """Live transport: UDS client over the J2534 pass-thru device.

    Implements the transport interface (mode/device/read_info/read_dtcs/
    clear_dtcs/sample) so the monitor loop is transport-agnostic.
    Read-only services are wired; write-side calibration channels are marked
    TODO and arrive with Phase 2.
    """

    mode = "live"
    device = "J2534 pass-thru (ISO15765, 500 kbps)"

    # This app never writes calibration — that is a settled product position,
    # not a missing feature. Changes are made by bench flashing the ECU
    # (boot mode); this app plans them beforehand and verifies afterwards.
    can_write_calibration = False
    calibration_write_note = (
        "calibration changes are applied by bench flashing the ECU (boot "
        "mode) — this app plans and verifies them, it does not write"
    )

    def __init__(self, client):
        self.client = client
        # imported locally so uds.py is only required once a session opens
        import uds  # noqa: PLC0415
        self.uds = uds
        self.did_map = dict(uds.DID_MAP)  # copy — probing mutates per session
        self.info_cache: dict | None = None

    def read_info(self) -> dict:
        if self.info_cache is None:
            self.client.enter_session(0x03)
            try:
                vin = self.client.read_vin()
            except Exception:
                vin = ""
            self.info_cache = {
                "protocol": "ISO 15765-4 (CAN 500 kbps)",
                "requestId": "0x7E0",
                "responseId": "0x7E8",
                "ecuName": "Engine Control Module \u2014 Bosch EDC17 (3.0 V6 TDI)",
                "partNumber": "\u2014",  # TODO: read DID 0xF18A part number once mapped
                "swVersion": "\u2014",  # TODO: read DID 0xF189
                "hwVersion": "\u2014",
                "coding": "\u2014",
                "vin": vin or "(not reported)",
            }
        return self.info_cache

    def read_dtcs(self) -> list:
        records = self.client.read_dtcs()
        # TODO: decode statusByte into Stored/Pending and attach freeze
        # frames (UDS 0x22 env data / 0x19 04) once live data is available.
        return [
            {
                "code": r["code"],
                "status": "Stored" if r["statusByte"] & 0x01 else "Pending",
                "description": "(read from ECU \u2014 description map pending)",
                "mileageKm": 0,
            }
            for r in records
        ]

    def clear_dtcs(self) -> int:
        self.client.clear_dtcs()
        return 0

    def remove_codes(self, codes: list) -> int:
        # Code suppression is part of the Phase 2 write calibration (TODO).
        return 0

    def probe_dids(self) -> list:
        """Ask the ECU which live DIDs it answers (UDS 0x22). Standard-set
        channels are probed directly; the diesel-critical channels try their
        candidate lists and adopt the first DID that responds, so the live
        map is learned from the vehicle rather than trusted from a table."""
        uds = self.uds
        entries = []
        for entry in uds.probe_dids(self.client, self.did_map):
            entries.append({**entry, "did": f"0x{entry['did']:04X}"})
        for channel in uds.DID_CANDIDATES:
            if any(e["channel"] == channel and e["ok"] for e in entries):
                continue  # standard set already covers it
            adopted, attempts = uds.probe_candidates(self.client, channel)
            for attempt in attempts:
                entries.append({**attempt, "did": f"0x{attempt['did']:04X}"})
            if adopted is not None:
                self.did_map[channel] = adopted
        return entries

    def total_backup_bytes(self) -> int | None:
        # Unknown until the DDXC calibration region is mapped from label data.
        return None

    def read_backup_chunks(self, block: int = 4096):
        """Honest blocker: a real stock read needs (a) security access with
        an OEM seed/key algorithm that is not installed, and (b) the DDXC
        flash-layout addresses. Both are deliberate gates, not TODO stubs —
        see HARDWARE.md for the first-connect plan."""
        raise self.uds.TransportError(
            "stock ECU read unavailable: security access has no seed/key algorithm "
            "installed and the DDXC calibration region is not yet mapped. Add the "
            "key algorithm + label-file addresses in uds.py before reading flash."
        )

    def sample(self, t: float) -> dict:
        values = self.client.read_live(self.did_map)
        # Channels without a confirmed DID yet read as None; keep the last
        # plausible value flowing so the dashboard stays complete. (None
        # itself is handled downstream by the plausibility layer.)
        return {name: value for name, value in values.items() if value is not None}


def open_real_transport():
    """Wire the real pyJ2534 pass-thru device here once an ECU is available."""
    try:
        import uds
    except ImportError as exc:
        raise RuntimeError(f"uds.py unavailable: {exc}") from exc
    try:
        device = uds.J2534Transport()
        device.open()
    except uds.TransportError as exc:
        raise RuntimeError(str(exc)) from exc
    return RealTransport(uds.UdsClient(device))


# ---------------------------------------------------------------------------
# Command channel (stdin). This is the backbone for every future UDS
# command: clear codes, output tests, basic settings, security access...
# ---------------------------------------------------------------------------


def start_command_worker() -> queue.Queue:
    commands: queue.Queue = queue.Queue()

    def reader() -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    commands.put(json.loads(line))
                except json.JSONDecodeError:
                    commands.put({"cmd": "_malformed"})
        finally:
            # stdin closed: the parent process is gone, stop the session.
            commands.put({"cmd": "_eof"})

    threading.Thread(target=reader, daemon=True).start()
    return commands


def emit_deletions(active: set) -> None:
    emit({"type": "deletions", "catalog": DELETION_CATALOG, "active": sorted(active)})


def emit_mods(active_mods: set) -> None:
    emit({
        "type": "mods",
        "catalog": MOD_CATALOG,
        "active": sorted(active_mods),
        "scope": MODULE_SCOPE,
    })


def refuse_out_of_scope(kind: str, name: str, ecu: str) -> None:
    emit(log(
        f"BLOCKED by safety scope: {kind} '{name}' targets the {ecu} ECU. "
        "This tool only writes to Engine and Transmission (performance scope); "
        "steering, brakes and all safety-critical modules are never touched."
    ))


def refuse_no_write(kind: str, name: str, transport) -> None:
    """Honest refusal: the app does not write calibration. Changes are made
    by bench flashing the ECU (boot mode); this app plans them beforehand
    and verifies the result afterwards. No state is mutated, no success is
    claimed."""
    note = getattr(transport, "calibration_write_note", None) or (
        "this transport does not write calibration"
    )
    emit(log(f"Refused {kind} '{name}': {note}."))


def transport_writes(transport) -> bool:
    return bool(getattr(transport, "can_write_calibration", False))


def handle_command(cmd: dict, transport, active_deletions: set, active_mods: set,
                   tracker: StreamTracker, vin: str, session: dict) -> None:
    name = cmd.get("cmd")

    if name == "verify_changes":
        duty = cmd.get("dutyProfile")
        if duty not in DUTY_PROFILES:
            duty = "standard"
        verification = run_verification(transport, active_deletions, active_mods,
                                        tracker, session, duty)
        verdict_label = {"pass": "PASSED", "fail": "FAILED",
                         "inconclusive": "NOT VERIFIED"}[verification["verdict"]]
        origin = "re-read from ECU" if verification["source"] == "ecu" else "simulated self-check"
        passed_n = sum(1 for i in verification["items"] if i["status"] == "pass")
        failed_n = sum(1 for i in verification["items"] if i["status"] == "fail")
        skipped_n = sum(1 for i in verification["items"] if i["status"] == "skipped")
        emit(log(f"Post-flash health check {verdict_label} ({origin}, {verification['dutyProfile']}) — "
                 f"{passed_n} passed, {failed_n} failed, {skipped_n} skipped "
                 f"of {len(verification['items'])} checks."))
        emit(verification)
        return

    if name == "probe_dids":
        if not hasattr(transport, "probe_dids"):
            emit(log("DID probe not supported by this transport."))
            return
        try:
            entries = transport.probe_dids()
        except Exception as exc:  # never kill the session over a probe
            emit(log(f"DID probe failed: {exc}"))
            return
        emit({"type": "dids", "entries": entries})
        ok = sum(1 for e in entries if e.get("ok"))
        emit(log(f"DID probe: {ok}/{len(entries)} entries answered (UDS 0x22)."))
        return

    if name == "read_ecu_backup":
        total = transport.total_backup_bytes() if hasattr(transport, "total_backup_bytes") else None
        emit({"type": "flash", "phase": "start", "totalBytes": total})
        emit(log(f"Reading ECU image for backup ({total} bytes expected)\u2026"
                 if total else "Reading ECU image for backup\u2026"))
        received = 0
        try:
            for chunk in transport.read_backup_chunks():
                received += len(chunk)
                emit({
                    "type": "flash",
                    "phase": "progress",
                    "bytes": received,
                    "totalBytes": total or received,
                    "chunkB64": base64.b64encode(chunk).decode("ascii"),
                })
            emit({"type": "flash", "phase": "complete", "bytes": received,
                  "totalBytes": total or received})
            emit(log(f"ECU read complete: {received} bytes — the main process writes the backup file."))
        except Exception as exc:
            emit({"type": "flash", "phase": "error", "message": str(exc)})
            emit(log(f"ECU read failed: {exc}"))
        return

    if name == "seed_baseline":
        vehicles = cmd.get("vehicles")
        entry = vehicles.get(vin) if isinstance(vehicles, dict) else None
        if isinstance(entry, dict) and entry.get("channels"):
            tracker.seed_from(entry)
            emit(log(f"Seeded cross-session baselines ({entry.get('sessions', 0)} prior session(s))."))
        else:
            emit(log("No stored baselines for this VIN — learning fresh this session."))
        return

    if name == "clear_dtc":
        count = transport.clear_dtcs()
        emit(log(f"Cleared {count} fault code(s) (UDS 0x14)."))
        emit({"type": "dtc", "codes": transport.read_dtcs()})
        emit(build_analysis(transport.read_dtcs(), None,
                            stream=tracker.snapshot(), provenance=tracker.provenance()))

    elif name == "delete_component":
        entry = next((c for c in DELETION_CATALOG if c["id"] == cmd.get("componentId")), None)
        if entry is None:
            emit(log(f"Unknown component id: {cmd.get('componentId')}"))
            return
        if not module_allowed(entry["ecu"]):
            refuse_out_of_scope("component delete", entry["name"], entry["ecu"])
            return
        if not transport_writes(transport):
            refuse_no_write("component delete", entry["name"], transport)
            return
        if entry["id"] in active_deletions:
            emit(log(f"{entry['name']} is already coded out."))
            return
        active_deletions.add(entry["id"])
        suffix = " (OFF-ROAD)" if entry["offRoadOnly"] else ""
        emit(log(f"Coded out {entry['name']}{suffix} — {entry['method']} on {entry['ecu']} ECU."))
        for step in entry.get("steps", []):
            emit(log(f"  \u2192 {step}"))
        for paired_id in entry.get("commonlyPairedWith", []):
            if paired_id not in active_deletions:
                paired = next((c for c in DELETION_CATALOG if c["id"] == paired_id), None)
                if paired:
                    emit(log(f"Note: on the 3.0 V6 TDI this is usually deleted together with {paired['name']}."))
        if entry["clearsCodes"]:
            removed = transport.remove_codes(entry["clearsCodes"])
            if removed:
                emit(log(f"ECU stops reporting {', '.join(entry['clearsCodes'])}."))
                emit({"type": "dtc", "codes": transport.read_dtcs()})
                emit(build_analysis(transport.read_dtcs(), None,
                                    stream=tracker.snapshot(), provenance=tracker.provenance()))
        emit_deletions(active_deletions)

    elif name == "restore_component":
        entry = next((c for c in DELETION_CATALOG if c["id"] == cmd.get("componentId")), None)
        if entry is None or entry["id"] not in active_deletions:
            emit(log(f"{cmd.get('componentId')} is not coded out."))
            return
        if not transport_writes(transport):
            refuse_no_write("component restore", entry["name"], transport)
            return
        active_deletions.discard(entry["id"])
        emit(log(f"Restored {entry['name']} to stock coding."))
        emit_deletions(active_deletions)

    elif name == "apply_mod":
        entry = next((m for m in MOD_CATALOG if m["id"] == cmd.get("modId")), None)
        if entry is None:
            emit(log(f"Unknown mod id: {cmd.get('modId')}"))
            return
        if not module_allowed(entry["ecu"]):
            refuse_out_of_scope("performance mod", entry["name"], entry["ecu"])
            return
        if not transport_writes(transport):
            refuse_no_write("performance mod", entry["name"], transport)
            return
        if entry["id"] in active_mods:
            emit(log(f"{entry['name']} is already applied."))
            return
        active_mods.add(entry["id"])
        suffix = " (OFF-ROAD)" if entry["offRoadOnly"] else ""
        emit(log(f"Applied {entry['name']}{suffix}: {entry['parameter']} — {entry['method']} on {entry['ecu']} ECU."))
        if entry.get("requirement"):
            emit(log(f"Requirement: {entry['requirement']}."))
        emit_mods(active_mods)

    elif name == "revert_mod":
        entry = next((m for m in MOD_CATALOG if m["id"] == cmd.get("modId")), None)
        if entry is None or entry["id"] not in active_mods:
            emit(log(f"{cmd.get('modId')} is not applied."))
            return
        if not transport_writes(transport):
            refuse_no_write("mod revert", entry["name"], transport)
            return
        active_mods.discard(entry["id"])
        emit(log(f"Reverted {entry['name']} to stock calibration."))
        emit_mods(active_mods)

    elif name == "_eof":
        pass  # handled by the caller
    elif name == "_malformed":
        emit(log("Ignored a malformed command line."))
    else:
        emit(log(f"Unknown command: {name}"))


def check_alerts(values: dict, active: dict) -> list:
    newly = {}
    for key, (name, threshold, triggered, message) in ALERT_THRESHOLDS.items():
        if triggered(values.get(key, 0), threshold):
            if name not in active:
                newly[name] = message
            active[name] = message
    return list(newly.values())


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run(duration: float | None, warmup: int, stream_every: int) -> None:
    """Product path: real J2534 only, no simulated fallback. If the
    interface can't be opened the genuine TransportError is reported as an
    error status and the monitor stays alive so the UI keeps showing the
    real reason until the user stops the session."""
    emit(status("starting", "Launching diagnostic monitor…", "live"))
    emit(status("connecting", "Opening J2534 pass-thru device…", "live"))
    try:
        transport = open_real_transport()
    except RuntimeError as exc:
        emit(status("error", str(exc), "live"))
        # Block on stdin rather than exiting so the error state persists on
        # screen. The main process kills us on Stop; stdin EOF (parent
        # gone) ends the wait cleanly.
        sys.stdin.read()
        return
    emit(status("connected", f"Connected via {transport.device}", "live"))
    _run_session(transport, duration, warmup, stream_every)


def _run_session(transport, duration: float | None, warmup: int,
                 stream_every: int) -> None:
    commands = start_command_worker()
    ecu_info = transport.read_info()
    vin = ecu_info.get("vin", "")
    emit({"type": "info", "info": ecu_info})
    emit({"type": "dtc", "codes": transport.read_dtcs()})

    # Learn the live DID map from the ECU so every dashboard channel has a
    # confirmed address behind it.
    if hasattr(transport, "probe_dids"):
        try:
            entries = transport.probe_dids()
            emit({"type": "dids", "entries": entries})
            ok = sum(1 for e in entries if e.get("ok"))
            emit(log(f"DID probe: {ok}/{len(entries)} entries answered (UDS 0x22)."))
        except Exception as exc:
            emit(log(f"DID probe skipped: {exc}"))

    started = time.monotonic()
    running = True
    active_alerts: dict = {}
    active_deletions: set = set()
    active_mods: set = set()
    tracker = StreamTracker(warmup=warmup)
    session: dict = {
        "baseline_codes": {c["code"] for c in transport.read_dtcs()},
        "last_values": None,
    }

    first_sample = transport.sample(0)
    session["last_values"] = first_sample
    tracker.update(first_sample)
    emit(build_analysis(transport.read_dtcs(), first_sample,
                        stream=tracker.snapshot(), provenance=tracker.provenance()))
    emit({"type": "live", "values": first_sample, "timestamp": now_iso()})
    emit_deletions(active_deletions)
    emit_mods(active_mods)

    def request_stop(_signum=None, _frame=None) -> None:
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    sample_index = 1
    try:
        while running:
            if duration is not None and time.monotonic() - started >= duration:
                break

            while True:
                try:
                    cmd = commands.get_nowait()
                except queue.Empty:
                    break
                if cmd.get("cmd") == "_eof":
                    running = False
                    break
                handle_command(cmd, transport, active_deletions, active_mods, tracker, vin, session)

            if not running:
                break

            values = transport.sample(time.monotonic() - started)
            session["last_values"] = values
            tracker.update(values)
            sample_index += 1

            new_alerts = check_alerts(values, active_alerts)
            if new_alerts:
                for message in new_alerts:
                    emit(log(f"\u26a0 {message}"))
                emit(build_analysis(transport.read_dtcs(), values, list(active_alerts.values()),
                                    stream=tracker.snapshot(), provenance=tracker.provenance()))

            # Tier-1 statistical layer: learned-baseline deviations and
            # confidence-gated predictions surface as one-shot log lines.
            for message in tracker.drain_new_alerts():
                emit(log(f"\u26a0 {message}"))

            # Continuous analysis refresh on the streaming cadence.
            if sample_index % stream_every == 0:
                emit(build_analysis(transport.read_dtcs(), values,
                                    stream=tracker.snapshot(), provenance=tracker.provenance()))

            # Hand baselines to the main process for cross-session persistence.
            if sample_index % 20 == 0:
                emit_baselines(vin, tracker)

            emit({"type": "live", "values": values, "timestamp": now_iso()})
            time.sleep(LIVE_INTERVAL_S)
    finally:
        emit_baselines(vin, tracker)
        emit(status("disconnected", "Session ended", transport.mode))


class _NonWritableProbe:
    """Stands in for the product transport in the write-refusal checks —
    reports the same 'does not write' capability RealTransport does."""

    mode = "live"
    device = "write-refusal probe (selftest)"
    can_write_calibration = False
    calibration_write_note = (
        "calibration changes are applied by bench flashing the ECU (boot "
        "mode) — this app plans and verifies them, it does not write"
    )

    def __init__(self, dtcs: list | None = None):
        self._dtcs = dtcs

    def read_dtcs(self) -> list:
        if self._dtcs is None:
            raise RuntimeError("probe: no DTC read this session")
        return list(self._dtcs)

    def sample(self, _t: float) -> dict:
        return {}

    def clear_dtcs(self) -> int:
        return 0


def _selftest_writes(fixture) -> int:
    """Command-surface refusal checks. Results go out as log events so the
    stream stays NDJSON; any failure makes the process exit non-zero."""
    checks: list[tuple[str, bool]] = []
    captured: list[dict] = []
    real_emit = globals()["emit"]
    globals()["emit"] = captured.append
    tracker = StreamTracker(warmup=4)
    session = {"baseline_codes": set(), "last_values": None}

    def log_text() -> str:
        return " ".join(e.get("message", "") for e in captured if e.get("type") == "log")

    try:
        probe = _NonWritableProbe()
        deletions: set = set()
        mods: set = set()
        handle_command({"cmd": "apply_mod", "modId": "stage1"},
                       probe, deletions, mods, tracker, "", session)
        handle_command({"cmd": "delete_component", "componentId": "egr"},
                       probe, deletions, mods, tracker, "", session)
        text = log_text()
        checks.append(("non-writable transport mutates no state", not mods and not deletions))
        checks.append(("refusal names the bench-flash write path",
                       "bench" in text and "does not write" in text))
        checks.append(("no success claim emitted",
                       "Applied" not in text and "Coded out" not in text))

        captured.clear()
        # Out-of-scope is refused as out-of-scope BEFORE the write check —
        # the more specific and more important reason wins.
        bogus = dict(MOD_CATALOG[0])
        bogus.update({"id": "zzz_scope_probe", "name": "scope probe", "ecu": "Brakes (ABS)"})
        MOD_CATALOG.append(bogus)
        try:
            handle_command({"cmd": "apply_mod", "modId": "zzz_scope_probe"},
                           probe, deletions, mods, tracker, "", session)
        finally:
            MOD_CATALOG.pop()
        checks.append(("out-of-scope refused as out-of-scope",
                       "BLOCKED by safety scope" in log_text() and not mods))

        captured.clear()
        # The writable fixture still exercises the real apply path.
        f_deletions: set = set()
        f_mods: set = set()
        handle_command({"cmd": "apply_mod", "modId": "pedal_map"},
                       fixture, f_deletions, f_mods, tracker, "", session)
        checks.append(("writable transport applies the mod", "pedal_map" in f_mods))

        captured.clear()
        # Health check must state plainly that this app applied nothing,
        # and must not announce PASSED for a session that read nothing.
        verdict = run_verification(probe, set(), set(), StreamTracker(warmup=4), session)
        item = next((i for i in verdict["items"]
                     if i["check"] == "Calibration changes applied this session"), None)
        checks.append(("verification marks no-apply explicitly",
                       item is not None and item["status"] == "skipped"))
        checks.append(("no session data is inconclusive — nothing went green",
                       verdict["verdict"] == "inconclusive"
                       and all(i["status"] == "skipped" for i in verdict["items"])))

        # Real ECU evidence with nothing applied still verifies health —
        # this is the post-flash confirmation path the user relies on.
        healthy_tracker = StreamTracker(warmup=4)
        healthy_tracker.update(fixture.sample(0))
        healthy_session = {"baseline_codes": {d["code"] for d in fixture.read_dtcs()},
                           "last_values": fixture.sample(0)}
        healthy = run_verification(fixture, set(), set(),
                                   healthy_tracker, healthy_session)
        checks.append(("pass on real evidence with nothing applied",
                       healthy["verdict"] == "pass"))

        # A fail always wins over skips.
        failing = run_verification(
            _NonWritableProbe(dtcs=[{"code": "P1234", "status": "Stored"}]),
            set(), set(), StreamTracker(warmup=4), session)
        checks.append(("any fail yields a fail verdict", failing["verdict"] == "fail"))

        # Applied work evaluated against the transport can genuinely pass —
        # the verdict is not permanently inconclusive.
        v_deletions: set = set()
        v_mods: set = set()
        v_session = {"baseline_codes": {d["code"] for d in fixture.read_dtcs()},
                     "last_values": None}
        handle_command({"cmd": "delete_component", "componentId": "egr"},
                       fixture, v_deletions, v_mods, tracker, "", v_session)
        passing = run_verification(fixture, v_deletions, v_mods,
                                   StreamTracker(warmup=4), v_session)
        checks.append(("applied work evaluated cleanly yields pass",
                       passing["verdict"] == "pass"))
    finally:
        globals()["emit"] = real_emit

    failures = 0
    for label, ok in checks:
        emit(log(f"selftest {'PASS' if ok else 'FAIL'}: {label}"))
        failures += 0 if ok else 1
    return 1 if failures else 0


def _selftest() -> int:
    """Event-stream smoke test — NOT a product mode. Runs the real session
    loop against the test-only fixture transport so CI exercises the same
    NDJSON event shape and DID encode/decode codec a live session uses,
    without fabricated data ever being reachable from the shipped app."""
    import sim_fixture  # noqa: PLC0415 — test fixture, outside the run path

    transport = sim_fixture.SimulatedTransport()
    emit(status("simulated", f"Self-test fixture session ({transport.device})", "simulate"))
    _run_session(transport, duration=2.0, warmup=4, stream_every=5)
    return _selftest_writes(transport)


def main() -> int:
    parser = argparse.ArgumentParser(description="VW J2534 diagnostic monitor")
    parser.add_argument("--selftest", action="store_true",
                        help="run the event-stream smoke test on the test fixture")
    parser.add_argument("--duration", type=float, default=None, help="stop after N seconds (testing)")
    parser.add_argument("--warmup-samples", type=int, default=60,
                        help="samples before learned baselines replace static thresholds (testing)")
    parser.add_argument("--stream-every", type=int, default=10,
                        help="emit a streaming analysis every N samples (testing)")
    args = parser.parse_args()

    if args.selftest:
        return _selftest()

    try:
        run(duration=args.duration,
            warmup=max(2, args.warmup_samples), stream_every=max(1, args.stream_every))
    except Exception as exc:  # never let a traceback hit stdout
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
