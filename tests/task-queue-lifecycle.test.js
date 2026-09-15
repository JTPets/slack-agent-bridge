'use strict';

/**
 * tests/task-queue-lifecycle.test.js
 *
 * Regression tests for WORK-TODO P1 #18: the task queue never entered `running`,
 * so crash recovery could never fire. `dequeue()` was the SOLE writer of
 * `STATUS.RUNNING`/`startedAt` and had zero non-test callers; the live path ran
 * `enqueue()` (poll loop) then `complete()`/`fail()` (processTask) with nothing in
 * between. So every completed entry carried `startedAt: null` and
 * `recoverInterrupted()` returned 0 at every startup, unconditionally.
 *
 * WHY THIS FILE DOES NOT JUST CALL THE MODULE: a hand-written
 * `enqueue(); markRunning(); complete()` proves only that the module CAN do it —
 * which `tests/task-queue.test.js` already proved, 38 assertions' worth, while
 * production did none of it. The lifecycle replayed below is instead EXTRACTED
 * FROM `bridge-agent.js`'s source at the sites production runs, then replayed
 * against a REAL `TaskQueue` on a real file. No transition in the production
 * source means nothing extracted, nothing replayed, and a red suite — which is
 * exactly how these fail on the commit before this one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_AGENT_PATH = path.join(__dirname, '..', 'bridge-agent.js');
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

// The WRITE surface — read-only accessors excluded; this is the state machine.
const MUTATORS = ['enqueue', 'markRunning', 'dequeue', 'complete', 'fail', 'interrupt'];
const MUTATION_RE = new RegExp(
    `(?:taskQueue\\.getQueue\\(\\)|\\bqueue)\\.(${MUTATORS.join('|')})\\(`,
    'g'
);

/** Ordered { method, index } for every queue mutation in a source region. */
function mutationsIn(region) {
    const out = [];
    const re = new RegExp(MUTATION_RE.source, 'g');
    let m;
    while ((m = re.exec(region)) !== null) out.push({ method: m[1], index: m.index });
    return out;
}

/**
 * Slice bridge-agent.js into the regions of the real task lifecycle and read the
 * queue mutations out of each. `src` is the real source, or a mutated copy for
 * the meta-tests below.
 */
function extractLifecycle(src) {
    // The poll loop's enqueue — where a TASK: message first becomes a queue entry.
    expect(src.indexOf('const queuedTask = queue.enqueue({')).toBeGreaterThan(-1);

    // LOGIC CHANGE 2026-09-15: match the function, not its parameter list (WORK-TODO #38).
    const fnStart = src.indexOf('async function processTask(');
    expect(fnStart).toBeGreaterThan(-1);
    // processTask is top-level, so its close is the next `}` at column 0.
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);

    // The failure path begins at processTask's own `catch (err)`.
    const catchIdx = body.indexOf('\n  } catch (err) {');
    expect(catchIdx).toBeGreaterThan(-1);

    // The "child was killed but this process is still alive" branch.
    const intStart = body.indexOf('if (interrupted) {');
    expect(intStart).toBeGreaterThan(-1);
    const intEnd = body.indexOf('\n      return;', intStart);
    expect(intEnd).toBeGreaterThan(intStart);

    const all = mutationsIn(body);
    return {
        // Before the interrupted branch: shared by every outcome, and the only
        // place the `running` transition can legitimately live.
        prefix: all.filter((x) => x.index < intStart).map((x) => x.method),
        interrupted: all
            .filter((x) => x.index > intStart && x.index < intEnd)
            .map((x) => x.method),
        success: all
            .filter((x) => x.index > intEnd && x.index < catchIdx)
            .map((x) => x.method),
        failure: all.filter((x) => x.index > catchIdx).map((x) => x.method),
    };
}

/**
 * Replay a source-derived sequence against a real TaskQueue, snapshotting the
 * persisted row after every step. Arguments are the shapes bridge-agent.js passes;
 * the ORDER and SET of calls come from the source, which is what is under test.
 */
function replay(queue, sequence, taskId) {
    const snapshots = [];
    let id = taskId;
    const ARGS = {
        markRunning: [],
        dequeue: [],
        complete: ['Success in 12s'],
        fail: ['boom'],
        interrupt: ['Task interrupted (SIGTERM) after 12s (likely container restart)'],
    };

    for (const method of sequence) {
        if (method === 'enqueue') {
            id = queue.enqueue({
                msgTs: '1700000000.000100',
                channelId: 'C_BRIDGE',
                text: 'TASK: replayed\nINSTRUCTIONS: do the thing',
                description: 'replayed task',
                repo: 'jtpets/slack-agent-bridge',
            }).id;
        } else if (ARGS[method]) {
            // dequeue() takes no id — it searches. Every other mutator is keyed.
            queue[method](...(method === 'dequeue' ? [] : [id, ...ARGS[method]]));
        } else {
            throw new Error(`replay(): unhandled queue mutation "${method}"`);
        }
        const rows = JSON.parse(fs.readFileSync(queue.queueFile, 'utf8'));
        snapshots.push({ after: method, row: rows.find((r) => r.id === id) });
    }

    return { id, snapshots };
}

describe('task queue lifecycle as bridge-agent.js actually drives it', () => {
    let tempDir;
    let queueFile;
    let TaskQueue;
    let STATUS;
    let INTERRUPTED_ON_STARTUP_REASON;
    let lifecycle;

    beforeAll(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lifecycle-'));
        queueFile = path.join(tempDir, 'task-queue.json');
        const mod = require('../lib/task-queue');
        TaskQueue = mod.TaskQueue;
        STATUS = mod.STATUS;
        INTERRUPTED_ON_STARTUP_REASON = mod.INTERRUPTED_ON_STARTUP_REASON;
        lifecycle = extractLifecycle(source);
    });

    afterAll(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        if (fs.existsSync(queueFile)) fs.unlinkSync(queueFile);
    });
    test('the live path passes through `running` on its way to a terminal state', () => {
        // This is the assertion the defect failed: production reached `completed`
        // without ever having been `running`.
        expect(lifecycle.prefix).toContain('markRunning');
    });

    test('a successful task goes enqueued -> running (with a timestamp) -> completed', () => {
        const queue = new TaskQueue(queueFile);
        const { snapshots } = replay(queue, ['enqueue', ...lifecycle.prefix, ...lifecycle.success]);
        expect(snapshots.map((s) => s.row.status))
            .toEqual([STATUS.PENDING, STATUS.RUNNING, STATUS.COMPLETED]);

        // `running` is worthless without the stamp: checkTaskQueue treats an
        // unparseable startedAt as LIVE, so a null defers every deploy forever.
        const running = snapshots[1].row;
        expect(running.startedAt).not.toBeNull();
        expect(Number.isFinite(Date.parse(running.startedAt))).toBe(true);

        // The stamp survives to the terminal row — the field owner-observed as
        // null on live completed entries.
        const completed = snapshots[2].row;
        expect(completed.startedAt).not.toBeNull();
        expect(Date.parse(completed.startedAt)).toBeGreaterThan(0);
        // A real date, not the epoch `new Date(null)` yields in
        // formatStatusResponse's "started N min ago" arithmetic.
        expect(new Date(completed.startedAt).getUTCFullYear()).toBeGreaterThan(2000);
    });

    test('a failing task goes enqueued -> running -> failed, with the stamp kept', () => {
        const queue = new TaskQueue(queueFile);
        const { snapshots } = replay(queue, ['enqueue', ...lifecycle.prefix, ...lifecycle.failure]);
        expect(snapshots.map((s) => s.row.status))
            .toEqual([STATUS.PENDING, STATUS.RUNNING, STATUS.FAILED]);
        expect(snapshots[2].row.startedAt).not.toBeNull();
    });

    test('an interruption the bridge survives is recorded terminally, not left running', () => {
        // `interrupted: true` covers any code === null child exit, including the
        // TASK_TIMEOUT_MS hard kill — so this branch routinely runs in a live
        // process that will not hit startup recovery.
        const queue = new TaskQueue(queueFile);
        const { snapshots } = replay(queue, ['enqueue', ...lifecycle.prefix, ...lifecycle.interrupted]);
        const final = snapshots[snapshots.length - 1].row;
        expect(final.status).toBe(STATUS.INTERRUPTED);
        expect(final.startedAt).not.toBeNull();
        expect(final.completedAt).not.toBeNull();
        expect(final.error).toMatch(/interrupted/i);

        // No phantom in-flight task left behind.
        expect(queue.getRunning()).toBeNull();
        expect(queue.getActiveCount()).toBe(0);
    });

    test('a task killed mid-run is recovered as interrupted at the next startup', () => {
        // The assertion that would have caught the defect: replay to `running`
        // then stop — what a kill does. No finally, no catch, no terminal write.
        const queue = new TaskQueue(queueFile);
        const { id } = replay(queue, ['enqueue', ...lifecycle.prefix]);

        const recovered = queue.recoverInterrupted();
        expect(recovered).toBe(1);

        const row = JSON.parse(fs.readFileSync(queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe(STATUS.INTERRUPTED);
        expect(row.error).toBe(INTERRUPTED_ON_STARTUP_REASON);
        // Terminal, never re-queued: nothing hands a task that killed the
        // process back to the process.
        expect(row.status).not.toBe(STATUS.PENDING);
        expect(queue.getActiveCount()).toBe(0);
    });

    test('the recovery reason does not name PM2 — this deployment has none', () => {
        expect(INTERRUPTED_ON_STARTUP_REASON).not.toMatch(/pm2/i);
        const queueSource = fs.readFileSync(
            path.join(__dirname, '..', 'lib', 'task-queue.js'),
            'utf8'
        );
        // The module header documents the removal, so comments may name PM2.
        // Strip them first — what must not survive is a PM2 string the code WRITES.
        const stripped = queueSource
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
        const literals = stripped.match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) || [];
        expect(literals.filter((l) => /pm2/i.test(l))).toEqual([]);
    });

    test('startup recovery runs before cleanup, so no RUNNING entry is stranded', () => {
        // cleanup() keeps every PENDING and RUNNING entry unconditionally, so
        // recoverInterrupted() must make the entry terminal first.
        const recoverIdx = source.indexOf('queue.recoverInterrupted()');
        const cleanupIdx = source.indexOf('queue.cleanup()');
        expect(recoverIdx).toBeGreaterThan(-1);
        expect(recoverIdx).toBeLessThan(cleanupIdx);
    });

    test('a re-attempt preserves the interruption verdict instead of erasing it', () => {
        // Both message-dedup guards (the done/failed reaction and
        // processed-tasks.json) are written only AFTER completion, so a killed
        // task IS re-read on the next poll. enqueue() dedups by msgTs and hands
        // back the same recovered entry, which must not lose its history.
        const queue = new TaskQueue(queueFile);
        const { id } = replay(queue, ['enqueue', ...lifecycle.prefix]);
        queue.recoverInterrupted();

        queue.markRunning(id);
        const row = JSON.parse(fs.readFileSync(queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe(STATUS.RUNNING);
        expect(row.attempts).toBe(2);
        expect(row.previousStatus).toBe(STATUS.INTERRUPTED);
        expect(row.previousError).toBe(INTERRUPTED_ON_STARTUP_REASON);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Without these, the suite above could pass by extracting nothing at all.
    test('removing the production markRunning call empties the running transition', () => {
        const broken = source.replace('taskQueue.getQueue().markRunning(queueId);', '');
        expect(broken).not.toBe(source);
        expect(extractLifecycle(broken).prefix).not.toContain('markRunning');
    });

    test('a replay with no running transition leaves startedAt null and recovers nothing', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lifecycle-neg-'));
        try {
            const { TaskQueue, STATUS } = require('../lib/task-queue');
            const queue = new TaskQueue(path.join(tempDir, 'task-queue.json'));
            // The pre-fix lifecycle, exactly: enqueue then complete.
            const { snapshots } = replay(queue, ['enqueue', 'complete']);
            expect(snapshots[1].row.status).toBe(STATUS.COMPLETED);
            expect(snapshots[1].row.startedAt).toBeNull();
            // ...and the epoch this produces downstream, plus a kill that
            // recovers nothing — the two symptoms owner-observed live.
            expect(new Date(snapshots[1].row.startedAt).getUTCFullYear()).toBe(1970);
            replay(queue, ['enqueue']);
            expect(queue.recoverInterrupted()).toBe(0);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('the extractor finds every terminal write, not just the running one', () => {
        const l = extractLifecycle(source);
        expect(l.success).toContain('complete');
        expect(l.failure).toContain('fail');
        expect(l.interrupted).toContain('interrupt');
    });
});
