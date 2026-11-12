'use strict';

/**
 * lib/task-queue.js
 *
 * LOGIC CHANGE 2026-04-01: Persistent task queue system to prevent auto-update
 * interruptions. Tasks are queued on disk before execution, allowing auto-update
 * to see in-flight work and defer rather than restart into it.
 *
 * LOGIC CHANGE 2026-09-14: PM2 removed from this file's prose. There is no PM2 in
 * this deployment (the `jt-agent` container restarts via `restart: unless-stopped`);
 * naming it described a supervisor that does not exist. See WORK-TODO P3 #12.
 *
 * LOGIC CHANGE 2026-09-15: Terminal transitions stamp a monotonic `completionSeq`
 * and `getRecentCompleted()` orders on it instead of on `completedAt`. `completedAt`
 * is `new Date().toISOString()` - MILLISECOND resolution - so two tasks completing
 * inside the same millisecond compared EQUAL, `Array#sort` is stable, and the tie
 * preserved insertion order: oldest first, the exact opposite of the method's
 * documented contract. Observed 1307/2000 wrong orderings in a tight loop and
 * 25 of 40 isolated runs of tests/task-queue.test.js red at one assertion.
 *
 * The tiebreaker is NOT a second clock field, because any clock can tie again at its
 * own resolution. `completionSeq` is an integer assigned as `1 + max(seq in file)`
 * inside the same synchronous `_load()` -> mutate -> `_save()` block that already
 * guards every write. It cannot tie: it is derived to be strictly greater than every
 * value present, so uniqueness holds by induction over the file, with no clock and
 * therefore no resolution to collide at. It is persisted on the entry, so it survives
 * a container restart - unlike `process.hrtime.bigint()`, whose origin is per-process
 * and would order a post-restart completion BEFORE a pre-restart one. See WORK-TODO #43.
 *
 * LOGIC CHANGE 2026-09-14: `markRunning()` added and the `running` state actually
 * wired into the live task path. Until now `dequeue()` was the SOLE writer of
 * `STATUS.RUNNING`/`startedAt` and had zero non-test callers: the live path went
 * `enqueue` -> `complete`/`fail` with no transition in between, so every completed
 * entry carried `startedAt: null` and `recoverInterrupted()` returned 0 at every
 * startup, unconditionally. See WORK-TODO P1 #18.
 *
 * Features:
 * - Persistent queue survives a container restart
 * - Status tracking: pending, running, completed, failed, interrupted
 * - Auto-update can see active work and defer
 * - Recovery from interrupted tasks (marked as interrupted on restart)
 * - Cleanup of old completed/failed entries
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): split. This file keeps the class, its
 * store (_load/_save) and EVERY writer of a row: enqueue, the running transition,
 * complete/fail/interrupt, recoverInterrupted, recordWork and cleanup. The readers moved
 * to lib/task-queue-view.js and are mixed into TaskQueue.prototype below; the delivery
 * verdict helpers moved to lib/task-queue-delivery.js and the status vocabulary to
 * lib/task-queue-status.js. Every name this module exported is still exported, as the
 * same object (tests/module-splits.test.js). The writers' delivery invariant is checked
 * over every method the class is assembled from, in whichever file it lives
 * (tests/task-queue-delivery-invariant.test.js).
 */

const fs = require('fs');
const path = require('path');

// Default queue file path - should be in a persistent location
const DEFAULT_QUEUE_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', 'task-queue.json');

// LOGIC CHANGE 2026-04-01: Retention for completed/failed tasks (24 hours)
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

// LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): the status vocabulary, the delivery
// verdict and the readers live in their own modules; see the header.
const { STATUS } = require('./task-queue-status');
const { DELIVERY_NOT_RECORDED, normalizeDelivery, deliveryRecorded } = require('./task-queue-delivery');
const { installReaders } = require('./task-queue-view');

// LOGIC CHANGE 2026-09-14: The reason recoverInterrupted() stamps. It used to read
// 'Task interrupted (PM2 restart or crash)' and named a process manager this
// deployment does not have - there is no PM2 on the `jt-agent` container, which
// restarts via the container runtime's `restart: unless-stopped` (WORK-TODO P3 #12).
// Exported so tests assert the same string the code writes rather than retyping it.
const INTERRUPTED_ON_STARTUP_REASON =
    'Task interrupted: the bridge process did not survive to record an outcome '
    + '(container restart or crash)';

/**
 * TaskQueue class - manages persistent task queue
 */
class TaskQueue {
    /**
     * @param {string} queueFile - Path to queue JSON file
     */
    constructor(queueFile = DEFAULT_QUEUE_FILE) {
        this.queueFile = queueFile;
        this._ensureDir();
    }

    /**
     * Ensure the directory for the queue file exists
     * @private
     */
    _ensureDir() {
        const dir = path.dirname(this.queueFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    /**
     * Load queue from disk
     * @returns {Array} Queue array
     * @private
     */
    _load() {
        try {
            if (!fs.existsSync(this.queueFile)) {
                return [];
            }
            const data = fs.readFileSync(this.queueFile, 'utf8');
            if (!data || !data.trim()) {
                return [];
            }
            const parsed = JSON.parse(data);
            if (!Array.isArray(parsed)) {
                console.warn('[task-queue] Queue file corrupted (not an array), resetting');
                return [];
            }
            return parsed;
        } catch (err) {
            if (err.code === 'ENOENT') {
                return [];
            }
            console.warn(`[task-queue] Failed to load queue: ${err.message}, resetting`);
            return [];
        }
    }

    /**
     * Save queue to disk
     * @param {Array} queue - Queue array
     * @private
     */
    _save(queue) {
        try {
            fs.writeFileSync(this.queueFile, JSON.stringify(queue, null, 2), 'utf8');
        } catch (err) {
            console.error(`[task-queue] Failed to save queue: ${err.message}`);
            throw err;
        }
    }

    /**
     * Add a task to the queue
     * @param {object} task - Task object with at minimum { msgTs, channelId, text }
     * @returns {object} The queued task with id and metadata
     */
    enqueue(task) {
        const queue = this._load();

        // Check for duplicate by msgTs
        const existing = queue.find(t => t.msgTs === task.msgTs);
        if (existing) {
            console.log(`[task-queue] Task ${task.msgTs} already in queue, skipping`);
            return existing;
        }

        const queuedTask = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            msgTs: task.msgTs,
            channelId: task.channelId,
            text: task.text,
            description: task.description || 'Unnamed task',
            repo: task.repo || null,
            status: STATUS.PENDING,
            enqueuedAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            // LOGIC CHANGE 2026-09-15: null until a terminal transition stamps it.
            completionSeq: null,
            // LOGIC CHANGE 2026-09-20: null until the result post's outcome is
            // recorded. Written explicitly rather than left absent so a reader can
            // tell "this code has not delivered yet" from "this row predates the
            // field" — see deliveryRecorded().
            delivery: null,
            // LOGIC CHANGE 2026-10-04 (WORK-TODO #39): what a repo task left behind
            // (branch, head commit, refs on the remote), recorded by recordWork().
            work: null,
            error: null,
        };

        queue.push(queuedTask);
        this._save(queue);

        console.log(`[task-queue] Enqueued task ${queuedTask.id}: ${queuedTask.description}`);
        return queuedTask;
    }

    /**
     * Allocate the next completion sequence number for a loaded queue.
     *
     * LOGIC CHANGE 2026-09-15: THE total order behind getRecentCompleted(). Returns
     * an integer strictly greater than every `completionSeq` already in the file, so
     * two entries can never share one - uniqueness holds by induction, with no clock
     * involved and therefore no resolution at which to collide.
     *
     * Callers MUST call this inside the same synchronous `_load()` -> mutate ->
     * `_save()` block as the write it stamps; the load-mutate-save cycle is what makes
     * "max in the file" current at the moment of allocation.
     *
     * `cleanup()` removing the current maximum does not break uniqueness: the max is
     * taken over the SURVIVING entries, so the reissued value is still greater than
     * every seq the file still holds, and the relative order of survivors is untouched.
     *
     * Entries written before this field existed carry no seq; they are skipped here
     * and ordered by the legacy branch of the comparator.
     *
     * @param {Array} queue - Loaded queue array
     * @returns {number} A sequence number unique within this queue file
     * @private
     */
    _nextCompletionSeq(queue) {
        let max = 0;
        for (const task of queue) {
            if (Number.isInteger(task.completionSeq) && task.completionSeq > max) {
                max = task.completionSeq;
            }
        }
        return max + 1;
    }

    /**
     * Transition one already-loaded entry into RUNNING.
     *
     * LOGIC CHANGE 2026-09-14: The single place that writes STATUS.RUNNING. Status
     * and `startedAt` are written TOGETHER and never separately - a RUNNING entry
     * with a null `startedAt` is not merely untidy, it is load-bearing damage:
     * `checkTaskQueue()` in auto-update.js treats an unparseable stamp as LIVE
     * (`isStale` returns false for a non-finite Date.parse), so such an entry would
     * defer every future deploy forever. `formatStatusResponse()` in bridge-agent.js
     * would likewise render `new Date(null)` as 1970 and report the task as having
     * started ~29 million minutes ago.
     *
     * @param {Array} queue - Loaded queue array (mutated)
     * @param {object} task - The entry to transition
     * @private
     */
    _startRunning(queue, task) {
        // A re-attempt of an entry that already reached a terminal state (the poll
        // loop re-processes a Slack message whose task was killed mid-run, because
        // both dedup guards - the done/failed reaction and processed-tasks.json -
        // are written only AFTER completion). Preserve that history instead of
        // erasing it: without this, a re-run would silently overwrite the
        // `interrupted` verdict recoverInterrupted() just recorded.
        if (task.status !== STATUS.PENDING) {
            task.attempts = (task.attempts || 1) + 1;
            task.previousStatus = task.status;
            task.previousError = task.error || null;
        }

        task.status = STATUS.RUNNING;
        task.startedAt = new Date().toISOString();
        task.completedAt = null;
        // LOGIC CHANGE 2026-09-15: cleared with completedAt, so a re-attempt's eventual
        // terminal write takes a FRESH (higher) seq and sorts as the recent completion
        // it is, rather than keeping the position of the attempt it replaced.
        task.completionSeq = null;
        // LOGIC CHANGE 2026-09-20: cleared with completionSeq. A re-attempt has not
        // delivered anything yet, and keeping the previous attempt's verdict would
        // tell the update gate that a task now in flight had already reported.
        task.delivery = null;
        // LOGIC CHANGE 2026-10-04 (WORK-TODO #39): a re-attempt has produced no work yet.
        task.work = null;
        task.error = null;
        this._save(queue);
        return task;
    }

    /**
     * Mark a known task as running. This is the transition the live task path uses.
     *
     * LOGIC CHANGE 2026-09-14: Prefer this over dequeue() from production code. The
     * bridge already holds the queue id it enqueued, whereas dequeue() searches for
     * "the first pending entry" - and with two entries pending (routine, since an
     * entry orphaned by a kill stays pending) that search picks the WRONG one: it
     * would mark entry A running while entry B executes, then complete(B) and leave
     * A running forever, deferring deploys until the staleness rule ages it out.
     *
     * @param {string} taskId - Task ID returned by enqueue()
     * @returns {object|null} The running task, or null if the id is unknown
     */
    markRunning(taskId) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found to mark running`);
            return null;
        }

        this._startRunning(queue, task);
        console.log(`[task-queue] Running task ${task.id}: ${task.description}`);
        return task;
    }

    /**
     * Get the next pending task and mark it as running.
     *
     * NOTE: no production caller. The live path uses markRunning() with the known
     * id (see above for why). This is kept as a queue-consumer API and delegates to
     * the same transition so the two can never disagree about what "running" writes.
     *
     * @returns {object|null} Next task to process or null if none
     */
    dequeue() {
        const queue = this._load();
        const pendingIdx = queue.findIndex(t => t.status === STATUS.PENDING);

        if (pendingIdx === -1) {
            return null;
        }

        const task = this._startRunning(queue, queue[pendingIdx]);
        console.log(`[task-queue] Dequeued task ${task.id}: ${task.description}`);
        return task;
    }

    /**
     * Mark a task as completed
     *
     * LOGIC CHANGE 2026-09-20: takes the delivery verdict for the result post. It is
     * a parameter rather than a separate call so the two cannot drift apart: a
     * terminal status and the question "did anyone find out?" are written in the
     * same load -> mutate -> save block, and a caller that omits it gets a recorded
     * `delivered: false`, never an optimistic default.
     *
     * @param {string} taskId - Task ID
     * @param {string} outcome - Outcome summary
     * @param {{ delivered?: boolean, detail?: string }} [delivery] - Result-post verdict
     */
    complete(taskId, outcome = 'Success', delivery) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found for completion`);
            return;
        }

        task.status = STATUS.COMPLETED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.delivery = normalizeDelivery(delivery);
        task.outcome = outcome;
        this._save(queue);

        console.log(
            `[task-queue] Completed task ${taskId} `
            + `(result delivered: ${task.delivery.delivered ? 'yes' : `NO — ${task.delivery.detail}`})`
        );
    }

    /**
     * Mark a task as failed
     * @param {string} taskId - Task ID
     * @param {string} error - Error message
     * @param {{ delivered?: boolean, detail?: string }} [delivery] - Failure-report verdict
     */
    fail(taskId, error, delivery) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found for failure`);
            return;
        }

        task.status = STATUS.FAILED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.delivery = normalizeDelivery(delivery);
        task.error = error;
        this._save(queue);

        console.log(
            `[task-queue] Failed task ${taskId}: ${error} `
            + `(report delivered: ${task.delivery.delivered ? 'yes' : `NO — ${task.delivery.detail}`})`
        );
    }

    /**
     * Mark a task as interrupted.
     *
     * LOGIC CHANGE 2026-09-14: Needed because the bridge OUTLIVES most interruptions.
     * `interrupted: true` is set by lib/llm-runner.js for any `code === null` child
     * exit - which includes the TASK_TIMEOUT_MS hard kill - so processTask's
     * interrupted branch runs in a process that is still very much alive and is NOT
     * about to hit startup recovery. Leaving that entry `running` would strand a
     * phantom in-flight task: `getRunning()` would report it as currently running
     * indefinitely, `cleanup()` never expires a RUNNING entry, and auto-update's
     * deferral gate would treat it as live work until the staleness threshold.
     * recoverInterrupted() stays the backstop for the case this cannot reach - the
     * bridge itself being killed.
     *
     * @param {string} taskId - Task ID
     * @param {string} reason - Why it was interrupted
     * @param {{ delivered?: boolean, detail?: string }} [delivery] - Interruption-notice verdict
     */
    interrupt(taskId, reason = 'Task interrupted', delivery) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found to mark interrupted`);
            return;
        }

        task.status = STATUS.INTERRUPTED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.delivery = normalizeDelivery(delivery);
        task.error = reason;
        this._save(queue);

        console.log(
            `[task-queue] Interrupted task ${taskId}: ${reason} `
            + `(notice delivered: ${task.delivery.delivered ? 'yes' : `NO — ${task.delivery.detail}`})`
        );
    }

    /**
     * Mark any running tasks as interrupted (called on startup recovery).
     *
     * LOGIC CHANGE 2026-09-14: This can finally fire. Before markRunning() was wired
     * into the live task path nothing ever wrote STATUS.RUNNING, so this returned 0
     * on every startup unconditionally and a task killed mid-run was never recorded
     * as interrupted at all - it stayed `pending` forever.
     *
     * The verdict is TERMINAL, never a re-queue: an entry goes to `interrupted`, not
     * back to `pending`, so nothing here can put a task that killed the process back
     * in front of it. (The bridge may still re-read the originating Slack message on
     * the next poll - see WORK-TODO - but that is the message dedup path, not this
     * one, and _startRunning() preserves this verdict rather than erasing it.)
     *
     * @returns {number} Number of tasks marked as interrupted
     */
    recoverInterrupted() {
        const queue = this._load();
        let count = 0;

        for (const task of queue) {
            if (task.status === STATUS.RUNNING) {
                task.status = STATUS.INTERRUPTED;
                task.completedAt = new Date().toISOString();
                // Allocated per entry inside the loop, so a startup sweep that recovers
                // several running entries still gives each a distinct position.
                task.completionSeq = this._nextCompletionSeq(queue);
                // LOGIC CHANGE 2026-09-20: this entry is the definition of an
                // undelivered result — the process died holding it. Recorded as a
                // loss rather than left null, because a null would keep deferring
                // updates for a task that no longer exists.
                task.delivery = normalizeDelivery({
                    delivered: false,
                    detail: 'the bridge process died before the result was delivered',
                });
                task.error = INTERRUPTED_ON_STARTUP_REASON;
                count++;
                console.log(`[task-queue] Marked task ${task.id} as interrupted`);
            }
        }

        if (count > 0) {
            this._save(queue);
        }

        return count;
    }

    /**
     * Record what a repo task left behind (lib/task-work.js describeWork()).
     *
     * LOGIC CHANGE 2026-10-04 (WORK-TODO #39). Writes the `work` field ONLY. It
     * never writes a status or a delivery verdict, so it cannot break the #74
     * invariant (tests/task-queue-delivery-invariant.test.js) and the update gate
     * reads nothing it writes.
     *
     * @param {string} taskId - Task ID
     * @param {object} work - describeWork() result
     * @returns {boolean} whether a row was found and written
     */
    recordWork(taskId, work) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);
        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found for work record`);
            return false;
        }
        task.work = work && typeof work === 'object' ? { ...work } : null;
        this._save(queue);
        return true;
    }

    /**
     * Clean up old completed/failed tasks
     * @returns {number} Number of tasks cleaned up
     */
    cleanup() {
        const queue = this._load();
        const now = Date.now();
        const initialLength = queue.length;

        const filtered = queue.filter(task => {
            // Keep all pending and running tasks
            if (task.status === STATUS.PENDING || task.status === STATUS.RUNNING) {
                return true;
            }
            // Remove completed/failed/interrupted tasks older than retention period
            if (task.completedAt) {
                const completedTime = new Date(task.completedAt).getTime();
                if (now - completedTime > COMPLETED_RETENTION_MS) {
                    return false;
                }
            }
            return true;
        });

        const removed = initialLength - filtered.length;
        if (removed > 0) {
            this._save(filtered);
            console.log(`[task-queue] Cleaned up ${removed} old tasks`);
        }

        return removed;
    }
}

// LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): the read side, installed with a class
// method's own descriptor (lib/task-queue-view.js).
installReaders(TaskQueue);

// Singleton instance for default queue
let defaultQueue = null;

/**
 * Get or create the default queue instance
 * @returns {TaskQueue} Default queue instance
 */
function getQueue() {
    if (!defaultQueue) {
        defaultQueue = new TaskQueue();
    }
    return defaultQueue;
}

/**
 * Check if any task is currently running or pending
 * (Used by auto-update to wait for queue to drain)
 * @returns {boolean} True if queue has active tasks
 */
function hasActiveTasks() {
    return !getQueue().isEmpty();
}

/**
 * Get current queue status for auto-update coordination
 * @returns {object} Status object with counts and details
 */
function getQueueStatus() {
    const queue = getQueue();
    return {
        ...queue.getStatus(),
        running: queue.getRunning(),
        pending: queue.getPending(),
    };
}

module.exports = {
    TaskQueue,
    getQueue,
    hasActiveTasks,
    getQueueStatus,
    STATUS,
    INTERRUPTED_ON_STARTUP_REASON,
    DEFAULT_QUEUE_FILE,
    // LOGIC CHANGE 2026-09-20: exported so auto-update.js asks the SAME question
    // about a queue row that this module answers, rather than re-deriving
    // "is it finished?" from the row's status. auto-update only ever READS
    // task-queue.json, so it needs the predicate, not the class.
    deliveryRecorded,
    normalizeDelivery,
    DELIVERY_NOT_RECORDED,
};
