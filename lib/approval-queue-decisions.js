/**
 * lib/approval-queue-decisions.js
 *
 * What the owner does to a queued task: approve or reject one or all, and the expiry
 * sweep that retires entries older than MAX_PENDING_AGE_MS.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/approval-queue.js unchanged,
 * on the boundary #10 names (the queue store vs. presentation; decisions split too so
 * the store fits the limit). lib/approval-queue.js re-exports every name.
 */

'use strict';

const { loadQueue, saveQueue, MAX_PENDING_AGE_MS } = require('./approval-queue-store');

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

module.exports = { approveTask, approveAllTasks, rejectTask, rejectAllTasks, cleanup };
