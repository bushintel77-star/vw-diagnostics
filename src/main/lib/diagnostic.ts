import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { app, WebContents } from "electron";
import monitorScript from "../../../resources/j2534_monitor.py?asset&asarUnpack";
// Bundled alongside the monitor so `import uds` resolves in packaged builds.
import udsModule from "../../../resources/uds.py?asset&asarUnpack";
void udsModule;
import {
  BaselineStateFile,
  DiagnosticCommand,
  DiagnosticCommandResult,
  DiagnosticEvent,
  DiagnosticFlashEvent,
  DiagnosticSessionResult,
} from "@shared/types";

const FIRST_LINE_TIMEOUT_MS = 10_000;
// The monitor itself does no file I/O; the main process owns persistence of
// learned per-VIN baselines at a fixed app-managed path.
const baselineStatePath = (): string =>
  join(app.getPath("userData"), "diagnostic-state.json");

async function loadBaselineState(): Promise<BaselineStateFile> {
  try {
    const raw = await readFile(baselineStatePath(), "utf8");
    const parsed = JSON.parse(raw) as BaselineStateFile;
    return parsed && typeof parsed === "object" && parsed.vins ? parsed : { version: 1, vins: {} };
  } catch {
    return { version: 1, vins: {} };
  }
}

async function persistBaselineState(state: BaselineStateFile): Promise<void> {
  try {
    await writeFile(baselineStatePath(), JSON.stringify(state), "utf8");
  } catch (error) {
    console.warn("[diagnostic] could not persist baseline state:", error);
  }
}

let child: ChildProcess | null = null;
let stoppedByUser = false;

interface PythonCandidate {
  command: string;
  args: string[];
}

// Monitor interpreter resolution: PARSER_PYTHON override, then the
// usual interpreter names per platform.
function pythonCandidates(): PythonCandidate[] {
  const candidates: PythonCandidate[] = [];
  if (process.env.PARSER_PYTHON) {
    candidates.push({ command: process.env.PARSER_PYTHON, args: [] });
  }
  if (process.platform === "win32") {
    candidates.push(
      { command: "python", args: [] },
      { command: "py", args: ["-3"] }
    );
  } else {
    candidates.push(
      { command: "python3", args: [] },
      { command: "python", args: [] }
    );
  }
  return candidates;
}

const emit = (sender: WebContents, event: DiagnosticEvent): void => {
  if (!sender.isDestroyed()) {
    sender.send("diagnostic:event", event);
  }
};

// ---------------------------------------------------------------------------
// Stock-ECU read/backup. The monitor streams base64 chunks as flash events
// (it performs no file I/O); this process is the persistence boundary. The
// written file is the rollback path for every future write to the ECU.
// ---------------------------------------------------------------------------

let flashChunks: Buffer[] = [];

const backupsDir = (): string => join(app.getPath("userData"), "backups");

async function persistBackup(
  sender: WebContents,
  complete: DiagnosticFlashEvent
): Promise<void> {
  const data = Buffer.concat(flashChunks);
  flashChunks = [];
  try {
    await mkdir(backupsDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(backupsDir(), `ecu-backup-${stamp}.bin`);
    await writeFile(path, data);
    emit(sender, {
      ...complete,
      path,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
  } catch (error) {
    emit(sender, {
      type: "flash",
      phase: "error",
      message: `backup write failed: ${String(error)}`,
    });
  }
}

function handleFlashEvent(sender: WebContents, event: DiagnosticFlashEvent): void {
  if (event.phase === "start") {
    flashChunks = [];
  } else if (event.phase === "progress" && event.chunkB64) {
    flashChunks.push(Buffer.from(event.chunkB64, "base64"));
    return; // progress chunks never cross into the renderer
  } else if (event.phase === "complete") {
    void persistBackup(sender, event);
    return;
  }
  emit(sender, { ...event, chunkB64: undefined });
}

/**
 * Spawns one candidate and resolves with the process once it prints its
 * first stdout line (proving a real interpreter is running the script).
 * Resolves null when this candidate can't run so the next one applies.
 */
function trySpawn(
  candidate: PythonCandidate,
  args: string[]
): Promise<ChildProcess | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(candidate.command, [...candidate.args, monitorScript, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (won: ChildProcess | null): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(won);
      }
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(null);
    }, FIRST_LINE_TIMEOUT_MS);

    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") finish(null);
    });
    // Also covers the Windows Store python stub, which spawns fine but
    // exits with a message instead of ever printing a JSON line.
    proc.on("close", () => finish(null));
    if (proc.stdout) {
      proc.stdout.once("data", () => finish(proc));
    }
  });
}

export const isDiagnosticRunning = (): boolean => child !== null;

export async function startDiagnostic(
  sender: WebContents
): Promise<DiagnosticSessionResult> {
  if (child) {
    return { started: false, message: "A diagnostic session is already running." };
  }

  // No mode flag: the monitor only ever attempts a real J2534 connection
  // and reports the genuine TransportError when none is attached.
  for (const candidate of pythonCandidates()) {
    const proc = await trySpawn(candidate, []);
    if (!proc) continue;

    child = proc;
    stoppedByUser = false;
    let stderr = "";

    if (proc.stdout) {
      // The once()-bound data listener in trySpawn does not consume the
      // chunk; readline receives every line including the first.
      const lines = createInterface({ input: proc.stdout });
      lines.on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as DiagnosticEvent;
          // Learned baselines are persisted here, not in the monitor.
          if (event.type === "baselines") {
            void (async () => {
              const state = await loadBaselineState();
              state.version = 1;
              state.vins[event.vin] = {
                sessions: event.sessions,
                channels: event.channels,
              };
              await persistBaselineState(state);
            })();
            return;
          }
          // Flash chunks are assembled here; the renderer only ever sees
          // progress/complete/error with the final file path.
          if (event.type === "flash") {
            handleFlashEvent(sender, event);
            return;
          }
          emit(sender, event);
        } catch {
          console.warn("[diagnostic] dropping malformed JSON line:", line);
        }
      });
    }
    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-2000);
        console.warn("[diagnostic] stderr:", chunk.trimEnd());
      });
    }
    // EPIPE if the monitor exits between a command write and delivery.
    proc.stdin?.on("error", () => {});
    proc.on("close", (code) => {
      if (child === proc) {
        child = null;
      }
      emit(sender, {
        type: "status",
        phase: "disconnected",
        message: stoppedByUser
          ? "Session stopped by user."
          : code === 0
            ? "Diagnostic session ended."
            : `Monitor exited with code ${code}. ${stderr.trim()}`.trim(),
        mode: "live",
      });
    });

    // Seed any cross-session baselines persisted for this machine so the
    // analysis tier starts with prior knowledge of the vehicle.
    const baselineState = await loadBaselineState();
    if (Object.keys(baselineState.vins).length > 0) {
      await sendDiagnosticCommand({
        cmd: "seed_baseline",
        vehicles: baselineState.vins,
      });
    }

    return {
      started: true,
      message: "Diagnostic monitor started; attempting live J2534 connection.",
    };
  }

  return {
    started: false,
    message:
      "No Python interpreter found. Install Python 3 or set PARSER_PYTHON to the interpreter path.",
  };
}

export async function stopDiagnostic(): Promise<DiagnosticSessionResult> {
  if (!child) {
    return { started: false, message: "No diagnostic session is running." };
  }
  stoppedByUser = true;
  child.kill();
  child = null;
  return { started: false, message: "Diagnostic session stopped." };
}

/**
 * Sends a JSON command to the running monitor over stdin. This is the
 * channel every future UDS operation (clear codes, output tests, basic
 * settings) flows through; the monitor acknowledges via event stream.
 */
export async function sendDiagnosticCommand(
  command: DiagnosticCommand
): Promise<DiagnosticCommandResult> {
  if (!child?.stdin?.writable) {
    return {
      ok: false,
      message: "No diagnostic session is running.",
    };
  }
  try {
    child.stdin.write(JSON.stringify(command) + "\n");
  } catch (error) {
    return { ok: false, message: `Failed to send command: ${String(error)}` };
  }
  return { ok: true, message: "Command sent to the monitor." };
}
