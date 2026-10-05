/**
 * lib/security-followup-dedup.js
 *
 * The in-process memory that stops the same (repo, file, severity) remediation task
 * being queued twice within TASK_DEDUP_MS. In memory only, so a restart forgets it.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/security-followup.js
 * unchanged, on the boundary #10 names (finding parsing vs. dedup bookkeeping vs. the
 * Slack-side orchestration). lib/security-followup.js re-exports every name.
 */

'use strict';

// Rate limiting: track recently created tasks to avoid duplicates
const recentTasks = new Map();
const TASK_DEDUP_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a unique key for deduplication.
 *
 * @param {string} repo - Repository name
 * @param {string} file - File path
 * @param {string} severity - Severity level
 * @returns {string} Dedup key
 */
function generateDedupKey(repo, file, severity) {
    return `${repo}:${file}:${severity}`;
}

/**
 * Check if a task was recently created (within dedup window).
 *
 * @param {string} key - Deduplication key
 * @returns {boolean} True if recently created
 */
function wasRecentlyCreated(key) {
    const created = recentTasks.get(key);
    if (!created) return false;
    return (Date.now() - created) < TASK_DEDUP_MS;
}

/**
 * Record that a task was created.
 *
 * @param {string} key - Deduplication key
 */
function recordTaskCreated(key) {
    recentTasks.set(key, Date.now());
}

/**
 * Clean up old entries from the dedup map.
 */
function cleanupDedupMap() {
    const now = Date.now();
    for (const [key, created] of recentTasks) {
        if ((now - created) > TASK_DEDUP_MS) {
            recentTasks.delete(key);
        }
    }
}

/**
 * Clear dedup map (for testing).
 */
function clearDedupMap() {
    recentTasks.clear();
}

module.exports = {
    TASK_DEDUP_MS, generateDedupKey, wasRecentlyCreated, recordTaskCreated, cleanupDedupMap, clearDedupMap,
};
