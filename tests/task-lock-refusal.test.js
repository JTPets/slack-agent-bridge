/**
 * tests/task-lock-refusal.test.js
 *
 * WORK-TODO #72, the owner's answer of 2026-11-08: "if locked - refuse - then a human can
 * over rule." lib/task-start-check.js (the rule), lib/lock-command.js (`ASK: lock` and
 * `ASK: lock clear`, against a REAL lock file and a REAL TaskQueue in a temp dir), and
 * processTask's wiring read from bridge-agent.js's source: a refusal is thrown inside the
 * try (so the failure path posts it and fails the row), and a lock the task did not
 * write is never released by it.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkTaskStart, describeStartRefusal } = require('../lib/task-start-check');
const { handleLock } = require('../lib/lock-command');
const taskLock = require('../lib/task-lock');
const { TaskQueue } = require('../lib/task-queue');
const commandRouter = require('../lib/command-router');

let dir, lockFile, queue;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-refusal-'));
    lockFile = path.join(dir, '.task-running');
    queue = new TaskQueue(path.join(dir, 'task-queue.json'));
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

describe('the rule', () => {
    test('free lock and an empty queue (or only this task) may start', () => {
        expect(checkTaskStart({ lock: { held: false }, running: null, queueId: 'q1' })).toBeNull();
        expect(checkTaskStart({ lock: { held: false }, running: { id: 'q1' }, queueId: 'q1' })).toBeNull();
    });
    test('a held lock, or another row marked running, refuses', () => {
        expect(checkTaskStart({ lock: { held: true, description: 'old job', stale: true }, running: null, queueId: 'q1' }))
            .toMatch(/lock is already held, by "old job" \(stale\)/);
        expect(checkTaskStart({ lock: { held: false }, running: { id: 'q0', description: 'ghost' }, queueId: 'q1' }))
            .toMatch(/queue already shows "ghost" as running/);
    });
    test('the refusal names the override', () => {
        expect(describeStartRefusal('x')).toMatch(/ASK: lock clear/);
    });
});

describe('ASK: lock and ASK: lock clear, on real files', () => {
    test('lock shows both and says when they agree', async () => {
        const r = await handleLock({ args: '', lockFile, queue });
        expect(r.text).toMatch(/Task lock: free\.\nQueue: nothing marked running\.\nThey agree/);
    });
    test('lock clear releases a left-over lock and interrupts the row still marked running', async () => {
        taskLock.acquire({ msgTs: '1.1', description: 'killed job', lockFile });
        const row = queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'TASK: x', description: 'killed job' });
        queue.markRunning(row.id);
        const shown = await handleLock({ args: '', lockFile, queue });
        expect(shown.text).toMatch(/HELD by "killed job"/);
        expect(shown.text).toMatch(/1 row\(s\) marked running: "killed job"/);
        const cleared = await handleLock({ args: 'clear', lockFile, queue });
        expect(cleared.text).toMatch(/released the lock held by "killed job"; marked "killed job" interrupted/);
        expect(fs.existsSync(lockFile)).toBe(false);
        expect(queue.getRunning()).toBeNull();
        expect(checkTaskStart({ lock: taskLock.inspect({ lockFile }), running: queue.getRunning(), queueId: 'new' })).toBeNull();
    });
    test('clear with nothing held changes nothing and says so; an unknown argument is usage', async () => {
        expect((await handleLock({ args: 'clear', lockFile, queue })).text).toMatch(/Nothing to clear/);
        expect((await handleLock({ args: 'smash', lockFile, queue })).ok).toBe(false);
    });
    test('lock is a registered verb', () => {
        expect(commandRouter.parseCommand('lock clear')).toEqual({ verb: 'lock', args: 'clear' });
    });
});

describe('processTask wiring (read from bridge-agent.js)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTask('), src.indexOf('// ---- Status query handling ----'));
    test('the start check runs before the lock is acquired, and a refusal skips both acquire and markRunning', () => {
        expect(fn.indexOf('checkTaskStart(')).toBeGreaterThan(-1);
        expect(fn.indexOf('checkTaskStart(')).toBeLessThan(fn.indexOf('taskLock.acquire('));
        expect(fn).toMatch(/const lockResult = startRefusal\s*\?\s*\{ acquired: false, refused: true \}/);
        expect(fn).toMatch(/if \(queueId && !startRefusal\)/);
    });
    test('a lock that could not be written, or a queue that would not record the row, also refuses', () => {
        expect(fn).toMatch(/startRefusal = `the task lock could not be written/);
        expect(fn).toMatch(/startRefusal = `the queue could not record this task as running/);
    });
    test('the refusal is thrown inside the try, so the failure path reports it and fails the row', () => {
        const tryAt = fn.indexOf('Task message rejected');
        expect(fn.indexOf('if (startRefusal) throw new Error(describeStartRefusal(startRefusal));')).toBeGreaterThan(tryAt);
    });
    test('only a lock this task wrote is released', () => {
        expect(fn).toMatch(/const releaseResult = lockOwned \? taskLock\.release\(TASK_LOCK_FILE\) : \{ existed: false \};/);
    });
    test('negative control: the old best-effort shape (acquire unconditionally, release unconditionally) fails these', () => {
        const old = fn.replace(/const releaseResult = lockOwned \? taskLock\.release\(TASK_LOCK_FILE\) : \{ existed: false \};/, 'const releaseResult = taskLock.release(TASK_LOCK_FILE);');
        expect(old).not.toMatch(/lockOwned \? taskLock\.release/);
    });
});
