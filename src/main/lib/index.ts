import { electronAPI } from "@electron-toolkit/preload";
import { GetVersionsFn } from "@shared/types";
import { getCableSetupStatus as probeCableSetup } from "./cableSetup";
import { runPythonPreflight } from "./diagnostic";

// Thie file stores functions used for the front-end
// to communicate with the main process directly

export {
  startDiagnostic,
  stopDiagnostic,
  isDiagnosticRunning,
  sendDiagnosticCommand,
} from "./diagnostic";

export { checkForUpdate, openUpdateDownload } from "./update";

export { installDriver, unlockDriver, sessionBlockReason } from "./cableSetup";

// A full check adds the monitor's read-only Python <-> driver preflight.
export const getCableSetupStatus = (options: { full?: boolean }) =>
  probeCableSetup(options, runPythonPreflight);

export const getVersions: GetVersionsFn = async () => {
  const versions = electronAPI.process.versions;
  return versions;
};

export const triggerIPC = () => {
  console.log("IPC invoked in console");
};
