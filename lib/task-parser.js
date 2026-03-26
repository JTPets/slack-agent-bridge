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
 * @returns {{ description: string, repo: string, branch: string, instructions: string, turns: number, raw: string }}
 */
function parseTask(text, githubOrg = DEFAULT_GITHUB_ORG) {
  const task = {
    description: '',
    repo: '',
    branch: 'main',
    instructions: '',
    turns: DEFAULT_TURNS,
    raw: text,
  };

  // Extract TASK:
  const taskMatch = text.match(/TASK:\s*(.+?)(?:\n|$)/);
  if (taskMatch) task.description = taskMatch[1].trim();

  // Extract REPO: (handles "org/repo", "https://github.com/org/repo", or just "repo")
  const repoMatch = text.match(/REPO:\s*(.+?)(?:\n|$)/);
  if (repoMatch) {
    let repo = repoMatch[1].trim();
    repo = repo.replace(/https?:\/\/github\.com\//, '');
    repo = repo.replace(/\.git$/, '');
    if (!repo.includes('/')) {
      repo = `${githubOrg}/${repo}`;
    }
    task.repo = repo;
  }

  // Extract BRANCH:
  const branchMatch = text.match(/BRANCH:\s*(.+?)(?:\n|$)/);
  if (branchMatch) {
    const branch = branchMatch[1].trim();
    if (branch && branch !== 'none') task.branch = branch;
  }

  // LOGIC CHANGE 2026-03-26: Extract TURNS: for per-task LLM turn control.
  // Parse as integer, default to 50, cap at 100 max, floor at 5 min.
  // Non-numeric values gracefully fall back to default.
  const turnsMatch = text.match(/TURNS:\s*(.+?)(?:\n|$)/);
  if (turnsMatch) {
    const parsed = parseInt(turnsMatch[1].trim(), 10);
    if (!isNaN(parsed)) {
      task.turns = Math.max(MIN_TURNS, Math.min(MAX_TURNS, parsed));
    }
  }

  // Extract INSTRUCTIONS: (everything after the label, can be multiline)
  const instrMatch = text.match(/INSTRUCTIONS:\s*([\s\S]+)/);
  if (instrMatch) task.instructions = instrMatch[1].trim();

  return task;
}

/**
 * Check if a Slack message is a TASK message.
 *
 * @param {{ subtype?: string, text?: string }} msg - Slack message object
 * @returns {boolean}
 */
function isTaskMessage(msg) {
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (!msg.text) return false;
  return msg.text.includes('TASK:');
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
  alreadyProcessed,
  EMOJI_DONE,
  EMOJI_FAILED,
  DEFAULT_TURNS,
  MIN_TURNS,
  MAX_TURNS,
};
