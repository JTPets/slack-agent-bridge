/**
 * lib/approval-queue-store.js
 *
 * The approval queue's file and its reads and writes: the path (with the init()
 * override tests use), load/save, the empty shape, id generation, queueing, and lookups.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/approval-queue.js unchanged,
 * on the boundary #10 names (the queue store vs. presentation; decisions split too so
 * the store fits the limit). lib/approval-queue.js re-exports every name.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Queue file path (gitignored - contains pending tasks).
// LOGIC CHANGE 2026-09-14: QUEUE_FILE was a module-level const bound to the real
// repo file, with no override path. Three test suites reach this module and two of
// them (tests/approval-queue.test.js, tests/security-followup.test.js) truncate and
// rewrite that one live file in their beforeEach; under jest's default parallel
// workers they race it, so tests/approval-queue.test.js failed a varying subset of
// its assertions ~6 runs in 8 (WORK-TODO #19). Following the shape lib/bridge-state.js
// already uses (init({ stateFile }) overrides a `let` rather than resolving a const),
// the path is now a `let` overridable via init({ queueFile }). Production callers
// (bridge-agent.js, lib/security-followup.js) never call init, so they keep the
// default path and behave exactly as before.
const DEFAULT_QUEUE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'approval-queue.json');
let QUEUE_FILE = DEFAULT_QUEUE_FILE;

/**
 * Initialise the module: optionally override the queue file path.
 * Non-test callers never call this, so QUEUE_FILE stays DEFAULT_QUEUE_FILE and
 * production behaviour is unchanged. Tests pass their own os.tmpdir() path so
 * parallel workers never share a file.
 *
 * @param {object} [options]
 * @param {string} [options.queueFile] Override path for the approval-queue file (tests).
 * @returns {string} the path now in effect (the facade, lib/approval-queue.js, returns itself for chaining)
 */
function init(options = {}) {
    if (options.queueFile) QUEUE_FILE = options.queueFile;
    return QUEUE_FILE;
}

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
    init, loadQueue, saveQueue, createEmptyQueue, queueTask, getPendingTasks, getTaskById,
    requiresApproval, clearQueue, DEFAULT_QUEUE_FILE, APPROVAL_REQUIRED_SOURCES, MAX_PENDING_AGE_MS,
};
