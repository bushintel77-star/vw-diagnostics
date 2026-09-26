import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MonitorProcess, pythonCandidates } from '../scripts/monitor-process.mjs';

function child() {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.exitCode = null; proc.signalCode = null;
  proc.close = (code = 0) => { proc.exitCode = code; proc.stdout.end(); proc.stderr.end(); proc.emit('close', code); };
  proc.kill = () => { proc.close(1); return true; };
  return proc;
}
const ready = { ready: true, python: 'legacy-python', bitness: 32, dll: 'legacy.dll' };
const setup = (proc, result = ready) => { proc.stdout.write(JSON.stringify(result)); proc.close(result.ready ? 0 : 2); };

test('explicit Python override is authoritative', () => {
  assert.deepEqual(pythonCandidates({ VWD_PYTHON: 'custom.exe' }, 'win32'), [{ command: 'custom.exe', args: [] }]);
});

test('preflight falls back, first live burst is retained, and only one live process is opened', async () => {
  const events = []; const calls = []; let live;
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: {}, platform: 'win32', spawn(command, args) {
    calls.push([command, args]); const p = child();
    queueMicrotask(() => {
      if (calls.length === 1) p.emit('error', new Error('missing Python'));
      else if (args.includes('--preflight')) setup(p);
      else { live = p; p.stdout.write('{"type":"status","phase":"starting"}\n{"type":"info","info":{}}\n'); }
    });
    return p;
  }});
  assert.equal((await host.start()).started, true);
  assert.deepEqual(events.map(e => e.type), ['log', 'status', 'info']);
  assert.equal(calls.filter(([, args]) => !args.includes('--preflight')).length, 1);
  assert.equal((await host.start()).started, false);
  live.close();
});

test('incompatible explicit interpreter reports preflight error without opening a driver', async () => {
  const calls = []; const events = [];
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: { VWD_PYTHON: 'wrong.exe' }, spawn(command, args) {
    calls.push(args); const p = child(); queueMicrotask(() => setup(p, { ready: false, message: '32-bit DLL needs 32-bit Python' })); return p;
  }});
  assert.equal((await host.start()).started, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--preflight'));
  assert.match(events.at(-1).message, /32-bit/);
});

test('driver error survives process exit instead of turning into disconnected', async () => {
  const events = [];
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: { VWD_PYTHON: 'legacy' }, spawn(command, args) {
    const p = child(); queueMicrotask(() => {
      if (args.includes('--preflight')) setup(p);
      else { p.stdout.write('{"type":"status","phase":"error","message":"driver blocked"}\n'); p.close(1); }
    }); return p;
  }});
  await host.start();
  assert.equal(events.at(-1).message, 'driver blocked');
  assert.equal(host.running, false);
});

test('startup stderr is preserved and live launch failure does not try another driver', async () => {
  const calls = []; const events = [];
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: {}, platform: 'win32', spawn(command, args) {
    calls.push(args); const p = child(); queueMicrotask(() => {
      if (args.includes('--preflight')) setup(p);
      else { p.stderr.write('missing bundled module'); p.close(1); }
    }); return p;
  }});
  assert.match((await host.start()).message, /missing bundled module/);
  assert.equal(calls.length, 2);
});

test('concurrent starts and stopping during preflight cannot spawn a live session', async () => {
  let probe; const calls = [];
  const host = new MonitorProcess('monitor.py', () => {}, { env: {}, platform: 'win32', spawn(command, args) {
    calls.push(args); probe = child(); return probe;
  }});
  const starting = host.start();
  assert.equal((await host.start()).started, false);
  const stopping = host.stop();
  setup(probe);
  assert.equal((await starting).started, false);
  await stopping;
  assert.equal(calls.length, 1);
  assert.equal(host.running, false);
});

test('stopping waits for the old child and suppresses its final events', async () => {
  let live; const events = [];
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: { VWD_PYTHON: 'legacy' }, spawn(command, args) {
    const p = child(); queueMicrotask(() => {
      if (args.includes('--preflight')) setup(p);
      else { live = p; p.stdout.write('{"type":"status","phase":"starting"}\n'); }
    }); return p;
  }});
  await host.start();
  const stopping = host.stop();
  assert.equal((await host.start()).started, false);
  live.stdout.write('{"type":"error","message":"old session"}\n'); live.close();
  await stopping;
  assert.equal(events.some(e => e.message === 'old session'), false);
  assert.equal(events.at(-1).message, 'Session stopped by user.');
});

test('the final baselines save from a stopping monitor is still delivered', async () => {
  let live; const events = [];
  const host = new MonitorProcess('monitor.py', e => events.push(e), { env: { VWD_PYTHON: 'legacy' }, spawn(command, args) {
    const p = child(); queueMicrotask(() => {
      if (args.includes('--preflight')) setup(p);
      else { live = p; p.stdout.write('{"type":"status","phase":"starting"}\n'); }
    }); return p;
  }});
  await host.start();
  const stopping = host.stop();
  live.stdout.write('{"type":"baselines","vin":"WV1","sessions":1,"channels":{}}\n');
  live.stdout.write('{"type":"status","phase":"disconnected","message":"Session ended"}\n');
  await new Promise(resolve => setImmediate(resolve));
  live.close();
  await stopping;
  assert.equal(events.some(e => e.type === 'baselines' && e.vin === 'WV1'), true);
  assert.equal(events.some(e => e.message === 'Session ended'), false);
});
