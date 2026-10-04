'use strict';

/**
 * tests/llm-runner-deadline.test.js
 *
 * The claude adapter's deadline, which it now owns instead of spawn's `timeout` option.
 *
 *   - WORK-TODO #58: a spawn that failed with ENOENT left Node's kill-timer referenced, so
 *     the process could not exit for the full timeout (600 s at the default). The first
 *     test runs the adapter in a child node process with the DEFAULT timeout and asserts
 *     that process exits on its own within seconds. Against the old code it is killed by
 *     the 20 s guard instead.
 *   - The deadline still kills: a stub that never exits is SIGTERMed and reported as
 *     interrupted, the same path as before.
 *   - WORK-TODO #7: `onDeadlineWarning` fires once, before the kill, and not at all for a
 *     task that finishes first; a throwing callback cannot affect the task.
 *
 * Real spawns against stub binaries, because a timer that outlives a failed spawn is a
 * property of the real child_process module that a mock cannot show.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNNER = path.join(__dirname, '..', 'lib', 'llm-runner.js');
const { runClaudeAdapter, WARN_AT_FRACTION } = require('../lib/llm-runner');

let dir;
let hangs;
let quick;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-deadline-'));
    hangs = path.join(dir, 'hangs');
    quick = path.join(dir, 'quick');
    fs.writeFileSync(hangs, `#!${process.execPath}\nprocess.stdin.resume();\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
    fs.writeFileSync(quick, `#!${process.execPath}\nprocess.stdout.write('done');\n`, { mode: 0o755 });
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a failed spawn at the DEFAULT timeout lets the process exit (WORK-TODO #58)', () => {
    const script = `
        const { runClaudeAdapter } = require(${JSON.stringify(RUNNER)});
        runClaudeAdapter('p', { claudeBin: ${JSON.stringify(path.join(dir, 'does-not-exist'))}, cwd: ${JSON.stringify(dir)} })
            .then(() => console.log('RESOLVED'), (e) => console.log('REJECTED ' + e.message));`;
    const started = Date.now();
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20000 });
    expect(res.signal).toBeNull();
    expect(res.stdout).toMatch(/REJECTED Spawn failed: .*ENOENT/);
    expect(Date.now() - started).toBeLessThan(15000);
}, 30000);

test('the deadline still kills a task that runs too long, via the interrupted path', async () => {
    const result = await runClaudeAdapter('p', { claudeBin: hangs, cwd: dir, timeout: 400 });
    expect(result).toMatchObject({ interrupted: true, signal: 'SIGTERM' });
});

test('the warning fires once, before the kill, with the remaining time (WORK-TODO #7)', async () => {
    const calls = [];
    const result = await runClaudeAdapter('p', {
        claudeBin: hangs, cwd: dir, timeout: 1000,
        onDeadlineWarning: (info) => calls.push({ ...info, at: Date.now() }),
    });
    expect(result.interrupted).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ elapsedMs: 1000 * WARN_AT_FRACTION, remainingMs: 1000 - 1000 * WARN_AT_FRACTION, timeoutMs: 1000 });
});

test('a task that finishes first gets no warning, and a throwing callback is harmless', async () => {
    const onDeadlineWarning = jest.fn(() => { throw new Error('boom'); });
    const result = await runClaudeAdapter('p', { claudeBin: quick, cwd: dir, timeout: 500, onDeadlineWarning });
    expect(result.output).toBe('done');
    await new Promise((r) => setTimeout(r, 600));
    expect(onDeadlineWarning).not.toHaveBeenCalled();

    const throwing = jest.fn(() => { throw new Error('boom'); });
    const killed = await runClaudeAdapter('p', { claudeBin: hangs, cwd: dir, timeout: 300, onDeadlineWarning: throwing });
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(killed.interrupted).toBe(true);
});
