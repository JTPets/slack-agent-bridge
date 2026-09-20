'use strict';

/**
 * tests/update-drain.test.js
 *
 * Tests lib/update-drain.js — the pending-update marker — and THE GUARD that the
 * poll loop actually refuses a dispatch while one is set.
 *
 * Why the second half is a source walk
 * ------------------------------------
 * `bridge-agent.js` is not requireable from a suite: it validates config and arms a
 * poll interval at load. So the refusal is read out of its source at the site
 * production runs, the way tests/task-queue-lifecycle.test.js and
 * tests/task-agent-identity.test.js already do here. A module-only test would prove
 * the marker CAN be read and nothing about whether anything reads it — which is the
 * exact failure mode this repository keeps finding (62 green tests for a daemon
 * nothing starts).
 *
 * What is NOT claimed by any of this
 * ----------------------------------
 * None of it says a self-update happens. `auto-update.js` is started by nothing
 * (WORK-TODO #17), so the marker is written by a process that does not run today.
 * The bridge-side refusal is live code on the live path; it simply never fires until
 * something starts the updater. These tests assert the mechanism, not a deployment.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const originalWorkDir = process.env.WORK_DIR;
const originalStale = process.env.UPDATE_PENDING_STALE_MS;
const originalInterval = process.env.CHECK_INTERVAL_MS;

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'update-drain-'));
process.env.WORK_DIR = WORK_DIR;

const drain = require('../lib/update-drain');

const MARKER = path.join(WORK_DIR, '.update-pending');
const COMMIT = 'bbbbbbb2222222222222222222222222222222bb';

let logSpy;
let warnSpy;
let errorSpy;

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fs.rmSync(MARKER, { force: true });
    delete process.env.UPDATE_PENDING_STALE_MS;
    delete process.env.CHECK_INTERVAL_MS;
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.clearAllMocks();
});

afterAll(() => {
    // Restore every global this suite moved — jest runs several files per worker
    // process, so leaking any of these hands another suite our deleted temp dir or
    // our shortened staleness threshold.
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    const restore = (name, value) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    };
    restore('WORK_DIR', originalWorkDir);
    restore('UPDATE_PENDING_STALE_MS', originalStale);
    restore('CHECK_INTERVAL_MS', originalInterval);
});

describe('the marker records a waiting update', () => {
    test('no marker means no update is pending', () => {
        const state = drain.inspect({ markerFile: MARKER });
        expect(state.pending).toBe(false);
        expect(state.stale).toBe(false);
        expect(state.commit).toBeNull();
    });

    test('marking writes a readable marker naming the commit', () => {
        const result = drain.markPending({ commit: COMMIT, reason: 'waiting', markerFile: MARKER });
        expect(result.marked).toBe(true);
        expect(result.refreshed).toBe(false);

        const state = drain.inspect({ markerFile: MARKER });
        expect(state.pending).toBe(true);
        expect(state.commit).toBe(COMMIT);
        expect(state.reason).toBe('waiting');
        expect(state.format).toBe('json');
    });

    test('clearing removes it, and says whether it was there', () => {
        drain.markPending({ commit: COMMIT, markerFile: MARKER });

        const first = drain.clear({ markerFile: MARKER, reason: 'applied' });
        expect(first).toMatchObject({ cleared: true, existed: true });
        expect(drain.inspect({ markerFile: MARKER }).pending).toBe(false);

        const second = drain.clear({ markerFile: MARKER });
        expect(second).toMatchObject({ cleared: false, existed: false });
    });
});

describe('the wait has no ceiling, and the heartbeat is not one', () => {
    // These two clocks are the decided shape: an update may wait indefinitely, but a
    // marker nobody is refreshing is an orphan. Conflating them would either force
    // updates (forbidden) or leave the bridge refusing all work forever.

    test('a refresh keeps the original `since` for the same commit', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });

        const later = t0 + (45 * 60 * 1000);
        const refresh = drain.markPending({ commit: COMMIT, markerFile: MARKER, now: later });
        expect(refresh.refreshed).toBe(true);

        const state = drain.inspect({ markerFile: MARKER, now: later });
        expect(state.since).toBe(t0);
        expect(state.waitingMs).toBe(45 * 60 * 1000);
        // Refreshed, therefore NOT stale, however long it has been waiting.
        expect(state.sinceHeartbeatMs).toBe(0);
        expect(state.stale).toBe(false);
    });

    test('a different commit starts its own clock', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });

        const later = t0 + (90 * 60 * 1000);
        const other = 'ccccccc3333333333333333333333333333333cc';
        drain.markPending({ commit: other, markerFile: MARKER, now: later });

        const state = drain.inspect({ markerFile: MARKER, now: later });
        expect(state.commit).toBe(other);
        expect(state.since).toBe(later);
        expect(state.waitingMs).toBe(0);
    });

    test('a marker waiting for hours is NOT stale while its heartbeat continues', () => {
        const t0 = 1_000_000_000_000;
        let now = t0;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now });

        // Six hours of five-minute heartbeats. No ceiling: still pending, still not stale.
        for (let i = 0; i < 72; i++) {
            now += 5 * 60 * 1000;
            drain.markPending({ commit: COMMIT, markerFile: MARKER, now });
        }

        const state = drain.inspect({ markerFile: MARKER, now });
        expect(state.pending).toBe(true);
        expect(state.stale).toBe(false);
        expect(state.waitingMs).toBe(6 * 60 * 60 * 1000);
    });

    test('a marker whose heartbeat stopped is stale', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });

        const quiet = t0 + (25 * 60 * 1000); // > 4 x the 5-minute default interval
        const state = drain.inspect({ markerFile: MARKER, now: quiet });
        expect(state.pending).toBe(true);
        expect(state.stale).toBe(true);
    });

    test('the threshold follows the updater\'s own interval', () => {
        process.env.CHECK_INTERVAL_MS = '60000';
        expect(drain.defaultStaleAfterMs()).toBe(4 * 60000);

        process.env.UPDATE_PENDING_STALE_MS = '123456';
        expect(drain.defaultStaleAfterMs()).toBe(123456);
    });
});

describe('an orphaned marker is cleared and SAID, never honoured and never silent', () => {
    test('a stale marker is cleared with a verdict a caller can post', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });

        const result = drain.clearIfStale({ markerFile: MARKER, now: t0 + (60 * 60 * 1000) });

        expect(result.action).toBe('cleared');
        expect(result.verdict).toEqual(expect.any(String));
        expect(fs.existsSync(MARKER)).toBe(false);

        // The verdict must not read as "an update was cancelled", which it is not.
        expect(result.verdict).toMatch(/did not cancel, force or hurry any update/i);
    });

    test('a live marker is left completely alone, with no verdict to post', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });

        const result = drain.clearIfStale({ markerFile: MARKER, now: t0 + 1000 });

        expect(result.action).toBe('none');
        expect(result.verdict).toBeNull();
        expect(fs.existsSync(MARKER)).toBe(true);
    });

    test('an absent marker produces no verdict', () => {
        expect(drain.clearIfStale({ markerFile: MARKER }).action).toBe('none');
    });
});

describe('it errs toward refusing, the way the task lock errs toward held', () => {
    test('an unparseable marker is pending, dated by its mtime', () => {
        fs.writeFileSync(MARKER, 'not json at all', 'utf8');

        const state = drain.inspect({ markerFile: MARKER });
        expect(state.pending).toBe(true);
        expect(state.format).toBe('mtime');
        expect(state.lastSeenAt).toEqual(expect.any(Number));
    });

    test('an unparseable marker still ages out rather than refusing forever', () => {
        fs.writeFileSync(MARKER, '{{{', 'utf8');
        const mtime = fs.statSync(MARKER).mtimeMs;

        const state = drain.inspect({ markerFile: MARKER, now: mtime + (60 * 60 * 1000) });
        expect(state.pending).toBe(true);
        expect(state.stale).toBe(true);
    });

    test('a marker with no commit recorded is still a refusal, described without crashing', () => {
        fs.writeFileSync(MARKER, JSON.stringify({ since: Date.now(), lastSeenAt: Date.now() }), 'utf8');

        const state = drain.inspect({ markerFile: MARKER });
        expect(state.pending).toBe(true);
        expect(drain.describeRefusal(state, 'some task')).toContain('(unknown commit)');
    });
});

describe('the refusal message says what was refused, why, and what to do', () => {
    test('it names the task, the update, and that nothing else was lost', () => {
        const t0 = 1_000_000_000_000;
        drain.markPending({ commit: COMMIT, markerFile: MARKER, now: t0 });
        const state = drain.inspect({ markerFile: MARKER, now: t0 + (12 * 60 * 1000) });

        const text = drain.describeRefusal(state, 'rebuild the widget');

        expect(text).toContain('rebuild the widget');
        expect(text).toContain('NOT queued');
        expect(text).toContain(COMMIT.substring(0, 7));
        expect(text).toMatch(/12m/);
        expect(text).toMatch(/resubmit/i);
        // It must not imply the operator's task is queued somewhere. It is not.
        expect(text).not.toMatch(/queued for later|will run when/i);
    });

    test('it works without a description', () => {
        drain.markPending({ commit: COMMIT, markerFile: MARKER });
        const text = drain.describeRefusal(drain.inspect({ markerFile: MARKER }));
        expect(text).toContain('this task');
    });
});

// ---------------------------------------------------------------------------
// THE GUARD: the poll loop actually refuses
// ---------------------------------------------------------------------------

const BRIDGE_AGENT_PATH = path.join(__dirname, '..', 'bridge-agent.js');
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

/**
 * The poll loop's TASK: branch — from the dedup check that admits a task to the
 * `continue` that ends the branch. Everything drain-one does to a dispatch happens
 * in here or nowhere.
 *
 * @param {string} src - bridge-agent.js source, or a mutated copy for the meta-tests
 */
function dispatchBranch(src) {
    const start = src.indexOf('if (isTaskMessage(msg) && !alreadyProcessed(msg)');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('const queuedTask = queue.enqueue({', start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
}

describe('the poll loop refuses a dispatch while an update is pending', () => {
    let branch;

    beforeAll(() => {
        branch = dispatchBranch(source);
    });

    test('the drain is consulted BEFORE the task is enqueued', () => {
        // After the enqueue it would be too late: the entry exists, the updater sees
        // live work, and the deferral is back to waiting on arrival rate.
        expect(branch).toContain('drainStateForDispatch()');
    });

    test('a refused dispatch is posted back to Slack, in the channel it was typed in', () => {
        const refusal = branch.slice(branch.indexOf('if (drain.refuse) {'));
        expect(refusal).toContain('slack.chat.postMessage');
        expect(refusal).toContain('updateDrain.describeRefusal');
        expect(refusal).toContain('channel: channelId');
    });

    test('a refused dispatch is marked processed, so it is not re-refused every poll', () => {
        const refusal = branch.slice(branch.indexOf('if (drain.refuse) {'));
        expect(refusal).toContain('markTaskProcessed(msg.ts)');
    });

    test('a refused dispatch does NOT fall through to being queued or run', () => {
        const refusal = branch.slice(branch.indexOf('if (drain.refuse) {'));
        expect(refusal).toContain('continue;');
        expect(refusal).not.toContain('queue.enqueue(');
        expect(refusal).not.toContain('processTask(');
    });

    test('a refusal that cannot be posted escalates instead of vanishing', () => {
        // The one outcome worse than a refusal is a refusal nobody hears.
        const refusal = branch.slice(branch.indexOf('if (drain.refuse) {'));
        expect(refusal).toContain('postToOps(');
        expect(refusal).toMatch(/has not been told/i);
    });

    test('the refusal text is redacted like every other outbound string', () => {
        const refusal = branch.slice(branch.indexOf('if (drain.refuse) {'));
        expect(refusal).toMatch(/redact\(/);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Every assertion above is "this region contains that string", which a region
    // that is accidentally empty also fails to satisfy only by luck. These prove the
    // extractor is looking at the right code.

    test('the extracted branch is the dispatch branch and not the whole file', () => {
        const branch = dispatchBranch(source);
        expect(branch.length).toBeGreaterThan(200);
        expect(branch.length).toBeLessThan(source.length / 4);
        expect(branch).toContain('isTaskMessage(msg)');
        // The ASK: branch lives after the enqueue site, so it must not be in here.
        expect(branch).not.toContain('processConversation(');
    });

    test('it fails when the drain check is removed', () => {
        const broken = source.replace('const drain = drainStateForDispatch();', 'const drain = { refuse: false };');
        expect(broken).not.toBe(source);
        expect(dispatchBranch(broken)).not.toContain('drainStateForDispatch()');
    });

    test('it fails when the refusal stops posting', () => {
        const branch = dispatchBranch(source);
        const broken = source.replace('updateDrain.describeRefusal', 'noop.describeRefusal');
        expect(broken).not.toBe(source);
        expect(dispatchBranch(broken)).not.toContain('updateDrain.describeRefusal');
        expect(branch).toContain('updateDrain.describeRefusal'); // and the real one does
    });

    test('the extractor throws rather than returning an empty region on a rename', () => {
        const renamed = source.replace('if (isTaskMessage(msg) && !alreadyProcessed(msg)', 'if (isTaskMsg(msg) && !alreadyProcessed(msg)');
        expect(() => dispatchBranch(renamed)).toThrow();
    });
});

describe('the drain check degrades open, and says so', () => {
    test('bridge-agent accepts dispatches if the check itself throws', () => {
        // Refusing every task forever because a marker file could not be parsed is
        // worse than the race drain-one closes, and looks identical to a dead bridge.
        const fn = source.slice(source.indexOf('function drainStateForDispatch()'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));

        expect(body).toContain('catch');
        expect(body).toMatch(/return \{ refuse: false/);
        expect(body).toContain('postToOps(');
    });

    test('a stale marker is swept on the way past, and its verdict is posted', () => {
        const fn = source.slice(source.indexOf('function drainStateForDispatch()'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));

        expect(body).toContain('updateDrain.clearIfStale()');
        expect(body).toMatch(/postToOps\(`:unlock:/);
    });

    test('a stale marker that could not be removed does not refuse', () => {
        // clearIfStale returning `clear-failed` leaves the file in place; inspect()
        // still reports it stale, and the gate is `pending && !stale`.
        const fn = source.slice(source.indexOf('function drainStateForDispatch()'));
        const body = fn.slice(0, fn.indexOf('\n}\n'));

        expect(body).toContain('state.pending && !state.stale');
    });
});
