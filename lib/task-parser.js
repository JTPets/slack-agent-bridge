/**
 * lib/task-parser.js
 *
 * Task parsing and message detection logic extracted from bridge-agent.js
 * for testability.
 */

// Default GitHub org used when REPO doesn't include an org
const DEFAULT_GITHUB_ORG = process.env.GITHUB_ORG || 'jtpets';

// LOGIC CHANGE 2026-03-26: Added TURNS parsing to allow per-task control of LLM
// max turns. Default 50, capped at 100 max, floor at 5 min.
const DEFAULT_TURNS = 50;
const MIN_TURNS = 5;
const MAX_TURNS = 100;

// Emoji constants for checking processed status
const EMOJI_DONE = 'robot_face';
const EMOJI_FAILED = 'x';

/**
 * Parse a TASK message into structured fields.
 *
 * @param {string} text - Raw message text
 * @param {string} [githubOrg] - Override default GitHub org
 * @returns {{ description: string, repo: string, branch: string, instructions: string, turns: number, skill: string, raw: string }}
 */
function parseTask(text, githubOrg = DEFAULT_GITHUB_ORG) {
  const task = {
    description: '',
    repo: '',
    branch: 'main',
    instructions: '',
    turns: DEFAULT_TURNS,
    // LOGIC CHANGE 2026-03-26: Added skill field for loading skill templates from
    // skills/<skill>/SKILL.md. Default empty string means no skill.
    skill: '',
    raw: text,
  };

  // LOGIC CHANGE 2026-04-01: Made all field patterns case-insensitive to accept
  // "task:", "Task:", "TASK:", etc. for better UX when typing from mobile.

  // Extract TASK:
  const taskMatch = text.match(/TASK:\s*(.+?)(?:\n|$)/i);
  if (taskMatch) task.description = taskMatch[1].trim();

  // Extract REPO: (handles "org/repo", "https://github.com/org/repo", or just "repo")
  const repoMatch = text.match(/REPO:\s*(.+?)(?:\n|$)/i);
  if (repoMatch) {
    let repo = repoMatch[1].trim();
    repo = repo.replace(/https?:\/\/github\.com\//i, '');
    repo = repo.replace(/\.git$/i, '');
    if (!repo.includes('/')) {
      repo = `${githubOrg}/${repo}`;
    }
    task.repo = repo;
  }

  // Extract BRANCH:
  const branchMatch = text.match(/BRANCH:\s*(.+?)(?:\n|$)/i);
  if (branchMatch) {
    const branch = branchMatch[1].trim();
    if (branch && branch !== 'none') task.branch = branch;
  }

  // LOGIC CHANGE 2026-03-26: Extract TURNS: for per-task LLM turn control.
  // Parse as integer, default to 50, cap at 100 max, floor at 5 min.
  // Non-numeric values gracefully fall back to default.
  const turnsMatch = text.match(/TURNS:\s*(.+?)(?:\n|$)/i);
  if (turnsMatch) {
    const parsed = parseInt(turnsMatch[1].trim(), 10);
    if (!isNaN(parsed)) {
      task.turns = Math.max(MIN_TURNS, Math.min(MAX_TURNS, parsed));
    }
  }

  // LOGIC CHANGE 2026-03-26: Extract SKILL: for loading skill templates.
  // Skill name is lowercased and trimmed. Used to load skills/<skill>/SKILL.md.
  const skillMatch = text.match(/SKILL:\s*(.+?)(?:\n|$)/i);
  if (skillMatch) {
    task.skill = skillMatch[1].trim().toLowerCase();
  }

  // Extract INSTRUCTIONS: (everything after the label, can be multiline)
  const instrMatch = text.match(/INSTRUCTIONS:\s*([\s\S]+)/i);
  if (instrMatch) task.instructions = instrMatch[1].trim();

  return task;
}

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
  parseTask,
  isTaskMessage,
  isConversationMessage,
  isNaturalConversationMessage,
  isStatusQuery,
  isCreateChannelCommand,
  parseCreateChannelCommand,
  // LOGIC CHANGE 2026-04-01: Added approval queue command exports.
  isApprovalQuery,
  isApproveCommand,
  parseApproveCommand,
  isRejectCommand,
  parseRejectCommand,
  isShowTaskCommand,
  parseShowTaskCommand,
  alreadyProcessed,
  EMOJI_DONE,
  EMOJI_FAILED,
  DEFAULT_TURNS,
  MIN_TURNS,
  MAX_TURNS,
};
