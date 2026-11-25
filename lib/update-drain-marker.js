'use strict';

/**
 * lib/update-drain-marker.js
 *
 * The DRAIN-ONE marker file itself ($WORK_DIR/.update-pending): where it is, how long
 * its heartbeat may go quiet, and the three operations on it (markPending, clear,
 * inspect). The reasoning that decides drain-one (no ceiling; a heartbeat on
 * `lastSeenAt`, never a deadline on `since`; erring toward pending) is the header of
 * lib/update-drain.js, the hub that re-exports this module.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved unchanged out of
 * lib/update-drain.js. No I/O beyond the marker file.
 */

const fs = require('fs');
const path = require('path');
const { short } = require('./update-drain-messages');

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

module.exports = {
    markPending,
    clear,
    inspect,
    defaultStaleAfterMs,
    DEFAULT_MARKER_FILE,
    STALE_INTERVAL_MULTIPLE,
};
