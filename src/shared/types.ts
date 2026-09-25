import { electronAPI } from "@electron-toolkit/preload";
export type GetVersionsFn = () => Promise<typeof electronAPI.process.versions>;

// --- J2534 diagnostic monitor (resources/j2534_monitor.py) ---

// The product monitor only ever runs a real J2534 session. The test fixture
// (resources/sim_fixture.py, reached only via --selftest) labels its stream
// "simulate", but that mode never crosses this IPC surface.
export type DiagnosticMode = "live";

export type DiagnosticPhase =
  | "starting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface DiagnosticStatusEvent {
  type: "status";
  phase: DiagnosticPhase;
  message: string;
  mode: DiagnosticMode;
}

export interface EcuInfo {
  protocol: string;
  requestId: string;
  responseId: string;
  ecuName: string;
  /** Identity DIDs (0xF187/0xF189/0xF191/0xF18C) — null = the ECU did not
   *  answer that DID. Never rendered as a value it didn't report. */
  partNumber: string | null;
  swVersion: string | null;
  hwVersion: string | null;
  serial: string | null;
  coding: string | null;
  vin: string;
}

export interface DtcFreezeFrame {
  rpm: number;
  coolantTempC: number;
  engineLoadPct: number;
  speedKph: number;
}

export interface DtcCode {
  code: string;
  status: "Stored" | "Pending" | "Active";
  description: string;
  /** Odometer at the time the fault set — null when the session doesn't
   *  read it. A fabricated 0 would render as a real measurement. */
  mileageKm: number | null;
  /** statusOfDTC bit 7 (warningIndicatorRequested) — the ECU asking for
   *  the MIL tell-tale. Absent on sources that don't decode the byte. */
  warningIndicator?: boolean;
  /** Conditions captured by the ECU when the fault set. */
  freezeFrame?: DtcFreezeFrame;
}

// A channel that failed to read is null, not its previous value — the UI
// must show no-data rather than a frozen number.
export interface LiveValues {
  rpm: number | null;
  speedKph: number | null;
  coolantTempC: number | null;
  intakeTempC: number | null;
  boostPressureKpa: number | null;
  pedalPct: number | null;
  engineLoadPct: number | null;
  batteryV: number | null;
  railPressureBar: number | null;
}

export interface DiagnosticInfoEvent {
  type: "info";
  info: EcuInfo;
}

export interface DiagnosticDtcEvent {
  type: "dtc";
  codes: DtcCode[];
}

export interface DiagnosticLiveEvent {
  type: "live";
  values: LiveValues;
  timestamp: string;
}

export interface DiagnosticErrorEvent {
  type: "error";
  message: string;
}

/** On-device heuristic analysis produced by the monitor. */
export interface AnalysisFinding {
  code: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  likelyCauses: string[];
  actions: string[];
  confidence: number;
}

export interface DiagnosticAnalysisEvent {
  type: "analysis";
  healthScore: number;
  healthLabel: "Good" | "Fair" | "Poor";
  summary: string;
  findings: AnalysisFinding[];
  advisories: string[];
  generatedAt: string;
  /** Tier-1 statistical layer — present once the monitor streams analysis. */
  stream?: AnalysisStream;
  provenance?: AnalysisProvenance;
}

/** Per-channel learned baseline and deviation state. */
export interface ChannelState {
  baseline: number;
  stddev: number;
  /** Signed deviation of the latest sample, in sigmas. */
  zScore: number;
  state: "learning" | "normal" | "elevated" | "abnormal";
}

export interface StreamPrediction {
  channel: string;
  message: string;
  etaSeconds: number | null;
  /** Fit quality (R²) × trend stability, 0–1. */
  confidence: number;
}

export interface AnalysisStream {
  samples: number;
  windowSeconds: number;
  channels: Partial<Record<keyof LiveValues, ChannelState>>;
  predictions: StreamPrediction[];
}

export interface AnalysisProvenance {
  analysisVersion: number;
  baselineSamples: number;
  mode: "static-fallback" | "session-learned" | "cross-session";
  sessions: number;
  /** Samples rejected by plausibility/rate checks this session. */
  rejectedSamples?: number;
  rejectedChannels?: string[];
}

export interface DiagnosticLogEvent {
  type: "log";
  message: string;
}

/** One entry of the monitor's component-deletion catalog. */
export interface ComponentDeletion {
  id: string;
  name: string;
  group: "engine" | "offroad";
  ecu: string;
  method: string;
  /** DTCs the ECU stops reporting once the component is coded out. */
  clearsCodes: string[];
  risk: "low" | "medium" | "high";
  /** Emissions-related deletes are off-road/show use only. */
  offRoadOnly: boolean;
  description: string;
  /** Calibration measures the ECU needs after physical removal. */
  steps?: string[];
  /** Deletes usually performed together with this one (catalog ids). */
  commonlyPairedWith?: string[];
  /** Conflict/prerequisite warning — e.g. dependencies on other components. */
  requirement?: string;
}

export interface DiagnosticDeletionsEvent {
  type: "deletions";
  catalog: ComponentDeletion[];
  /** Catalog ids currently coded out. */
  active: string[];
}

/** Write policy enforced by the monitor: default-deny outside `allowed`. */
export interface ScopedModule {
  name: string;
  address?: string;
  reason: string;
}

export interface ModuleScope {
  allowed: ScopedModule[];
  blocked: ScopedModule[];
}

/** One entry of the monitor's performance-mods catalog. */
export interface PerformanceMod {
  id: string;
  name: string;
  group: "engine" | "transmission" | "offroad";
  ecu: string;
  method: string;
  /** What the mod changes, in tuning terms. */
  parameter: string;
  risk: "low" | "medium" | "high";
  offRoadOnly: boolean;
  requirement?: string;
  description: string;
}

export interface DiagnosticModsEvent {
  type: "mods";
  catalog: PerformanceMod[];
  /** Catalog ids currently applied. */
  active: string[];
  scope: ModuleScope;
}

/** One check of the post-flash health-check routine. */
export interface VerificationItem {
  check: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
}

/** Manufacturer-standard torque envelope assembled from the factory variant
 * ladder (550 stock · 580 VW transient · 620 single-turbo Audi · 700 ZF
 * 8HP70 rating). Verification holds any signed-off tune inside it. */
export interface FactoryEnvelope {
  ceilingSustainedNm: number;
  ceilingPeakNm: number;
  ladder: string;
  peakTorqueNm: number | null;
  sustainedTorqueNm: number | null;
}

export type DutyProfile = "standard" | "no_tow";

/** Health-check outcome: "pass" means at least one check passed on real
 * ECU evidence read this session (a DTC re-read, live channels, coolant,
 * the stream) and nothing failed; "inconclusive" means nothing was
 * evaluated on real evidence — never rendered as success; "fail" means a
 * check actually failed. Never collapse to a boolean — "not verified"
 * is not a pass. */
export type VerificationVerdict = "pass" | "fail" | "inconclusive";

export interface DiagnosticVerificationEvent {
  type: "verification";
  verdict: VerificationVerdict;
  items: VerificationItem[];
  timestamp: string;
  /** Where the inputs came from: re-read from the ECU, or the test-fixture
   * transport's own state (say so — never pass the fixture off as measured). */
  source?: "ecu" | "simulated";
  dutyProfile?: string;
  envelope?: FactoryEnvelope;
}

/** One live-channel DID probe result (UDS 0x22 at connect / on demand). */
export interface DidMapEntry {
  channel: string;
  did: string;
  ok: boolean;
  value: number | null;
  note: string;
}

export interface DiagnosticDidMapEvent {
  type: "dids";
  entries: DidMapEntry[];
}

/** Stock-ECU read/backup progress. Chunks travel monitor→main process only;
 * the renderer sees progress and, on completion, the written file path. */
export interface DiagnosticFlashEvent {
  type: "flash";
  phase: "start" | "progress" | "complete" | "error";
  bytes?: number;
  totalBytes?: number | null;
  message?: string;
  chunkB64?: string;
  /** Present on phase=complete when the main process wrote the backup. */
  path?: string;
  sha256?: string;
}

export type DiagnosticEvent =
  | DiagnosticStatusEvent
  | DiagnosticInfoEvent
  | DiagnosticDidMapEvent
  | DiagnosticDtcEvent
  | DiagnosticLiveEvent
  | DiagnosticAnalysisEvent
  | DiagnosticLogEvent
  | DiagnosticDeletionsEvent
  | DiagnosticModsEvent
  | DiagnosticBaselinesEvent
  | DiagnosticVerificationEvent
  | DiagnosticFlashEvent
  | DiagnosticErrorEvent;

/** Commands the monitor accepts on stdin (extensible for future UDS ops). */
export interface ClearDtcCommand {
  cmd: "clear_dtc";
}

export interface DeleteComponentCommand {
  cmd: "delete_component";
  componentId: string;
}

export interface RestoreComponentCommand {
  cmd: "restore_component";
  componentId: string;
}

export interface ApplyModCommand {
  cmd: "apply_mod";
  modId: string;
}

export interface RevertModCommand {
  cmd: "revert_mod";
  modId: string;
}

/** Baseline state persisted by the main process, seeded into the monitor. */
export interface BaselineChannelExport {
  baseline: number;
  var: number;
  samples: number;
}

export interface VehicleBaseline {
  sessions: number;
  channels: Record<string, BaselineChannelExport>;
}

export type BaselineStateFile = {
  version: number;
  vins: Record<string, VehicleBaseline>;
};

export interface SeedBaselineCommand {
  cmd: "seed_baseline";
  vehicles: Record<string, VehicleBaseline>;
}

export interface VerifyChangesCommand {
  cmd: "verify_changes";
  /** How the vehicle is used — tunes verification scrutiny, never ceilings. */
  dutyProfile?: DutyProfile;
}

export interface ProbeDidsCommand {
  cmd: "probe_dids";
}

export interface ReadEcuBackupCommand {
  cmd: "read_ecu_backup";
}

export type DiagnosticCommand =
  | ClearDtcCommand
  | DeleteComponentCommand
  | RestoreComponentCommand
  | ApplyModCommand
  | RevertModCommand
  | SeedBaselineCommand
  | VerifyChangesCommand
  | ProbeDidsCommand
  | ReadEcuBackupCommand;

/** Emitted by the monitor so the main process can persist learned baselines. */
export interface DiagnosticBaselinesEvent {
  type: "baselines";
  vin: string;
  sessions: number;
  channels: Record<string, BaselineChannelExport>;
}

export interface DiagnosticCommandResult {
  ok: boolean;
  message: string;
}

export type SendDiagnosticCommandFn = (
  command: DiagnosticCommand
) => Promise<DiagnosticCommandResult>;

export interface DiagnosticSessionResult {
  started: boolean;
  message: string;
}

// No options: the app only ever attempts a real J2534 connection — there
// is no simulated product mode.
export type StartDiagnosticFn = () => Promise<DiagnosticSessionResult>;

export type StopDiagnosticFn = () => Promise<DiagnosticSessionResult>;

export type DiagnosticEventListener = (event: DiagnosticEvent) => void;

export type OnDiagnosticEventFn = (
  listener: DiagnosticEventListener
) => () => void;

// --- Update notice (GitHub releases check, main process only) ---
//
// Discriminated union: a failed check must never render as "up to date".
export type UpdateCheckResult =
  | { status: "current"; currentVersion: string }
  | {
      status: "available";
      currentVersion: string;
      latestVersion: string;
      releaseUrl: string;
      publishedAt: string;
    }
  | {
      status: "blocked";
      currentVersion: string;
      requiredVersion: string;
      releaseUrl: string;
    }
  | { status: "unknown"; currentVersion: string; reason: string };
// "blocked" is the kill switch: the remote update-floor.json declares a
// minimum required version and this install is below it — the UI renders
// a blocking gate instead of the dashboard.

export type CheckForUpdateFn = () => Promise<UpdateCheckResult>;

export type OpenUpdateDownloadFn = () => Promise<void>;
