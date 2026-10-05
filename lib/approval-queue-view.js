/**
 * lib/approval-queue-view.js
 *
 * How the queue is shown in Slack: counts, the pending list, one task's details, ages.
 * Reads the store; writes nothing.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/approval-queue.js unchanged,
 * on the boundary #10 names (the queue store vs. presentation; decisions split too so
 * the store fits the limit). lib/approval-queue.js re-exports every name.
 */

'use strict';

const { loadQueue, getPendingTasks } = require('./approval-queue-store');

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

module.exports = { getStats, formatPendingTasks, formatTaskDetails, getTaskAge };
