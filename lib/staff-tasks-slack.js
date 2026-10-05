/**
 * lib/staff-tasks-slack.js
 *
 * Staff tasks in #store-tasks: rendering a task, posting it, marking it done,
 * posting the day's template, and escalating critical overdue tasks to the owner.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/staff-tasks.js unchanged, on
 * the four concerns #10 names (staff/template/state, time parsing, Slack side, command
 * recognition and rendering). lib/staff-tasks.js re-exports every name.
 */

'use strict';

const { dayKey, STORE_TIME_ZONE } = require('./time-format');
const {
  PRIORITY_EMOJI, loadDailyTemplate, loadTasksState, saveTasksState,
  getEscalationRecipients, getCriticalOverdueTasks,
} = require('./staff-tasks-store');
const { parseTimeToMinutes, getCurrentTimeMinutes, isStoreHours } = require('./staff-tasks-time');

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
  const today = dayKey(new Date(), STORE_TIME_ZONE);

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
  const today = dayKey(new Date(), STORE_TIME_ZONE);

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

module.exports = {
  formatTask, formatCompletedTask, createTask, completeTask,
  escalateTask, postDailyTasks, checkAndEscalateOverdue,
};
