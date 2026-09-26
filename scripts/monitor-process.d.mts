import type { DiagnosticEvent, DiagnosticCommand, DiagnosticSessionResult, DiagnosticCommandResult } from '../src/shared/types';
export class MonitorProcess {
  constructor(script: string, onEvent: (event: DiagnosticEvent) => void);
  readonly running: boolean;
  start(): Promise<DiagnosticSessionResult>;
  stop(): Promise<DiagnosticSessionResult>;
  send(command: DiagnosticCommand): Promise<DiagnosticCommandResult>;
}
