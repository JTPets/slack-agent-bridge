'use strict';

/**
 * lib/ask-commands.js
 *
 * The phrase recognisers and parsers for the built-in ASK: commands that are matched by
 * wording rather than by a verb in the command table: the status query, create channel,
 * and the approval queue (list, approve, reject, show task). Each takes the question
 * text already stripped of its ASK: prefix. Pure. The handlers they gate are
 * lib/conversation-builtins.js.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-parser.js, which re-exports every name. This is the lib/ask-commands.js the
 * #10 plan named; the handlers already moved to lib/conversation-builtins.js in B35, so
 * recogniser and handler now sit in sibling modules instead of the parser.
 */

// LOGIC CHANGE 2026-03-26: Added isStatusQuery() to detect built-in status
// commands. These are handled directly without calling the LLM to save tokens.
// Patterns: "what's queued", "whats queued", "queue status", "task status",
// "what are you working on"
/**
 * Check if a question text is a status query that can be answered without LLM.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isStatusQuery(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return /what'?s\s+queued/i.test(lower) ||
         /queue\s+status/i.test(lower) ||
         /task\s+status/i.test(lower) ||
         /what\s+are\s+you\s+working\s+on/i.test(lower);
}

// LOGIC CHANGE 2026-03-26: Added isCreateChannelCommand() to detect built-in
// channel creation commands. Pattern: "create channel #name" or "create channel name"
/**
 * Check if a question text is a create channel command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isCreateChannelCommand(text) {
  if (!text) return false;
  return /^create\s+channel\s+#?[\w-]+/i.test(text.trim());
}

/**
 * Parse channel name from create channel command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {string|null} Channel name or null if not a valid command
 */
function parseCreateChannelCommand(text) {
  if (!text) return null;
  const match = text.trim().match(/^create\s+channel\s+#?([\w-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// LOGIC CHANGE 2026-04-01: Added approval queue command detection.
// These commands manage the manual approval queue for auto-generated tasks.
// Patterns:
// - "pending approvals" / "approval queue" / "awaiting approval"
// - "approve <id>" / "approve all"
// - "reject <id> [reason]" / "reject all"
// - "show task <id>"

/**
 * Check if a question text is an approval queue query.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isApprovalQuery(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  return /pending\s+approvals?/i.test(lower) ||
         /approval\s+queue/i.test(lower) ||
         /awaiting\s+approval/i.test(lower) ||
         /what'?s?\s+pending/i.test(lower) ||
         /show\s+pending/i.test(lower);
}

/**
 * Check if a question text is an approve command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isApproveCommand(text) {
  if (!text) return false;
  return /^approve\s+/i.test(text.trim());
}

/**
 * Parse an approve command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {{ all: boolean, id?: string } | null}
 */
function parseApproveCommand(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // "approve all"
  if (/^approve\s+all$/i.test(trimmed)) {
    return { all: true };
  }

  // "approve <id>"
  const match = trimmed.match(/^approve\s+([\w-]+)/i);
  if (match) {
    return { all: false, id: match[1] };
  }

  return null;
}

/**
 * Check if a question text is a reject command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isRejectCommand(text) {
  if (!text) return false;
  return /^reject\s+/i.test(text.trim());
}

/**
 * Parse a reject command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {{ all: boolean, id?: string, reason?: string } | null}
 */
function parseRejectCommand(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // "reject all [reason]"
  const allMatch = trimmed.match(/^reject\s+all(?:\s+(.+))?$/i);
  if (allMatch) {
    return { all: true, reason: allMatch[1] || '' };
  }

  // "reject <id> [reason]"
  const idMatch = trimmed.match(/^reject\s+([\w-]+)(?:\s+(.+))?$/i);
  if (idMatch) {
    return { all: false, id: idMatch[1], reason: idMatch[2] || '' };
  }

  return null;
}

/**
 * Check if a question text is a show task command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isShowTaskCommand(text) {
  if (!text) return false;
  return /^show\s+task\s+/i.test(text.trim());
}

/**
 * Parse a show task command.
 *
 * @param {string} text - Question text (already stripped of ASK: prefix)
 * @returns {string | null} Task ID or null
 */
function parseShowTaskCommand(text) {
  if (!text) return null;
  const match = text.trim().match(/^show\s+task\s+([\w-]+)/i);
  return match ? match[1] : null;
}

module.exports = {
  isStatusQuery,
  isCreateChannelCommand,
  parseCreateChannelCommand,
  isApprovalQuery,
  isApproveCommand,
  parseApproveCommand,
  isRejectCommand,
  parseRejectCommand,
  isShowTaskCommand,
  parseShowTaskCommand,
};
