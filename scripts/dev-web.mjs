/**
 * Web viewer host: runs the REAL Python diagnostic monitor and streams its
 * NDJSON events to browser tabs over SSE (events) + HTTP POST (commands),
 * alongside the vite dev server for the renderer. This gives the browser
 * dashboard the genuine monitor pipeline instead of the page-local demo.
 *
 *   npm run dev:web   → vite on :5174, live bridge on :5175
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const LIVE_PORT = 5175;
const VITE_PORT = 5174;

// Per-run bearer token. The mutating endpoints require it via X-Live-Token;
// /status serves it to the vite dev page (the only CORS-trusted origins).
// This guards against malicious web pages: a cross-origin site cannot read
// the token response (no ACAO) nor send the header without a preflight the
// allowlist rejects. It is NOT a general access control — any local process
// can read /status directly, which is fine for a dev-only bridge bound to
// loopback.
const LIVE_TOKEN = randomUUID();
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${VITE_PORT}`,
  `http://127.0.0.1:${VITE_PORT}`,
]);

/** @type {import("node:child_process").ChildProcess | null} */
let monitor = null;
const sseClients = new Set();
// Late subscribers (page reloads) must still see the session's catalogs and
// current state, so the last event of each type is replayed on connect.
const REPLAY_TYPES = new Set(["info", "dids", "dtc", "analysis", "deletions", "mods", "live", "status", "pull", "verification", "flash"]);
const lastByType = new Map();

function broadcastLine(line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    if (REPLAY_TYPES.has(event.type)) lastByType.set(event.type, line);
  } catch {
    // non-JSON line, just forward
  }
  for (const res of sseClients) res.write(`data: ${line}\n\n`);
}

function broadcastEvent(event) {
  broadcastLine(JSON.stringify(event));
}

const PYTHON_CANDIDATES =
  process.platform === "win32"
    ? [["python", []], ["py", ["-3"]]]
    : [["python3", []], ["python", []]];

function startMonitor(simulate = true) {
  if (monitor) return { started: false, message: "A session is already running." };
  for (const [command, baseArgs] of PYTHON_CANDIDATES) {
    let proc;
    try {
      proc = spawn(
        command,
        [...baseArgs, "resources/j2534_monitor.py", ...(simulate ? ["--simulate"] : [])],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
      );
    } catch {
      continue;
    }
    let won = false;
    proc.on("error", (error) => {
      if (error.code === "ENOENT" && !won) monitor = null;
    });
    proc.stdout.once("data", () => {
      won = true;
    });
    proc.on("close", (code) => {
      if (monitor === proc) monitor = null;
      broadcastEvent({
        type: "status",
        phase: "disconnected",
        message: code === 0 ? "Monitor exited." : `Monitor exited with code ${code}.`,
        mode: "simulate",
      });
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on("line", broadcastLine);
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => console.warn("[monitor]", chunk.trimEnd()));
    proc.stdin?.on("error", () => {});
    monitor = proc;
    return { started: true, message: "Monitor started." };
  }
  return { started: false, message: "No Python interpreter found." };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// CORS is an explicit allowlist, not a wildcard: echo the request Origin only
// for the vite dev origins; absent or unlisted origins get no ACAO at all.
function corsHeaders(req) {
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Live-Token",
    Vary: "Origin",
  };
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function authorized(req) {
  return req.headers["x-live-token"] === LIVE_TOKEN;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${LIVE_PORT}`);
  const CORS = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/status") {
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ running: monitor !== null, token: LIVE_TOKEN }));
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      ...CORS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    // Replay the current session state so a freshly loaded page is complete.
    for (const line of lastByType.values()) res.write(`data: ${line}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && ["/start", "/stop", "/command"].includes(url.pathname) && !authorized(req)) {
    res.writeHead(403, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, message: "Forbidden: missing or invalid X-Live-Token." }));
  }

  if (req.method === "POST" && url.pathname === "/start") {
    const body = await readBody(req);
    const result = startMonitor(body.simulate !== false);
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify(result));
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    if (monitor) {
      monitor.kill();
      monitor = null;
    }
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ started: false, message: "Stopped." }));
  }

  if (req.method === "POST" && url.pathname === "/command") {
    const command = await readBody(req);
    if (!monitor?.stdin?.writable) {
      res.writeHead(409, { ...CORS, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, message: "No session running." }));
    }
    monitor.stdin.write(JSON.stringify(command) + "\n");
    res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, message: "Command sent." }));
  }

  res.writeHead(404, CORS);
  res.end();
});

server.listen(LIVE_PORT, "127.0.0.1", () => {
  console.log(`[live] monitor bridge on http://127.0.0.1:${LIVE_PORT}`);
  console.log(`[live] session token: ${LIVE_TOKEN}`);
});

// Run vite alongside and tear everything down together.
const vite = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["vite", "serve", "src/renderer", "--port", String(VITE_PORT), "--strictPort"],
  { stdio: "inherit", shell: true }
);

function shutdown() {
  for (const res of sseClients) res.end();
  server.close();
  if (monitor) monitor.kill();
  vite.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
vite.on("exit", shutdown);
