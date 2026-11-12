'use strict';

/**
 * lib/task-queue-view.js
 *
 * The READ side of TaskQueue: every method that loads task-queue.json and answers a
 * question about it without writing it (what is running, what is pending, the status
 * counts, the recent terminal rows in completion order, and the Slack rendering of all
 * of that). Mixed into TaskQueue.prototype by lib/task-queue.js, so `queue.getStatus()`
 * and every other call site is unchanged.
 *
 * Nothing here writes a status, a delivery verdict or the file. That is a property
 * tests/task-queue-delivery-invariant.test.js checks over every method TaskQueue is
 * assembled from, wherever it is defined.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): moved unchanged out of the class body
 * in lib/task-queue.js (the method bodies are byte-identical; only the indentation of
 * the class body is gone). The stray "Get the currently running task" comment that sat
 * above recordWork() now sits above getRunning(), which it always described.
 */

const { STATUS } = require('./task-queue-status');

/**
 * The reader methods, as plain functions that read `this` like the class methods
 * they were. Installed on TaskQueue.prototype by installReaders().
 */
const readers = {
    /**
     * Get the currently running task (if any)
     * @returns {object|null} Running task or null
     */
    getRunning() {
        const queue = this._load();
        return queue.find(t => t.status === STATUS.RUNNING) || null;
    },

    /**
     * Get all pending tasks
     * @returns {Array} Pending tasks
     */
    getPending() {
        const queue = this._load();
        return queue.filter(t => t.status === STATUS.PENDING);
    },

    /**
     * Get queue size (pending + running)
     * @returns {number} Number of active tasks
     */
    getActiveCount() {
        const queue = this._load();
        return queue.filter(t => t.status === STATUS.PENDING || t.status === STATUS.RUNNING).length;
    },

    /**
     * Check if queue is empty (no pending or running tasks)
     * @returns {boolean} True if queue is empty
     */
    isEmpty() {
        return this.getActiveCount() === 0;
    },

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
    },

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
    },

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
    },
};

/**
 * Install the readers on a class prototype with the descriptor a class method has
 * (writable, configurable, NOT enumerable), so a mixed-in method is indistinguishable
 * from one declared in the class body.
 *
 * @param {Function} Klass
 * @returns {Function} the same class
 */
function installReaders(Klass) {
    for (const [name, fn] of Object.entries(readers)) {
        Object.defineProperty(Klass.prototype, name, {
            value: fn, writable: true, configurable: true, enumerable: false,
        });
    }
    return Klass;
}

module.exports = { readers, installReaders, READER_NAMES: Object.keys(readers) };
