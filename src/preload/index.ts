import { contextBridge } from "electron";
import { ipcRenderer } from "electron/renderer";
import {
  DiagnosticCommand,
  DiagnosticEvent,
  GetVersionsFn,
} from "@shared/types";

// The preload process plays a middleware role in bridging
// the call from the front end, and the function in the main process

if (!process.contextIsolated) {
  throw new Error("Context isolation must be enabled in the Browser window");
}

try {
  // Front end can call the function by using window.context.<Function name>
  contextBridge.exposeInMainWorld("context", {
    getVersions: (...args: Parameters<GetVersionsFn>) =>
      ipcRenderer.invoke("getVersions", ...args),
    triggerIPC: () => ipcRenderer.invoke("triggerIPC"),
    startDiagnostic: () => ipcRenderer.invoke("diagnostic:start"),
    stopDiagnostic: () => ipcRenderer.invoke("diagnostic:stop"),
    sendDiagnosticCommand: (command: DiagnosticCommand) =>
      ipcRenderer.invoke("diagnostic:command", command),
    checkForUpdate: () => ipcRenderer.invoke("update:check"),
    // No URL argument crosses the bridge: the main process opens only the
    // release URL it resolved itself in the last check.
    openUpdateDownload: () => ipcRenderer.invoke("update:openDownload"),
    getCableSetupStatus: (options?: { full?: boolean }) =>
      ipcRenderer.invoke("cable:status", { full: options?.full === true }),
    unlockDriver: (passkey: string) =>
      ipcRenderer.invoke("cable:unlockDriver", passkey),
    installDriver: () => ipcRenderer.invoke("cable:installDriver"),
    onDiagnosticEvent: (
      listener: (event: DiagnosticEvent) => void
    ): (() => void) => {
      const subscription = (
        _event: unknown,
        diagnosticEvent: DiagnosticEvent
      ): void => listener(diagnosticEvent);
      ipcRenderer.on("diagnostic:event", subscription);
      return () => {
        ipcRenderer.removeListener("diagnostic:event", subscription);
      };
    },
  });
} catch (error) {
  console.error("Error occured when establishing context bridge: ", error);
}
