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
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): this file is now the facade over three
 * modules: lib/approval-queue-store.js (the file, queueing, lookups),
 * lib/approval-queue-decisions.js (approve, reject, expiry) and
 * lib/approval-queue-view.js (Slack rendering). Every name it exported before is
 * exported here, and init() still returns this module for chaining.
 */

'use strict';

const store = require('./approval-queue-store');
const decisions = require('./approval-queue-decisions');
const view = require('./approval-queue-view');

/**
 * Override the queue file path (tests). Returns this module, as it always did.
 * @param {object} [options]
 * @param {string} [options.queueFile]
 */
function init(options = {}) {
    store.init(options);
    return module.exports;
}

module.exports = {
    init,
    loadQueue: store.loadQueue,
    saveQueue: store.saveQueue,
    queueTask: store.queueTask,
    getPendingTasks: store.getPendingTasks,
    getTaskById: store.getTaskById,
    approveTask: decisions.approveTask,
    approveAllTasks: decisions.approveAllTasks,
    rejectTask: decisions.rejectTask,
    rejectAllTasks: decisions.rejectAllTasks,
    cleanup: decisions.cleanup,
    getStats: view.getStats,
    formatPendingTasks: view.formatPendingTasks,
    formatTaskDetails: view.formatTaskDetails,
    requiresApproval: store.requiresApproval,
    clearQueue: store.clearQueue,
    DEFAULT_QUEUE_FILE: store.DEFAULT_QUEUE_FILE,
    APPROVAL_REQUIRED_SOURCES: store.APPROVAL_REQUIRED_SOURCES,
    MAX_PENDING_AGE_MS: store.MAX_PENDING_AGE_MS,
};
