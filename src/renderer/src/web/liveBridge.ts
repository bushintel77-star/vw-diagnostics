/**
 * Live web bridge. In a plain browser there is no Electron preload; if the
 * local live server (scripts/dev-web.mjs) is running, connect to the REAL
 * Python monitor over SSE/HTTP and expose it as `window.context`. Only when
 * that server is unreachable do we fall back to the page-local demo bridge.
 */
import {
  DiagnosticCommand,
  DiagnosticCommandResult,
  DiagnosticEventListener,
  DiagnosticEvent,
  DiagnosticSessionResult,
  StartDiagnosticOptions,
} from "@shared/types";
import { ensureDemoContext } from "./demoBridge";

// Same-origin proxy path (vite proxies /live to the monitor server); the
// direct address is the fallback when the renderer is served elsewhere.
const LIVE_BASES = ["/live", "http://127.0.0.1:5175"];

let liveActive = false;

export const isBrowserLive = (): boolean => liveActive;

async function post(base: string, path: string, body: unknown): Promise<Response | null> {
  try {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response;
  } catch {
    return null;
  }
}

async function tryLiveBridge(): Promise<boolean> {
  // jsdom (tests) and non-browser shells have no EventSource.
  if (typeof fetch === "undefined" || typeof EventSource === "undefined") {
    return false;
  }
  let base: string | null = null;
  for (const candidate of LIVE_BASES) {
    try {
      const probe = await fetch(candidate + "/status", {
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(800)
            : undefined,
      });
      if (probe.ok) {
        base = candidate;
        break;
      }
    } catch {
      // try next base
    }
  }
  if (base === null) return false;

  const listeners = new Set<DiagnosticEventListener>();
  // Events can arrive (server replay + session start burst) before the App
  // mounts and subscribes; buffer them for the first subscriber.
  const pending: DiagnosticEvent[] = [];
  const events = new EventSource(base + "/events");
  events.onmessage = (message: MessageEvent<string>): void => {
    try {
      const event = JSON.parse(message.data) as DiagnosticEvent;
      if (listeners.size === 0) {
        pending.push(event);
        if (pending.length > 200) pending.shift();
        return;
      }
      listeners.forEach((listener) => listener(event));
    } catch {
      // ignore malformed frames
    }
  };

  liveActive = true;
  window.context = {
    getVersions: () =>
      Promise.resolve({ electron: "web", chrome: "web", node: "web" } as never),
    triggerIPC: () => {},
    startDiagnostic: async (options: StartDiagnosticOptions): Promise<DiagnosticSessionResult> => {
      const response = await post(base, "/start", options);
      if (!response) {
        return { started: false, message: "Live server unreachable." };
      }
      return response.json();
    },
    stopDiagnostic: async (): Promise<DiagnosticSessionResult> => {
      const response = await post(base, "/stop", {});
      if (!response) {
        return { started: false, message: "Live server unreachable." };
      }
      return response.json();
    },
    sendDiagnosticCommand: async (
      command: DiagnosticCommand
    ): Promise<DiagnosticCommandResult> => {
      const response = await post(base, "/command", command);
      if (!response) {
        return { ok: false, message: "Live server unreachable." };
      }
      if (response.status === 409) {
        return { ok: false, message: "No diagnostic session is running." };
      }
      return response.json();
    },
    onDiagnosticEvent: (listener: DiagnosticEventListener): (() => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        // First subscriber: deliver everything buffered during mount.
        const buffered = [...pending];
        pending.length = 0;
        for (const event of buffered) listener(event);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };

  // Viewer convenience: start a simulated-transport session on the real monitor.
  void post(base, "/start", { simulate: true });
  return true;
}

/** Installs the live bridge when available, else the demo bridge. */
export const ensureContext = async (): Promise<void> => {
  if (typeof window === "undefined" || window.context) {
    return;
  }
  if (await tryLiveBridge()) {
    return;
  }
  ensureDemoContext();
};
