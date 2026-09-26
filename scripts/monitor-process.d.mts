import type { DiagnosticEvent, DiagnosticCommand, DiagnosticSessionResult, DiagnosticCommandResult } from '../src/shared/types';
export interface PreflightResult {
  ready: boolean;
  message: string;
  python?: string;
  bitness?: number;
  dll?: string;
  stopped?: boolean;
}
export class MonitorProcess {
  constructor(script: string, onEvent: (event: DiagnosticEvent) => void);
  readonly running: boolean;
  preflight(): Promise<PreflightResult>;
  start(): Promise<DiagnosticSessionResult>;
  stop(): Promise<DiagnosticSessionResult>;
  send(command: DiagnosticCommand): Promise<DiagnosticCommandResult>;
}
