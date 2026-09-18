/**
 * Live web bridge. In a plain browser there is no Electron preload; if the
 * local live server (scripts/dev-web.mjs) is running, connect to the REAL
 * Python monitor over SSE/HTTP and expose it as `window.context`. When the
 * server is unreachable we install an honest "not connected" context —
 * never fabricated data.
 */
import {
  DiagnosticCommand,
  DiagnosticCommandResult,
  DiagnosticEventListener,
  DiagnosticEvent,
  DiagnosticSessionResult,
} from "@shared/types";

// Same-origin proxy path (vite proxies /live to the monitor server); the
// direct address is the fallback when the renderer is served elsewhere.
const LIVE_BASES = ["/live", "http://127.0.0.1:5175"];

let liveActive = false;

export const isBrowserLive = (): boolean => liveActive;

async function post(
  base: string,
  path: string,
  body: unknown,
  token: string
): Promise<Response | null> {
  try {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Live-Token": token },
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
  // The bridge mints a per-run token and serves it via /status; mutating
  // endpoints require it as X-Live-Token.
  let token = "";
  for (const candidate of LIVE_BASES) {
    try {
      const probe = await fetch(candidate + "/status", {
        signal:
          typeof AbortSignal.timeout === "function"
            ? AbortSignal.timeout(800)
            : undefined,
      });
      if (probe.ok) {
        const status = (await probe.json()) as { token?: unknown };
        if (typeof status.token !== "string") continue;
        token = status.token;
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
    startDiagnostic: async (): Promise<DiagnosticSessionResult> => {
      const response = await post(base, "/start", {}, token);
      if (!response) {
        return { started: false, message: "Live server unreachable." };
      }
      return response.json();
    },
    stopDiagnostic: async (): Promise<DiagnosticSessionResult> => {
      const response = await post(base, "/stop", {}, token);
      if (!response) {
        return { started: false, message: "Live server unreachable." };
      }
      return response.json();
    },
    sendDiagnosticCommand: async (
      command: DiagnosticCommand
    ): Promise<DiagnosticCommandResult> => {
      const response = await post(base, "/command", command, token);
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
    // Update checks are a packaged-app concern; the browser bridge reports
    // "unknown" so the banner stays silent (as designed for failures).
    checkForUpdate: () =>
      Promise.resolve({
        status: "unknown" as const,
        currentVersion: "web",
        reason: "browser session",
      }),
    openUpdateDownload: () => Promise.resolve(),
  };

  return true;
}

/**
 * Browser without the dev bridge: an honest "not connected" context. Every
 * call reports that no monitor is reachable — fabricated vehicle data is
 * never served as a stand-in.
 */
const installOfflineContext = (): void => {
  const notConnected = {
    started: false,
    message:
      "No monitor bridge — start the desktop app, or npm run dev:web for a browser session.",
  };
  window.context = {
    getVersions: () =>
      Promise.resolve({ electron: "web", chrome: "web", node: "web" } as never),
    triggerIPC: () => {},
    startDiagnostic: () => Promise.resolve(notConnected),
    stopDiagnostic: () => Promise.resolve(notConnected),
    sendDiagnosticCommand: () =>
      Promise.resolve({ ok: false, message: "No diagnostic session is running." }),
    onDiagnosticEvent: () => () => {},
    checkForUpdate: () =>
      Promise.resolve({
        status: "unknown" as const,
        currentVersion: "web",
        reason: "browser session",
      }),
    openUpdateDownload: () => Promise.resolve(),
  };
};

/** Installs the live bridge when available, else the offline context. */
export const ensureContext = async (): Promise<void> => {
  if (typeof window === "undefined" || window.context) {
    return;
  }
  if (await tryLiveBridge()) {
    return;
  }
  installOfflineContext();
};
