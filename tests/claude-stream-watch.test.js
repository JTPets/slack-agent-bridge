'use strict';

/**
 * tests/claude-stream-watch.test.js
 *
 * WORK-TODO #59, report-first phase (owner, 2026-10-10): lib/claude-stream-watch.js reads
 * the Claude CLI's stream-json events, reports a stall or a loop, and returns per-run stats.
 * The adapter only stops a run when TASK_LIMITER_MODE=enforce. The last describe spawns a
 * real stub binary, because the wiring between a child's stdout and the watcher is what a
 * mocked child_process would hide.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStreamWatch } = require('../lib/claude-stream-watch');
const { runClaudeAdapter } = require('../lib/llm-runner');

const ev = (obj) => `${JSON.stringify(obj)}\n`;
const toolUse = (name, input) => ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const result = (fields) => ev({ type: 'result', ...fields });

describe('createStreamWatch: what the run produced', () => {
  test('the final text comes from the result event', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert: jest.fn() });
    w.feed(ev({ type: 'system', subtype: 'init' }));
    w.feed(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }));
    w.feed(result({ subtype: 'success', result: 'All done.', num_turns: 7, total_cost_usd: 0.42 }));
    const out = w.finish();
    expect(out).toMatchObject({ output: 'All done.', hitMaxTurns: false, structured: true });
    expect(out.stats).toMatchObject({ events: 3, numTurns: 7, costUsd: 0.42 });
  });

  test('a run ended by the turn limit is reported as hitMaxTurns', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert: jest.fn() });
    w.feed(result({ subtype: 'error_max_turns', num_turns: 50 }));
    expect(w.finish().hitMaxTurns).toBe(true);
  });

  test('events split across chunks are reassembled', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert: jest.fn() });
    const line = result({ subtype: 'success', result: 'split ok' });
    w.feed(line.slice(0, 10));
    w.feed(line.slice(10));
    expect(w.finish().output).toBe('split ok');
  });

  test('plain-text output (an older CLI, a stub) passes through unchanged', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert: jest.fn() });
    w.feed('plain answer\nReached max turns (5)\n');
    const out = w.finish();
    expect(out).toMatchObject({ structured: false, hitMaxTurns: true });
    expect(out.output).toBe('plain answer\nReached max turns (5)');
  });

  test('with no result event the assistant text is the output', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert: jest.fn() });
    w.feed(ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }));
    expect(w.finish().output).toBe('partial');
  });
});

describe('createStreamWatch: loop alert', () => {
  test('the same tool call N times in a row alerts once', () => {
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 3, onAlert });
    for (let i = 0; i < 6; i++) w.feed(toolUse('Bash', { command: 'npm test' }));
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0][0]).toBe('loop');
    expect(onAlert.mock.calls[0][1]).toMatch(/3 times in a row: Bash .*npm test.*TASK_LOOP_REPEAT/);
    expect(w.finish().stats).toMatchObject({ toolCalls: 6, maxRepeat: 6, alerts: ['loop'] });
  });

  test('alternating calls are not a loop', () => {
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 3, onAlert });
    for (let i = 0; i < 6; i++) w.feed(toolUse('Bash', { command: i % 2 ? 'git status' : 'npm test' }));
    expect(onAlert).not.toHaveBeenCalled();
    expect(w.finish().stats.maxRepeat).toBe(1);
  });

  test('a new run of identical calls can alert again', () => {
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 2, onAlert });
    w.feed(toolUse('Read', { f: 'a' })); w.feed(toolUse('Read', { f: 'a' }));
    w.feed(toolUse('Read', { f: 'b' })); w.feed(toolUse('Read', { f: 'b' }));
    expect(onAlert).toHaveBeenCalledTimes(2);
  });

  test('loopRepeat 0 turns the rule off', () => {
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 0, onAlert });
    for (let i = 0; i < 20; i++) w.feed(toolUse('Bash', { command: 'x' }));
    expect(onAlert).not.toHaveBeenCalled();
  });
});

describe('createStreamWatch: stall alert', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('silence past the threshold alerts once per quiet spell, with the time in minutes', () => {
    let t = 0;
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 600000, loopRepeat: 0, onAlert, now: () => t });
    t = 599000; jest.advanceTimersByTime(599000);
    expect(onAlert).not.toHaveBeenCalled();
    t = 600000; jest.advanceTimersByTime(1000);
    expect(onAlert).toHaveBeenCalledTimes(1);
    expect(onAlert.mock.calls[0]).toEqual(['stall', expect.stringMatching(/10 min \(threshold 10 min, TASK_STALL_MS\)/)]);
    t = 2000000; jest.advanceTimersByTime(1400000);
    expect(onAlert).toHaveBeenCalledTimes(1);
    w.feed('x');
    t = 2600000; jest.advanceTimersByTime(600000);
    expect(onAlert).toHaveBeenCalledTimes(2);
    w.dispose();
  });

  test('activity keeps resetting the clock; the longest gap is recorded', () => {
    let t = 0;
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 1000, loopRepeat: 0, onAlert, now: () => t });
    for (const step of [500, 900, 300]) { t += step; jest.advanceTimersByTime(step); w.feed('.'); }
    expect(onAlert).not.toHaveBeenCalled();
    expect(w.finish().stats.maxQuietMs).toBe(900);
  });

  test('no alert after the run has finished', () => {
    const onAlert = jest.fn();
    const w = createStreamWatch({ stallMs: 1000, loopRepeat: 0, onAlert });
    w.finish();
    jest.advanceTimersByTime(5000);
    expect(onAlert).not.toHaveBeenCalled();
  });

  test('a throwing alert handler cannot break the watch', () => {
    const w = createStreamWatch({ stallMs: 0, loopRepeat: 2, onAlert: () => { throw new Error('boom'); } });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => { w.feed(toolUse('A', 1)); w.feed(toolUse('A', 1)); }).not.toThrow();
    err.mockRestore();
  });
});

describe('the adapter with a real stub that loops', () => {
  let dir;
  let looping;
  const quiet = {};

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-watch-'));
    looping = path.join(dir, 'looping');
    const lines = [];
    for (let i = 0; i < 6; i++) lines.push(toolUse('Bash', { command: 'npm test' }));
    lines.push(result({ subtype: 'success', result: 'finished anyway', num_turns: 6 }));
    // Emits six identical tool calls a little apart, then a result, then exits 0.
    fs.writeFileSync(looping, `#!${process.execPath}
process.stdin.resume();
const lines = ${JSON.stringify(lines)};
let i = 0;
const next = () => { if (i < lines.length) { process.stdout.write(lines[i++]); setTimeout(next, 20); } else process.exit(0); };
next();
`, { mode: 0o755 });
    quiet.log = jest.spyOn(console, 'log').mockImplementation(() => {});
    quiet.error = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    quiet.log.mockRestore();
    quiet.error.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('report mode: the loop is reported and the run still finishes', async () => {
    const alerts = [];
    const res = await runClaudeAdapter('p', {
      claudeBin: looping, cwd: dir, timeout: 20000, stallMs: 0, loopRepeat: 3,
      limiterMode: 'report', onRunAlert: (a) => alerts.push(a),
    });
    expect(res.output).toBe('finished anyway');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ reason: 'loop', enforced: false });
  });

  test('enforce mode: the run is stopped with the reason', async () => {
    const alerts = [];
    const err = await runClaudeAdapter('p', {
      claudeBin: looping, cwd: dir, timeout: 20000, stallMs: 0, loopRepeat: 3,
      limiterMode: 'enforce', onRunAlert: (a) => alerts.push(a),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.stopReason).toBe('loop');
    expect(err.message).toMatch(/Stopped by the run limiter \(loop\)/);
    expect(alerts[0]).toMatchObject({ reason: 'loop', enforced: true });
  });

  test('every run logs a [run-stats] line', async () => {
    quiet.log.mockClear();
    await runClaudeAdapter('p', { claudeBin: looping, cwd: dir, timeout: 20000, stallMs: 0, loopRepeat: 0, agentId: 'secretary' });
    const line = quiet.log.mock.calls.map((c) => c[0]).find((s) => String(s).startsWith('[run-stats] '));
    expect(line).toBeDefined();
    expect(JSON.parse(line.slice('[run-stats] '.length))).toMatchObject({ agent_id: 'secretary', exit: 0, toolCalls: 6, maxRepeat: 6, numTurns: 6 });
  });
});

describe('the alert text', () => {
  const { formatRunAlert } = require('../lib/deadline-warning');

  test('report mode says nothing was stopped', () => {
    const text = formatRunAlert({ description: 'Morning briefing', agentId: 'secretary', reason: 'stall', detail: 'no output for 10 min', enforced: false });
    expect(text).toMatch(/may be stalled: "Morning briefing" \(agent secretary\)/);
    expect(text).toMatch(/Nothing was stopped/);
  });

  test('enforce mode says the run was stopped', () => {
    const text = formatRunAlert({ description: 'x', reason: 'loop', detail: 'd', enforced: true });
    expect(text).toMatch(/may be looping/);
    expect(text).toMatch(/STOPPED/);
  });
});
