'use strict';

/**
 * tests/poll-reentrancy.test.js
 *
 * THE guard that poll() runs one sweep at a time (2026-10-04, found while adding the
 * immediate poll for WORK-TODO #4). The old check was only `isRunning`, set around a
 * TASK: and not around an ASK: answer, so an interval tick during a long ASK: started
 * a second concurrent sweep. poll() and pollNow() are extracted from bridge-agent.js's
 * SOURCE (requiring it starts the bridge) and run against a controllable sweep.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

function extractGuard(src) {
  const start = src.indexOf('let pollInFlight = false;');
  const end = src.indexOf('async function pollSweep()');
  if (start < 0 || end < 0 || end < start) throw new Error('poll guard not found in bridge-agent.js');
  return src.slice(start, end);
}

/** Build poll/pollNow from `code` around a sweep the test controls. */
function build(code, sweep) {
  const logs = [];
  const fakeConsole = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
  // eslint-disable-next-line no-new-func
  const make = new Function('pollSweep', 'console', `${code}\nreturn { poll, pollNow: typeof pollNow === 'function' ? pollNow : null };`);
  return { ...make(sweep, fakeConsole), logs };
}

function deferredSweep() {
  let release;
  let calls = 0;
  const sweep = () => { calls += 1; return new Promise((r) => { release = r; }); };
  return { sweep, release: () => release(), calls: () => calls };
}

describe('one sweep at a time', () => {
  test('a second call while a sweep is in flight does nothing and says so', async () => {
    const d = deferredSweep();
    const { poll } = build(extractGuard(SRC), d.sweep);
    const first = poll();
    const second = await poll();
    expect(second).toBe(false);
    expect(d.calls()).toBe(1);
    d.release();
    expect(await first).toBe(true);
  });

  test('the next call after a sweep finishes runs', async () => {
    const d = deferredSweep();
    const { poll } = build(extractGuard(SRC), d.sweep);
    const first = poll(); d.release(); await first;
    const next = poll(); d.release();
    expect(await next).toBe(true);
    expect(d.calls()).toBe(2);
  });

  test('a sweep that throws releases the guard, so polling does not stop for good', async () => {
    let n = 0;
    const { poll } = build(extractGuard(SRC), async () => { n += 1; if (n === 1) throw new Error('slack down'); });
    await expect(poll()).rejects.toThrow('slack down');
    expect(await poll()).toBe(true);
  });

  test('pollNow never throws and never rejects, whether skipped or failed', async () => {
    const d = deferredSweep();
    const ok = build(extractGuard(SRC), d.sweep);
    ok.poll();
    expect(() => ok.pollNow('dispatch')).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(ok.logs.join('\n')).toMatch(/skipped: a sweep is in flight/);

    const bad = build(extractGuard(SRC), async () => { throw new Error('boom'); });
    bad.pollNow('dispatch');
    await new Promise((r) => setImmediate(r));
    expect(bad.logs.join('\n')).toMatch(/failed; the next tick retries/);
  });
});

describe('negative control: the pre-2026-10-04 shape allowed two sweeps', () => {
  test('a poll guarded only by an isRunning flag that an ASK: never sets runs twice', async () => {
    const OLD = 'let isRunning = false;\nasync function poll() {\n  if (isRunning) return;\n  await pollSweep();\n  return true;\n}';
    const d = deferredSweep();
    const { poll } = build(OLD, d.sweep);
    poll(); poll();
    expect(d.calls()).toBe(2);
  });
});

test('the interval and the boot call both go through poll(), not the unguarded sweep', () => {
  expect(SRC).toMatch(/setInterval\(poll, POLL_INTERVAL\)/);
  expect(SRC).not.toMatch(/setInterval\(pollSweep/);
  const callers = SRC.match(/pollSweep\(/g) || [];
  expect(callers.length).toBe(2); // the definition and the one call inside poll()
});
