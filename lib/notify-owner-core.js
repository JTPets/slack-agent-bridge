/**
 * lib/notify-owner-core.js
 *
 * The routing half of the owner notification layer: the injected Slack client and ids
 * (init), the priority levels, and the three ways a message leaves (notifyChannel,
 * notifyOps, notifyOwner) with the secretary-vs-DM decision behind CRITICAL.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved unchanged out of
 * lib/notify-owner.js, which is now the hub that re-exports this module and the three
 * notice modules built on it (lib/notify-owner-tasks.js, lib/notify-owner-actions.js,
 * lib/notify-owner-rate-limit.js). The state lives here only, so one init() reaches all.
 */

'use strict';

const { getAgent } = require('./agent-registry');
// LOGIC CHANGE 2026-09-13: Redact secrets from failure messages before they
// reach the ops channel or the owner DM. Error messages embed subprocess
// stderr (which can carry env dumps / live tokens) via describeClaudeExit().
const { redact } = require('./redact-secrets');
const { postText } = require('./slack-web');
const highNotices = require('./high-notices');

// Priority levels for notifications
const PRIORITY = {
  CRITICAL: 'critical', // Immediate DM to owner
  HIGH: 'high',         // Recorded; posted in the next digest (lib/high-digest.js)
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
 * The injected Slack client and ids, read by the notice modules (lib/notify-owner-*.js)
 * at call time, so a later init() reaches them too.
 *
 * @returns {{ slackClient: object|null, ownerId: string|null, opsChannelId: string|null }}
 */
function getContext() {
  return { slackClient, ownerId, opsChannelId };
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

  // LOGIC CHANGE 2026-10-04 (WORK-TODO #30): the post itself is lib/slack-web.js postText,
  // which redacts. This path did not, so only notifyOps (which redacted its own argument)
  // was scrubbed; every owner notification and secretary-channel post now is too.
  return postText(slackClient, channelId, message, 'notify-owner');
}

/**
 * Post an operational failure to #sqtools-ops.
 *
 * LOGIC CHANGE 2026-09-14: Added for part four of the autonomous-loop
 * prerequisites. Several background failures had no destination at all — the
 * scheduler's weekly job failing to post, a bulletin notification rejected with
 * `not_in_channel`, a task found interrupted at startup — and a lib module cannot
 * reach the ops channel without one of two things: its own copy of a postToOps (a
 * FOURTH one; see docs/CANONICAL-HELPERS.md section 1, WORK-TODO #30), or this.
 * This is the second, so the count does not grow.
 *
 * Redacts, which `notifyChannel` alone does not — every caller here is formatting
 * an error message from somewhere else in the system.
 *
 * @param {string} message - Message text (Slack markdown)
 * @returns {Promise<boolean>} True if it reached Slack.
 */
async function notifyOps(message) {
  if (!opsChannelId) {
    // Not a silent drop: say that the message had nowhere to go, and say what it was.
    console.error('[notify-owner] No opsChannelId configured; ops notification dropped:', redact(String(message)));
    return false;
  }
  return notifyChannel(opsChannelId, redact(String(message)));
}

/**
 * Notify the owner with a message at the specified priority level.
 *
 * LOGIC CHANGE 2026-03-26: Priority-based routing determines notification method.
 * - critical: Immediate DM (or secretary channel if active)
 * - high: Recorded for the digest (WORK-TODO #37, 2026-11-09); posted to ops if it cannot be
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

  // LOGIC CHANGE 2026-11-09 (WORK-TODO #37): HIGH used to log and return true, so the
  // owner received nothing while the caller was told it worked. It is now RECORDED for
  // the digest lib/high-digest.js posts to #sqtools-ops. A notice that cannot be recorded
  // is posted to #sqtools-ops at once instead, and the return value is whether either
  // happened.
  if (priority === PRIORITY.HIGH) {
    const kept = highNotices.record(redact(String(message)));
    if (kept.recorded) {
      console.log(`[notify-owner] High priority notice ${kept.id} recorded for the digest`);
      return true;
    }
    console.error('[notify-owner] High priority notice could not be recorded:', kept.error);
    return notifyOps(`:warning: A HIGH owner notice could not be stored for the digest (${kept.error}), so here it is now:\n${message}`);
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
    // Posting to a user id delivers a DM. LOGIC CHANGE 2026-10-04 (WORK-TODO #30): via postText.
    if (ownerId) {
      return postText(slackClient, ownerId, message, 'notify-owner');
    }

    console.error('[notify-owner] Cannot send critical notification: no ownerId configured');
    return false;
  }

  console.error(`[notify-owner] Unknown priority: ${priority}`);
  return false;
}

module.exports = {
  init,
  getContext,
  PRIORITY,
  getSecretaryStatus,
  notifyChannel,
  notifyOps,
  notifyOwner,
};
