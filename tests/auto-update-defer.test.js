/**
 * tests/auto-update-defer.test.js
 *
 * Tests the deferral gate in auto-update.js: a self-update must stand aside
 * while a task is running, and must NOT be blocked forever by a lock a killed
 * task left behind.
 *
 * Why this file exists
 * --------------------
 * The previous behaviour was `waitForTaskCompletion()`: poll the lock every 30s
 * up to 10 times, then restart ANYWAY. TASK_TIMEOUT_MS defaults to 10 minutes
 * and a max-turns task retries once, so a task is permitted to run far longer
 * than the 5-minute cap. The restart was not an unlucky race — it was certain to
 * kill a long task. A long refactor died that way.
 *
 * These tests assert the DECISION (did it pull? did it exit?), not a real
 * restart, for the same reason tests/auto-update-restart.test.js does.
 *
 * Both of the first two tests fail against the old implementation:
 *   - "defers ... while a task holds the lock" — the old code pulled and exited.
 *   - "does not mutate the working tree" — the old wait ran AFTER reset/pull.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// WORK_DIR is read at module load to build TASK_LOCK_FILE / TASK_QUEUE_FILE,
// so it has to be set before auto-update.js is required. The original is
// captured and restored in afterAll: jest runs several test files per worker
// process, so leaking this would hand another suite our (deleted) temp dir.
const originalWorkDir = process.env.WORK_DIR;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-update-defer-'));
process.env.WORK_DIR = WORK_DIR;

const LOCK_FILE = path.join(WORK_DIR, '.task-running');
const QUEUE_FILE = path.join(WORK_DIR, 'task-queue.json');
// LOGIC CHANGE 2026-09-20 (drain-one): the pending-update marker bridge-agent.js
// reads to decide whether to refuse a new dispatch.
const MARKER_FILE = path.join(WORK_DIR, '.update-pending');

const autoUpdate = require('../auto-update');
const taskLock = require('../lib/task-lock');

const PREV_HEAD = 'aaaaaaa1111111111111111111111111111111aa';
const NEW_HEAD = 'bbbbbbb2222222222222222222222222222222bb';

/**
 * Dependency bag whose happy path ends in a restart. `evaluateTaskDeferral` is
 * deliberately NOT faked — it is the code under test, and it reads the real
 * lock/queue files in the temp WORK_DIR above.
 */
function makeDeps(overrides = {}) {
    const calls = [];
    const posts = [];
    const savedStates = [];
    let state = {
        lastKnownCommit: PREV_HEAD,
        restartedIntoCommit: null,
        failedCommit: null,
        deferringSince: null,
        deferNotifiedAt: null,
    };

    let pulled = false;

    const deps = {
        calls,
        posts,
        savedStates,
        getState: () => state,
        setState: (s) => { state = s; },

        loadState: jest.fn(() => ({ ...state })),
        saveState: jest.fn((s) => {
            calls.push('saveState');
            savedStates.push({ ...s });
            state = { ...s };
            return { success: true };
        }),
        gitFetch: jest.fn(() => ({ success: true })),
        getLocalHead: jest.fn(() => (pulled ? NEW_HEAD : PREV_HEAD)),
        getRemoteHead: jest.fn(() => NEW_HEAD),
        getCommitMessage: jest.fn(() => 'some commit'),
        gitResetHard: jest.fn(() => {
            calls.push('gitResetHard');
            return { success: true };
        }),
        gitResetTo: jest.fn(() => {
            calls.push('gitResetTo');
            return { success: true };
        }),
        gitPull: jest.fn(() => {
            calls.push('gitPull');
            pulled = true;
            return { success: true };
        }),
        npmInstall: jest.fn(() => {
            calls.push('npmInstall');
            return { success: true };
        }),
        verifyEntryPoints: jest.fn(() => {
            calls.push('verifyEntryPoints');
            return { ok: true, checked: ['bridge-agent.js'], missing: [], failures: [] };
        }),
        runSmokeTest: jest.fn(() => {
            calls.push('runSmokeTest');
            return { ok: true };
        }),
        planRestart: jest.fn(() => {
            calls.push('planRestart');
            return { exit: true, reason: 'ok' };
        }),
        evaluateTaskDeferral: autoUpdate.evaluateTaskDeferral,
        postToOps: jest.fn(async (msg) => {
            calls.push('postToOps');
            posts.push(msg);
        }),
        exit: jest.fn(async () => {
            calls.push('exit');
        }),
    };

    return Object.assign(deps, overrides);
}

function writeQueue(entries) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(entries, null, 2), 'utf8');
}

let logSpy;
let warnSpy;
let errorSpy;

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fs.rmSync(LOCK_FILE, { force: true });
    fs.rmSync(QUEUE_FILE, { force: true });
    fs.rmSync(MARKER_FILE, { force: true });
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.clearAllMocks();
});

afterAll(() => {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    if (originalWorkDir === undefined) {
        delete process.env.WORK_DIR;
    } else {
        process.env.WORK_DIR = originalWorkDir;
    }
});

describe('deferral while a task holds the lock', () => {
    // THE regression. Under the old waitForTaskCompletion() this test fails:
    // the old code waited 5 minutes and then exited regardless.
    test('defers instead of restarting while a task holds the lock', async () => {
        taskLock.acquire({ msgTs: '1.1', description: 'long refactor', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.calls).not.toContain('exit');

        // The lock is untouched — a fresh lock is never released.
        expect(fs.existsSync(LOCK_FILE)).toBe(true);
    });

    // The deferral must happen BEFORE the destructive git steps. The old code
    // ran reset --hard + pull + npm install first and only then waited, so the
    // tree was already rewritten beneath the running task.
    test('does not mutate the working tree while deferring', async () => {
        taskLock.acquire({ msgTs: '1.2', description: 'long refactor', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitResetHard).not.toHaveBeenCalled();
        expect(deps.gitPull).not.toHaveBeenCalled();
        expect(deps.npmInstall).not.toHaveBeenCalled();
    });

    test('announces the deferral to ops rather than deferring silently', async () => {
        taskLock.acquire({ msgTs: '1.3', description: 'long refactor', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.posts.join('\n')).toMatch(/holding/i);
        expect(deps.posts.join('\n')).toMatch(/long refactor/);
    });

    // "Deferred" must mean "retried next cycle", not "skipped". Nothing is
    // persisted that would suppress the commit, so the next tick picks it up.
    test('a deferred update proceeds on the next cycle once the lock clears', async () => {
        taskLock.acquire({ msgTs: '1.4', description: 'long refactor', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);
        expect(deps.exit).not.toHaveBeenCalled();

        // The commit was NOT recorded as failed — that is what would make it skip forever.
        expect(deps.getState().failedCommit).toBeNull();

        // Task finishes, releasing its lock. Next cycle:
        taskLock.release(LOCK_FILE);
        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitPull).toHaveBeenCalled();
        expect(deps.exit).toHaveBeenCalledWith(autoUpdate.RESTART_EXIT_CODE);
    });
});

describe('a stale lock must not deadlock the deploy', () => {
    // The opposite failure mode: a lock left behind by a killed task must be
    // released, announced, and the update must proceed in the SAME cycle.
    test('releases a stale lock, surfaces it, and still updates', async () => {
        taskLock.acquire({ msgTs: '2.1', description: 'task killed by a restart', lockFile: LOCK_FILE });

        // Backdate the lock well past the staleness threshold.
        const ancient = Date.now() - (taskLock.defaultStaleAfterMs() + 60 * 60 * 1000);
        fs.writeFileSync(LOCK_FILE, JSON.stringify({
            msgTs: '2.1',
            description: 'task killed by a restart',
            pid: 424242,
            startedAt: ancient,
        }), 'utf8');

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        // Released, not waited on.
        expect(fs.existsSync(LOCK_FILE)).toBe(false);

        // Surfaced, not silent.
        expect(deps.posts.join('\n')).toMatch(/stale task lock/i);
        expect(deps.posts.join('\n')).toMatch(/task killed by a restart/);

        // And the deploy went through in the same cycle.
        expect(deps.exit).toHaveBeenCalledWith(autoUpdate.RESTART_EXIT_CODE);
    });
});

describe('task queue deferral', () => {
    test('defers while the queue holds a live running task', async () => {
        writeQueue([{
            id: 'q1',
            status: 'running',
            description: 'queued work',
            enqueuedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
        }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.gitPull).not.toHaveBeenCalled();
    });

    // recoverInterrupted() only repairs "running" entries, so a task killed
    // between enqueue() and dequeue() stays "pending" forever. With no wait cap
    // left, one such orphan would freeze deploys permanently.
    test('an orphaned pending entry is ignored, surfaced, and does not block', async () => {
        const ancient = new Date(Date.now() - (taskLock.defaultStaleAfterMs() + 60 * 60 * 1000)).toISOString();
        writeQueue([{
            id: 'q2',
            status: 'pending',
            description: 'never dequeued',
            enqueuedAt: ancient,
            startedAt: null,
        }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.posts.join('\n')).toMatch(/stale task-queue entr/i);
        expect(deps.exit).toHaveBeenCalledWith(autoUpdate.RESTART_EXIT_CODE);
    });

    test('a fresh pending entry still defers', async () => {
        writeQueue([{
            id: 'q3',
            status: 'pending',
            description: 'waiting its turn',
            enqueuedAt: new Date().toISOString(),
            startedAt: null,
        }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
    });
});

describe('deferral escalation bound', () => {
    // A succession of healthy tasks can defer indefinitely by design — killing
    // live work is the bug being fixed. The bound is visibility: past the alert
    // threshold, EVERY cycle escalates.
    test('escalates to ops once a deferral passes the alert threshold', async () => {
        taskLock.acquire({ msgTs: '3.1', description: 'endless work', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);
        const firstPostCount = deps.posts.length;
        expect(firstPostCount).toBeGreaterThan(0);

        // Second cycle, still deferred, still recent: no new post (no spam).
        await autoUpdate.checkForUpdates(deps);
        expect(deps.posts.length).toBe(firstPostCount);

        // Backdate the deferral start past the alert threshold.
        const state = deps.getState();
        deps.setState({ ...state, deferringSince: Date.now() - (2 * 60 * 60 * 1000) });

        await autoUpdate.checkForUpdates(deps);
        const escalations = deps.posts.filter(p => /deferred for \d+m/i.test(p));
        expect(escalations.length).toBeGreaterThan(0);
        expect(escalations.join('\n')).toMatch(/NOT being forced/);
    });

    // The elapsed figure is per-commit. A new commit must not inherit the
    // previous one's clock and escalate immediately quoting someone else's time.
    test('a new commit restarts the deferral clock instead of inheriting it', async () => {
        taskLock.acquire({ msgTs: '3.2', description: 'endless work', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        // Pretend this commit has been deferred for two hours.
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        deps.setState({ ...deps.getState(), deferringSince: twoHoursAgo });

        // A DIFFERENT commit lands.
        const OTHER_HEAD = 'ccccccc3333333333333333333333333333333cc';
        deps.getRemoteHead.mockReturnValue(OTHER_HEAD);

        const postsBefore = deps.posts.length;
        await autoUpdate.checkForUpdates(deps);

        const state = deps.getState();
        expect(state.deferringCommit).toBe(OTHER_HEAD);
        expect(state.deferringSince).toBeGreaterThan(twoHoursAgo);

        // It announces the new commit as a fresh hold, not as a 120m escalation.
        const newPosts = deps.posts.slice(postsBefore).join('\n');
        expect(newPosts).toMatch(/holding/i);
        expect(newPosts).not.toMatch(/deferred for 1[0-9][0-9]m/);
    });
});

// ---------------------------------------------------------------------------
// DRAIN-ONE — the marker lifecycle, and the DELIVERY signal the gate keys on
// ---------------------------------------------------------------------------
//
// Drain-one adds the half deferral was missing. Deferral alone stands aside for a
// running task, but its wait is bounded by the ARRIVAL RATE of new dispatches: a
// back-to-back succession of healthy tasks defers a deploy forever. Marking the
// update PENDING is what makes bridge-agent.js refuse new dispatches, so the only
// task the update can wait for is the one already in flight.
//
// The marker is real here — these write and read the actual file in the temp
// WORK_DIR, because a mocked marker would prove nothing about the thing two
// processes coordinate through.

/** The marker as it is on disk, or null. */
function readMarker() {
    if (!fs.existsSync(MARKER_FILE)) return null;
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
}

describe('drain-one: an update that must wait is recorded as PENDING', () => {
    test('an update arriving mid-task marks itself pending and does NOT restart the task', async () => {
        taskLock.acquire({ msgTs: '9.1', description: 'long refactor', lockFile: LOCK_FILE });

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        // The task is untouched: nothing pulled, nothing exited, lock still held.
        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.calls).not.toContain('gitPull');
        expect(fs.existsSync(LOCK_FILE)).toBe(true);

        // And the refusal half is now armed.
        const marker = readMarker();
        expect(marker).not.toBeNull();
        expect(marker.commit).toBe(NEW_HEAD);
    });

    test('the marker is written BEFORE the deferral decision, so it covers the apply window too', async () => {
        // Nothing running: the update proceeds. The marker must still have existed
        // during reset/pull/npm/smoke — minutes in which the poll loop would
        // otherwise start a task the imminent restart would kill.
        const seen = [];
        const deps = makeDeps({
            gitResetHard: jest.fn(() => {
                seen.push(fs.existsSync(MARKER_FILE));
                return { success: true };
            }),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(seen).toEqual([true]);
    });

    test('the marker is cleared before the exit, never left for the restarted process', async () => {
        const deps = makeDeps({
            exit: jest.fn(async () => {
                deps.calls.push('exit');
                // Guard (d)'s reasoning applied to the marker: there is no "after"
                // an exit, so the marker has to be gone by the time we get here or
                // the new process refuses every dispatch for an update that landed.
                expect(fs.existsSync(MARKER_FILE)).toBe(false);
            }),
        });

        await autoUpdate.checkForUpdates(deps);
        expect(deps.exit).toHaveBeenCalled();
    });

    test('an aborted update clears the marker — a refused commit must not refuse work forever', async () => {
        const deps = makeDeps({
            verifyEntryPoints: jest.fn(() => ({
                ok: false,
                checked: [],
                missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError' }],
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(fs.existsSync(MARKER_FILE)).toBe(false);
    });

    test('a manual restart that already applied the merge clears the marker on the next cycle', async () => {
        // Deploys are manual today (WORK-TODO #17): a human runs
        // `docker compose restart jt-agent` and the merge lands with this loop none
        // the wiser. Without this, every dispatch would be refused until the marker
        // went stale.
        const deps = makeDeps();
        taskLock.acquire({ msgTs: '9.2', description: 'holding', lockFile: LOCK_FILE });
        await autoUpdate.checkForUpdates(deps);
        expect(fs.existsSync(MARKER_FILE)).toBe(true);

        taskLock.release(LOCK_FILE);
        deps.getLocalHead.mockReturnValue(NEW_HEAD); // the restart applied it

        await autoUpdate.checkForUpdates(deps);
        expect(fs.existsSync(MARKER_FILE)).toBe(false);
    });
});

describe('drain-one: the gate keys on DELIVERY, not on the task having stopped', () => {
    // THE point of task 0. Applying an update restarts the process, so "finished"
    // has to mean RESULT DELIVERED — a task that completed and never posted is, in
    // every durable record, identical to one that never ran. These two tests differ
    // ONLY in the delivery verdict; the status is `completed` in both.

    const base = {
        id: 'q1',
        msgTs: '9.9',
        description: 'a task that has stopped running',
        status: 'completed',
        enqueuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
    };

    test('a completed task whose result is NOT yet delivered still defers the update', async () => {
        writeQueue([{ ...base, delivery: null }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.calls).not.toContain('gitPull');
        expect(deps.posts.join('\n')).toMatch(/not yet delivered/i);
    });

    test('the same task WITH a recorded delivery lets the update proceed', async () => {
        writeQueue([{
            ...base,
            delivery: { delivered: true, detail: 'task result posted to the ops channel', at: new Date().toISOString() },
        }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.calls).toContain('gitPull');
        expect(deps.exit).toHaveBeenCalled();
    });

    test('a recorded NON-delivery is still finished — the loss is known, the task is over', async () => {
        // The gate waits for the verdict, not for a happy one. A task whose post
        // failed is over; refusing to ever deploy again because of it would be a
        // permanent freeze caused by one Slack outage.
        writeQueue([{
            ...base,
            delivery: { delivered: false, detail: 'the task result post failed', at: new Date().toISOString() },
        }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).toHaveBeenCalled();
    });

    test('a row written before the delivery field existed cannot freeze deploys', async () => {
        // No `delivery` key at all. Treating a pre-change row as in-flight would
        // freeze every deploy for the queue's retention window the first time this
        // code met an existing task-queue.json.
        writeQueue([base]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).toHaveBeenCalled();
    });

    test('an undelivered entry old enough to be an orphan is ignored, and said so', async () => {
        const old = new Date(Date.now() - (10 * 60 * 60 * 1000)).toISOString();
        writeQueue([{ ...base, enqueuedAt: old, startedAt: old, completedAt: old, delivery: null }]);

        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).toHaveBeenCalled();
        expect(deps.posts.join('\n')).toMatch(/stale task-queue entr/i);
    });
});
