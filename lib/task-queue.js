'use strict';

/**
 * lib/task-queue.js
 *
 * LOGIC CHANGE 2026-04-01: Persistent task queue system to prevent auto-update
 * interruptions. Tasks are queued on disk before execution, allowing auto-update
 * to wait for the queue to drain before restarting PM2.
 *
 * Features:
 * - Persistent queue survives PM2 restarts
 * - Status tracking: pending, running, completed, failed
 * - Auto-update can wait for queue to empty
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
            error: null,
        };

        queue.push(queuedTask);
        this._save(queue);

        console.log(`[task-queue] Enqueued task ${queuedTask.id}: ${queuedTask.description}`);
        return queuedTask;
    }

    /**
     * Get the next pending task and mark it as running
     * @returns {object|null} Next task to process or null if none
     */
    dequeue() {
        const queue = this._load();
        const pendingIdx = queue.findIndex(t => t.status === STATUS.PENDING);

        if (pendingIdx === -1) {
            return null;
        }

        queue[pendingIdx].status = STATUS.RUNNING;
        queue[pendingIdx].startedAt = new Date().toISOString();
        this._save(queue);

        console.log(`[task-queue] Dequeued task ${queue[pendingIdx].id}: ${queue[pendingIdx].description}`);
        return queue[pendingIdx];
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
        task.error = error;
        this._save(queue);

        console.log(`[task-queue] Failed task ${taskId}: ${error}`);
    }

    /**
     * Mark any running tasks as interrupted (called on startup recovery)
     * @returns {number} Number of tasks marked as interrupted
     */
    recoverInterrupted() {
        const queue = this._load();
        let count = 0;

        for (const task of queue) {
            if (task.status === STATUS.RUNNING) {
                task.status = STATUS.INTERRUPTED;
                task.completedAt = new Date().toISOString();
                task.error = 'Task interrupted (PM2 restart or crash)';
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
     * Get recent completed/failed tasks (for status queries)
     * @param {number} limit - Max number to return
     * @returns {Array} Recent completed/failed tasks
     */
    getRecentCompleted(limit = 5) {
        const queue = this._load();
        return queue
            .filter(t => t.status === STATUS.COMPLETED || t.status === STATUS.FAILED || t.status === STATUS.INTERRUPTED)
            .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
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
    DEFAULT_QUEUE_FILE,
};
