/**
 * lib/notify-owner-rate-limit.js
 *
 * Model rate-limit notices: the pause (ops post plus a CRITICAL owner notice) and the
 * all-clear (ops only).
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved unchanged out of
 * lib/notify-owner.js, which re-exports it.
 */

'use strict';

const { getContext, notifyChannel, notifyOwner, PRIORITY } = require('./notify-owner-core');

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
  const { opsChannelId } = getContext();
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
  const { opsChannelId } = getContext();
  return notifyChannel(opsChannelId, ':white_check_mark: Rate limit resolved. Queue processing resumed.');
}

module.exports = { rateLimitHit, rateLimitCleared };
