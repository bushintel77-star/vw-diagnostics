import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function pythonCandidates(env = process.env, platform = process.platform) {
  const override = env.VWD_PYTHON || env.PARSER_PYTHON;
  // An explicit path is authoritative. Never silently switch architectures.
  if (override) return [{ command: override, args: [] }];
  return platform === 'win32'
    ? [{ command: 'py', args: ['-3-32'] }, { command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
}

/** Shared desktop/web host. Preflight reads files only; live mode starts once. */
export class MonitorProcess {
  constructor(script, onEvent, options = {}) {
    this.script = script;
    this.onEvent = onEvent;
    this.spawn = options.spawn || spawn;
    this.env = options.env || process.env;
    this.platform = options.platform || process.platform;
    this.timeoutMs = options.timeoutMs || 10000;
    this.proc = null;
    this.starting = null;
    this.generation = 0;
    this.stopping = null;
    // The process being stopped: its last data events (the final baselines
    // save) are still delivered while it shuts down; its status is not.
    this.stoppingProc = null;
  }

  get running() { return this.starting !== null || this.proc !== null || this.stopping !== null; }

  async start() {
    if (this.running || this.stopping) return { started: false, message: 'A session is already running or stopping.' };
    const generation = ++this.generation;
    this.starting = this.launch(generation);
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  inspect(candidate, generation) {
    return new Promise((resolve) => {
      let proc;
      let output = '';
      let errors = '';
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        resolve(result);
      };
      const timer = setTimeout(() => {
        proc?.kill();
        finish({ ready: false, message: 'Python preflight timed out.' });
      }, this.timeoutMs);
      try {
        proc = this.spawn(candidate.command, [...candidate.args, '-u', this.script, '--preflight'], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env,
        });
        this.proc = proc;
        proc.stdin?.on('error', () => {});
        proc.stdin?.end();
        proc.stdout.on('data', (data) => { output = (output + data).slice(-64000); });
        proc.stderr.on('data', (data) => { errors = (errors + data).slice(-4000); });
        proc.on('error', (error) => finish({ ready: false, message: `${candidate.command}: ${error.message}` }));
        proc.on('close', (code) => {
          if (generation !== this.generation) return finish({ ready: false, message: 'Session stopped.' });
          try {
            const result = JSON.parse(output.trim());
            finish({ ...result, ready: code === 0 && result.ready === true });
          } catch {
            finish({ ready: false, message: errors.trim() || `${candidate.command}: no valid preflight output (exit ${code}).` });
          }
        });
      } catch (error) { finish({ ready: false, message: error.message }); }
    });
  }

  /** Read-only interpreter/driver check across the candidates; opens no
   *  device. First ready setup wins (with its candidate); otherwise the
   *  joined errors. A stop during the search abandons it. */
  async preflight(generation = this.generation) {
    const errors = [];
    for (const candidate of pythonCandidates(this.env, this.platform)) {
      const setup = await this.inspect(candidate, generation);
      if (generation !== this.generation) return { ready: false, stopped: true, message: 'Session stopped.' };
      if (setup.ready) return { ...setup, candidate };
      errors.push(setup.message);
    }
    return { ready: false, message: errors.join('\n') };
  }

  async launch(generation) {
    const setup = await this.preflight(generation);
    if (setup.stopped) return { started: false, message: setup.message };
    if (!setup.ready) {
      this.onEvent({ type: 'status', phase: 'error', mode: 'live', message: setup.message });
      return { started: false, message: setup.message };
    }
    this.onEvent({ type: 'log', message: `J2534 preflight: ${setup.bitness}-bit Python ${setup.python}; existing DLL ${setup.dll}` });
    return this.connect(setup.candidate, generation);
  }

  connect(candidate, generation) {
    return new Promise((resolve) => {
      let proc;
      let stderr = '';
      let errorSeen = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const reportError = (message) => {
        errorSeen = true;
        if (generation === this.generation) this.onEvent({ type: 'status', phase: 'error', mode: 'live', message });
        finish({ started: false, message });
      };
      const timer = setTimeout(() => {
        reportError('Diagnostic monitor produced no events before the startup timeout.');
        proc?.kill();
      }, this.timeoutMs);
      try {
        proc = this.spawn(candidate.command, [...candidate.args, '-u', this.script], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env,
        });
        this.proc = proc;
        // Attach the line parser immediately so the initial event burst is retained.
        const lines = createInterface({ input: proc.stdout });
        lines.on('line', (line) => {
          if (!line.trim()) return;
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (!event || typeof event.type !== 'string') return;
          if (generation !== this.generation) {
            if (proc === this.stoppingProc && event.type === 'baselines') this.onEvent(event);
            return;
          }
          if (event.type === 'error' || (event.type === 'status' && event.phase === 'error')) errorSeen = true;
          this.onEvent(event);
          finish({ started: true, message: 'Diagnostic monitor started; attempting live J2534 connection.' });
        });
        proc.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
        proc.stdin.on('error', () => {});
        proc.on('error', (error) => {
          if (this.proc === proc) this.proc = null;
          reportError(`Cannot start monitor: ${error.message}`);
        });
        proc.on('close', (code) => {
          lines.close();
          if (this.proc === proc) this.proc = null;
          if (generation === this.generation && !errorSeen) {
            if (code !== 0) reportError(`Monitor exited with code ${code}. ${stderr.trim()}`.trim());
            else this.onEvent({ type: 'status', phase: 'disconnected', mode: 'live', message: 'Diagnostic session ended.' });
          }
          finish({ started: false, message: errorSeen ? stderr || 'Monitor failed.' : 'Diagnostic session ended.' });
        });
      } catch (error) { reportError(error.message); }
    });
  }

  async stop() {
    if (this.stopping) return this.stopping;
    ++this.generation; // suppress callbacks from the old session
    const proc = this.proc;
    const pendingStart = this.starting;
    this.stoppingProc = proc;
    this.stopping = (async () => {
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise((resolve) => {
          proc.once('close', resolve);
          // EOF permits the monitor to close its device; kill if a driver is stuck.
          proc.stdin?.end();
          const timer = setTimeout(() => proc.kill(), 5000);
          proc.once('close', () => clearTimeout(timer));
        });
      }
      await pendingStart;
      this.proc = null;
      this.stoppingProc = null;
      this.onEvent({ type: 'status', phase: 'disconnected', mode: 'live', message: 'Session stopped by user.' });
      return { started: false, message: 'Diagnostic session stopped.' };
    })();
    try { return await this.stopping; }
    finally { this.stopping = null; }
  }

  send(command) {
    const proc = this.proc;
    if (this.starting || this.stopping || !proc?.stdin?.writable) {
      return Promise.resolve({ ok: false, message: 'No diagnostic session is running.' });
    }
    return new Promise((resolve) => {
      try {
        proc.stdin.write(JSON.stringify(command) + '\n', (error) => resolve(error
          ? { ok: false, message: `Failed to send command: ${error.message}` }
          : { ok: true, message: 'Command sent to the monitor.' }));
      } catch (error) { resolve({ ok: false, message: error.message }); }
    });
  }
}
