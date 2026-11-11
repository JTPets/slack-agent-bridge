'use strict';

/**
 * lib/update-deferral.js
 *
 * Whether a self-update must stand aside for work in flight (the task lock and the
 * task queue), and what it does while it stands aside. Moved out of auto-update.js on
 * 2026-11-11 (WORK-TODO #10, Wave 4): checkTaskQueue and evaluateTaskDeferral unchanged,
 * and holdUpdate, the deferral bookkeeping that was inline in checkForUpdates.
 * Reads the lock and the queue; never writes either (task-queue.json is bridge-agent's).
 */

const fs = require('fs');
const taskLock = require('./task-lock');
// LOGIC CHANGE 2026-09-20: the DELIVERY predicate, not a re-derivation of it. This
// file only ever READS task-queue.json, so it takes the predicate rather than the
// class - but it must ask the same question lib/task-queue.js answers, or the gate
// and the record would disagree about what "finished" means.
const { deliveryRecorded } = require('./task-queue');
const {
    TASK_LOCK_FILE, TASK_QUEUE_FILE, CHECK_INTERVAL_MS, DEFER_ALERT_AFTER_MS,
} = require('./update-config');

// LOGIC CHANGE 2026-03-27: Wait for bridge-agent task to complete before restarting.
// LOGIC CHANGE 2026-04-01: Also checks task queue for pending/running tasks.
// LOGIC CHANGE 2026-09-14: The wait loop is gone; this is now a non-blocking
// deferral check. See DEFER_ALERT_AFTER_MS above for why waiting-then-restarting
// was the defect rather than the safeguard.

/**
 * Check if task queue has active tasks (pending or running).
 *
 * LOGIC CHANGE 2026-09-14: Entries older than the task-lock staleness threshold
 * no longer count as active. `recoverInterrupted()` on bridge startup only
 * rewrites "running" entries, so a task killed between `enqueue()` and
 * `dequeue()` stays "pending" forever. Under the old 5-minute cap that merely
 * delayed each update; now that a deferral has no cap, one such entry would
 * freeze deploys permanently. Stale entries are reported, never rewritten -
 * task-queue.json is bridge-agent's file and auto-update only reads it.
 *
 * @param {object} [options]
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ hasActive: boolean, pending: number, running: object|null, staleIgnored: number }}
 */
function checkTaskQueue({ staleAfterMs, now } = {}) {
    const empty = { hasActive: false, pending: 0, running: null, awaitingDelivery: 0, staleIgnored: 0 };
    try {
        if (!fs.existsSync(TASK_QUEUE_FILE)) {
            return empty;
        }
        const data = fs.readFileSync(TASK_QUEUE_FILE, 'utf8');
        if (!data || !data.trim()) {
            return empty;
        }
        const queue = JSON.parse(data);
        if (!Array.isArray(queue)) {
            return empty;
        }

        const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0
            ? staleAfterMs
            : taskLock.defaultStaleAfterMs();
        const clock = Number.isFinite(now) ? now : Date.now();

        const isStale = (task, stampField) => {
            const stamp = Date.parse(task[stampField]);
            if (!Number.isFinite(stamp)) return false; // no usable stamp -> treat as live
            return clock - stamp > threshold;
        };

        const allPending = queue.filter(t => t.status === 'pending');
        const livePending = allPending.filter(t => !isStale(t, 'enqueuedAt'));

        const allRunning = queue.filter(t => t.status === 'running');
        const liveRunning = allRunning.filter(t => !isStale(t, 'startedAt'));

        // LOGIC CHANGE 2026-09-20: THE FINISH LINE IS DELIVERY, NOT STATUS.
        //
        // Applying an update restarts the process, so "this task is finished" has to
        // mean its RESULT WAS DELIVERED - a task that completed and never posted is,
        // in every durable record, identical to one that never ran. The terminal
        // queue write happens strictly AFTER the result post and now carries that
        // post's verdict (lib/task-queue.js), so an entry with no verdict recorded is
        // still in flight whatever its status says.
        //
        // LOGIC CHANGE 2026-10-02 (WORK-TODO #74): what that sentence does NOT say is
        // that no production writer can produce such an entry. Every terminal write in
        // lib/task-queue.js stamps a verdict in the same block (normalizeDelivery never
        // returns null), so `allUndelivered` below is empty for every row this code
        // writes. The branch is kept as defence in depth against a future terminal
        // writer, and tests/task-queue-delivery-invariant.test.js fails if one appears.
        // What actually protects the post window is ORDER: the result post precedes the
        // terminal write, so during it the entry is still `running` (liveRunning above),
        // and the task lock is released only after both (tests/task-delivery-signal.test.js).
        // A delivery that permanently fails is recorded as `delivered: false` and does
        // NOT hold an update - deliberately: holding it would turn one Slack outage into
        // a bridge that refuses every dispatch (drain-one).
        //
        // This does not change the behaviour of any entry written before that field
        // existed: deliveryRecorded() returns true for a row with no `delivery` key
        // at all, precisely so a pre-change queue file cannot freeze every deploy the
        // first time this code runs against it.
        const terminalStamp = t => (t.completedAt ? 'completedAt' : (t.startedAt ? 'startedAt' : 'enqueuedAt'));
        const isTerminal = t => t.status !== 'pending' && t.status !== 'running';
        const allUndelivered = queue.filter(t => isTerminal(t) && !deliveryRecorded(t));
        const liveUndelivered = allUndelivered.filter(t => !isStale(t, terminalStamp(t)));

        const staleIgnored = (allPending.length - livePending.length)
            + (allRunning.length - liveRunning.length)
            + (allUndelivered.length - liveUndelivered.length);

        return {
            hasActive: livePending.length > 0 || liveRunning.length > 0 || liveUndelivered.length > 0,
            pending: livePending.length,
            running: liveRunning[0] || null,
            awaitingDelivery: liveUndelivered.length,
            staleIgnored,
        };
    } catch (err) {
        console.error('Failed to check task queue:', err.message);
        return empty;
    }
}

/**
 * Decide whether this update cycle must stand aside for a running task.
 *
 * Order matters. A stale lock is released FIRST, so a lock left behind by a
 * killed task cannot make the check below defer forever. Anything released here
 * is surfaced twice - logged by lib/task-lock.js and posted to #sqtools-ops by
 * the caller. There is no silent release.
 *
 * On the bound: a deferral retries on the very next check interval because
 * nothing is persisted to suppress it - the caller simply returns, and
 * setInterval(checkForUpdates, CHECK_INTERVAL_MS) runs it again. A SINGLE task
 * can hold the lock for at most the staleness threshold (default 30 min, see
 * lib/task-lock.js) before it is released out from under it. A back-to-back
 * SUCCESSION of healthy tasks can, however, defer an update indefinitely: that
 * is deliberate, because the alternative is killing live work, which is the bug
 * being fixed. It is bounded by visibility rather than by a timer - once a
 * single update has been deferred continuously for DEFER_ALERT_AFTER_MS
 * (default 60 min), every cycle escalates to #sqtools-ops so a deploy that is
 * never landing cannot go unnoticed.
 *
 * @param {object} [options]
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ defer: boolean, reason: string|null, staleVerdicts: string[], queue: object, lock: object }}
 */
function evaluateTaskDeferral({ staleAfterMs, now } = {}) {
    const staleVerdicts = [];

    const staleRelease = taskLock.releaseIfStale({
        lockFile: TASK_LOCK_FILE,
        staleAfterMs,
        now,
    });
    if (staleRelease.verdict) {
        staleVerdicts.push(staleRelease.verdict);
    }

    // Re-read after a possible release so the decision uses current truth.
    const lock = taskLock.inspect({ lockFile: TASK_LOCK_FILE, staleAfterMs, now });
    const queue = checkTaskQueue({ staleAfterMs, now });

    if (queue.staleIgnored > 0) {
        const verdict =
            `Ignored ${queue.staleIgnored} stale task-queue entr${queue.staleIgnored === 1 ? 'y' : 'ies'} ` +
            `in ${TASK_QUEUE_FILE} when deciding whether to defer: older than the staleness limit, so they ` +
            `cannot belong to a live task. They were NOT rewritten - task-queue.json belongs to bridge-agent, ` +
            `whose recoverInterrupted() only repairs "running" entries. A "pending" entry orphaned by a kill ` +
            `stays in the file and would otherwise block every future deploy.`;
        console.warn(`[auto-update] ${verdict}`);
        staleVerdicts.push(verdict);
    }

    if (lock.held && !lock.stale) {
        const ageMin = Math.round((lock.ageMs || 0) / 60000);
        return {
            defer: true,
            reason: `a task holds the lock (${lock.description || lock.msgTs || 'unknown task'}, running ${ageMin}m)`,
            staleVerdicts,
            queue,
            lock,
        };
    }

    if (queue.hasActive) {
        // LOGIC CHANGE 2026-09-20: `awaitingDelivery` is reported FIRST when present,
        // because it is the reason a reader would otherwise not believe: an entry
        // whose status already reads `completed` but whose result has not been
        // delivered. Naming it as "the queue is not drained" would send whoever reads
        // the ops post looking for a running task that is not there.
        const detail = queue.awaitingDelivery > 0
            ? `${queue.awaitingDelivery} task(s) finished but their results are not yet delivered`
            : queue.running
                ? `running: ${queue.running.description || 'unknown'}`
                : `${queue.pending} pending task(s)`;
        return {
            defer: true,
            reason: `the task queue is not drained (${detail})`,
            staleVerdicts,
            queue,
            lock,
        };
    }

    return { defer: false, reason: null, staleVerdicts, queue, lock };
}

/**
 * Stand an update aside for this cycle: record when this commit started waiting, log,
 * post on the first deferral and again once past DEFER_ALERT_AFTER_MS, and save state.
 * The caller returns afterwards; nothing has been pulled.
 *
 * LOGIC CHANGE 2026-11-11 (WORK-TODO #10): moved unchanged out of checkForUpdates, which
 * was 340 lines, over the owner's 300-lines-per-function rule.
 *
 * @param {{ reason: string }} deferral - evaluateTaskDeferral's verdict, `defer` true
 * @param {object} state - auto-update's state, mutated and saved
 * @param {string} remoteHead - the commit being held
 * @param {{ postToOps: Function, saveState: Function }} deps
 */
async function holdUpdate(deferral, state, remoteHead, deps) {
    const now = Date.now();
    // The elapsed figure is per-commit. Without this, a commit deferred
    // for 90m would hand its clock to the NEXT commit, which would then
    // escalate immediately quoting an elapsed time that is not its own.
    if (state.deferringCommit !== remoteHead) {
        state.deferringCommit = remoteHead;
        state.deferringSince = now;
        state.deferNotifiedAt = null;
    }
    if (!state.deferringSince) {
        state.deferringSince = now;
    }
    const deferredForMs = now - state.deferringSince;
    const deferredMin = Math.round(deferredForMs / 60000);

    console.log(
        `Deferring update to ${remoteHead.substring(0, 7)}: ${deferral.reason}. ` +
        `Deferred for ${deferredMin}m; retrying next check interval.`
    );

    // Post on the first deferral of this update, then only once past the
    // escalation threshold, so a normal long task does not spam #sqtools-ops
    // every CHECK_INTERVAL_MS.
    const escalating = deferredForMs >= DEFER_ALERT_AFTER_MS;
    if (!state.deferNotifiedAt) {
        await deps.postToOps(
            `:hourglass_flowing_sand: Auto-update: holding ${remoteHead.substring(0, 7)} - ${deferral.reason}. ` +
            `Nothing has been pulled; retrying every ${Math.round(CHECK_INTERVAL_MS / 60000)}m until the task finishes.`
        );
        state.deferNotifiedAt = now;
    } else if (escalating) {
        await deps.postToOps(
            `:warning: Auto-update: ${remoteHead.substring(0, 7)} has been deferred for ${deferredMin}m ` +
            `(over the ${Math.round(DEFER_ALERT_AFTER_MS / 60000)}m alert threshold) - ${deferral.reason}. ` +
            `The update is NOT being forced: killing a live task is the failure this deferral exists to ` +
            `prevent. If no task should be running, check the lock at \`${TASK_LOCK_FILE}\` and the queue ` +
            `at \`${TASK_QUEUE_FILE}\`.`
        );
        state.deferNotifiedAt = now;
    }

    deps.saveState(state);
}

/**
 * Cleared to proceed - forget any deferral history so the next one starts fresh.
 * Moved unchanged out of checkForUpdates on 2026-11-11 (WORK-TODO #10).
 * @param {object} state - mutated; the caller saves it later in the cycle
 */
function clearDeferral(state) {
    if (state.deferringSince || state.deferNotifiedAt || state.deferringCommit) {
        const heldMin = state.deferringSince ? Math.round((Date.now() - state.deferringSince) / 60000) : 0;
        console.log(`Task lock clear after ${heldMin}m of deferral; proceeding with update`);
        state.deferringSince = null;
        state.deferNotifiedAt = null;
        state.deferringCommit = null;
    }
}

module.exports = {
    checkTaskQueue,
    evaluateTaskDeferral,
    holdUpdate,
    clearDeferral,
};
