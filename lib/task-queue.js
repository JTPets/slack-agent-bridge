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
 */

const fs = require('fs');
const path = require('path');

// Default queue file path - should be in a persistent location
const DEFAULT_QUEUE_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', 'task-queue.json');

// LOGIC CHANGE 2026-04-01: Retention for completed/failed tasks (24 hours)
const COMPLETED_RETENTION_MS = 24 * 60 * 60 * 1000;

// Task statuses
const STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted',
};

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
     * @param {string} taskId - Task ID
     * @param {string} outcome - Outcome summary
     */
    complete(taskId, outcome = 'Success') {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found for completion`);
            return;
        }

        task.status = STATUS.COMPLETED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.outcome = outcome;
        this._save(queue);

        console.log(`[task-queue] Completed task ${taskId}`);
    }

    /**
     * Mark a task as failed
     * @param {string} taskId - Task ID
     * @param {string} error - Error message
     */
    fail(taskId, error) {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found for failure`);
            return;
        }

        task.status = STATUS.FAILED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.error = error;
        this._save(queue);

        console.log(`[task-queue] Failed task ${taskId}: ${error}`);
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
     */
    interrupt(taskId, reason = 'Task interrupted') {
        const queue = this._load();
        const task = queue.find(t => t.id === taskId);

        if (!task) {
            console.warn(`[task-queue] Task ${taskId} not found to mark interrupted`);
            return;
        }

        task.status = STATUS.INTERRUPTED;
        task.completedAt = new Date().toISOString();
        task.completionSeq = this._nextCompletionSeq(queue);
        task.error = reason;
        this._save(queue);

        console.log(`[task-queue] Interrupted task ${taskId}: ${reason}`);
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
     * Get the currently running task (if any)
     * @returns {object|null} Running task or null
     */
    getRunning() {
        const queue = this._load();
        return queue.find(t => t.status === STATUS.RUNNING) || null;
    }

    /**
     * Get all pending tasks
     * @returns {Array} Pending tasks
     */
    getPending() {
        const queue = this._load();
        return queue.filter(t => t.status === STATUS.PENDING);
    }

    /**
     * Get queue size (pending + running)
     * @returns {number} Number of active tasks
     */
    getActiveCount() {
        const queue = this._load();
        return queue.filter(t => t.status === STATUS.PENDING || t.status === STATUS.RUNNING).length;
    }

    /**
     * Check if queue is empty (no pending or running tasks)
     * @returns {boolean} True if queue is empty
     */
    isEmpty() {
        return this.getActiveCount() === 0;
    }

    /**
     * Get queue status summary
     * @returns {object} Status counts
     */
    getStatus() {
        const queue = this._load();
        const status = {
            pending: 0,
            running: 0,
            completed: 0,
            failed: 0,
            interrupted: 0,
            total: queue.length,
        };

        for (const task of queue) {
            if (status[task.status] !== undefined) {
                status[task.status]++;
            }
        }

        return status;
    }

    /**
     * Get recent completed/failed tasks (for status queries), newest first.
     *
     * LOGIC CHANGE 2026-09-15: orders on `completionSeq`, not on `completedAt`.
     * `completedAt` has millisecond resolution, so two tasks finishing in the same
     * millisecond compared equal and the stable sort handed them back in INSERTION
     * order - oldest first, which is what this method promises not to do.
     * `completionSeq` is a per-file integer assigned strictly above every value
     * present (`_nextCompletionSeq`), so the order it induces is TOTAL: no two
     * entries can compare equal on it. WORK-TODO #43.
     *
     * Entries written before the field existed carry no seq. They sort AFTER every
     * seq-bearing entry, which is correct rather than a compromise: a seq is stamped
     * at the moment of the terminal transition, so an entry lacking one necessarily
     * terminated before this code was running, and is therefore genuinely older than
     * any entry that has one. Among themselves they keep the old `completedAt`
     * ordering - the legacy defect, confined to legacy rows, which the 24-hour
     * retention in `cleanup()` ages out.
     *
     * @param {number} limit - Max number to return
     * @returns {Array} Recent completed/failed tasks
     */
    getRecentCompleted(limit = 5) {
        const queue = this._load();
        return queue
            .filter(t => t.status === STATUS.COMPLETED || t.status === STATUS.FAILED || t.status === STATUS.INTERRUPTED)
            .sort((a, b) => {
                const aSeq = Number.isInteger(a.completionSeq) ? a.completionSeq : null;
                const bSeq = Number.isInteger(b.completionSeq) ? b.completionSeq : null;
                if (aSeq !== null && bSeq !== null) return bSeq - aSeq;   // total: never 0
                if (aSeq !== null) return -1;                              // seq-bearing first
                if (bSeq !== null) return 1;
                return new Date(b.completedAt) - new Date(a.completedAt);  // legacy rows only
            })
            .slice(0, limit);
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

    /**
     * Format queue status for Slack display
     * @returns {string} Formatted status message
     */
    formatStatus() {
        const status = this.getStatus();
        const running = this.getRunning();
        const pending = this.getPending();
        const recent = this.getRecentCompleted(5);

        const lines = [];

        // Current task
        if (running) {
            lines.push(`:runner: *Currently running:* ${running.description}`);
            lines.push(`   Started: ${running.startedAt}`);
        } else {
            lines.push(`:checkered_flag: No task currently running`);
        }

        // Queue
        if (pending.length > 0) {
            lines.push(`\n:clipboard: *Queued tasks (${pending.length}):*`);
            for (const task of pending.slice(0, 5)) {
                lines.push(`  - ${task.description}`);
            }
            if (pending.length > 5) {
                lines.push(`  ... and ${pending.length - 5} more`);
            }
        } else {
            lines.push(`\n:clipboard: *Queue is empty*`);
        }

        // Recent completed
        if (recent.length > 0) {
            lines.push(`\n:history: *Recently completed:*`);
            for (const task of recent) {
                const emoji = task.status === STATUS.COMPLETED ? ':white_check_mark:'
                    : task.status === STATUS.INTERRUPTED ? ':warning:'
                    : ':x:';
                lines.push(`  ${emoji} ${task.description} (${task.status})`);
            }
        }

        return lines.join('\n');
    }
}

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
};
