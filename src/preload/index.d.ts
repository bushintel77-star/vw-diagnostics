import {
  CheckForUpdateFn,
  GetCableSetupStatusFn,
  GetVersionsFn,
  InstallDriverFn,
  UnlockDriverFn,
  OpenUpdateDownloadFn,
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
      startDiagnostic: StartDiagnosticFn;
      stopDiagnostic: StopDiagnosticFn;
      sendDiagnosticCommand: SendDiagnosticCommandFn;
      onDiagnosticEvent: OnDiagnosticEventFn;
      checkForUpdate: CheckForUpdateFn;
      openUpdateDownload: OpenUpdateDownloadFn;
      getCableSetupStatus: GetCableSetupStatusFn;
      unlockDriver: UnlockDriverFn;
      installDriver: InstallDriverFn;
    };
  }
}
