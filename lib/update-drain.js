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
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): the hub. This header and clearIfStale
 * (the one decision: honour a marker or clear it as an orphan) stay here; the marker
 * file and its three operations are lib/update-drain-marker.js, and every message is
 * lib/update-drain-messages.js. Every name this module exported is still exported, as
 * the same function object (tests/module-splits.test.js).
 */

const marker = require('./update-drain-marker');
const { describeRefusal, describeStaleCleared, describeStaleClearFailed } = require('./update-drain-messages');

const { inspect, clear } = marker;

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
        const verdict = describeStaleClearFailed(state, quietMin, thresholdMin, result.error);
        console.error(`[update-drain] ${verdict}`);
        return { action: 'clear-failed', verdict, state };
    }

    const verdict = describeStaleCleared(state, quietMin, thresholdMin);
    console.warn(`[update-drain] ${verdict}`);
    return { action: 'cleared', verdict, state };
}

module.exports = {
    markPending: marker.markPending,
    clear: marker.clear,
    inspect: marker.inspect,
    clearIfStale,
    describeRefusal,
    defaultStaleAfterMs: marker.defaultStaleAfterMs,
    DEFAULT_MARKER_FILE: marker.DEFAULT_MARKER_FILE,
    STALE_INTERVAL_MULTIPLE: marker.STALE_INTERVAL_MULTIPLE,
};
