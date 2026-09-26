import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import {
  DRIVER_FILE,
  DRIVER_SHA256,
  DriverMeta,
  ENCRYPTED_FILE,
  META_FILE,
  decryptDriver,
  isValidMeta,
  sha256,
} from "../../../scripts/driver-bundle.mjs";
import {
  CablePreflight,
  CableSetupStatus,
  CableState,
  DriverInstallResult,
  DriverUnlockResult,
  DriverVersionState,
} from "@shared/types";

// Plug-and-play cable setup. Everything here is read-only except
// installDriver, which launches ONLY the pinned 1004341 installer (newer
// Tactrix packages brick clone cables) and only after the passkey.
//
// The driver ships in every build as AES-256-GCM ciphertext (see
// scripts/driver-bundle.mjs): the passkey is the decryption key, so the
// public download holds no usable driver without it. Decrypted bytes live in
// memory for the unlock window and touch disk only for the install itself.
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

// The J2534 DLL that openport2_setup_1004341.exe installs. Anything newer
// came from other Tactrix software, which can reflash (and brick) a clone.
export const SAFE_DRIVER_VERSION = "1.01.0.4341";

export function driverVersionState(version: string | null): DriverVersionState {
  const parse = (v: string): number[] | null => {
    const parts = v.trim().split(".").map(Number);
    return parts.length === 4 && parts.every(Number.isInteger) ? parts : null;
  };
  const found = version ? parse(version) : null;
  if (!found) return "unknown";
  const safe = parse(SAFE_DRIVER_VERSION)!;
  for (let i = 0; i < 4; i++) {
    if (found[i] !== safe[i]) return found[i] > safe[i] ? "newer" : "older";
  }
  return "match";
}

export interface ProbeResult {
  cable: CableState;
  code: number | null;
  driverVersion: string | null;
}

/** Parses the probe output. Any healthy device wins over a faulty one. */
export function parseProbeQuery(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim() || "{}");
  } catch {
    return { cable: "unknown", code: null, driverVersion: null };
  }
  const { devices, driverVersion } = (parsed ?? {}) as { devices?: unknown; driverVersion?: unknown };
  const version = typeof driverVersion === "string" && driverVersion.trim() ? driverVersion.trim() : null;
  const codes = (Array.isArray(devices) ? devices : devices ? [devices] : [])
    .map((row) => Number((row as { ConfigManagerErrorCode?: unknown })?.ConfigManagerErrorCode))
    .filter(Number.isInteger);
  if (codes.length === 0) return { cable: "absent", code: null, driverVersion: version };
  const code = codes.includes(0) ? 0 : codes[0];
  return { cable: cableStateFromCode(code), code: code === 0 ? null : code, driverVersion: version };
}

export const isTactrixRegistration = (regOutput: string): boolean =>
  /Vendor\s+REG_SZ\s+Tactrix/i.test(regOutput);

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
// The same pass reads the registered Tactrix DLL's file version (read-only).
const PROBE_QUERY = [
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Stop'",
  String.raw`$d = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_0403&PID_CC4_\\%'" | Select-Object PNPDeviceID, ConfigManagerErrorCode)`,
  "$v = $null",
  String.raw`foreach ($k in 'HKLM:\SOFTWARE\WOW6432Node\PassThruSupport.04.04', 'HKLM:\SOFTWARE\PassThruSupport.04.04') {`,
  "  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {",
  "    $p = Get-ItemProperty $_.PSPath",
  "    if ($p.Vendor -like 'Tactrix*' -and $p.FunctionLibrary -and (Test-Path -LiteralPath $p.FunctionLibrary)) {",
  "      $v = (Get-Item -LiteralPath $p.FunctionLibrary).VersionInfo.FileVersion",
  "    }",
  "  }",
  "}",
  "ConvertTo-Json -InputObject @{ devices = $d; driverVersion = $v } -Compress",
].join("\n");

async function queryDevices(): Promise<ProbeResult> {
  const result = await powershell(PROBE_QUERY, PROBE_TIMEOUT_MS);
  return result.code === 0 ? parseProbeQuery(result.stdout) : { cable: "unknown", code: null, driverVersion: null };
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
let probeInFlight: Promise<ProbeResult & { driverInstalled: boolean }> | null = null;
const probe = (): NonNullable<typeof probeInFlight> =>
  (probeInFlight ??= Promise.all([isDriverRegistered(), queryDevices()])
    .then(([driverInstalled, devices]) => ({ driverInstalled, ...devices }))
    .finally(() => {
      probeInFlight = null;
    }));

/** Why a session must not start, or null. Checked by the main process on
 *  every Start Session, so the renderer can't be the only line of defence. */
export async function sessionBlockReason(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const { driverInstalled, driverVersion } = await probe();
  if (driverInstalled && driverVersionState(driverVersion) === "newer") {
    return (
      `Blocked: Tactrix driver ${driverVersion} is installed. Newer Tactrix software can update a clone ` +
      `cable's firmware and permanently break it. Reinstall version 1.01.4341 from Cable setup first.`
    );
  }
  return null;
}

// --- bundle ------------------------------------------------------------------

// Packaged builds carry the locked driver as an extraResource beside app.asar.
const driverDir = (): string =>
  app.isPackaged ? join(process.resourcesPath, "driver") : join(app.getAppPath(), "resources", "driver");

function readMeta(): DriverMeta | null {
  try {
    const meta = JSON.parse(readFileSync(join(driverDir(), META_FILE), "utf8"));
    return isValidMeta(meta) ? meta : null;
  } catch {
    return null;
  }
}

const isBundled = (): boolean =>
  readMeta() !== null && existsSync(join(driverDir(), ENCRYPTED_FILE));

// --- public API --------------------------------------------------------------

const gate = new PasskeyGate();
let installing = false;
// The decrypted installer, held only while the gate is unlocked.
let unlockedInstaller: Buffer | null = null;

const takeInstaller = (): Buffer | null => {
  if (!gate.isUnlocked()) unlockedInstaller = null;
  return unlockedInstaller;
};

export async function getCableSetupStatus(
  options: { full?: boolean } = {},
  preflight?: () => Promise<CablePreflight>
): Promise<CableSetupStatus> {
  const windows = process.platform === "win32";
  const [probed, preflightResult] = await Promise.all([
    windows
      ? probe()
      : Promise.resolve({ driverInstalled: false, cable: "unknown" as CableState, code: null, driverVersion: null }),
    windows && options.full && preflight ? preflight() : Promise.resolve(null),
  ]);
  return {
    platformSupported: windows,
    windowsBuild: windows ? parseWindowsBuild(release()) : null,
    driverInstalled: probed.driverInstalled,
    driverVersion: probed.driverInstalled ? probed.driverVersion : null,
    driverVersionState: probed.driverInstalled ? driverVersionState(probed.driverVersion) : "unknown",
    driverBundled: windows && isBundled(),
    cable: probed.cable,
    cableProblemCode: probed.code,
    preflight: preflightResult,
    lockedForSeconds: gate.lockedForSeconds(),
    unlocked: takeInstaller() !== null,
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

const UNAVAILABLE = "This copy of the app doesn't include the cable driver.";

// One passkey check at a time, so parallel guesses can't all pass the
// lockout check before any of them is counted.
let unlockQueue: Promise<unknown> = Promise.resolve();

export function unlockDriver(passkey: unknown): Promise<DriverUnlockResult> {
  const attempt = unlockQueue.then(() => tryUnlock(passkey));
  unlockQueue = attempt.catch(() => {});
  return attempt;
}

async function tryUnlock(passkey: unknown): Promise<DriverUnlockResult> {
  const meta = readMeta();
  if (process.platform !== "win32" || !meta || !existsSync(join(driverDir(), ENCRYPTED_FILE))) {
    return { ok: false, reason: "unavailable", message: UNAVAILABLE };
  }
  if (takeInstaller()) return { ok: true };
  // Checked before decrypting, so a locked gate costs no scrypt work.
  if (gate.lockedForSeconds() > 0) {
    return { ok: false, reason: "locked", message: "Too many wrong passkeys.", lockedForSeconds: gate.lockedForSeconds() };
  }
  // A wrong passkey fails GCM authentication; a right one yields bytes that
  // decryptDriver has already matched against the pinned SHA-256.
  const plain = await decryptDriver(await readFile(join(driverDir(), ENCRYPTED_FILE)), meta, passkey);
  const outcome = gate.record(plain !== null);
  if (outcome.ok) {
    unlockedInstaller = plain;
    return { ok: true };
  }
  return outcome.locked
    ? { ok: false, reason: "locked", message: "Too many wrong passkeys.", lockedForSeconds: outcome.lockedForSeconds }
    : { ok: false, reason: "bad_passkey", message: "That passkey isn't right.", attemptsLeft: outcome.attemptsLeft };
}

export async function installDriver(): Promise<DriverInstallResult> {
  if (process.platform !== "win32" || !isBundled()) {
    return { ok: false, reason: "unavailable", message: UNAVAILABLE };
  }
  const plain = takeInstaller();
  if (!plain) {
    return { ok: false, reason: "not_unlocked", message: "Enter the passkey first." };
  }
  if (installing) {
    return { ok: false, reason: "busy", message: "The driver installer is already open." };
  }

  installing = true;
  // A fresh private folder per install; removed again whatever happens.
  const workDir = await mkdtemp(join(tmpdir(), "vwd-driver-"));
  try {
    const installer = join(workDir, DRIVER_FILE);
    await writeFile(installer, plain);
    // Re-hash what is on disk at the point of launch: never run anything
    // but the pinned build.
    if (sha256(await readFile(installer)) !== DRIVER_SHA256) {
      return { ok: false, reason: "failed", message: "The driver failed its integrity check, so it was not started." };
    }
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
    await rm(workDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
