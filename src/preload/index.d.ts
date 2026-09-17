import {
  GetVersionsFn,
  RunParserFn,
  SendDiagnosticCommandFn,
  StartDiagnosticFn,
  StopDiagnosticFn,
  OnDiagnosticEventFn,
} from "@shared/types";

// Type definition for the preload process
declare global {
  interface Window {
    context: {
      getVersions: GetVersionsFn;
      triggerIPC: () => void;
      runParser: RunParserFn;
      startDiagnostic: StartDiagnosticFn;
      stopDiagnostic: StopDiagnosticFn;
      sendDiagnosticCommand: SendDiagnosticCommandFn;
      onDiagnosticEvent: OnDiagnosticEventFn;
    };
  }
}
