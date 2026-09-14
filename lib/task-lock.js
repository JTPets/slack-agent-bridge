'use strict';

/**
 * lib/task-lock.js
 *
 * Sole owner of the task lock file (`$WORK_DIR/.task-running`), the flag that
 * tells auto-update.js "a task is running, do not restart the container".
 *
 * LOGIC CHANGE 2026-09-14: Extracted from the inline fs calls in
 * `processTask` (bridge-agent.js) and the `fs.existsSync` probe in
 * `waitForTaskCompletion` (auto-update.js), and given a staleness rule.
 *
 * Why this module exists
 * ----------------------
 * The lock was written at task start and deleted in `processTask`'s `finally`.
 * A `finally` does not run when the process is killed — which is exactly what a
 * self-update does — so a lock left behind by a killed task was never cleaned
 * up by anything. That did not deadlock only because auto-update gave up
 * waiting after 5 minutes and restarted anyway; the 5-minute cap was itself the
 * bug that killed long-running tasks. Removing the cap without a staleness rule
 * would convert a task-killer into a permanent deploy freeze.
 *
 * So staleness is not an add-on here, it is the precondition for deferring at
 * all. Both halves ship together.
 *
 * The staleness rule
 * ------------------
 * A lock is stale when it is older than `staleAfterMs`, whose default is
 * derived from the longest a task can legitimately hold it:
 *
 *     2 × TASK_TIMEOUT_MS   — `processTask` runs the LLM once, and on a
 *                             max-turns hit retries ONCE with doubled turns.
 *                             Each invocation is bounded by TASK_TIMEOUT_MS.
 *   + STALE_GRACE_MS        — Phase-3 `npm test`, delivery detection and the
 *                             Slack posts that run after the LLM returns.
 *
 * At the defaults (TASK_TIMEOUT_MS=600000) that is 30 minutes. Any lock older
 * than that cannot belong to a task that is still legitimately running, because
 * a task that age has already been hard-killed by its own timeout.
 *
 * Process liveness (the pid recorded below) is deliberately NOT a release
 * criterion. auto-update and bridge-agent are separate processes and this repo
 * cannot prove they share a pid namespace; a wrong liveness read would release
 * a live task's lock and destroy its work — the failure this module exists to
 * prevent. The pid is recorded and reported for diagnosis only.
 *
 * Nothing here releases a lock silently. `releaseIfStale()` returns a verdict
 * object describing what it did and why, and every caller is expected to both
 * log it and post it to #sqtools-ops.
 *
 * Regression coverage lives in tests/task-lock.test.js.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCK_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', '.task-running');

// Slack for the non-LLM part of processTask (Phase-3 `npm test`, delivery
// detection, Slack posts) that runs after the last LLM invocation returns.
const STALE_GRACE_MS = 10 * 60 * 1000;

/**
 * Longest a task may legitimately hold the lock. See the derivation above.
 * Read from the environment at call time (not module load) so a test can move
 * it without re-requiring the module.
 *
 * @returns {number} milliseconds
 */
function defaultStaleAfterMs() {
    const explicit = parseInt(process.env.TASK_LOCK_STALE_MS, 10);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;

    const taskTimeout = parseInt(process.env.TASK_TIMEOUT_MS, 10);
    const effectiveTimeout = Number.isFinite(taskTimeout) && taskTimeout > 0 ? taskTimeout : 600000;
    return 2 * effectiveTimeout + STALE_GRACE_MS;
}

function lockPath(lockFile) {
    return lockFile || DEFAULT_LOCK_FILE;
}

/**
 * Write the lock file, marking a task as running.
 *
 * Best effort by design: a task that cannot write its lock still runs. The
 * consequence of a missing lock is a restart that interrupts it, which is
 * strictly better than refusing to do the work at all. The failure is returned
 * (and logged) rather than thrown so the caller can surface it.
 *
 * @param {object} options
 * @param {string} options.msgTs        Slack message ts of the task
 * @param {string} [options.description] Human-readable task description
 * @param {string} [options.lockFile]   Override path (tests)
 * @returns {{ acquired: boolean, lockFile: string, error?: string }}
 */
function acquire({ msgTs, description, lockFile } = {}) {
    const file = lockPath(lockFile);
    const payload = {
        msgTs: msgTs || null,
        description: description || 'no description',
        pid: process.pid,
        startedAt: Date.now(),
    };

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
        console.log(`[task-lock] Acquired ${file} (pid ${payload.pid})`);
        return { acquired: true, lockFile: file };
    } catch (err) {
        console.error(`[task-lock] Failed to acquire ${file}: ${err.message}`);
        return { acquired: false, lockFile: file, error: err.message };
    }
}

/**
 * Remove the lock file.
 *
 * @param {string} [lockFile] Override path (tests)
 * @returns {{ released: boolean, existed: boolean, lockFile: string, error?: string }}
 */
function release(lockFile) {
    const file = lockPath(lockFile);
    try {
        if (!fs.existsSync(file)) {
            return { released: false, existed: false, lockFile: file };
        }
        fs.unlinkSync(file);
        console.log(`[task-lock] Released ${file}`);
        return { released: true, existed: true, lockFile: file };
    } catch (err) {
        console.error(`[task-lock] Failed to release ${file}: ${err.message}`);
        return { released: false, existed: true, lockFile: file, error: err.message };
    }
}

/**
 * Read the lock without changing it.
 *
 * Parses three shapes, because a deploy can briefly have one process on the new
 * code and one on the old:
 *   - JSON            — the format `acquire()` writes.
 *   - legacy 3 lines  — `msgTs\n<epoch ms>\ndescription`, written before this
 *                       module existed. Line 2 is the start time.
 *   - unparseable     — treated as HELD with the file's mtime as its start
 *                       time. Erring toward "held" keeps an unreadable lock
 *                       from being read as "no task running", which would
 *                       restart into a live task.
 *
 * @param {object} [options]
 * @param {string} [options.lockFile]     Override path (tests)
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ held: boolean, stale: boolean, ageMs: number|null, staleAfterMs: number,
 *             format: string|null, pid: number|null, msgTs: string|null,
 *             description: string|null, lockFile: string }}
 */
function inspect({ lockFile, staleAfterMs, now } = {}) {
    const file = lockPath(lockFile);
    const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : defaultStaleAfterMs();
    const clock = Number.isFinite(now) ? now : Date.now();

    const absent = {
        held: false,
        stale: false,
        ageMs: null,
        staleAfterMs: threshold,
        format: null,
        pid: null,
        msgTs: null,
        description: null,
        lockFile: file,
    };

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return absent;
        // Unreadable but present: assume held. See the doc comment.
        console.warn(`[task-lock] Could not read ${file} (${err.message}); treating as held`);
        return { ...absent, held: true, format: 'unreadable' };
    }

    let startedAt = null;
    let pid = null;
    let msgTs = null;
    let description = null;
    let format = 'unknown';

    const trimmed = (raw || '').trim();
    let parsedJson = null;
    if (trimmed.startsWith('{')) {
        try {
            parsedJson = JSON.parse(trimmed);
        } catch {
            parsedJson = null;
        }
    }

    if (parsedJson && typeof parsedJson === 'object') {
        format = 'json';
        startedAt = Number.isFinite(parsedJson.startedAt) ? parsedJson.startedAt : null;
        pid = Number.isFinite(parsedJson.pid) ? parsedJson.pid : null;
        msgTs = parsedJson.msgTs || null;
        description = parsedJson.description || null;
    } else {
        // Legacy: msgTs \n epochMs \n description
        const lines = raw.split('\n');
        const legacyStart = parseInt((lines[1] || '').trim(), 10);
        if (Number.isFinite(legacyStart) && legacyStart > 0) {
            format = 'legacy';
            startedAt = legacyStart;
            msgTs = (lines[0] || '').trim() || null;
            description = (lines[2] || '').trim() || null;
        }
    }

    if (startedAt === null) {
        // No usable timestamp in the file itself — fall back to its mtime so a
        // corrupted lock still ages out instead of pinning updates forever.
        try {
            startedAt = fs.statSync(file).mtimeMs;
            if (format === 'unknown') format = 'mtime';
        } catch (err) {
            console.warn(`[task-lock] Could not stat ${file} (${err.message}); treating as held`);
            return { ...absent, held: true, format: 'unreadable' };
        }
    }

    const ageMs = Math.max(0, clock - startedAt);

    return {
        held: true,
        stale: ageMs > threshold,
        ageMs,
        staleAfterMs: threshold,
        format,
        pid,
        msgTs,
        description,
        lockFile: file,
    };
}

/**
 * Release the lock only if it is stale, and describe what happened.
 *
 * The returned verdict is the whole point: it is never null on a release, so a
 * caller cannot drop a release on the floor without it being visible. Callers
 * log it AND post it to #sqtools-ops.
 *
 * @param {object} [options] Same options as inspect()
 * @returns {{ action: 'none'|'released'|'release-failed', verdict: string|null, lock: object }}
 */
function releaseIfStale(options = {}) {
    const lock = inspect(options);

    if (!lock.held || !lock.stale) {
        return { action: 'none', verdict: null, lock };
    }

    const ageMin = Math.round(lock.ageMs / 60000);
    const thresholdMin = Math.round(lock.staleAfterMs / 60000);
    const who = lock.description || lock.msgTs || 'unknown task';
    const pidNote = lock.pid ? ` (pid ${lock.pid})` : '';

    const result = release(lock.lockFile);
    if (!result.released) {
        const verdict =
            `Stale task lock detected at ${lock.lockFile} but could NOT be removed ` +
            `(${result.error || 'unknown error'}). Task: ${who}${pidNote}, age ${ageMin}m ` +
            `(stale after ${thresholdMin}m). Self-update stays blocked until this file is removed by hand.`;
        console.error(`[task-lock] ${verdict}`);
        return { action: 'release-failed', verdict, lock };
    }

    const verdict =
        `Released a stale task lock: "${who}"${pidNote} held ${lock.lockFile} for ${ageMin}m, ` +
        `past the ${thresholdMin}m limit, so its task cannot still be running ` +
        `(a task is hard-killed at TASK_TIMEOUT_MS). The lock was left behind by a process ` +
        `that died before its cleanup ran. Self-update is no longer blocked by it.`;
    console.warn(`[task-lock] ${verdict}`);
    return { action: 'released', verdict, lock };
}

module.exports = {
    acquire,
    release,
    inspect,
    releaseIfStale,
    defaultStaleAfterMs,
    DEFAULT_LOCK_FILE,
    STALE_GRACE_MS,
};
