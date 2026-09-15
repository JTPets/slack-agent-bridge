/**
 * lib/owner-tasks.js
 *
 * Owner task management for agent activation checklists: how pending setup tasks are
 * PRESENTED to the owner, and how a request for them is RECOGNISED.
 *
 * LOGIC CHANGE 2026-09-15: The store — the reader/writer of
 * `agents/activation-checklists.json` and the CRUD and readiness maths over it — moved
 * to `lib/owner-tasks-store.js` (WORK-TODO #10; this file was 368 lines, over the
 * repo's 300-line limit). This file keeps the presentation half and re-exports every
 * store name unchanged, so all six callers are untouched.
 */

const store = require('./owner-tasks-store');

const {
  CHECKLISTS_PATH,
  loadChecklists,
  saveChecklists,
  getPendingTasks,
  completeTask,
  completeChecklistItem,
  getAgentReadiness,
  getAllAgentReadiness,
  addTask,
} = store;

/**
 * Check if a text contains ACTION REQUIRED pattern.
 * Returns the action item text if found, null otherwise.
 *
 * @param {string} text - Output text to check
 * @returns {string | null} Action item or null
 */
function extractActionRequired(text) {
  if (!text) return null;

  // Pattern: "ACTION REQUIRED:" followed by text until end of line
  const match = text.match(/ACTION REQUIRED:\s*(.+?)(?:\n|$)/i);
  if (match) {
    return match[1].trim();
  }

  return null;
}

/**
 * Format pending tasks for display in Slack.
 *
 * @returns {string} Formatted task list
 */
function formatPendingTasks() {
  const pendingTasks = getPendingTasks();
  const readiness = getAllAgentReadiness();

  if (pendingTasks.length === 0) {
    return '*All agent activation tasks are complete!* :white_check_mark:';
  }

  let output = '*Your pending tasks:*\n\n';

  // Group by priority
  const highPriority = pendingTasks.filter(t => t.priority === 'high');
  const mediumPriority = pendingTasks.filter(t => t.priority === 'medium');
  const lowPriority = pendingTasks.filter(t => t.priority === 'low');

  if (highPriority.length > 0) {
    output += ':red_circle: *High Priority:*\n';
    for (const task of highPriority) {
      output += `  • [${task.agentName}] ${task.description}\n`;
    }
    output += '\n';
  }

  if (mediumPriority.length > 0) {
    output += ':large_yellow_circle: *Medium Priority:*\n';
    for (const task of mediumPriority) {
      output += `  • [${task.agentName}] ${task.description}\n`;
    }
    output += '\n';
  }

  if (lowPriority.length > 0) {
    output += ':white_circle: *Low Priority:*\n';
    for (const task of lowPriority) {
      output += `  • [${task.agentName}] ${task.description}\n`;
    }
    output += '\n';
  }

  // Add readiness summary
  output += '*Agent Readiness:*\n';
  for (const [agentId, stats] of Object.entries(readiness)) {
    const emoji = stats.percentage === 100 ? ':white_check_mark:' : ':construction:';
    output += `  ${emoji} ${stats.name}: ${stats.percentage}% (${stats.completed}/${stats.total})\n`;
  }

  return output;
}

/**
 * Check if a question text is an owner tasks query.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isOwnerTasksQuery(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  // Patterns for owner task queries
  return /what\s+do\s+i\s+need\s+to\s+do/i.test(lower) ||
         /my\s+tasks?/i.test(lower) ||
         /pending\s+tasks?/i.test(lower) ||
         /owner\s+tasks?/i.test(lower) ||
         /action\s+items?/i.test(lower) ||
         /activation\s+checklist/i.test(lower) ||
         /what'?s\s+left\s+to\s+do/i.test(lower);
}

module.exports = {
  loadChecklists,
  saveChecklists,
  getPendingTasks,
  completeTask,
  completeChecklistItem,
  getAgentReadiness,
  getAllAgentReadiness,
  addTask,
  extractActionRequired,
  formatPendingTasks,
  isOwnerTasksQuery,
  CHECKLISTS_PATH,
};
