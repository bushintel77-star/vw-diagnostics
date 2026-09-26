import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
  DRIVER_FILE,
  DRIVER_SHA256,
  PASSKEY_FILE,
  scryptMaxmem,
} from "../../../scripts/driver-bundle.mjs";
import {
  CablePreflight,
  CableSetupStatus,
  CableState,
  DriverInstallResult,
  DriverUnlockResult,
} from "@shared/types";

// Plug-and-play cable setup. Everything here is read-only except
// installDriver, which launches ONLY the pinned 1004341 installer (newer
// Tactrix packages brick clone cables) and only after the passkey gate.
//
// The passkey is a convenience gate, not encryption: a private build carries
// the installer unencrypted. Public builds carry neither file (see
// electron-builder.yml), so `driverBundled` is false and install is refused.
// Nothing here changes Windows security settings or driver policy.

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 60_000;
const UNLOCK_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 8_000;
const ERROR_CANCELLED = 1223; // UAC "No", or the installer's own Cancel
const SUCCESS_REBOOT_REQUIRED = 3010;

// --- pure helpers (unit-tested) ---------------------------------------------

export function parseWindowsBuild(osRelease: string): number | null {
  const build = Number(osRelease.split(".")[2]);
  return Number.isInteger(build) && build > 0 ? build : null;
}

/** Device Manager problem code -> wizard state. 45 = remembered but unplugged. */
export function cableStateFromCode(code: number): CableState {
  if (code === 0) return "ready";
  if (code === 39 || code === 52) return "blocked";
  if (code === 28) return "no_driver";
  if (code === 45) return "absent";
  return "problem";
}

/** Parses the PnP query output. Any healthy device wins over a faulty one. */
export function parseCableQuery(stdout: string): {
  cable: CableState;
  code: number | null;
} {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout.trim() || "[]");
  } catch {
    return { cable: "unknown", code: null };
  }
  const codes = (Array.isArray(rows) ? rows : [rows])
    .map((row) => Number((row as { ConfigManagerErrorCode?: unknown })?.ConfigManagerErrorCode))
    .filter(Number.isInteger);
  if (codes.length === 0) return { cable: "absent", code: null };
  const code = codes.includes(0) ? 0 : codes[0];
  return { cable: cableStateFromCode(code), code: code === 0 ? null : code };
}

export const isTactrixRegistration = (regOutput: string): boolean =>
  /Vendor\s+REG_SZ\s+Tactrix/i.test(regOutput);

export interface PasskeyRecord {
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

/** Constant-time scrypt comparison against the build-time record. */
export function verifyPasskey(passkey: string, record: PasskeyRecord): boolean {
  const expected = Buffer.from(record.hash, "hex");
  if (expected.length === 0) return false;
  const actual = scryptSync(passkey, Buffer.from(record.salt, "hex"), expected.length, {
    N: record.N,
    r: record.r,
    p: record.p,
    maxmem: scryptMaxmem(record.N, record.r),
  });
  return timingSafeEqual(actual, expected);
}

export type GateOutcome =
  | { ok: true }
  | { ok: false; locked: boolean; attemptsLeft: number; lockedForSeconds: number };

/** Attempt counting, lockout and the post-unlock retry window. */
export class PasskeyGate {
  private failures = 0;
  private lockedUntil = 0;
  private unlockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  lockedForSeconds(): number {
    return Math.max(0, Math.ceil((this.lockedUntil - this.now()) / 1000));
  }

  isUnlocked(): boolean {
    return this.now() < this.unlockedUntil;
  }

  record(correct: boolean): GateOutcome {
    if (this.lockedForSeconds() > 0) {
      return { ok: false, locked: true, attemptsLeft: 0, lockedForSeconds: this.lockedForSeconds() };
    }
    if (correct) {
      this.failures = 0;
      this.unlockedUntil = this.now() + UNLOCK_MS;
      return { ok: true };
    }
    this.failures += 1;
    if (this.failures >= MAX_ATTEMPTS) {
      this.failures = 0;
      this.lockedUntil = this.now() + LOCKOUT_MS;
      return { ok: false, locked: true, attemptsLeft: 0, lockedForSeconds: this.lockedForSeconds() };
    }
    return { ok: false, locked: false, attemptsLeft: MAX_ATTEMPTS - this.failures, lockedForSeconds: 0 };
  }
}

// --- system probes -----------------------------------------------------------

const systemRoot = (): string => process.env.SystemRoot ?? "C:\\Windows";
const system32 = (...parts: string[]): string => join(systemRoot(), "System32", ...parts);

const run = (
  file: string,
  args: string[],
  timeout: number
): Promise<{ code: number | null; stdout: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
      const code = !error ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, stdout: String(stdout) });
    });
  });

// -EncodedCommand sidesteps every quoting layer between Node and PowerShell.
const powershell = (script: string, timeout: number): ReturnType<typeof run> =>
  run(
    system32("WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    timeout
  );

// Win32_PnPEntity lists present devices only: no row means not plugged in.
// Openport 2.0 and its clones enumerate as FTDI VID 0403, PID CC4C/CC4D.
const CABLE_QUERY = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  String.raw`$d = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_0403&PID_CC4_\\%'" | Select-Object PNPDeviceID, ConfigManagerErrorCode)`,
  "ConvertTo-Json -InputObject $d -Compress",
].join("\n");

async function queryCable(): Promise<{ cable: CableState; code: number | null }> {
  const result = await powershell(CABLE_QUERY, PROBE_TIMEOUT_MS);
  return result.code === 0 ? parseCableQuery(result.stdout) : { cable: "unknown", code: null };
}

async function isDriverRegistered(): Promise<boolean> {
  const views = await Promise.all(
    ["/reg:32", "/reg:64"].map((view) =>
      run(system32("reg.exe"), ["query", "HKLM\\SOFTWARE\\PassThruSupport.04.04", "/s", view], PROBE_TIMEOUT_MS)
    )
  );
  return views.some((view) => view.code === 0 && isTactrixRegistration(view.stdout));
}

// Polls arrive every few seconds; overlapping callers share one probe.
let probeInFlight: Promise<{ driverInstalled: boolean; cable: CableState; code: number | null }> | null = null;
const probe = (): NonNullable<typeof probeInFlight> =>
  (probeInFlight ??= Promise.all([isDriverRegistered(), queryCable()])
    .then(([driverInstalled, { cable, code }]) => ({ driverInstalled, cable, code }))
    .finally(() => {
      probeInFlight = null;
    }));

// --- bundle ------------------------------------------------------------------

// Private builds ship the bundle as an extraResource beside app.asar.
const driverDir = (): string =>
  app.isPackaged ? join(process.resourcesPath, "driver") : join(app.getAppPath(), "resources", "driver");

function readPasskeyRecord(): PasskeyRecord | null {
  try {
    const record = JSON.parse(readFileSync(join(driverDir(), PASSKEY_FILE), "utf8"));
    const valid =
      typeof record?.salt === "string" &&
      typeof record?.hash === "string" &&
      [record.N, record.r, record.p].every(Number.isInteger);
    return valid ? record : null;
  } catch {
    return null;
  }
}

const isBundled = (): boolean =>
  existsSync(join(driverDir(), DRIVER_FILE)) && readPasskeyRecord() !== null;

// --- public API --------------------------------------------------------------

const gate = new PasskeyGate();
let installing = false;

export async function getCableSetupStatus(
  options: { full?: boolean } = {},
  preflight?: () => Promise<CablePreflight>
): Promise<CableSetupStatus> {
  const windows = process.platform === "win32";
  const [probed, preflightResult] = await Promise.all([
    windows ? probe() : Promise.resolve({ driverInstalled: false, cable: "unknown" as CableState, code: null }),
    windows && options.full && preflight ? preflight() : Promise.resolve(null),
  ]);
  return {
    platformSupported: windows,
    windowsBuild: windows ? parseWindowsBuild(release()) : null,
    driverInstalled: probed.driverInstalled,
    driverBundled: windows && isBundled(),
    cable: probed.cable,
    cableProblemCode: probed.code,
    preflight: preflightResult,
    lockedForSeconds: gate.lockedForSeconds(),
    unlocked: gate.isUnlocked(),
    checkedAt: new Date().toISOString(),
  };
}

const quotePs = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Runs the installer through UAC and waits for it (and its children). */
const runElevated = (file: string): Promise<{ code: number | null }> =>
  powershell(
    [
      "$ProgressPreference = 'SilentlyContinue'",
      "try {",
      `  $p = Start-Process -FilePath ${quotePs(file)} -Verb RunAs -Wait -PassThru`,
      "  exit $p.ExitCode",
      "} catch {",
      "  $e = $_.Exception",
      `  while ($e) { if ($e.NativeErrorCode -eq ${ERROR_CANCELLED}) { exit ${ERROR_CANCELLED} }; $e = $e.InnerException }`,
      "  exit 1",
      "}",
    ].join("\n"),
    0
  );

const UNAVAILABLE = "This build doesn't include the cable driver.";

export async function unlockDriver(passkey: unknown): Promise<DriverUnlockResult> {
  const record = readPasskeyRecord();
  if (process.platform !== "win32" || !record || !existsSync(join(driverDir(), DRIVER_FILE))) {
    return { ok: false, reason: "unavailable", message: UNAVAILABLE };
  }
  if (gate.isUnlocked()) return { ok: true };
  // Checked before hashing, so a locked gate costs no scrypt work.
  if (gate.lockedForSeconds() > 0) {
    return { ok: false, reason: "locked", message: "Too many wrong passkeys.", lockedForSeconds: gate.lockedForSeconds() };
  }
  const correct = typeof passkey === "string" && passkey.length > 0 && verifyPasskey(passkey, record);
  const outcome = gate.record(correct);
  if (outcome.ok) return { ok: true };
  return outcome.locked
    ? { ok: false, reason: "locked", message: "Too many wrong passkeys.", lockedForSeconds: outcome.lockedForSeconds }
    : { ok: false, reason: "bad_passkey", message: "That passkey isn't right.", attemptsLeft: outcome.attemptsLeft };
}

export async function installDriver(): Promise<DriverInstallResult> {
  const installer = join(driverDir(), DRIVER_FILE);
  if (process.platform !== "win32" || !readPasskeyRecord() || !existsSync(installer)) {
    return { ok: false, reason: "unavailable", message: UNAVAILABLE };
  }
  if (!gate.isUnlocked()) {
    return { ok: false, reason: "not_unlocked", message: "Enter the passkey first." };
  }
  if (installing) {
    return { ok: false, reason: "busy", message: "The driver installer is already open." };
  }

  // Re-hash at the point of launch: never run anything but the pinned build.
  if (createHash("sha256").update(readFileSync(installer)).digest("hex") !== DRIVER_SHA256) {
    return { ok: false, reason: "failed", message: "The bundled installer failed its integrity check, so it was not started." };
  }

  installing = true;
  try {
    const wasRegistered = await isDriverRegistered();
    const { code } = await runElevated(installer);
    if (code === ERROR_CANCELLED) {
      return { ok: false, reason: "declined", message: "The install was cancelled, so nothing changed." };
    }
    const registered = await isDriverRegistered();
    if (registered && (code === 0 || code === SUCCESS_REBOOT_REQUIRED || !wasRegistered)) {
      return { ok: true, message: "Driver installed." };
    }
    return {
      ok: false,
      reason: "failed",
      message: `The installer closed before finishing${code === null ? "" : ` (code ${code})`}.`,
    };
  } finally {
    installing = false;
  }
}
