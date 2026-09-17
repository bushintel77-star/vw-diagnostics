import { contextBridge } from "electron";
import { ipcRenderer } from "electron/renderer";
import {
  DiagnosticCommand,
  DiagnosticEvent,
  GetVersionsFn,
  RunParserFn,
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
    runParser: (...args: Parameters<RunParserFn>) =>
      ipcRenderer.invoke("runParser", ...args),
    startDiagnostic: (options: { simulate: boolean }) =>
      ipcRenderer.invoke("diagnostic:start", options),
    stopDiagnostic: () => ipcRenderer.invoke("diagnostic:stop"),
    sendDiagnosticCommand: (command: DiagnosticCommand) =>
      ipcRenderer.invoke("diagnostic:command", command),
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
