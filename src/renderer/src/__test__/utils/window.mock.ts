import { vi } from "vitest";
import { DiagnosticEvent } from "@shared/types";

// Data events replayed to every subscriber while `mockState.replaySession`
// is on — they stand in for a real J2534 session's stream. Status events are
// NOT replayed automatically so tests can drive connection state explicitly.
// Tests of the disconnected UI set `mockState.replaySession = false` first.
const MOCK_SESSION: DiagnosticEvent[] = [
  {
    type: "info",
    info: {
      protocol: "ISO 15765-4 (CAN 500 kbps)",
      requestId: "0x7E0",
      responseId: "0x7E8",
      ecuName: "Engine Control Module — Bosch EDC17 (3.0 V6 TDI, DDXC / TDI550)",
      partNumber: "2H0906027",
      swVersion: "6177",
      hwVersion: "H14",
      coding: "0011721",
      vin: "WV1ZZZ2H0JW123456",
    },
  },
  {
    type: "dtc",
    codes: [
      {
        code: "P0299",
        status: "Stored",
        description: "Turbocharger/supercharger underboost condition",
        mileageKm: 186410,
        freezeFrame: { rpm: 2210, coolantTempC: 88, engineLoadPct: 71, speedKph: 96 },
      },
    ],
  },
  {
    type: "analysis",
    healthScore: 90,
    healthLabel: "Good",
    summary: "1 stored and 0 pending fault codes. Priority: Turbo underboost (VNT).",
    findings: [
      {
        code: "P0299",
        severity: "medium",
        title: "Turbo underboost (VNT)",
        detail: "Measured boost fell short of target — most often a sticking VNT mechanism or boost leak.",
        likelyCauses: ["Sticking VNT mechanism", "Boost pipe or intercooler leak"],
        actions: ["Smoke/pressure test the charge pipes"],
        confidence: 0.68,
      },
    ],
    advisories: ["Coolant below operating temperature — normal during warm-up."],
    generatedAt: "2026-08-15T03:00:00.000Z",
    stream: {
      samples: 118,
      windowSeconds: 59,
      channels: {
        rpm: { baseline: 781.2, stddev: 18.4, zScore: 0.3, state: "normal" },
        coolantTempC: { baseline: 64.1, stddev: 2.2, zScore: 1.1, state: "normal" },
      },
      predictions: [
        {
          channel: "coolantTempC",
          message:
            "Coolant trending +0.8 °C/min — projects past 105°C in ~6 min if the current trend continues",
          etaSeconds: 360,
          confidence: 0.91,
        },
      ],
    },
    provenance: {
      analysisVersion: 2,
      baselineSamples: 118,
      mode: "session-learned",
      sessions: 1,
    },
  },
  {
    type: "deletions",
    catalog: [
      {
        id: "start_stop_memory",
        name: "Start-Stop memory (stays off)",
        group: "engine",
        ecu: "Engine",
        method: "Coding",
        clearsCodes: [],
        risk: "low",
        offRoadOnly: false,
        description: "Remembers the last Start-Stop state across ignition cycles.",
      },
      {
        id: "egr",
        name: "EGR system",
        group: "offroad",
        ecu: "Engine",
        method: "Calibration (tables) + DTC",
        clearsCodes: ["P0401", "P0402"],
        risk: "medium",
        offRoadOnly: true,
        description: "Disables EGR in software after blanking or removal.",
        steps: [
          "Zero the five EGR hysteresis matrices (Hyst 1–5) across rpm/load so the activation conditions are never met — no limp-home",
          "Recalibrate the MAF plausibility model (MAF_req) for 100% fresh air at part load — otherwise sets P0401/P0402",
          "Mask the EGR valve and cooler circuit DTCs in the EDC17CP54 error-class matrix so no emissions light remains",
        ],
        commonlyPairedWith: ["asv"],
        requirement:
          "CONFLICT — the ECU uses the ASV to throttle intake air for DPF regeneration heat. Keep the ASV while the DPF stays.",
      },
    ],
    // Writes are refused by the monitor — nothing is ever active.
    active: [],
  },
  {
    type: "mods",
    catalog: [
      {
        id: "stage1",
        name: "Stage 1 calibration",
        group: "engine",
        ecu: "Engine",
        method: "Calibration slot",
        parameter: "224 → 310 hp · 680 Nm sustained · 710 Nm 10-second overboost",
        risk: "medium",
        offRoadOnly: false,
        requirement: "Healthy DPF/EGR and EGT headroom; 680 Nm runs near the ZF 8HP70 rating — watch transmission temperature under load. Dyno verify",
        description: "Loads a stage-1 EDC17 slot: raised injection quantity and boost.",
      },
      {
        id: "rev_limit",
        name: "Rev limiter +300 rpm",
        group: "engine",
        ecu: "Engine",
        method: "Calibration slot",
        parameter: "+300 rpm cut point",
        risk: "medium",
        offRoadOnly: false,
        requirement: "Diesel power band ends early — marginal benefit, more smoke",
        description: "Raises the fuel cut point from ~4800 to ~5100 rpm.",
      },
    ],
    // Writes are refused by the monitor — nothing is ever active.
    active: [],
    scope: {
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
    },
  },
  {
    type: "dids",
    entries: [
      { channel: "rpm", did: "0xF40C", ok: true, value: 790, note: "standard set" },
      { channel: "speedKph", did: "0xF40D", ok: true, value: 0, note: "standard set" },
      { channel: "railPressureBar", did: "0xF484", ok: true, value: 300, note: "community EDC17 table (x0.1 bar)" },
      { channel: "boostPressureKpa", did: "0xF4A3", ok: true, value: 100, note: "charge pressure (x0.03 kPa, community table)" },
      { channel: "pedalPct", did: "0xF4A1", ok: true, value: 0, note: "accelerator position (x100/255 %)" },
    ],
  },
  {
    type: "flash",
    phase: "complete",
    bytes: 65536,
    totalBytes: 65536,
    path: "C:\\Users\\Tim\\AppData\\Roaming\\vw-diagnostics\\backups\\ecu-backup-2026-08-16.bin",
    sha256: "a3f5c7d9b1e0246813579acd0b2468ef13579acd0b2468ef13579acd0b2468ef",
  },
  {
    type: "verification",
    // Nothing was applied by this app — the honest verdict is inconclusive,
    // never "verified".
    verdict: "inconclusive",
    source: "ecu",
    dutyProfile: "Standard (tow-capable)",
    envelope: {
      ceilingSustainedNm: 700,
      ceilingPeakNm: 715,
      ladder: "550 stock · 580 VW transient · 620 single-turbo Audi · 700 ZF 8HP70 rating",
      peakTorqueNm: null,
      sustainedTorqueNm: null,
    },
    items: [
      { check: "No new fault codes introduced", status: "pass", detail: "1 known code(s), none new this session" },
      { check: "Coded-out codes suppressed", status: "skipped", detail: "no deletes active — nothing to check" },
      { check: "Live channels within limits", status: "pass", detail: "all channels plausible" },
      { check: "Coolant within duty-profile limit (105 °C)", status: "pass", detail: "Standard (tow-capable): sustained towing duty. Now: 64 °C." },
      { check: "No rejected implausible samples", status: "pass", detail: "0 sample(s) rejected" },
      { check: "Applied state read-back", status: "skipped", detail: "stock coding — nothing applied" },
      { check: "Calibration changes applied this session", status: "skipped", detail: "none — this app does not write to the ECU; changes are applied by bench flashing and verified here" },
    ],
    timestamp: "2026-08-15T03:00:02.000Z",
  },
  {
    type: "live",
    values: {
      rpm: 782,
      speedKph: 0,
      coolantTempC: 64,
      intakeTempC: 28,
      boostPressureKpa: 100,
      pedalPct: 1.2,
      engineLoadPct: 22,
      batteryV: 14.02,
      railPressureBar: 288,
    },
    timestamp: "2026-08-15T03:00:00.000Z",
  },
];

export const mockState = { replaySession: true };

const context = Object.defineProperty(window, "context", {
  writable: true,
  value: {
    getVersions: vi.fn().mockImplementation(() => ({
      electron: "0.0",
      chrome: "0.0",
      node: "0.0",
    })),
    triggerIPC: vi.fn().mockImplementation(() => {}),
    startDiagnostic: vi.fn().mockImplementation(() =>
      Promise.resolve({
        started: true,
        message: "Diagnostic monitor started.",
      })
    ),
    stopDiagnostic: vi.fn().mockImplementation(() =>
      Promise.resolve({ started: false, message: "Diagnostic session stopped." })
    ),
    sendDiagnosticCommand: vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, message: "Command sent to the monitor." })
    ),
    onDiagnosticEvent: vi
      .fn()
      .mockImplementation((listener: (event: DiagnosticEvent) => void) => {
        if (mockState.replaySession) MOCK_SESSION.forEach(listener);
        return () => {};
      }),
    checkForUpdate: vi.fn().mockImplementation(() =>
      Promise.resolve({
        status: "unknown",
        currentVersion: "0.0.0",
        reason: "test stub",
      })
    ),
    openUpdateDownload: vi.fn().mockImplementation(() => Promise.resolve()),
  },
});

export { context };
