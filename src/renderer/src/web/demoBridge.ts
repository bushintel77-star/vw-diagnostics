/**
 * Browser demo bridge. The renderer normally talks to the Electron preload
 * (window.context); when the dashboard is served in a plain web browser that
 * bridge does not exist, so this module installs an equivalent implemented
 * entirely in the page: it replays the same NDJSON event stream the Python
 * monitor produces, from mirrored catalogs and live-value formulas.
 *
 * This is a *viewer* mirror — the Python monitor remains the source of truth
 * for the real app. No car, no Electron, no IPC.
 */
import {
  ComponentDeletion,
  DiagnosticCommand,
  DiagnosticCommandResult,
  DiagnosticEvent,
  DiagnosticEventListener,
  DiagnosticPullEvent,
  DiagnosticSessionResult,
  DiagnosticVerificationEvent,
  DidMapEntry,
  DutyProfile,
  LiveValues,
  PerformanceMod,
  PullSample,
  StartDiagnosticOptions,
  VerificationItem,
} from "@shared/types";

const TICK_MS = 500;

const INFO = {
  protocol: "ISO 15765-4 (CAN 500 kbps)",
  requestId: "0x7E0",
  responseId: "0x7E8",
  ecuName: "Engine Control Module — Bosch EDC17 (3.0 V6 TDI, DDXC / TDI550)",
  partNumber: "2H0906027",
  swVersion: "6177",
  hwVersion: "H14",
  coding: "0011721",
  vin: "WV1ZZZ2H0JW123456",
};

const KNOWLEDGE: Record<
  string,
  { severity: "high" | "medium" | "low"; title: string; detail: string; causes: string[]; actions: string[]; confidence: number }
> = {
  P0299: {
    severity: "medium",
    title: "Turbo underboost (VNT)",
    detail: "Measured boost fell short of target — on the 3.0 V6 TDI most often a sticking VNT mechanism or boost leak.",
    causes: ["Sticking VNT mechanism", "Boost pipe or intercooler leak", "VNT actuator fault"],
    actions: ["Smoke/pressure test the charge pipes", "Check VNT actuator movement"],
    confidence: 0.68,
  },
  P0671: {
    severity: "low",
    title: "Cylinder 1 glow plug circuit",
    detail: "Glow plug 1 electrical fault — hard cold starts, not damaging while driving.",
    causes: ["Worn glow plug", "Corroded connector", "Glow plug module fault"],
    actions: ["Measure glow plug 1 resistance", "Inspect the connector for corrosion"],
    confidence: 0.75,
  },
  P2002: {
    severity: "medium",
    title: "DPF efficiency below threshold",
    detail: "DPF no longer trapping soot efficiently — usually interrupted regenerations from short trips.",
    causes: ["Interrupted regenerations", "High ash loading", "Differential pressure sensor fault"],
    actions: ["Drive 20–30 min at ~100 km/h to complete a regen", "Read soot mass live values"],
    confidence: 0.66,
  },
  P2015: {
    severity: "low",
    title: "Intake runner (swirl flap) position implausible",
    detail: "Swirl flap position disagrees with command — commonly EGR soot in the intake.",
    causes: ["Soot buildup on swirl flaps", "Weak flap motor", "Faulty position sensor"],
    actions: ["Run the intake flap output test", "Inspect the intake for soot"],
    confidence: 0.58,
  },
};

interface SimDtc {
  code: string;
  status: "Stored" | "Pending";
  description: string;
  mileageKm: number;
  freezeFrame: { rpm: number; coolantTempC: number; engineLoadPct: number; speedKph: number };
}

const SIM_DTCS: SimDtc[] = [
  { code: "P0299", status: "Stored", description: "Turbocharger/supercharger underboost condition", mileageKm: 186410,
    freezeFrame: { rpm: 2210, coolantTempC: 88, engineLoadPct: 71, speedKph: 96 } },
  { code: "P0671", status: "Stored", description: "Cylinder 1 glow plug circuit malfunction", mileageKm: 186044,
    freezeFrame: { rpm: 795, coolantTempC: 6, engineLoadPct: 12, speedKph: 0 } },
  { code: "P2002", status: "Pending", description: "Diesel particulate filter efficiency below threshold (Bank 1)", mileageKm: 186905,
    freezeFrame: { rpm: 2080, coolantTempC: 84, engineLoadPct: 41, speedKph: 104 } },
  { code: "P2015", status: "Stored", description: "Intake manifold runner position sensor (Bank 1): implausible signal", mileageKm: 185772,
    freezeFrame: { rpm: 1490, coolantTempC: 84, engineLoadPct: 31, speedKph: 43 } },
];

const DELETIONS: ComponentDeletion[] = [
  { id: "start_stop_memory", name: "Start-Stop memory (stays off)", group: "engine", ecu: "Engine", method: "Coding",
    clearsCodes: [], risk: "low", offRoadOnly: false,
    description: "Remembers the last Start-Stop state across ignition cycles." },
  { id: "egr", name: "EGR system", group: "offroad", ecu: "Engine", method: "Calibration (tables) + DTC",
    clearsCodes: ["P0401", "P0402"], risk: "medium", offRoadOnly: true,
    description: "Disables EGR in software after blanking or removal (DSD6033-type plates) — stops the soot buildup that carbon-fouls the intake.",
    steps: [
      "Zero the five EGR hysteresis matrices (Hyst 1–5) across rpm/load so the activation conditions are never met — no limp-home",
      "Recalibrate the MAF plausibility model (MAF_req) for 100% fresh air at part load — otherwise sets P0401/P0402",
      "Mask the EGR valve and cooler circuit DTCs in the EDC17CP54 error-class matrix so no emissions light remains",
    ],
    commonlyPairedWith: ["asv"] },
  { id: "dpf", name: "Diesel particulate filter (DPF)", group: "offroad", ecu: "Engine", method: "Adaptation + DTC",
    clearsCodes: ["P2002", "P2463"], risk: "high", offRoadOnly: true,
    description: "Codes out DPF monitoring and regeneration after removal. High risk; illegal on public roads. The DPF and the ASV delete decide each other's fate." },
  { id: "scr", name: "AdBlue / SCR system", group: "offroad", ecu: "Engine", method: "Adaptation + DTC",
    clearsCodes: ["P204F", "P20E8"], risk: "high", offRoadOnly: true,
    description: "Disables NOx aftertreatment monitoring (AdBlue injection) — off-road/show use only." },
  { id: "asv", name: "Throttle / anti-shudder valve delete (ASV)", group: "offroad", ecu: "Engine", method: "Calibration (DTC mask) + hardware",
    clearsCodes: ["P2015", "P2100"], risk: "low", offRoadOnly: true,
    description: "Replaces the integrated throttle-valve housing (059 129 593 AG/AL-type) with a CNC delete pipe (DSD6427.1). The housing carries BOTH mechanisms: the main anti-shudder/shutoff butterfly plus the annexed swirl-function channel that replaced the old manifold runner flaps — one delete removes both restrictions at once.",
    steps: [
      "Fit the CNC delete pipe in place of the integrated throttle-valve assembly — shutoff butterfly and swirl channel go together",
      "Mask the throttle-valve circuit DTCs in the error-class matrix (active byte 01/08 → 00) — no open-circuit light, no restricted torque profile",
      "Recalibrate the intake airflow model for the now-unrestricted passage",
    ],
    commonlyPairedWith: ["egr"],
    requirement: "CONFLICT — the ECU uses the ASV to throttle intake air for DPF regeneration heat. Keep the ASV while the DPF stays (Stage 1 does not need it deleted); delete ASV and DPF together (off-road) or expect longer/failed regens and a blocked filter." },
];

const MODS: PerformanceMod[] = [
  { id: "stage1", name: "Stage 1 calibration", group: "engine", ecu: "Engine", method: "Calibration slot",
    parameter: "224 → 310 hp · 680 Nm sustained · 710 Nm 10-second overboost", risk: "medium", offRoadOnly: false,
    requirement: "EGT protection (830 °C) stays intact; ~2.8 bar abs boost sits at the GTD2060VZ compressor edge; rail +50 bar max (CP4). Gearbox torque-offset must be mapped 1:1 — pair with the ZF TCU recal. Dyno verify",
    description: "Loads a stage-1 EDC17 slot: raised injection quantity and boost. Factory 10-second 580 Nm overboost becomes 680 Nm sustained with 710 Nm transient." },
  { id: "pedal_map", name: "Sport pedal map", group: "engine", ecu: "Engine", method: "Coding",
    parameter: "Sharpened accelerator map", risk: "low", offRoadOnly: false,
    description: "Reduces pedal-to-torque lag for a more direct response off idle." },
  { id: "rev_limit", name: "Rev limiter +300 rpm", group: "engine", ecu: "Engine", method: "Calibration slot",
    parameter: "+300 rpm cut point", risk: "medium", offRoadOnly: false,
    requirement: "Diesel power band ends early — marginal benefit, more smoke",
    description: "Raises the fuel cut point from ~4800 to ~5100 rpm." },
  { id: "speed_limit", name: "Speed limiter removed", group: "engine", ecu: "Engine", method: "Coding",
    parameter: "Vmax derestricted", risk: "medium", offRoadOnly: false,
    requirement: "Observe local law and the tyre load/speed rating (loaded pickup!)",
    description: "Removes the electronic Vmax cap set for the stock tyre and payload package." },
  { id: "tow_torque", name: "Towing torque limit +50 Nm", group: "engine", ecu: "Engine", method: "Calibration slot",
    parameter: "+50 Nm in gears 1–3", risk: "medium", offRoadOnly: false,
    requirement: "Gearbox and clutch thermal limits — respect the tow rating",
    description: "Raises the low-gear torque limiter used under load — aimed at towing and sand driving." },
  { id: "auto_shift", name: "ZF 8HP70 shift map — tow/sport", group: "transmission", ecu: "Transmission (ZF 8HP70)", method: "TCU calibration",
    parameter: "Held gears · firmer shifts", risk: "medium", offRoadOnly: false,
    requirement: "Raises TCU torque limiters and line pressure to match the 710 Nm CAN broadcast — without it the TCU fights the tune (4E86) or slips the clutches. Verify transmission oil service history",
    description: "Loads a TCU map that holds gears longer and shifts firmer under load." },
];

const SCOPE = {
  allowed: [
    { name: "Engine", address: "0x7E0", reason: "performance calibration" },
    { name: "Transmission (ZF 8HP70)", address: "0x7E1", reason: "performance calibration" },
  ],
  blocked: [
    { name: "Steering (EPS)", reason: "steering — safety critical" },
    { name: "Brakes (ABS / ESP / EPB)", reason: "braking — safety critical" },
    { name: "Airbag / belt tensioners (SRS)", reason: "restraint system — safety critical" },
    { name: "Driver assistance (ACC / lane / camera)", reason: "ADAS — safety critical" },
    { name: "All other modules", reason: "outside the performance scope of this tool" },
  ],
};

const SIM_DID_ENTRIES: DidMapEntry[] = [
  { channel: "rpm", did: "0xF40C", ok: true, value: 790, note: "standard set" },
  { channel: "speedKph", did: "0xF40D", ok: true, value: 0, note: "standard set" },
  { channel: "coolantTempC", did: "0xF405", ok: true, value: 90, note: "standard set" },
  { channel: "intakeTempC", did: "0xF40F", ok: true, value: 32, note: "standard set" },
  { channel: "engineLoadPct", did: "0xF404", ok: true, value: 24, note: "standard set" },
  { channel: "batteryV", did: "0xF448", ok: true, value: 14.0, note: "standard set (unconfirmed on DDXC)" },
  { channel: "railPressureBar", did: "0xF484", ok: true, value: 300, note: "community EDC17 table (x0.1 bar)" },
  { channel: "boostPressureKpa", did: "0xF4A3", ok: true, value: 100, note: "charge pressure (x0.03 kPa, community table)" },
  { channel: "pedalPct", did: "0xF4A1", ok: true, value: 0, note: "accelerator position (x100/255 %)" },
];

const DUTY_LABELS: Record<DutyProfile, string> = {
  standard: "Standard (tow-capable)",
  no_tow: "No-tow / light duty",
};

const ENVELOPE = {
  ceilingSustainedNm: 700,
  ceilingPeakNm: 715,
  ladder: "550 stock · 580 VW transient · 620 single-turbo Audi · 700 ZF 8HP70 rating",
};

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
// simulated sensor jitter only -- nothing security-sensitive
const jitter = (spread: number): number => (Math.random() * 2 - 1) * spread;

/** Mirror of the monitor's dyno pull model (3.0 V6 TDI profile, mod-scaled). */
const PULL_PROFILES = {
  stock: { base: 400, plateau: 550, plateauStart: 1500, plateauEnd: 2800, endTorque: 270, boostAdd: 0 },
  stage1: { base: 460, plateau: 680, plateauStart: 1500, plateauEnd: 3000, endTorque: 440, boostAdd: 25 },
};

const pullTorque = (rpm: number, p: (typeof PULL_PROFILES)["stock"], revLimit: number): number => {
  if (rpm <= p.plateauStart) {
    return p.base + (p.plateau - p.base) * ((rpm - 1200) / Math.max(1, p.plateauStart - 1200));
  }
  if (rpm <= p.plateauEnd) return p.plateau;
  return p.plateau + (p.endTorque - p.plateau) * ((rpm - p.plateauEnd) / Math.max(1, revLimit - p.plateauEnd));
};

const simulatePull = (activeMods: Set<string>, index: number): DiagnosticPullEvent => {
  const revLimit = activeMods.has("rev_limit") ? 5100 : 4800;
  const profile = activeMods.has("stage1") ? PULL_PROFILES.stage1 : PULL_PROFILES.stock;
  const samples: PullSample[] = [];
  for (let rpm = 1200; rpm <= revLimit; rpm += 100) {
    const torque = pullTorque(rpm, profile, revLimit) + jitter(6);
    samples.push({
      rpm,
      powerKw: Number(((torque * rpm) / 9549).toFixed(1)),
      torqueNm: Number(torque.toFixed(1)),
      boostKpa: Number(
        (100 + 140 * (1 - Math.exp(-(rpm - 1100) / 1200)) + profile.boostAdd + jitter(3)).toFixed(1)
      ),
    });
  }
  const power = samples.reduce((a, b) => (b.powerKw > a.powerKw ? b : a));
  const torque = samples.reduce((a, b) => (b.torqueNm > a.torqueNm ? b : a));
  const mods = [...activeMods].sort();
  return {
    type: "pull",
    index,
    label: mods.length > 0 ? mods.join(" + ") : "Stock",
    modsActive: mods,
    revLimit,
    samples,
    peakPowerKw: power.powerKw,
    peakPowerRpm: power.rpm,
    peakTorqueNm: torque.torqueNm,
    peakTorqueRpm: torque.rpm,
    peakBoostKpa: Math.max(...samples.map((s) => s.boostKpa)),
    timestamp: new Date().toISOString(),
  };
};

const sample = (t: number): LiveValues => {
  const warmup = Math.min(t / 120, 1);
  return {
    rpm: Math.round(clamp(790 + 35 * Math.sin(t * 0.9) + jitter(15), 660, 900)),
    speedKph: 0,
    coolantTempC: Math.round(clamp(18 + 74 * warmup + jitter(0.4), 12, 95)),
    intakeTempC: Math.round(clamp(26 + 3 * Math.sin(t * 0.2) + jitter(0.3), 15, 45)),
    boostPressureKpa: Math.round(clamp(99 + 2.0 * Math.sin(t * 0.7) + jitter(1.0), 95, 104)),
    pedalPct: Number(clamp(1.5 * Math.sin(t * 1.3) + jitter(0.4), 0, 3).toFixed(1)),
    engineLoadPct: Math.round(clamp(21 + 6 * Math.sin(t * 0.5) + jitter(1.5), 12, 38)),
    batteryV: Number((14.0 + 0.2 * Math.sin(t * 0.11) + jitter(0.03)).toFixed(2)),
    railPressureBar: Math.round(clamp(290 + 25 * Math.sin(t * 0.8) + jitter(8), 250, 340)),
  };
};

class DemoBridge {
  private listeners = new Set<DiagnosticEventListener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private codes: SimDtc[] = SIM_DTCS.map((d) => ({ ...d }));
  private readonly baselineCodes = new Set(SIM_DTCS.map((d) => d.code));
  private deletions = new Set<string>();
  private mods = new Set<string>();
  private samples = 0;
  private pulls = 0;
  private lastPull: DiagnosticPullEvent | null = null;
  private ewma: Record<string, { baseline: number; var: number; init: boolean }> = {};

  onDiagnosticEvent = (listener: DiagnosticEventListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  startDiagnostic = async (
    _options: StartDiagnosticOptions
  ): Promise<DiagnosticSessionResult> => {
    if (this.timer) {
      return { started: false, message: "A diagnostic session is already running." };
    }
    this.emit({ type: "status", phase: "starting", message: "Launching browser demo monitor…", mode: "simulate" });
    this.emit({
      type: "status",
      phase: "simulated",
      message: "Browser demo — no ECU, events simulated in the page",
      mode: "simulate",
    });
    this.emit({ type: "info", info: INFO });
    this.emit({ type: "dids", entries: SIM_DID_ENTRIES });
    this.emit({ type: "dtc", codes: this.codes });
    this.emit(this.analysis());
    this.emit({ type: "deletions", catalog: DELETIONS, active: [...this.deletions] });
    this.emit({ type: "mods", catalog: MODS, active: [...this.mods], scope: SCOPE });

    const started = Date.now();
    this.timer = setInterval(() => {
      const t = (Date.now() - started) / 1000;
      const values = sample(t);
      this.track(values);
      this.samples += 1;
      this.emit({ type: "live", values, timestamp: new Date().toISOString() });
      if (this.samples % 10 === 0) {
        this.emit(this.analysis(values));
      }
    }, TICK_MS);
    return { started: true, message: "Browser demo session started." };
  };

  stopDiagnostic = async (): Promise<DiagnosticSessionResult> => {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.emit({ type: "status", phase: "disconnected", message: "Session ended", mode: "simulate" });
    }
    return { started: false, message: "Browser demo session stopped." };
  };

  sendDiagnosticCommand = async (
    command: DiagnosticCommand
  ): Promise<DiagnosticCommandResult> => {
    if (!this.timer) {
      return { ok: false, message: "No diagnostic session is running." };
    }
    if (command.cmd === "clear_dtc") {
      const count = this.codes.length;
      this.codes = [];
      this.log(`Cleared ${count} fault code(s) (demo UDS 0x14).`);
      this.emit({ type: "dtc", codes: this.codes });
      this.emit(this.analysis());
    } else if (command.cmd === "delete_component") {
      const entry = DELETIONS.find((d) => d.id === command.componentId);
      if (!entry) {
        this.log(`Unknown component id: ${command.componentId}`);
      } else if (!this.deletions.has(entry.id)) {
        this.deletions.add(entry.id);
        this.log(`Coded out ${entry.name}${entry.offRoadOnly ? " (OFF-ROAD)" : ""} — demo ${entry.method}.`);
        for (const step of entry.steps ?? []) {
          this.log(`  → ${step}`);
        }
        if (entry.clearsCodes.length > 0) {
          this.codes = this.codes.filter((c) => !entry.clearsCodes.includes(c.code));
          this.emit({ type: "dtc", codes: this.codes });
          this.emit(this.analysis());
        }
        this.emit({ type: "deletions", catalog: DELETIONS, active: [...this.deletions] });
      }
    } else if (command.cmd === "restore_component") {
      const entry = DELETIONS.find((d) => d.id === command.componentId);
      if (entry && this.deletions.delete(entry.id)) {
        this.log(`Restored ${entry.name} to stock coding.`);
        this.emit({ type: "deletions", catalog: DELETIONS, active: [...this.deletions] });
      }
    } else if (command.cmd === "apply_mod") {
      const entry = MODS.find((m) => m.id === command.modId);
      if (entry && !this.mods.has(entry.id)) {
        this.mods.add(entry.id);
        this.log(`Applied ${entry.name}: ${entry.parameter}${entry.offRoadOnly ? " (OFF-ROAD)" : ""}.`);
        this.emit({ type: "mods", catalog: MODS, active: [...this.mods], scope: SCOPE });
      }
    } else if (command.cmd === "run_pull") {
      this.pulls += 1;
      this.log(`Dyno pull #${this.pulls} — simulated WOT sweep to ${this.mods.has("rev_limit") ? 5100 : 4800} rpm.`);
      const pull = simulatePull(this.mods, this.pulls);
      this.lastPull = pull;
      this.emit(pull);
    } else if (command.cmd === "verify_changes") {
      const suppressed = new Set(
        DELETIONS.filter((d) => this.deletions.has(d.id)).flatMap((d) => d.clearsCodes)
      );
      const current = new Set(this.codes.map((c) => c.code));
      const unexpected = [...current].filter((c) => !this.baselineCodes.has(c));
      const leaking = [...suppressed].filter((c) => current.has(c));
      const items: VerificationItem[] = [
        { check: "No new fault codes introduced", status: unexpected.length ? ("fail" as const) : ("pass" as const),
          detail: unexpected.length ? `new: ${unexpected.join(", ")}` : `${current.size} known code(s), none new` },
        { check: "Coded-out codes suppressed", status: leaking.length ? ("fail" as const) : ("pass" as const),
          detail: leaking.length ? `still reporting: ${leaking.join(", ")}` : `${suppressed.size} code(s) suppressed` },
        { check: "Applied state read-back", status: "pass" as const,
          detail: `${this.mods.size} mod(s) + ${this.deletions.size} delete(s) active and consistent` },
      ];
      let peak: number | null = null;
      let sustained: number | null = null;
      if (this.lastPull) {
        peak = this.lastPull.peakTorqueNm;
        const samples = this.lastPull.samples.map((s) => s.torqueNm).sort((a, b) => a - b);
        const plateau = samples.filter((t) => t >= (peak ?? 0) * 0.95);
        sustained = plateau.length ? plateau[Math.floor(plateau.length / 2)] : peak;
        const ok = peak <= ENVELOPE.ceilingPeakNm && sustained <= ENVELOPE.ceilingSustainedNm;
        items.push({
          check: "Torque within factory envelope",
          status: ok ? ("pass" as const) : ("fail" as const),
          detail: `peak ${peak.toFixed(0)} Nm / sustained ${sustained.toFixed(0)} Nm vs ceilings ${ENVELOPE.ceilingPeakNm} / ${ENVELOPE.ceilingSustainedNm} Nm (${ENVELOPE.ladder})`,
        });
      } else {
        items.push({
          check: "Torque within factory envelope",
          status: "skipped" as const,
          detail: "no dyno pull this session — run one before sign-off",
        });
      }
      const passed = items.every((i) => i.status === "pass");
      this.log(`Sign-off verification ${passed ? "PASSED" : "FAILED"} (simulated self-check).`);
      const duty = DUTY_LABELS[command.dutyProfile ?? "standard"] ?? DUTY_LABELS.standard;
      this.emit({
        type: "verification",
        passed,
        items,
        timestamp: new Date().toISOString(),
        source: "simulated",
        dutyProfile: duty,
        envelope: { ...ENVELOPE, peakTorqueNm: peak, sustainedTorqueNm: sustained },
      } as DiagnosticVerificationEvent);
    } else if (command.cmd === "read_ecu_backup") {
      this.emit({ type: "flash", phase: "start", totalBytes: 65536 });
      this.log("Reading ECU image for backup (65536 bytes expected)…");
      let bytes = 0;
      const total = 65536;
      const reader = setInterval(() => {
        bytes = Math.min(total, bytes + 4096);
        this.emit({ type: "flash", phase: "progress", bytes, totalBytes: total });
        if (bytes >= total) {
          clearInterval(reader);
          this.emit({ type: "flash", phase: "complete", bytes: total, totalBytes: total });
          this.log("ECU read complete (browser demo — nothing written to disk).");
        }
      }, 60);
    } else if (command.cmd === "revert_mod") {
      const entry = MODS.find((m) => m.id === command.modId);
      if (entry && this.mods.delete(entry.id)) {
        this.log(`Reverted ${entry.name} to stock calibration.`);
        this.emit({ type: "mods", catalog: MODS, active: [...this.mods], scope: SCOPE });
      }
    }
    return { ok: true, message: "Command handled by the demo bridge." };
  };

  private track(values: LiveValues): void {
    for (const [name, value] of Object.entries(values)) {
      let ch = this.ewma[name];
      if (!ch) {
        ch = this.ewma[name] = { baseline: value, var: 0, init: true };
        continue;
      }
      ch.baseline = 0.95 * ch.baseline + 0.05 * value;
      ch.var = 0.95 * ch.var + 0.05 * (value - ch.baseline) ** 2;
    }
  }

  private analysis(values?: LiveValues): DiagnosticEvent {
    const findings = this.codes
      .map((dtc) => ({ dtc, knowledge: KNOWLEDGE[dtc.code] }))
      .filter((f) => f.knowledge)
      .map(({ dtc, knowledge }) => ({
        code: dtc.code,
        severity: knowledge.severity,
        title: knowledge.title,
        detail: knowledge.detail,
        likelyCauses: knowledge.causes,
        actions: knowledge.actions,
        confidence: knowledge.confidence,
      }));
    const score = Math.max(
      0,
      100 - findings.reduce((sum, f) => sum + ({ high: 20, medium: 10, low: 5 }[f.severity]), 0)
    );
    const label = score >= 80 ? "Good" : score >= 50 ? "Fair" : "Poor";
    const advisories: string[] = [];
    if (values && values.coolantTempC > 0 && values.coolantTempC < 80) {
      advisories.push("Coolant below operating temperature — normal during warm-up.");
    }
    const stream = {
      samples: this.samples,
      windowSeconds: this.samples / 2,
      channels: Object.fromEntries(
        Object.entries(this.ewma).map(([name, ch]) => {
          const sigma = Math.sqrt(ch.var);
          const z = values && sigma > 1e-6 ? (values[name as keyof LiveValues] - ch.baseline) / sigma : 0;
          return [
            name,
            {
              baseline: Number(ch.baseline.toFixed(2)),
              stddev: Number(sigma.toFixed(2)),
              zScore: Number(z.toFixed(1)),
              state: this.samples < 20 ? "learning" : Math.abs(z) >= 3 ? "elevated" : "normal",
            },
          ];
        })
      ) as Record<string, { baseline: number; stddev: number; zScore: number; state: "learning" | "normal" | "elevated" }>,
      predictions: [],
    };
    return {
      type: "analysis",
      healthScore: score,
      healthLabel: label,
      summary:
        findings.length === 0
          ? "No fault codes stored and live values are within expected idle ranges."
          : `${this.codes.filter((c) => c.status !== "Pending").length} stored and ${this.codes.filter((c) => c.status === "Pending").length} pending fault codes. Priority: ${findings[0].title}.`,
      findings,
      advisories,
      generatedAt: new Date().toISOString(),
      stream,
      provenance: {
        analysisVersion: 2,
        baselineSamples: this.samples,
        mode: this.samples < 20 ? "static-fallback" : "session-learned",
        sessions: 1,
      },
    };
  }

  private log(message: string): void {
    this.emit({ type: "log", message });
  }

  private emit(event: DiagnosticEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}

let demoActive = false;

export const isDemoMode = (): boolean => demoActive;

/** Installs the browser demo bridge when the preload context is absent. */
export const ensureDemoContext = (): void => {
  if (typeof window === "undefined" || window.context) {
    return;
  }
  demoActive = true;
  const bridge = new DemoBridge();
  window.context = {
    getVersions: () =>
      Promise.resolve({ electron: "demo", chrome: "demo", node: "demo" } as never),
    triggerIPC: () => {},
    startDiagnostic: bridge.startDiagnostic,
    stopDiagnostic: bridge.stopDiagnostic,
    sendDiagnosticCommand: bridge.sendDiagnosticCommand,
    onDiagnosticEvent: bridge.onDiagnosticEvent,
    // Update checks are a packaged-app concern; the browser demo reports
    // "unknown" so the banner stays silent (as designed for failures).
    checkForUpdate: () =>
      Promise.resolve({
        status: "unknown" as const,
        currentVersion: "demo",
        reason: "browser demo",
      }),
    openUpdateDownload: () => Promise.resolve(),
  };
  // Viewer convenience: start a simulated session right away.
  window.setTimeout(() => void bridge.startDiagnostic({ simulate: true }), 400);
};
