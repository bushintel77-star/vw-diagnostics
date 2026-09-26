import { MonitorProcess } from "../../../scripts/monitor-process.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { app, WebContents } from "electron";
import monitorScript from "../../../resources/j2534_monitor.py?asset&asarUnpack";
// Bundled alongside the monitor so `import uds` resolves in packaged builds.
import udsModule from "../../../resources/uds.py?asset&asarUnpack";
import j2534Module from "../../../resources/j2534.py?asset&asarUnpack";
void udsModule;
void j2534Module;
import {
  BaselineStateFile,
  DiagnosticCommand,
  DiagnosticCommandResult,
  DiagnosticEvent,
  DiagnosticFlashEvent,
  DiagnosticSessionResult,
} from "@shared/types";

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
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(baselineStatePath(), JSON.stringify(state), "utf8");
  } catch (error) {
    console.warn("[diagnostic] could not persist baseline state:", error);
  }
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
    if (data.length === 0 || data.length !== complete.bytes || (complete.totalBytes != null && data.length !== complete.totalBytes)) {
      throw new Error("Incomplete backup: received byte count does not match completion event");
    }
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

let host: MonitorProcess | null = null;
let baselineWrites: Promise<void> = Promise.resolve();

export const isDiagnosticRunning = (): boolean => host?.running ?? false;

export async function startDiagnostic(sender: WebContents): Promise<DiagnosticSessionResult> {
  if (host?.running) return { started: false, message: "A diagnostic session is already running." };
  flashChunks = [];
  host = new MonitorProcess(monitorScript, (event) => {
    if (event.type === "baselines") {
      // Serialize read-modify-write updates so final/session events cannot race.
      baselineWrites = baselineWrites.then(async () => {
        const state = await loadBaselineState();
        state.vins[event.vin] = { sessions: event.sessions, channels: event.channels };
        await persistBaselineState(state);
      }).catch((error) => console.warn("[diagnostic] baseline save failed:", error));
    } else if (event.type === "flash") {
      handleFlashEvent(sender, event);
    } else {
      emit(sender, event);
    }
  });
  const sessionHost = host;
  const result = await sessionHost.start();
  if (result.started && host === sessionHost) {
    const state = await loadBaselineState();
    if (Object.keys(state.vins).length) await sessionHost.send({ cmd: "seed_baseline", vehicles: state.vins });
  }
  return result;
}

export async function stopDiagnostic(): Promise<DiagnosticSessionResult> {
  const result = host ? await host.stop() : { started: false, message: "Diagnostic session stopped." };
  await baselineWrites;
  return result;
}

export async function sendDiagnosticCommand(command: DiagnosticCommand): Promise<DiagnosticCommandResult> {
  return host ? host.send(command) : { ok: false, message: "No diagnostic session is running." };
}
