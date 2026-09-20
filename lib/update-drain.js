'use strict';

/**
 * lib/update-drain.js
 *
 * Sole owner of the pending-update marker (`$WORK_DIR/.update-pending`) — the flag
 * that tells bridge-agent.js "a self-update is waiting; refuse new dispatches".
 *
 * LOGIC CHANGE 2026-09-20: new module, implementing DRAIN-ONE.
 *
 * What drain-one is, and what it replaces
 * ---------------------------------------
 * Before this, an update that found a task running simply DEFERRED: it pulled
 * nothing and retried on the next check interval (`evaluateTaskDeferral`,
 * auto-update.js). That is correct as far as it goes — it is what stopped the
 * updater killing live work — but its wait is bounded by the ARRIVAL RATE of new
 * tasks, not by one task. A back-to-back succession of healthy dispatches defers a
 * deploy forever, and nothing in the system pushes back.
 *
 * Drain-one adds the missing half: once an update is known, NEW dispatches are
 * REFUSED. The current task is allowed to finish — one task, not a queue to empty —
 * and the update applies when that task is confirmed finished. The refusal is what
 * bounds the wait; without it the bridge waits on arrival rate.
 *
 * Two shapes were considered and rejected: plain deferral (starves, as above) and
 * queue-to-empty (still waits on arrival rate, just one level up).
 *
 * THERE IS NO CEILING, and that is a decision, not an oversight
 * -------------------------------------------------------------
 * A pending update may wait indefinitely. Nothing here forces one, and nothing here
 * kills a task to apply one. The staleness rule below is NOT a ceiling: it does not
 * bound how long an update may wait, only how long the MARKER may go unrefreshed
 * before it is read as an orphan. Those are different clocks and they are stored in
 * different fields on purpose:
 *
 *   since      — when this update was first noticed. Grows without limit. Reported.
 *   lastSeenAt — refreshed by the updater on every cycle it is still waiting. This
 *                is a liveness heartbeat.
 *
 * Staleness is measured on `lastSeenAt`. A marker whose updater has stopped
 * refreshing it cannot belong to a live update — the updater refreshes every
 * CHECK_INTERVAL_MS — so continuing to refuse every dispatch on its account would
 * be the worst failure this file can produce: a bridge that silently accepts no
 * work at all, for an update that is never coming. A stale marker is therefore
 * cleared and REPORTED, never honoured and never silently dropped.
 *
 * Erring direction
 * ----------------
 * An unreadable or unparseable marker is treated as PENDING (with the file's mtime
 * as its heartbeat), the same direction lib/task-lock.js errs in: refusing a
 * dispatch costs one resubmission, whereas starting a task that a restart then
 * kills costs the work. Nothing here is silent — every verdict is a string the
 * caller logs AND posts.
 *
 * This module does no I/O beyond the marker file: no Slack call, no git call, no
 * subprocess. It decides and describes; the callers act.
 *
 * Regression coverage lives in tests/update-drain.test.js and
 * tests/auto-update-defer.test.js.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MARKER_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', '.update-pending');

// How many missed heartbeats before the marker is read as an orphan. The updater
// refreshes on every CHECK_INTERVAL_MS, so four missed refreshes is a daemon that
// has stopped, not one that is busy.
const STALE_INTERVAL_MULTIPLE = 4;

/**
 * The updater's own poll interval, read the same way auto-update.js reads it, so the
 * heartbeat and the staleness rule cannot be configured apart from each other.
 *
 * @returns {number} milliseconds
 */
function checkIntervalMs() {
    const explicit = parseInt(process.env.CHECK_INTERVAL_MS, 10);
    return Number.isFinite(explicit) && explicit > 0 ? explicit : 5 * 60 * 1000;
}

/**
 * How long a marker may go unrefreshed before it is treated as an orphan.
 *
 * Read from the environment at call time (not module load) so a test can move it
 * without re-requiring the module — the same reason lib/task-lock.js does.
 *
 * @returns {number} milliseconds
 */
function defaultStaleAfterMs() {
    const explicit = parseInt(process.env.UPDATE_PENDING_STALE_MS, 10);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return STALE_INTERVAL_MULTIPLE * checkIntervalMs();
}

function markerPath(markerFile) {
    return markerFile || DEFAULT_MARKER_FILE;
}

/**
 * Record that an update is waiting, or refresh the heartbeat of one already
 * recorded.
 *
 * `since` is preserved across refreshes FOR THE SAME COMMIT, so "this update has
 * been waiting 90 minutes" is the truth about that update and is not handed to the
 * next one. A different commit starts its own clock — the same per-commit rule
 * auto-update.js already applies to its deferral bookkeeping.
 *
 * Best effort, like the task lock: an update that cannot write its marker still
 * defers. The consequence of a missing marker is dispatches that are not refused,
 * which is the behaviour that existed before this module — strictly no worse. The
 * failure is returned rather than thrown so the caller can surface it.
 *
 * @param {object} options
 * @param {string} options.commit        The remote head this update would apply
 * @param {string} [options.reason]      Why it is waiting (for the refusal message)
 * @param {string} [options.markerFile]  Override path (tests)
 * @param {number} [options.now]         Override clock (tests)
 * @returns {{ marked: boolean, refreshed: boolean, since: number|null, markerFile: string, error?: string }}
 */
function markPending({ commit, reason, markerFile, now } = {}) {
    const file = markerPath(markerFile);
    const clock = Number.isFinite(now) ? now : Date.now();

    const existing = inspect({ markerFile: file, now: clock });
    const sameUpdate = existing.pending && existing.commit === (commit || null);
    const since = sameUpdate && Number.isFinite(existing.since) ? existing.since : clock;

    const payload = {
        commit: commit || null,
        reason: reason || null,
        since,
        lastSeenAt: clock,
        pid: process.pid,
    };

    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
        const waitedMin = Math.round((clock - since) / 60000);
        console.log(
            `[update-drain] Update ${short(commit)} is PENDING `
            + `(waiting ${waitedMin}m). New dispatches are refused until it applies.`
        );
        return { marked: true, refreshed: sameUpdate, since, markerFile: file };
    } catch (err) {
        console.error(`[update-drain] Failed to record pending update at ${file}: ${err.message}`);
        return { marked: false, refreshed: false, since: null, markerFile: file, error: err.message };
    }
}

/**
 * Remove the marker, so dispatches are accepted again.
 *
 * Called on EVERY path out of a pending update — applied, aborted, refused by a
 * guard, or thrown out of — because a marker left behind refuses work forever.
 *
 * @param {object} [options]
 * @param {string} [options.markerFile] Override path (tests)
 * @param {string} [options.reason]     Why it is being cleared (logged)
 * @returns {{ cleared: boolean, existed: boolean, markerFile: string, error?: string }}
 */
function clear({ markerFile, reason } = {}) {
    const file = markerPath(markerFile);
    try {
        if (!fs.existsSync(file)) {
            return { cleared: false, existed: false, markerFile: file };
        }
        fs.unlinkSync(file);
        console.log(`[update-drain] Cleared pending-update marker ${file}${reason ? ` (${reason})` : ''}`);
        return { cleared: true, existed: true, markerFile: file };
    } catch (err) {
        console.error(`[update-drain] Failed to clear ${file}: ${err.message}`);
        return { cleared: false, existed: true, markerFile: file, error: err.message };
    }
}

/**
 * Read the marker without changing it.
 *
 * Parses two shapes, because a deploy can briefly have one process on the new code
 * and one on the old:
 *   - JSON        — the format markPending() writes.
 *   - unparseable — treated as PENDING with the file's mtime as its heartbeat.
 *                   Erring toward "pending" keeps an unreadable marker from being
 *                   read as "no update waiting", which would start a task into a
 *                   restart.
 *
 * @param {object} [options]
 * @param {string} [options.markerFile]   Override path (tests)
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ pending: boolean, stale: boolean, commit: string|null, reason: string|null,
 *             since: number|null, lastSeenAt: number|null, waitingMs: number|null,
 *             sinceHeartbeatMs: number|null, staleAfterMs: number, format: string|null,
 *             markerFile: string }}
 */
function inspect({ markerFile, staleAfterMs, now } = {}) {
    const file = markerPath(markerFile);
    const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : defaultStaleAfterMs();
    const clock = Number.isFinite(now) ? now : Date.now();

    const absent = {
        pending: false,
        stale: false,
        commit: null,
        reason: null,
        since: null,
        lastSeenAt: null,
        waitingMs: null,
        sinceHeartbeatMs: null,
        staleAfterMs: threshold,
        format: null,
        markerFile: file,
    };

    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return absent;
        console.warn(`[update-drain] Could not read ${file} (${err.message}); treating as pending`);
        return { ...absent, pending: true, format: 'unreadable' };
    }

    let parsed = null;
    const trimmed = (raw || '').trim();
    if (trimmed.startsWith('{')) {
        try {
            parsed = JSON.parse(trimmed);
        } catch {
            parsed = null;
        }
    }

    let commit = null;
    let reason = null;
    let since = null;
    let lastSeenAt = null;
    let format = 'unknown';

    if (parsed && typeof parsed === 'object') {
        format = 'json';
        commit = parsed.commit || null;
        reason = parsed.reason || null;
        since = Number.isFinite(parsed.since) ? parsed.since : null;
        lastSeenAt = Number.isFinite(parsed.lastSeenAt) ? parsed.lastSeenAt : null;
    }

    if (lastSeenAt === null) {
        // No usable heartbeat in the file itself — fall back to its mtime so a
        // corrupted marker still ages out instead of refusing dispatches forever.
        try {
            lastSeenAt = fs.statSync(file).mtimeMs;
            if (format === 'unknown') format = 'mtime';
        } catch (err) {
            console.warn(`[update-drain] Could not stat ${file} (${err.message}); treating as pending`);
            return { ...absent, pending: true, format: 'unreadable' };
        }
    }
    if (since === null) since = lastSeenAt;

    const sinceHeartbeatMs = Math.max(0, clock - lastSeenAt);

    return {
        pending: true,
        stale: sinceHeartbeatMs > threshold,
        commit,
        reason,
        since,
        lastSeenAt,
        waitingMs: Math.max(0, clock - since),
        sinceHeartbeatMs,
        staleAfterMs: threshold,
        format,
        markerFile: file,
    };
}

/**
 * Clear the marker only if its heartbeat has stopped, and describe what happened.
 *
 * The returned verdict is the whole point: it is never null on a clear, so a caller
 * cannot drop one on the floor without it being visible. Callers log it AND post it.
 *
 * Read the bound carefully — this ages out an ORPHANED MARKER, not a waiting update.
 * A live updater refreshes `lastSeenAt` every check interval, so this can only fire
 * for a marker no updater is tending. It never forces, cancels or hurries an update.
 *
 * @param {object} [options] Same options as inspect()
 * @returns {{ action: 'none'|'cleared'|'clear-failed', verdict: string|null, state: object }}
 */
function clearIfStale(options = {}) {
    const state = inspect(options);

    if (!state.pending || !state.stale) {
        return { action: 'none', verdict: null, state };
    }

    const quietMin = Math.round(state.sinceHeartbeatMs / 60000);
    const thresholdMin = Math.round(state.staleAfterMs / 60000);
    const result = clear({ markerFile: state.markerFile, reason: 'stale heartbeat' });

    if (!result.cleared) {
        const verdict =
            `A pending-update marker at \`${state.markerFile}\` (${short(state.commit)}) has not been `
            + `refreshed for ${quietMin}m, past the ${thresholdMin}m limit, but it could NOT be removed `
            + `(${result.error || 'unknown error'}). Every new dispatch stays refused until this file is `
            + `removed by hand.`;
        console.error(`[update-drain] ${verdict}`);
        return { action: 'clear-failed', verdict, state };
    }

    const verdict =
        `Cleared an orphaned pending-update marker: ${short(state.commit)} was recorded as waiting but its `
        + `heartbeat stopped ${quietMin}m ago, past the ${thresholdMin}m limit, so no updater is tending it. `
        + `Dispatches are accepted again. NOTE: this did not cancel, force or hurry any update — a live `
        + `updater refreshes the marker every check interval, so a marker this quiet belongs to a process `
        + `that is gone.`;
    console.warn(`[update-drain] ${verdict}`);
    return { action: 'cleared', verdict, state };
}

/**
 * The message posted back to Slack when a dispatch is refused.
 *
 * A refused dispatch MUST be visible. This repo has already had one silent-drop
 * defect on the intake path — a body with no `INSTRUCTIONS:` label was dropped and
 * the executor ran on the one-line description, with nothing reported — and the fix
 * there was to refuse and name what was unclaimed. This matches that shape: say what
 * was refused, say why, and say what to do about it. A race is eventually noticed; a
 * disappearance is not.
 *
 * @param {object} state - An inspect() result
 * @param {string} [description] - The refused task's description
 * @returns {string} Slack message text
 */
function describeRefusal(state, description) {
    const waitedMin = Math.round((state.waitingMs || 0) / 60000);
    const what = description ? `*${description}*` : 'this task';

    return (
        `:no_entry: *Dispatch refused — a self-update is pending.*\n`
        + `${what} was NOT queued and NOT started.\n`
        + `Update ${short(state.commit)} has been waiting ${waitedMin}m for the current task to finish. `
        + `While it waits, new dispatches are refused so the wait is bounded by one task rather than by how `
        + `often work arrives.\n`
        + `Nothing has been lost except this request: **resubmit it once the update has applied.** `
        + `The update is never forced and the running task is never killed.`
    );
}

/**
 * Short commit hash for a message, never throwing on a null.
 * @param {string|null} commit
 * @returns {string}
 */
function short(commit) {
    return commit ? `\`${String(commit).substring(0, 7)}\`` : '(unknown commit)';
}

module.exports = {
    markPending,
    clear,
    inspect,
    clearIfStale,
    describeRefusal,
    defaultStaleAfterMs,
    DEFAULT_MARKER_FILE,
    STALE_INTERVAL_MULTIPLE,
};
