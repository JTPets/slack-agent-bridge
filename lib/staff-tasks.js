/**
 * lib/staff-tasks.js
 *
 * Staff task management for JT Pets store operations.
 * Handles daily recurring tasks posted to #store-tasks channel.
 *
 * Features:
 * - Create and post tasks with priority, assignee, and due time
 * - Track task completion via :white_check_mark: reactions
 * - Escalate overdue tasks to owner via secretary DM
 * - Daily recurring task scheduling from template
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Path to staff and template files
const STAFF_FILE = path.join(__dirname, '..', 'agents', 'shared', 'staff.json');
const TEMPLATE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'daily-tasks-template.json');
const TASKS_STATE_FILE = path.join(__dirname, '..', 'data', 'staff-tasks-state.json');

// Priority emoji mapping
const PRIORITY_EMOJI = {
  high: ':red_circle:',
  medium: ':large_yellow_circle:',
  low: ':white_circle:',
};

// Store hours (America/Toronto timezone)
const STORE_HOURS = {
  open: 9,   // 9:00 AM
  close: 21, // 9:00 PM
};

/**
 * Load staff members from agents/shared/staff.json
 * @returns {Array<{name: string, slackId: string, role: string, canReceiveEscalations?: boolean}>}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadStaff().
// JSON.parse errors now reset to [] instead of crashing.
function loadStaff() {
  try {
    const data = fs.readFileSync(STAFF_FILE, 'utf8');
    if (!data || !data.trim()) return [];
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      console.warn('[staff-tasks] staff.json is not an array, resetting to []');
      return [];
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[staff-tasks] Corrupted staff.json: ${err.message}. Resetting to [].`);
    return [];
  }
}

/**
 * Get staff member by name (case-insensitive)
 * @param {string} name - Staff member name
 * @returns {Object|null} Staff member object or null
 */
function getStaffByName(name) {
  const staff = loadStaff();
  const lower = name.toLowerCase().trim();
  return staff.find(s => s.name.toLowerCase() === lower) || null;
}

/**
 * Get staff member by Slack ID
 * @param {string} slackId - Slack user ID
 * @returns {Object|null} Staff member object or null
 */
function getStaffBySlackId(slackId) {
  const staff = loadStaff();
  return staff.find(s => s.slackId === slackId) || null;
}

/**
 * Get owner(s) who can receive escalations
 * @returns {Array<Object>} Staff members with canReceiveEscalations=true
 */
function getEscalationRecipients() {
  const staff = loadStaff();
  return staff.filter(s => s.canReceiveEscalations === true);
}

/**
 * Load daily tasks template from agents/shared/daily-tasks-template.json
 * @returns {{tasks: Array<{time: string, description: string, priority: string, assignee: string|null, category: string}>}}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadDailyTemplate().
function loadDailyTemplate() {
  try {
    const data = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    if (!data || !data.trim()) return { tasks: [] };
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[staff-tasks] daily-tasks-template.json has unexpected format, resetting');
      return { tasks: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { tasks: [] };
    console.warn(`[staff-tasks] Corrupted daily-tasks-template.json: ${err.message}. Resetting.`);
    return { tasks: [] };
  }
}

/**
 * Load current tasks state from data/staff-tasks-state.json
 * @returns {{date: string, tasks: Array<Object>}}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadTasksState().
function loadTasksState() {
  try {
    const data = fs.readFileSync(TASKS_STATE_FILE, 'utf8');
    if (!data || !data.trim()) return { date: null, tasks: [] };
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[staff-tasks] staff-tasks-state.json has unexpected format, resetting');
      return { date: null, tasks: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { date: null, tasks: [] };
    console.warn(`[staff-tasks] Corrupted staff-tasks-state.json: ${err.message}. Resetting.`);
    return { date: null, tasks: [] };
  }
}

/**
 * Save tasks state to data/staff-tasks-state.json
 * @param {Object} state - State object to save
 */
function saveTasksState(state) {
  const dataDir = path.dirname(TASKS_STATE_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(TASKS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Format a task for posting to Slack
 * @param {Object} task - Task object
 * @param {string} task.description - Task description
 * @param {string} [task.assignee] - Assignee name or Slack ID
 * @param {string} [task.dueTime] - Due time in HH:MM format
 * @param {string} [task.priority='medium'] - Priority level (high, medium, low)
 * @returns {string} Formatted task message
 */
function formatTask(task) {
  const priority = task.priority || 'medium';
  const emoji = PRIORITY_EMOJI[priority] || PRIORITY_EMOJI.medium;

  let message = `[ ] ${emoji} ${task.description}`;

  if (task.assignee) {
    // Check if assignee is a Slack ID (starts with U)
    const assigneeStr = task.assignee.startsWith('U')
      ? `<@${task.assignee}>`
      : `@${task.assignee}`;
    message += ` | Assigned: ${assigneeStr}`;
  }

  if (task.dueTime) {
    message += ` | Due: ${task.dueTime}`;
  }

  return message;
}

/**
 * Format a completed task (checkbox checked)
 * @param {string} originalMessage - Original task message
 * @returns {string} Updated message with checkbox checked
 */
function formatCompletedTask(originalMessage) {
  return originalMessage.replace(/^\[ \]/, '[x]');
}

/**
 * Create a task and post it to Slack
 * @param {Object} slack - Slack WebClient instance
 * @param {string} channelId - Channel ID to post to
 * @param {Object} task - Task details
 * @param {string} task.description - Task description
 * @param {string} [task.assignee] - Assignee name or Slack ID
 * @param {string} [task.dueTime] - Due time in HH:MM format
 * @param {string} [task.priority='medium'] - Priority level
 * @returns {Promise<{ok: boolean, messageTs: string, channelId: string}>}
 */
async function createTask(slack, channelId, task) {
  if (!channelId) {
    throw new Error('STORE_TASKS_CHANNEL_ID not configured');
  }

  const message = formatTask(task);

  const result = await slack.chat.postMessage({
    channel: channelId,
    text: message,
    unfurl_links: false,
  });

  // Track this task in state
  const state = loadTasksState();
  const today = new Date().toISOString().split('T')[0];

  if (state.date !== today) {
    // New day, reset tasks
    state.date = today;
    state.tasks = [];
  }

  state.tasks.push({
    messageTs: result.ts,
    channelId,
    description: task.description,
    assignee: task.assignee || null,
    dueTime: task.dueTime || null,
    priority: task.priority || 'medium',
    completed: false,
    createdAt: new Date().toISOString(),
  });

  saveTasksState(state);

  return {
    ok: true,
    messageTs: result.ts,
    channelId,
  };
}

/**
 * Mark a task as completed by updating the message
 * @param {Object} slack - Slack WebClient instance
 * @param {string} channelId - Channel ID
 * @param {string} messageTs - Message timestamp
 * @returns {Promise<{ok: boolean}>}
 */
async function completeTask(slack, channelId, messageTs) {
  // Get the original message
  const result = await slack.conversations.history({
    channel: channelId,
    latest: messageTs,
    inclusive: true,
    limit: 1,
  });

  if (!result.messages || result.messages.length === 0) {
    throw new Error('Task message not found');
  }

  const originalMessage = result.messages[0].text;
  const updatedMessage = formatCompletedTask(originalMessage);

  // Update the message
  await slack.chat.update({
    channel: channelId,
    ts: messageTs,
    text: updatedMessage,
  });

  // Update state
  const state = loadTasksState();
  const taskIndex = state.tasks.findIndex(t => t.messageTs === messageTs);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].completed = true;
    state.tasks[taskIndex].completedAt = new Date().toISOString();
    saveTasksState(state);
  }

  return { ok: true };
}

/**
 * Parse time string (HH:MM) to minutes since midnight
 * @param {string} timeStr - Time in HH:MM format
 * @returns {number} Minutes since midnight
 */
function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Get current time in minutes since midnight (America/Toronto)
 * @returns {number}
 */
function getCurrentTimeMinutes() {
  const now = new Date();
  const torontoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  return torontoTime.getHours() * 60 + torontoTime.getMinutes();
}

/**
 * Check if current time is within store hours
 * @returns {boolean}
 */
function isStoreHours() {
  const currentMinutes = getCurrentTimeMinutes();
  const openMinutes = STORE_HOURS.open * 60;
  const closeMinutes = STORE_HOURS.close * 60;
  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

/**
 * Get all tasks for today from state
 * @returns {Array<Object>} Today's tasks
 */
function getDailyTasks() {
  const state = loadTasksState();
  const today = new Date().toISOString().split('T')[0];

  if (state.date !== today) {
    return [];
  }

  return state.tasks;
}

/**
 * Get overdue tasks (past due time and not completed)
 * @returns {Array<Object>} Overdue tasks
 */
function getOverdueTasks() {
  const tasks = getDailyTasks();
  const currentMinutes = getCurrentTimeMinutes();

  return tasks.filter(task => {
    if (task.completed) return false;
    if (!task.dueTime) return false;

    const dueMinutes = parseTimeToMinutes(task.dueTime);
    return currentMinutes > dueMinutes;
  });
}

/**
 * Get critical overdue tasks (high priority, overdue by 1+ hours)
 * @returns {Array<Object>} Critical overdue tasks
 */
function getCriticalOverdueTasks() {
  const tasks = getDailyTasks();
  const currentMinutes = getCurrentTimeMinutes();

  return tasks.filter(task => {
    if (task.completed) return false;
    if (!task.dueTime) return false;
    if (task.priority !== 'high') return false;

    const dueMinutes = parseTimeToMinutes(task.dueTime);
    return currentMinutes > dueMinutes + 60; // 1+ hour overdue
  });
}

/**
 * Escalate a task to the owner via DM
 * @param {Object} slack - Slack WebClient instance
 * @param {Object} task - Task object
 * @param {string} ownerId - Owner's Slack user ID
 * @returns {Promise<{ok: boolean}>}
 */
async function escalateTask(slack, task, ownerId) {
  // Calculate how long overdue
  const currentMinutes = getCurrentTimeMinutes();
  const dueMinutes = parseTimeToMinutes(task.dueTime);
  const overdueMinutes = currentMinutes - dueMinutes;

  let overdueStr;
  if (overdueMinutes < 60) {
    overdueStr = `${overdueMinutes} min ago`;
  } else {
    const hours = Math.floor(overdueMinutes / 60);
    const mins = overdueMinutes % 60;
    overdueStr = mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  }

  const assigneeStr = task.assignee
    ? task.assignee.startsWith('U')
      ? `<@${task.assignee}>`
      : task.assignee
    : 'unassigned';

  const message = `:warning: *Task overdue*\n"${task.description}" was due ${overdueStr}. ${assigneeStr} hasn't completed it.`;

  // Open DM with owner
  const openResult = await slack.conversations.open({ users: ownerId });
  const dmChannel = openResult.channel.id;

  await slack.chat.postMessage({
    channel: dmChannel,
    text: message,
    unfurl_links: false,
  });

  // Mark as escalated in state
  const state = loadTasksState();
  const taskIndex = state.tasks.findIndex(t => t.messageTs === task.messageTs);
  if (taskIndex >= 0) {
    state.tasks[taskIndex].escalatedAt = new Date().toISOString();
    saveTasksState(state);
  }

  return { ok: true };
}

/**
 * Post daily recurring tasks from template
 * Only posts tasks that are due at or after the current time.
 * @param {Object} slack - Slack WebClient instance
 * @param {string} channelId - Channel ID to post to
 * @returns {Promise<{posted: number, skipped: number}>}
 */
async function postDailyTasks(slack, channelId) {
  const template = loadDailyTemplate();
  const currentMinutes = getCurrentTimeMinutes();
  const today = new Date().toISOString().split('T')[0];

  // Reset state for new day
  const state = loadTasksState();
  if (state.date !== today) {
    state.date = today;
    state.tasks = [];
    saveTasksState(state);
  }

  let posted = 0;
  let skipped = 0;

  for (const templateTask of template.tasks) {
    const taskMinutes = parseTimeToMinutes(templateTask.time);

    // Only post tasks that are due now or later
    if (taskMinutes < currentMinutes) {
      skipped++;
      continue;
    }

    await createTask(slack, channelId, {
      description: templateTask.description,
      assignee: templateTask.assignee,
      dueTime: templateTask.time,
      priority: templateTask.priority,
    });
    posted++;
  }

  return { posted, skipped };
}

/**
 * Check for overdue tasks and escalate critical ones
 * Should be called periodically (e.g., every hour during store hours)
 * @param {Object} slack - Slack WebClient instance
 * @returns {Promise<{checked: number, escalated: number}>}
 */
async function checkAndEscalateOverdue(slack) {
  if (!isStoreHours()) {
    return { checked: 0, escalated: 0, outsideHours: true };
  }

  const criticalOverdue = getCriticalOverdueTasks();
  const recipients = getEscalationRecipients();

  let escalated = 0;

  for (const task of criticalOverdue) {
    // Skip if already escalated
    if (task.escalatedAt) continue;

    for (const recipient of recipients) {
      try {
        await escalateTask(slack, task, recipient.slackId);
        escalated++;
      } catch (err) {
        console.error(`[staff-tasks] Failed to escalate to ${recipient.name}:`, err.message);
      }
    }
  }

  return { checked: criticalOverdue.length, escalated };
}

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
 * Normalize time string to HH:MM 24h format
 * @param {string} timeStr - Input time (e.g., "9am", "14:30", "2:30pm")
 * @returns {string} Normalized time in HH:MM format
 */
function normalizeTimeString(timeStr) {
  const lower = timeStr.toLowerCase().trim();

  // Check for am/pm
  const isPM = lower.includes('pm');
  const isAM = lower.includes('am');

  // Remove am/pm
  const cleaned = lower.replace(/\s*(am|pm)/i, '');

  let hours, minutes;

  if (cleaned.includes(':')) {
    [hours, minutes] = cleaned.split(':').map(Number);
  } else {
    hours = parseInt(cleaned, 10);
    minutes = 0;
  }

  // Convert to 24h
  if (isPM && hours !== 12) {
    hours += 12;
  } else if (isAM && hours === 12) {
    hours = 0;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
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
  // Staff management
  loadStaff,
  getStaffByName,
  getStaffBySlackId,
  getEscalationRecipients,

  // Template management
  loadDailyTemplate,

  // Task state management
  loadTasksState,
  saveTasksState,

  // Task CRUD
  formatTask,
  formatCompletedTask,
  createTask,
  completeTask,

  // Task queries
  getDailyTasks,
  getOverdueTasks,
  getCriticalOverdueTasks,

  // Scheduling and escalation
  postDailyTasks,
  escalateTask,
  checkAndEscalateOverdue,
  isStoreHours,

  // Time utilities
  parseTimeToMinutes,
  getCurrentTimeMinutes,
  normalizeTimeString,

  // Command parsing
  parseAssignCommand,
  isStaffTaskCommand,
  parseStaffTaskCommandType,

  // Formatting
  formatDigestSummary,
  formatOverdueList,
  formatTodayList,

  // Constants
  PRIORITY_EMOJI,
  STORE_HOURS,
  STAFF_FILE,
  TEMPLATE_FILE,
  TASKS_STATE_FILE,
};
