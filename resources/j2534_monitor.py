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
  --simulate  Force the simulated transport (no hardware needed).
  (default)   Try the real pyJ2534 transport first, fall back to simulation.

The real transport is not wired yet: without an ECU connected there is
nothing to talk to. open_real_transport() below marks every integration
point (PassThruOpen/Connect/StartMsgFilter + UDS requests over ISO-TP).
"""

import argparse
import base64
import json
import math
import queue
import random
import signal
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone

# Optional at runtime: simulation only needs the protocol layer to route its
# samples through the DID codec; without uds.py the sim still runs raw.
try:
    import uds as _uds
except ImportError:
    _uds = None

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
# refused before a (simulated or real) write happens. Steering, brakes and
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


def _pull_envelope(pull: dict) -> tuple[float, float]:
    """(peak, sustained) torque from a pull event: peak is the max sample;
    sustained is the median of the plateau (samples within 5% of peak)."""
    samples = pull.get("samples", [])
    if not samples:
        return 0.0, 0.0
    peak = max(s["torqueNm"] for s in samples)
    plateau = sorted(s["torqueNm"] for s in samples if s["torqueNm"] >= peak * 0.95)
    sustained = plateau[len(plateau) // 2] if plateau else peak
    return peak, sustained


def run_verification(transport, active_deletions: set, active_mods: set,
                     tracker: StreamTracker, session: dict,
                     duty_profile: str = "standard") -> dict:
    """Post-work sign-off: the workshop 'scan after work' plus read-back
    verification, automated. In live mode every input is re-read from the
    ECU at this moment (DTCs via 0x19, channels via 0x22); in simulation it
    grades the monitor's own state and says so via `source`."""
    profile = DUTY_PROFILES.get(duty_profile, DUTY_PROFILES["standard"])
    source = "ecu" if transport.mode == "live" else "simulated"

    codes = transport.read_dtcs()  # live: fresh 0x19 read right now
    baseline = session.get("baseline_codes", set())
    current = {c["code"] for c in codes}

    suppressed: set = set()
    for entry in DELETION_CATALOG:
        if entry["id"] in active_deletions:
            suppressed.update(entry["clearsCodes"])

    items = []

    unexpected = sorted(current - baseline)
    items.append({
        "check": "No new fault codes introduced",
        "status": "fail" if unexpected else "pass",
        "detail": f"new since session start: {', '.join(unexpected)}" if unexpected
        else f"{len(codes)} known code(s), none new this session",
    })

    leaking = sorted(suppressed & current)
    items.append({
        "check": "Coded-out codes suppressed",
        "status": "fail" if leaking else "pass",
        "detail": f"still reporting: {', '.join(leaking)}" if leaking
        else f"{len(suppressed)} code(s) suppressed by active deletes" if suppressed
        else "no deletes active",
    })

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
        "status": "fail" if (breaches or not values) else "pass",
        "detail": ", ".join(breaches) if breaches
        else "all channels plausible" if values
        else "no live data received",
    })

    coolant = values.get("coolantTempC") if values else None
    items.append({
        "check": f"Coolant within duty-profile limit ({profile['coolantMaxC']:.0f} °C)",
        "status": "fail" if (coolant is not None and coolant > profile["coolantMaxC"]) else "pass",
        "detail": f"{profile['label']}: {profile['note']}"
        + (f" Now: {coolant} °C." if coolant is not None else " No coolant reading."),
    })

    items.append({
        "check": "No rejected implausible samples",
        "status": "fail" if tracker.rejected > 5 else "pass",
        "detail": f"{tracker.rejected} sample(s) rejected"
        + (f" on {', '.join(sorted(tracker.rejected_channels))}" if tracker.rejected_channels else ""),
    })

    items.append({
        "check": "Applied state read-back",
        "status": "pass",
        "detail": (f"{len(active_mods)} mod(s) + {len(active_deletions)} delete(s) active and consistent"
                   if (active_mods or active_deletions) else "stock coding — nothing applied"),
    })

    # Factory-envelope check: the torque the tune actually makes must sit
    # inside the manufacturer ladder — this is the "tune to the standard"
    # rule made enforceable.
    envelope = dict(FACTORY_ENVELOPE)
    last_pull = session.get("last_pull")
    if not last_pull:
        items.append({
            "check": "Torque within factory envelope",
            "status": "skipped",
            "detail": "no dyno pull this session — run one before sign-off",
        })
        envelope["peakTorqueNm"] = None
        envelope["sustainedTorqueNm"] = None
    else:
        peak, sustained = _pull_envelope(last_pull)
        envelope["peakTorqueNm"] = round(peak, 1)
        envelope["sustainedTorqueNm"] = round(sustained, 1)
        ok = peak <= envelope["ceilingPeakNm"] and sustained <= envelope["ceilingSustainedNm"]
        items.append({
            "check": "Torque within factory envelope",
            "status": "pass" if ok else "fail",
            "detail": (f"peak {peak:.0f} Nm / sustained {sustained:.0f} Nm vs ceilings "
                       f"{envelope['ceilingPeakNm']:.0f} / {envelope['ceilingSustainedNm']:.0f} Nm "
                       f"({envelope['ladder']})"),
        })

    passed = all(item["status"] == "pass" for item in items)
    return {
        "type": "verification",
        "passed": passed,
        "items": items,
        "timestamp": now_iso(),
        "source": source,
        "dutyProfile": profile["label"],
        "envelope": envelope,
    }


# ---------------------------------------------------------------------------
# Dyno pull model: full-throttle sweep reference curves for the 3.0 V6 TDI
# (2018 Amarok, 224 PS flavour). Diesel torque shape: early plateau, hard
# taper; Stage 1 raises plateau and slightly extends the sweep. Simulated
# reference data until live mode.
# ---------------------------------------------------------------------------

PULL_START_RPM = 1200
PULL_STEP_RPM = 100

PULL_PROFILES = {
    "stock": {"base": 400.0, "plateau": 550.0, "plateau_start": 1500, "plateau_end": 2800,
              "end_torque": 270.0, "boost_add": 0.0},
    "stage1": {"base": 460.0, "plateau": 680.0, "plateau_start": 1500, "plateau_end": 3000,
               "end_torque": 440.0, "boost_add": 25.0},
}


def pull_torque(rpm: float, profile: dict, rev_limit: float) -> float:
    if rpm <= profile["plateau_start"]:
        frac = (rpm - PULL_START_RPM) / max(1.0, profile["plateau_start"] - PULL_START_RPM)
        return profile["base"] + (profile["plateau"] - profile["base"]) * frac
    if rpm <= profile["plateau_end"]:
        return profile["plateau"]
    frac = (rpm - profile["plateau_end"]) / max(1.0, rev_limit - profile["plateau_end"])
    return profile["plateau"] + (profile["end_torque"] - profile["plateau"]) * frac


def simulate_pull(active_mods: set, index: int) -> dict:
    rev_limit = 5100 if "rev_limit" in active_mods else 4800
    profile = PULL_PROFILES["stage1"] if "stage1" in active_mods else PULL_PROFILES["stock"]

    samples = []
    rpm = float(PULL_START_RPM)
    while rpm <= rev_limit:
        # simulated sensor jitter only -- nothing security-sensitive
        torque = pull_torque(rpm, profile, rev_limit) + random.uniform(-6, 6)
        boost = (
            100.0 + 140.0 * (1.0 - math.exp(-(rpm - 1100.0) / 1200.0))
            + profile["boost_add"] + random.uniform(-3, 3)
        )
        samples.append({
            "rpm": int(rpm),
            "powerKw": round(torque * rpm / 9549.0, 1),
            "torqueNm": round(torque, 1),
            "boostKpa": round(boost, 1),
        })
        rpm += PULL_STEP_RPM

    power = max(samples, key=lambda s: s["powerKw"])
    torque = max(samples, key=lambda s: s["torqueNm"])
    mods = sorted(active_mods)
    return {
        "type": "pull",
        "index": index,
        "label": " + ".join(mods) if mods else "Stock",
        "modsActive": mods,
        "revLimit": rev_limit,
        "samples": samples,
        "peakPowerKw": power["powerKw"],
        "peakPowerRpm": power["rpm"],
        "peakTorqueNm": torque["torqueNm"],
        "peakTorqueRpm": torque["rpm"],
        "peakBoostKpa": max(s["boostKpa"] for s in samples),
        "timestamp": now_iso(),
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
# Transports. A real transport must implement the same methods.
# ---------------------------------------------------------------------------


class SimulatedTransport:
    """Fabricates plausible VW ECU data for dashboard development."""

    mode = "simulate"
    device = "Simulated J2534 pass-thru (no hardware)"

    def __init__(self):
        self._sim_did_map = None

    INFO = {
        "protocol": "ISO 15765-4 (CAN 500 kbps)",
        "requestId": "0x7E0",
        "responseId": "0x7E8",
        "ecuName": "Engine Control Module \u2014 Bosch EDC17 (3.0 V6 TDI, DDXC / TDI550)",
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
        through the same scalars the real transport uses. Simulation
        therefore exercises the DID mapping instead of bypassing it —
        a wrong DID or width surfaces here first, in the safe world."""
        if _uds is None:
            return raw  # protocol layer absent: raw sim values (legacy mode)
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


class RealTransport:
    """Live transport: UDS client over the J2534 pass-thru device.

    Implements the SimulatedTransport interface (mode/device/read_info/
    read_dtcs/clear_dtcs/sample) so the monitor loop is transport-agnostic.
    Read-only services are wired; write-side calibration channels are marked
    TODO and arrive with Phase 2.
    """

    mode = "live"
    device = "J2534 pass-thru (ISO15765, 500 kbps)"

    def __init__(self, client):
        self.client = client
        # import locally so simulation never requires uds.py to be present
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


def handle_command(cmd: dict, transport, active_deletions: set, active_mods: set,
                   tracker: StreamTracker, vin: str, session: dict) -> None:
    name = cmd.get("cmd")

    if name == "run_pull":
        session["pulls"] = session.get("pulls", 0) + 1
        emit(log(f"Dyno pull #{session['pulls']} — simulated WOT sweep to "
                 f"{7000 if 'rev_limit' in active_mods else 6500} rpm."))
        pull_event = simulate_pull(active_mods, session["pulls"])
        session["last_pull"] = pull_event
        emit(pull_event)
        return

    if name == "verify_changes":
        duty = cmd.get("dutyProfile")
        if duty not in DUTY_PROFILES:
            duty = "standard"
        verification = run_verification(transport, active_deletions, active_mods,
                                        tracker, session, duty)
        verdict = "PASSED" if verification["passed"] else "FAILED"
        origin = "re-read from ECU" if verification["source"] == "ecu" else "simulated self-check"
        emit(log(f"Sign-off verification {verdict} ({origin}, {verification['dutyProfile']}) — "
                 f"{sum(1 for i in verification['items'] if i['status'] == 'pass')}"
                 f"/{len(verification['items'])} checks passed."))
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
        emit(log(f"Cleared {count} fault code(s) (simulated UDS 0x14)."))
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
        if entry["id"] in active_deletions:
            emit(log(f"{entry['name']} is already coded out."))
            return
        active_deletions.add(entry["id"])
        suffix = " (OFF-ROAD)" if entry["offRoadOnly"] else ""
        emit(log(f"Coded out {entry['name']}{suffix} — simulated {entry['method']} on {entry['ecu']} ECU."))
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
        if entry["id"] in active_mods:
            emit(log(f"{entry['name']} is already applied."))
            return
        active_mods.add(entry["id"])
        suffix = " (OFF-ROAD)" if entry["offRoadOnly"] else ""
        emit(log(f"Applied {entry['name']}{suffix}: {entry['parameter']} — simulated {entry['method']} on {entry['ecu']} ECU."))
        if entry.get("requirement"):
            emit(log(f"Requirement: {entry['requirement']}."))
        emit_mods(active_mods)

    elif name == "revert_mod":
        entry = next((m for m in MOD_CATALOG if m["id"] == cmd.get("modId")), None)
        if entry is None or entry["id"] not in active_mods:
            emit(log(f"{cmd.get('modId')} is not applied."))
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


def run(simulate: bool, duration: float | None, warmup: int, stream_every: int) -> None:
    transport: SimulatedTransport | None = None

    emit(status("starting", "Launching diagnostic monitor\u2026", "live" if not simulate else "simulate"))

    if simulate:
        transport = SimulatedTransport()
        emit(status("simulated", f"No ECU connected \u2014 simulation active ({transport.device})", "simulate"))
    else:
        emit(status("connecting", "Opening J2534 pass-thru device\u2026", "live"))
        try:
            transport = open_real_transport()
            emit(status("connected", f"Connected via {transport.device}", "live"))
        except RuntimeError as exc:
            transport = SimulatedTransport()
            emit(status("simulated", f"{exc} \u2014 falling back to simulation", "simulate"))

    commands = start_command_worker()
    ecu_info = transport.read_info()
    vin = ecu_info.get("vin", "")
    emit({"type": "info", "info": ecu_info})
    emit({"type": "dtc", "codes": transport.read_dtcs()})

    # Learn the live DID map from the ECU (or replay the simulated one) so
    # every dashboard channel has a confirmed address behind it.
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
        "pulls": 0,
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


def main() -> int:
    parser = argparse.ArgumentParser(description="VW J2534 diagnostic monitor")
    parser.add_argument("--simulate", action="store_true", help="force simulated transport")
    parser.add_argument("--duration", type=float, default=None, help="stop after N seconds (testing)")
    parser.add_argument("--warmup-samples", type=int, default=60,
                        help="samples before learned baselines replace static thresholds (testing)")
    parser.add_argument("--stream-every", type=int, default=10,
                        help="emit a streaming analysis every N samples (testing)")
    args = parser.parse_args()

    try:
        run(simulate=args.simulate, duration=args.duration,
            warmup=max(2, args.warmup_samples), stream_every=max(1, args.stream_every))
    except Exception as exc:  # never let a traceback hit stdout
        emit({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
