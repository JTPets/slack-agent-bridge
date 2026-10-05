/**
 * lib/staff-tasks-commands.js
 *
 * The ASK: side of staff tasks: recognising and parsing "assign X to Y by Z" and the
 * list queries, and rendering today's, the overdue, and the digest summaries.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/staff-tasks.js unchanged, on
 * the four concerns #10 names (staff/template/state, time parsing, Slack side, command
 * recognition and rendering). lib/staff-tasks.js re-exports every name.
 */

'use strict';

const { PRIORITY_EMOJI, getDailyTasks, getOverdueTasks } = require('./staff-tasks-store');
const { normalizeTimeString } = require('./staff-tasks-time');

/**
 * Format a summary of today's tasks for the morning digest
 * @returns {string} Formatted summary
 */
function formatDigestSummary() {
  const tasks = getDailyTasks();
  const overdue = getOverdueTasks();

  if (tasks.length === 0) {
    return null;
  }

  const completed = tasks.filter(t => t.completed).length;
  const pending = tasks.length - completed;

  let summary = `*Staff tasks for today:* ${tasks.length}`;
  if (completed > 0) {
    summary += ` (${completed} completed, ${pending} pending)`;
  }

  if (overdue.length > 0) {
    summary += `\n*Overdue from yesterday:* ${overdue.length}`;
  }

  return summary;
}

/**
 * Parse an "assign task" command
 * Format: "assign [task] to [name] by [time]"
 * @param {string} text - Command text
 * @returns {{task: string, assignee: string, dueTime: string|null}|null}
 */
function parseAssignCommand(text) {
  // Pattern: assign <task> to <name> [by <time>]
  const match = text.match(/^assign\s+(.+?)\s+to\s+(\w+)(?:\s+by\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m?)?))?$/i);

  if (!match) return null;

  const task = match[1].trim();
  const assignee = match[2].trim();
  let dueTime = match[3] ? match[3].trim() : null;

  // Normalize time to HH:MM format
  if (dueTime) {
    dueTime = normalizeTimeString(dueTime);
  }

  return { task, assignee, dueTime };
}

/**
 * Check if a question is a staff task command
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isStaffTaskCommand(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();

  return /^assign\s+/i.test(lower) ||
         /what\s+tasks?\s+(are\s+)?overdue/i.test(lower) ||
         /overdue\s+tasks?/i.test(lower) ||
         /store\s+tasks?\s+today/i.test(lower) ||
         /today'?s?\s+store\s+tasks?/i.test(lower) ||
         /staff\s+tasks?\s+today/i.test(lower);
}

/**
 * Parse what type of staff task command this is
 * @param {string} text - Command text
 * @returns {'assign'|'overdue'|'today'|null}
 */
function parseStaffTaskCommandType(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  if (/^assign\s+/i.test(lower)) return 'assign';
  if (/what\s+tasks?\s+(are\s+)?overdue/i.test(lower) || /overdue\s+tasks?/i.test(lower)) return 'overdue';
  if (/store\s+tasks?\s+today/i.test(lower) || /today'?s?\s+store\s+tasks?/i.test(lower) || /staff\s+tasks?\s+today/i.test(lower)) return 'today';

  return null;
}

/**
 * Format overdue tasks list for Slack response
 * @returns {string}
 */
function formatOverdueList() {
  const overdue = getOverdueTasks();

  if (overdue.length === 0) {
    return ':white_check_mark: No overdue tasks!';
  }

  let response = `*Overdue tasks (${overdue.length}):*\n`;

  for (const task of overdue) {
    const priority = PRIORITY_EMOJI[task.priority] || '';
    const assignee = task.assignee
      ? task.assignee.startsWith('U')
        ? `<@${task.assignee}>`
        : task.assignee
      : 'unassigned';
    response += `${priority} ${task.description} | Due: ${task.dueTime} | ${assignee}\n`;
  }

  return response;
}

/**
 * Format today's tasks list for Slack response
 * @returns {string}
 */
function formatTodayList() {
  const tasks = getDailyTasks();

  if (tasks.length === 0) {
    return 'No tasks posted for today yet.';
  }

  const completed = tasks.filter(t => t.completed);
  const pending = tasks.filter(t => !t.completed);

  let response = `*Today's store tasks:* ${tasks.length} total (${completed.length} done, ${pending.length} pending)\n\n`;

  if (pending.length > 0) {
    response += '*Pending:*\n';
    for (const task of pending) {
      const priority = PRIORITY_EMOJI[task.priority] || '';
      const due = task.dueTime ? ` | Due: ${task.dueTime}` : '';
      response += `[ ] ${priority} ${task.description}${due}\n`;
    }
  }

  if (completed.length > 0) {
    response += '\n*Completed:*\n';
    for (const task of completed) {
      response += `[x] ${task.description}\n`;
    }
  }

  return response;
}

module.exports = {
  formatDigestSummary, parseAssignCommand, isStaffTaskCommand, parseStaffTaskCommandType,
  formatOverdueList, formatTodayList,
};
