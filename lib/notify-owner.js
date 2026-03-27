/**
 * lib/notify-owner.js
 *
 * Centralized notification layer for owner-facing communications.
 * When secretary agent is active, routes notifications through its channel.
 * Falls back to direct DM when secretary is not active.
 *
 * LOGIC CHANGE 2026-03-26: Initial implementation of notification abstraction layer.
 * All owner notifications should go through this module instead of direct Slack calls.
 */

'use strict';

const { getAgent } = require('./agent-registry');
const { addTask: addOwnerTask, extractActionRequired } = require('./owner-tasks');

// Priority levels for notifications
const PRIORITY = {
  CRITICAL: 'critical', // Immediate DM to owner
  HIGH: 'high',         // Include in next digest
  LOW: 'low',           // Log only, no notification
};

// Module state - will be initialized by init()
let slackClient = null;
let ownerId = null;
let opsChannelId = null;

/**
 * Initialize the notification module with required dependencies.
 * Must be called before using other functions.
 *
 * LOGIC CHANGE 2026-03-26: Uses dependency injection for testability.
 * Takes a Slack WebClient and configuration to avoid module-level coupling.
 *
 * @param {Object} options - Configuration options
 * @param {Object} options.slack - Slack WebClient instance
 * @param {string} options.ownerId - Owner's Slack user ID for DMs
 * @param {string} options.opsChannelId - #sqtools-ops channel ID
 */
function init({ slack, ownerId: ownerIdParam, opsChannelId: opsChannelParam }) {
  slackClient = slack;
  ownerId = ownerIdParam;
  opsChannelId = opsChannelParam;
}

/**
 * Check if secretary agent is active (has channel assigned, no "planned" status).
 *
 * LOGIC CHANGE 2026-03-26: Checks agent registry to determine routing.
 * When secretary is active, notifications route through its channel for
 * better organization and future AI-assisted notification management.
 *
 * @returns {{ active: boolean, channelId: string | null }} Secretary status and channel
 */
function getSecretaryStatus() {
  try {
    const secretary = getAgent('secretary');
    if (!secretary) {
      return { active: false, channelId: null };
    }
    // Secretary is active if it has a channel and no "planned" status
    const active = Boolean(secretary.channel && secretary.status !== 'planned');
    return { active, channelId: secretary.channel || null };
  } catch (err) {
    // Registry access failed - default to inactive
    return { active: false, channelId: null };
  }
}

/**
 * Post a message to a specific Slack channel.
 *
 * @param {string} channelId - Slack channel ID
 * @param {string} message - Message text (supports Slack markdown)
 * @returns {Promise<boolean>} True if message was sent successfully
 */
async function notifyChannel(channelId, message) {
  if (!slackClient) {
    console.error('[notify-owner] Module not initialized. Call init() first.');
    return false;
  }

  if (!channelId || !message) {
    console.error('[notify-owner] notifyChannel requires channelId and message');
    return false;
  }

  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      text: message,
      unfurl_links: false,
    });
    return true;
  } catch (err) {
    console.error(`[notify-owner] Failed to post to channel ${channelId}:`, err.message);
    return false;
  }
}

/**
 * Notify the owner with a message at the specified priority level.
 *
 * LOGIC CHANGE 2026-03-26: Priority-based routing determines notification method.
 * - critical: Immediate DM (or secretary channel if active)
 * - high: Added to next digest, no immediate notification
 * - low: Logged only, no Slack message
 *
 * When secretary agent is active, critical notifications go to secretary channel
 * instead of direct DM, allowing for AI-assisted notification batching.
 *
 * @param {string} message - Notification message
 * @param {string} [priority='high'] - Priority level: 'critical', 'high', or 'low'
 * @returns {Promise<boolean>} True if notification was handled successfully
 */
async function notifyOwner(message, priority = PRIORITY.HIGH) {
  if (!slackClient) {
    console.error('[notify-owner] Module not initialized. Call init() first.');
    return false;
  }

  if (!message) {
    return false;
  }

  // Low priority - log only
  if (priority === PRIORITY.LOW) {
    console.log('[notify-owner] Low priority notification:', message);
    return true;
  }

  // High priority - for future digest system, currently just logs
  // TODO: Add digest collection when secretary agent implements it
  if (priority === PRIORITY.HIGH) {
    console.log('[notify-owner] High priority (for digest):', message);
    return true;
  }

  // Critical priority - immediate notification
  if (priority === PRIORITY.CRITICAL) {
    const secretary = getSecretaryStatus();

    // Route through secretary channel if active
    if (secretary.active && secretary.channelId) {
      console.log('[notify-owner] Routing critical notification via secretary channel');
      return notifyChannel(secretary.channelId, `:rotating_light: *Owner Notification*\n${message}`);
    }

    // Fall back to direct DM
    if (ownerId) {
      try {
        await slackClient.chat.postMessage({
          channel: ownerId,
          text: message,
          unfurl_links: false,
        });
        return true;
      } catch (err) {
        console.error('[notify-owner] Failed to DM owner:', err.message);
        return false;
      }
    }

    console.error('[notify-owner] Cannot send critical notification: no ownerId configured');
    return false;
  }

  console.error(`[notify-owner] Unknown priority: ${priority}`);
  return false;
}

/**
 * Format and send a task failure notification.
 *
 * LOGIC CHANGE 2026-03-26: Centralizes task failure notification formatting.
 * Posts to ops channel and sends critical DM to owner.
 *
 * @param {Object} task - Task object with description, repo, etc.
 * @param {string} task.description - Task description
 * @param {string} [task.repo] - Repository (optional)
 * @param {Error|string} error - Error object or message
 * @param {Object} [options] - Additional options
 * @param {string} [options.elapsed] - Elapsed time in seconds
 * @param {string} [options.sourceLink] - Link to source message
 * @returns {Promise<{ opsPosted: boolean, ownerNotified: boolean }>} Status of notifications
 */
async function taskFailed(task, error, options = {}) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const elapsed = options.elapsed || 'N/A';
  const sourceLink = options.sourceLink || '';

  // Format error summary (truncate for DM)
  const errorSummary = errorMessage.length > 200
    ? errorMessage.slice(0, 200) + '...'
    : errorMessage;

  // Format truncated error for ops channel
  const truncatedError = errorMessage.length > 3500
    ? errorMessage.slice(0, 1750) + '\n\n... [truncated] ...\n\n' + errorMessage.slice(-1750)
    : errorMessage;

  let opsPosted = false;
  let ownerNotified = false;

  // Post to ops channel
  if (opsChannelId) {
    const opsMessage =
      `:x: *Task failed* (${elapsed}s)\n` +
      (sourceLink ? `Source: ${sourceLink}\n\n` : '') +
      `\`\`\`\n${truncatedError}\n\`\`\``;

    opsPosted = await notifyChannel(opsChannelId, opsMessage);
  }

  // Send critical notification to owner
  const ownerMessage = `Task failed: ${task.description || 'Unknown task'} - ${errorSummary}. Check #sqtools-ops for details.`;
  ownerNotified = await notifyOwner(ownerMessage, PRIORITY.CRITICAL);

  return { opsPosted, ownerNotified };
}

/**
 * Format and send a task completion notification.
 *
 * LOGIC CHANGE 2026-03-26: Task completions go to ops channel only (no DM).
 * Owner receives completion summaries in daily digest instead of per-task DMs.
 *
 * @param {Object} task - Task object with description, repo, branch, etc.
 * @param {string} summary - Completion summary (truncated output)
 * @param {Object} [options] - Additional options
 * @param {string} [options.elapsed] - Elapsed time in seconds
 * @param {string} [options.sourceLink] - Link to source message
 * @returns {Promise<boolean>} True if ops channel notification was sent
 */
async function taskCompleted(task, summary, options = {}) {
  const elapsed = options.elapsed || 'N/A';
  const sourceLink = options.sourceLink || '';

  // Truncate summary if needed
  const truncatedSummary = summary.length > 3500
    ? summary.slice(0, 1750) + '\n\n... [truncated] ...\n\n' + summary.slice(-1750)
    : summary;

  // Build repo label
  const repoLabel = task.repo ? `\nRepo: \`${task.repo}\` (${task.branch || 'main'})` : '';

  const opsMessage =
    `:white_check_mark: *Task completed* (${elapsed}s)\n` +
    (sourceLink ? `Source: ${sourceLink}` : '') +
    repoLabel + '\n\n' +
    `\`\`\`\n${truncatedSummary}\n\`\`\``;

  // Post to ops channel only - no owner DM for completions
  return notifyChannel(opsChannelId, opsMessage);
}

/**
 * Format and send an ACTION REQUIRED notification.
 *
 * LOGIC CHANGE 2026-03-26: Auto-extracts and logs ACTION REQUIRED items.
 * Adds to agent's activation checklist and optionally notifies owner.
 *
 * @param {Object} task - Task object (for context)
 * @param {string} action - Action item text
 * @param {Object} [options] - Additional options
 * @param {string} [options.agentId='bridge'] - Agent ID to add task to
 * @param {string} [options.priority='high'] - Task priority
 * @returns {Promise<{ added: boolean, notified: boolean }>} Status of action
 */
async function actionRequired(task, action, options = {}) {
  const agentId = options.agentId || 'bridge';
  const priority = options.priority || 'high';

  // Add to activation checklist
  let added = false;
  try {
    added = addOwnerTask(agentId, action, priority);
    if (added) {
      console.log(`[notify-owner] Added ACTION REQUIRED to ${agentId} checklist: ${action}`);
    }
  } catch (err) {
    console.error('[notify-owner] Failed to add ACTION REQUIRED:', err.message);
  }

  // High priority notifications go to digest, not immediate DM
  const notified = await notifyOwner(
    `ACTION REQUIRED: ${action}`,
    PRIORITY.HIGH
  );

  return { added, notified };
}

/**
 * Process task output for ACTION REQUIRED items.
 *
 * LOGIC CHANGE 2026-03-26: Scans output for ACTION REQUIRED patterns and
 * automatically logs them to activation checklists.
 *
 * @param {string} output - Task output text to scan
 * @param {Object} [options] - Options
 * @param {string} [options.agentId='bridge'] - Agent ID for checklist
 * @returns {Promise<{ found: boolean, action: string | null, added: boolean }>} Result
 */
async function processActionRequired(output, options = {}) {
  const agentId = options.agentId || 'bridge';

  const action = extractActionRequired(output);
  if (!action) {
    return { found: false, action: null, added: false };
  }

  const result = await actionRequired({}, action, { agentId, priority: 'high' });
  return { found: true, action, added: result.added };
}

/**
 * Send a rate limit notification.
 *
 * LOGIC CHANGE 2026-03-26: Specific notification for rate limit events.
 * Posts to ops channel and sends critical DM to owner.
 *
 * @param {Object} options - Rate limit details
 * @param {number} options.pauseMinutes - How long the pause will last
 * @param {string} options.resumeTime - Human-readable resume time
 * @param {number} options.retryCount - Number of retry attempts so far
 * @returns {Promise<{ opsPosted: boolean, ownerNotified: boolean }>} Status
 */
async function rateLimitHit({ pauseMinutes, resumeTime, retryCount }) {
  const opsMessage =
    `:warning: *Rate limit hit.* Pausing task queue for ${pauseMinutes} minutes.\n` +
    `Next retry at ${resumeTime}. (Attempt ${retryCount})`;

  const ownerMessage = `Claude API rate limit reached. Queue paused. Tasks will resume at ${resumeTime}.`;

  const opsPosted = await notifyChannel(opsChannelId, opsMessage);
  const ownerNotified = await notifyOwner(ownerMessage, PRIORITY.CRITICAL);

  return { opsPosted, ownerNotified };
}

/**
 * Send a rate limit cleared notification.
 *
 * @returns {Promise<boolean>} True if notification was sent
 */
async function rateLimitCleared() {
  return notifyChannel(opsChannelId, ':white_check_mark: Rate limit resolved. Queue processing resumed.');
}

module.exports = {
  // Initialization
  init,

  // Priority constants
  PRIORITY,

  // Core notification functions
  notifyOwner,
  notifyChannel,

  // Task notifications
  taskFailed,
  taskCompleted,
  actionRequired,
  processActionRequired,

  // Rate limit notifications
  rateLimitHit,
  rateLimitCleared,

  // Internal helpers (exported for testing)
  getSecretaryStatus,
};
