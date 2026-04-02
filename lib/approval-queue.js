/**
 * lib/approval-queue.js
 *
 * Manual approval queue for auto-generated tasks.
 * Tasks from automated sources (security-followup, email-monitor, etc.)
 * are queued here for owner approval before execution.
 *
 * LOGIC CHANGE 2026-04-01: Initial implementation of approval queue.
 * Addresses P0-SECURITY concern that auto-generated tasks could be exploited
 * via prompt injection or malicious security findings. All auto-generated
 * tasks now require explicit owner approval before posting to agent channels.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Queue file path (gitignored - contains pending tasks)
const QUEUE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'approval-queue.json');

// Task sources that require approval
const APPROVAL_REQUIRED_SOURCES = [
    'security-followup',
    'email-monitor',
    'automated-scan',
];

// Maximum age for pending tasks before auto-expiry (7 days)
const MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Load the approval queue from disk.
 * Returns empty structure if file doesn't exist or is corrupted.
 *
 * @returns {{ pending: Array, approved: Array, rejected: Array, meta: Object }}
 */
function loadQueue() {
    try {
        const data = fs.readFileSync(QUEUE_FILE, 'utf8');
        if (!data || !data.trim()) return createEmptyQueue();

        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object') {
            console.warn('[approval-queue] Invalid queue format, resetting');
            return createEmptyQueue();
        }

        // Ensure required fields exist
        return {
            pending: Array.isArray(parsed.pending) ? parsed.pending : [],
            approved: Array.isArray(parsed.approved) ? parsed.approved : [],
            rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
            meta: parsed.meta || { lastUpdated: null },
        };
    } catch (err) {
        if (err.code === 'ENOENT') return createEmptyQueue();
        console.warn(`[approval-queue] Corrupted queue file: ${err.message}. Resetting.`);
        return createEmptyQueue();
    }
}

/**
 * Create an empty queue structure.
 *
 * @returns {{ pending: Array, approved: Array, rejected: Array, meta: Object }}
 */
function createEmptyQueue() {
    return {
        pending: [],
        approved: [],
        rejected: [],
        meta: { lastUpdated: null },
    };
}

/**
 * Save the approval queue to disk.
 *
 * @param {Object} queue - Queue object to save
 */
function saveQueue(queue) {
    try {
        const dir = path.dirname(QUEUE_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        queue.meta.lastUpdated = new Date().toISOString();
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
    } catch (err) {
        console.error('[approval-queue] Failed to save queue:', err.message);
    }
}

/**
 * Generate a short, readable task ID.
 *
 * @returns {string} Task ID (e.g., "sec-a1b2c3")
 */
function generateTaskId(source) {
    const prefix = source.substring(0, 3).toLowerCase();
    const random = crypto.randomBytes(3).toString('hex');
    return `${prefix}-${random}`;
}

/**
 * Add a task to the approval queue.
 *
 * @param {Object} task - Task to queue
 * @param {string} task.source - Source of the task (e.g., 'security-followup')
 * @param {string} task.targetChannel - Channel ID where task would be posted
 * @param {string} task.targetAgent - Agent ID that would handle the task
 * @param {string} task.taskMessage - The TASK: message text to post
 * @param {Object} task.metadata - Additional context (repo, file, severity, etc.)
 * @returns {{ id: string, queued: boolean, reason?: string }}
 */
function queueTask(task) {
    if (!task || !task.source || !task.taskMessage) {
        return { id: null, queued: false, reason: 'Invalid task: missing required fields' };
    }

    const queue = loadQueue();
    const id = generateTaskId(task.source);

    const queuedTask = {
        id,
        source: task.source,
        targetChannel: task.targetChannel || null,
        targetAgent: task.targetAgent || null,
        taskMessage: task.taskMessage,
        metadata: task.metadata || {},
        queuedAt: new Date().toISOString(),
        status: 'pending',
    };

    queue.pending.push(queuedTask);
    saveQueue(queue);

    console.log(`[approval-queue] Queued task ${id} from ${task.source}`);
    return { id, queued: true };
}

/**
 * Get all pending tasks awaiting approval.
 *
 * @param {Object} options - Filter options
 * @param {string} options.source - Filter by source
 * @returns {Array} Pending tasks
 */
function getPendingTasks(options = {}) {
    const queue = loadQueue();
    let pending = queue.pending;

    // Filter by source if specified
    if (options.source) {
        pending = pending.filter(t => t.source === options.source);
    }

    // Sort by queued time (oldest first)
    pending.sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));

    return pending;
}

/**
 * Get a specific task by ID.
 *
 * @param {string} id - Task ID
 * @returns {Object|null} Task or null if not found
 */
function getTaskById(id) {
    if (!id) return null;

    const queue = loadQueue();
    const normalizedId = id.toLowerCase();

    // Check pending
    const pending = queue.pending.find(t => t.id.toLowerCase() === normalizedId);
    if (pending) return { ...pending, status: 'pending' };

    // Check approved
    const approved = queue.approved.find(t => t.id.toLowerCase() === normalizedId);
    if (approved) return { ...approved, status: 'approved' };

    // Check rejected
    const rejected = queue.rejected.find(t => t.id.toLowerCase() === normalizedId);
    if (rejected) return { ...rejected, status: 'rejected' };

    return null;
}

/**
 * Approve a pending task.
 * Moves task from pending to approved and returns the task for execution.
 *
 * @param {string} id - Task ID to approve
 * @param {string} approvedBy - User ID who approved
 * @returns {{ success: boolean, task?: Object, error?: string }}
 */
function approveTask(id, approvedBy = 'owner') {
    if (!id) {
        return { success: false, error: 'Task ID is required' };
    }

    const queue = loadQueue();
    const normalizedId = id.toLowerCase();

    const index = queue.pending.findIndex(t => t.id.toLowerCase() === normalizedId);
    if (index === -1) {
        // Check if already approved/rejected
        if (queue.approved.some(t => t.id.toLowerCase() === normalizedId)) {
            return { success: false, error: 'Task already approved' };
        }
        if (queue.rejected.some(t => t.id.toLowerCase() === normalizedId)) {
            return { success: false, error: 'Task was rejected' };
        }
        return { success: false, error: 'Task not found' };
    }

    const task = queue.pending.splice(index, 1)[0];
    task.status = 'approved';
    task.approvedAt = new Date().toISOString();
    task.approvedBy = approvedBy;

    queue.approved.push(task);
    saveQueue(queue);

    console.log(`[approval-queue] Approved task ${id} by ${approvedBy}`);
    return { success: true, task };
}

/**
 * Approve all pending tasks.
 *
 * @param {string} approvedBy - User ID who approved
 * @param {Object} options - Filter options
 * @param {string} options.source - Only approve tasks from this source
 * @returns {{ success: boolean, count: number, tasks: Array }}
 */
function approveAllTasks(approvedBy = 'owner', options = {}) {
    const queue = loadQueue();
    let toApprove = queue.pending;

    if (options.source) {
        toApprove = toApprove.filter(t => t.source === options.source);
    }

    const approved = [];
    const now = new Date().toISOString();

    for (const task of toApprove) {
        task.status = 'approved';
        task.approvedAt = now;
        task.approvedBy = approvedBy;
        queue.approved.push(task);
        approved.push(task);
    }

    // Remove approved tasks from pending
    queue.pending = queue.pending.filter(t => !approved.includes(t));
    saveQueue(queue);

    console.log(`[approval-queue] Approved ${approved.length} tasks by ${approvedBy}`);
    return { success: true, count: approved.length, tasks: approved };
}

/**
 * Reject a pending task.
 *
 * @param {string} id - Task ID to reject
 * @param {string} rejectedBy - User ID who rejected
 * @param {string} reason - Reason for rejection
 * @returns {{ success: boolean, error?: string }}
 */
function rejectTask(id, rejectedBy = 'owner', reason = '') {
    if (!id) {
        return { success: false, error: 'Task ID is required' };
    }

    const queue = loadQueue();
    const normalizedId = id.toLowerCase();

    const index = queue.pending.findIndex(t => t.id.toLowerCase() === normalizedId);
    if (index === -1) {
        if (queue.approved.some(t => t.id.toLowerCase() === normalizedId)) {
            return { success: false, error: 'Task already approved' };
        }
        if (queue.rejected.some(t => t.id.toLowerCase() === normalizedId)) {
            return { success: false, error: 'Task already rejected' };
        }
        return { success: false, error: 'Task not found' };
    }

    const task = queue.pending.splice(index, 1)[0];
    task.status = 'rejected';
    task.rejectedAt = new Date().toISOString();
    task.rejectedBy = rejectedBy;
    task.rejectionReason = reason;

    queue.rejected.push(task);
    saveQueue(queue);

    console.log(`[approval-queue] Rejected task ${id} by ${rejectedBy}: ${reason || 'no reason given'}`);
    return { success: true };
}

/**
 * Reject all pending tasks.
 *
 * @param {string} rejectedBy - User ID who rejected
 * @param {string} reason - Reason for rejection
 * @param {Object} options - Filter options
 * @param {string} options.source - Only reject tasks from this source
 * @returns {{ success: boolean, count: number }}
 */
function rejectAllTasks(rejectedBy = 'owner', reason = '', options = {}) {
    const queue = loadQueue();
    let toReject = queue.pending;

    if (options.source) {
        toReject = toReject.filter(t => t.source === options.source);
    }

    const now = new Date().toISOString();
    let count = 0;

    for (const task of toReject) {
        task.status = 'rejected';
        task.rejectedAt = now;
        task.rejectedBy = rejectedBy;
        task.rejectionReason = reason;
        queue.rejected.push(task);
        count++;
    }

    // Remove rejected tasks from pending
    queue.pending = queue.pending.filter(t => t.status !== 'rejected');
    saveQueue(queue);

    console.log(`[approval-queue] Rejected ${count} tasks by ${rejectedBy}`);
    return { success: true, count };
}

/**
 * Clean up old entries from approved/rejected lists.
 * Removes entries older than MAX_PENDING_AGE_MS.
 *
 * @returns {{ expiredPending: number, cleanedApproved: number, cleanedRejected: number }}
 */
function cleanup() {
    const queue = loadQueue();
    const now = Date.now();
    const cutoff = now - MAX_PENDING_AGE_MS;

    // Expire old pending tasks
    const expiredPending = queue.pending.filter(t => new Date(t.queuedAt).getTime() < cutoff);
    queue.pending = queue.pending.filter(t => new Date(t.queuedAt).getTime() >= cutoff);

    // Move expired pending to rejected
    for (const task of expiredPending) {
        task.status = 'expired';
        task.expiredAt = new Date().toISOString();
        queue.rejected.push(task);
    }

    // Clean old approved/rejected
    const cleanedApproved = queue.approved.filter(t => {
        const timestamp = t.approvedAt || t.queuedAt;
        return new Date(timestamp).getTime() < cutoff;
    }).length;

    const cleanedRejected = queue.rejected.filter(t => {
        const timestamp = t.rejectedAt || t.expiredAt || t.queuedAt;
        return new Date(timestamp).getTime() < cutoff;
    }).length;

    queue.approved = queue.approved.filter(t => {
        const timestamp = t.approvedAt || t.queuedAt;
        return new Date(timestamp).getTime() >= cutoff;
    });

    queue.rejected = queue.rejected.filter(t => {
        const timestamp = t.rejectedAt || t.expiredAt || t.queuedAt;
        return new Date(timestamp).getTime() >= cutoff;
    });

    saveQueue(queue);

    if (expiredPending.length > 0 || cleanedApproved > 0 || cleanedRejected > 0) {
        console.log(`[approval-queue] Cleanup: ${expiredPending.length} expired pending, ${cleanedApproved} old approved, ${cleanedRejected} old rejected`);
    }

    return {
        expiredPending: expiredPending.length,
        cleanedApproved,
        cleanedRejected,
    };
}

/**
 * Get queue statistics.
 *
 * @returns {{ pending: number, approved: number, rejected: number, oldestPending: string|null }}
 */
function getStats() {
    const queue = loadQueue();
    const pending = queue.pending;

    let oldestPending = null;
    if (pending.length > 0) {
        const sorted = [...pending].sort((a, b) => new Date(a.queuedAt) - new Date(b.queuedAt));
        oldestPending = sorted[0].queuedAt;
    }

    return {
        pending: pending.length,
        approved: queue.approved.length,
        rejected: queue.rejected.length,
        oldestPending,
    };
}

/**
 * Format pending tasks for Slack display.
 *
 * @returns {string} Formatted task list
 */
function formatPendingTasks() {
    const pending = getPendingTasks();

    if (pending.length === 0) {
        return ':white_check_mark: No tasks awaiting approval.';
    }

    const lines = [`:warning: *${pending.length} task(s) awaiting approval:*\n`];

    for (const task of pending) {
        const age = getTaskAge(task.queuedAt);
        const severity = task.metadata?.highestSeverity || 'N/A';
        const repo = task.metadata?.repo || 'N/A';
        const file = task.metadata?.file || '';

        lines.push(`*\`${task.id}\`* - ${task.source}`);
        lines.push(`  Repo: ${repo}${file ? ` | File: ${file}` : ''}`);
        lines.push(`  Severity: ${severity} | Queued: ${age} ago`);
        lines.push('');
    }

    lines.push('*Commands:*');
    lines.push('• `ASK: approve <id>` - Approve a specific task');
    lines.push('• `ASK: approve all` - Approve all pending tasks');
    lines.push('• `ASK: reject <id> [reason]` - Reject a task');
    lines.push('• `ASK: reject all` - Reject all pending tasks');
    lines.push('• `ASK: show task <id>` - View full task details');

    return lines.join('\n');
}

/**
 * Format a single task for detailed Slack display.
 *
 * @param {Object} task - Task to format
 * @returns {string} Formatted task details
 */
function formatTaskDetails(task) {
    if (!task) {
        return ':x: Task not found.';
    }

    const statusEmoji = {
        pending: ':hourglass:',
        approved: ':white_check_mark:',
        rejected: ':x:',
        expired: ':clock1:',
    };

    const lines = [
        `${statusEmoji[task.status] || ':question:'} *Task ${task.id}*`,
        `*Status:* ${task.status}`,
        `*Source:* ${task.source}`,
        `*Queued:* ${task.queuedAt}`,
    ];

    if (task.targetAgent) {
        lines.push(`*Target Agent:* ${task.targetAgent}`);
    }

    if (task.metadata) {
        if (task.metadata.repo) lines.push(`*Repository:* ${task.metadata.repo}`);
        if (task.metadata.file) lines.push(`*File:* ${task.metadata.file}`);
        if (task.metadata.highestSeverity) lines.push(`*Severity:* ${task.metadata.highestSeverity}`);
        if (task.metadata.findingCount) lines.push(`*Findings:* ${task.metadata.findingCount}`);
    }

    if (task.approvedAt) {
        lines.push(`*Approved:* ${task.approvedAt} by ${task.approvedBy || 'unknown'}`);
    }

    if (task.rejectedAt) {
        lines.push(`*Rejected:* ${task.rejectedAt} by ${task.rejectedBy || 'unknown'}`);
        if (task.rejectionReason) {
            lines.push(`*Reason:* ${task.rejectionReason}`);
        }
    }

    lines.push('');
    lines.push('*Task Message:*');
    lines.push('```');
    lines.push(task.taskMessage);
    lines.push('```');

    return lines.join('\n');
}

/**
 * Calculate human-readable age from timestamp.
 *
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Human-readable age (e.g., "2h", "3d")
 */
function getTaskAge(timestamp) {
    const ms = Date.now() - new Date(timestamp).getTime();
    const minutes = Math.floor(ms / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return 'just now';
}

/**
 * Check if a source requires approval.
 *
 * @param {string} source - Task source
 * @returns {boolean} True if approval required
 */
function requiresApproval(source) {
    return APPROVAL_REQUIRED_SOURCES.includes(source);
}

/**
 * Clear the queue (for testing).
 */
function clearQueue() {
    saveQueue(createEmptyQueue());
}

module.exports = {
    loadQueue,
    saveQueue,
    queueTask,
    getPendingTasks,
    getTaskById,
    approveTask,
    approveAllTasks,
    rejectTask,
    rejectAllTasks,
    cleanup,
    getStats,
    formatPendingTasks,
    formatTaskDetails,
    requiresApproval,
    clearQueue,
    QUEUE_FILE,
    APPROVAL_REQUIRED_SOURCES,
    MAX_PENDING_AGE_MS,
};
