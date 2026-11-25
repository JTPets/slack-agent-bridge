'use strict';

/**
 * lib/message-kind.js
 *
 * What kind of Slack message this is, for the poll loop: a TASK, an ASK, a natural
 * conversation message (no prefix), and whether it already carries a done/failed
 * reaction. Pure: reads the message object only.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-parser.js, which re-exports every name. Classifying a message is a
 * different job from parsing a task message's fields.
 */

// Emoji constants for checking processed status
const EMOJI_DONE = 'robot_face';
const EMOJI_FAILED = 'x';

/**
 * Check if a Slack message is a TASK message.
 *
 * @param {{ subtype?: string, text?: string }} msg - Slack message object
 * @returns {boolean}
 */
// LOGIC CHANGE 2026-04-01: Made TASK: detection case-insensitive to accept
// "task:", "Task:", "TASK:", etc. for better UX when typing from mobile.
function isTaskMessage(msg) {
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (!msg.text) return false;
  return msg.text.toUpperCase().includes('TASK:');
}

/**
 * Check if a Slack message is a conversational ASK: message.
 *
 * @param {{ subtype?: string, text?: string }} msg - Slack message object
 * @returns {boolean}
 */
function isConversationMessage(msg) {
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (!msg.text) return false;
  return msg.text.trim().toUpperCase().startsWith('ASK:');
}

// LOGIC CHANGE 2026-04-01: Added isNaturalConversationMessage to detect messages that
// should be processed in natural conversation mode. These are messages that:
// 1. Are not TASK: messages
// 2. Are not ASK: messages
// 3. Have text content
// 4. Are not system subtypes (channel_join, channel_leave, etc.)
// When NATURAL_CONVERSATION_MODE is enabled, these messages are routed to the
// channel's default agent for conversational handling.
/**
 * Check if a Slack message is a natural conversation message (no TASK:/ASK: prefix).
 * Only meaningful when NATURAL_CONVERSATION_MODE is enabled.
 *
 * @param {{ subtype?: string, text?: string }} msg - Slack message object
 * @returns {boolean}
 */
function isNaturalConversationMessage(msg) {
  // Skip system messages
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (msg.subtype === 'bot_message') return false;
  if (msg.subtype === 'message_changed') return false;
  if (msg.subtype === 'message_deleted') return false;
  // LOGIC CHANGE 2026-10-04 (WORK-TODO #49): a message posted by any bot - this one
  // included - is never natural conversation. A bot-token post carries `bot_id` and
  // usually no subtype, so the bot_message check above did not catch the bridge's own
  // top-level posts (an inbox report in the email-monitor channel, for one), and with
  // NATURAL_CONVERSATION_MODE on, an agent would have answered every one of them.
  if (msg.bot_id) return false;

  // Must have text content
  if (!msg.text || !msg.text.trim()) return false;

  // Must NOT be a TASK: or ASK: message
  if (isTaskMessage(msg)) return false;
  if (isConversationMessage(msg)) return false;

  return true;
}

/**
 * Check if a message has already been processed (has done or failed emoji).
 *
 * @param {{ reactions?: Array<{ name: string }> }} msg - Slack message object
 * @returns {boolean}
 */
function alreadyProcessed(msg) {
  if (!msg.reactions) return false;
  return msg.reactions.some(
    (r) => r.name === EMOJI_DONE || r.name === EMOJI_FAILED
  );
}

module.exports = {
  isTaskMessage,
  isConversationMessage,
  isNaturalConversationMessage,
  alreadyProcessed,
  EMOJI_DONE,
  EMOJI_FAILED,
};
