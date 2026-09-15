/**
 * lib/task-parser.js
 *
 * Task parsing and message detection logic extracted from bridge-agent.js
 * for testability.
 */

const {
  isValidRepo,
  isValidBranch,
  describeValue,
  describeCharset,
  OWNER_PUNCTUATION,
  NAME_PUNCTUATION,
  BRANCH_PUNCTUATION,
} = require('./git-identifiers');

// Default GitHub org used when REPO doesn't include an org
const DEFAULT_GITHUB_ORG = process.env.GITHUB_ORG || 'jtpets';

// LOGIC CHANGE 2026-09-14: Field labels are matched at the start of a line and in
// the UPPERCASE form only. Both halves are the fix for a real misparse: on
// 2026-09-13 the unanchored, case-insensitive /REPO:\s*(.+?)/i matched the phrase
// "repo: runWithFallback had" inside an INSTRUCTIONS body and the bridge ran
// `git clone https://github.com/jtpets/runWithFallback had.git`. A task message is
// a header block, so a field label belongs at the start of a line; prose that
// happens to mention "repo:" mid-sentence is not a field. Requiring the uppercase
// form removes the remaining case — an INSTRUCTIONS line that legitimately begins
// "Repo: ..." or "Branch: ...", which is common in dispatch prose.
//
// This intentionally retires the 2026-04-01 case-insensitive-labels behaviour.
// Dropping a lowercase label silently would be its own defect (the task would run
// against no repo, or with no instructions, and nobody would be told), so a label
// that is present in a non-canonical form is recorded in task.errors and the task
// is refused by processTask instead of running degraded.
const FIELD_LABELS = ['TASK', 'REPO', 'BRANCH', 'TURNS', 'SKILL', 'INSTRUCTIONS'];

// Skill names index into skills/<skill>/SKILL.md, so the value is a path segment.
// The allowlist admits no "/" and no leading ".", and ".." is refused below, so the
// value cannot walk out of the scratch clone. "." and "_" stay legal because skill
// names already use them (see the SKILL parsing tests).
const SKILL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// LOGIC CHANGE 2026-09-14: The characters SKILL_PATTERN admits, declared once so the
// rejection message is generated from them rather than retyped. The retyped message
// said "lowercase letters, digits and '-' only" while the pattern also admits "."
// and "_" — so a legitimate skill name like "deploy_check" was described as illegal
// by the very message that accepted it. Same defect class as the REPO message below.
// tests/task-parser.test.js probes the pattern against this list.
const SKILL_PUNCTUATION = ['.', '_', '-'];

// LOGIC CHANGE 2026-09-15: Extracted from parseTask so a GENERATOR of task messages
// can reach the same normalisation the parser applies, instead of re-deriving it.
// lib/dispatch-message.js emits the normalised value, which is what makes its output
// a fixed point of parseTask: the parser re-runs this on the emitted text and gets
// the same string back. Two copies of these three substitutions would be a silent
// round-trip break the moment either changed (docs/CANONICAL-HELPERS.md).
//
// This is NOT sanitisation. It strips a URL wrapper the operator may legitimately
// have pasted and supplies the default org; it removes no character in order to make
// an illegal value pass. Validation still happens afterwards, and still rejects.
//
// @param {string} value - Raw REPO: value, already trimmed.
// @param {string} githubOrg - Org to prepend when the value carries no "/".
// @returns {string} Normalised "owner/name" candidate - NOT yet validated.
function normalizeRepo(value, githubOrg = DEFAULT_GITHUB_ORG) {
  let repo = typeof value === 'string' ? value.trim() : '';
  // LOGIC CHANGE 2026-09-14: Anchor the URL strip too. Unanchored, it removed a
  // "github.com/" occurring anywhere in the value.
  repo = repo.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  repo = repo.replace(/^git@github\.com:/i, '');
  repo = repo.replace(/\.git$/i, '');
  if (repo && !repo.includes('/')) {
    repo = `${githubOrg}/${repo}`;
  }
  return repo;
}

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
 * @returns {{ description: string, repo: string, branch: string, instructions: string, turns: number, skill: string, errors: string[], raw: string }}
 *   `errors` is empty for a well-formed message. A non-empty `errors` means at
 *   least one field was refused (bad shape, or a non-UPPERCASE label) and the
 *   caller must refuse the task rather than run it with the surviving fields.
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
    // LOGIC CHANGE 2026-09-14: Rejected fields are collected here rather than
    // thrown, so a malformed message yields one report listing everything wrong
    // with it. processTask refuses any task with a non-empty errors array.
    errors: [],
    raw: text,
  };

  const source = typeof text === 'string' ? text : '';

  /**
   * Match one field label, anchored to the start of a line and uppercase-only.
   * Returns the captured value, or null when the field is absent.
   *
   * LOGIC CHANGE 2026-09-14: This docstring previously listed "indented prose" among
   * the non-canonical forms recorded as an error. It is not one: the canonical
   * pattern is `^[ \t]*LABEL:`, so leading spaces and tabs are DELIBERATELY
   * accepted (CLAUDE.md, "Field Label Rules"), and `  REPO: x` parses as the REPO
   * field with no error — see the "accepts a label indented with spaces or tabs"
   * test. What IS recorded as an error is a label that is present but carries no
   * value, and a label written in a non-UPPERCASE form. A docstring naming a rule
   * the code does not enforce is the same defect as a rejection message naming the
   * wrong character set, so it is corrected here rather than left as folklore.
   */
  const matchField = (label, capture) => {
    const canonical = source.match(new RegExp(`^[ \\t]*${label}:[ \\t]*${capture}`, 'm'));
    if (canonical) return canonical[1];
    // The label did not yield a value. Say which of the two reasons it was, rather
    // than blaming the casing of a label that is correctly cased but empty.
    if (new RegExp(`^[ \\t]*${label}:`, 'm').test(source)) {
      task.errors.push(`${label}: label is present but carries no value`);
    } else if (new RegExp(`^[ \\t]*${label}:`, 'im').test(source)) {
      task.errors.push(`${label}: label must be UPPERCASE at the start of its own line`);
    }
    return null;
  };

  const singleLine = '(.+?)(?:\\n|$)';

  // Extract TASK:
  const description = matchField('TASK', singleLine);
  if (description !== null) task.description = description.trim();

  // Extract REPO: (handles "org/repo", "https://github.com/org/repo", or just "repo")
  const repoRaw = matchField('REPO', singleLine);
  if (repoRaw !== null) {
    // LOGIC CHANGE 2026-09-15: Normalisation moved to normalizeRepo (above) so the
    // dispatch-modal generator applies the identical transformation. Behaviour here
    // is unchanged - the same three substitutions in the same order.
    const repo = normalizeRepo(repoRaw, githubOrg);
    // LOGIC CHANGE 2026-09-14: Reject, never sanitise. An unvalidated repo reached
    // cloneRepo's shell strings; stripping the offending characters instead would
    // clone a different repository than the operator asked for, without saying so.
    if (isValidRepo(repo)) {
      task.repo = repo;
    } else {
      // LOGIC CHANGE 2026-09-14: Message generated from the same character lists the
      // patterns use. It previously said the whole value could use "." and "_",
      // which is true of the NAME half only — OWNER_PATTERN admits neither, so
      // "jt.pets/app" was refused by a message asserting it was legal.
      task.errors.push(
        `REPO: rejected ${describeValue(repoRaw.trim())} - expected owner/name, where ` +
          `owner uses ${describeCharset(OWNER_PUNCTUATION)} and starts and ends ` +
          `alphanumeric, and name uses ${describeCharset(NAME_PUNCTUATION)}`
      );
    }
  }

  // Extract BRANCH:
  const branchRaw = matchField('BRANCH', singleLine);
  if (branchRaw !== null) {
    const branch = branchRaw.trim();
    if (branch && branch !== 'none') {
      // LOGIC CHANGE 2026-09-14: Same boundary rejection as REPO — branch was
      // interpolated into `git clone --branch <branch>` as a shell string.
      if (isValidBranch(branch)) {
        task.branch = branch;
      } else {
        task.errors.push(
          `BRANCH: rejected ${describeValue(branch)} - expected a git ref name using ` +
            `${describeCharset(BRANCH_PUNCTUATION)}, starting alphanumeric`
        );
      }
    }
  }

  // LOGIC CHANGE 2026-03-26: Extract TURNS: for per-task LLM turn control.
  // Parse as integer, default to 50, cap at 100 max, floor at 5 min.
  // Non-numeric values gracefully fall back to default.
  const turnsRaw = matchField('TURNS', singleLine);
  if (turnsRaw !== null) {
    const parsed = parseInt(turnsRaw.trim(), 10);
    if (!isNaN(parsed)) {
      task.turns = Math.max(MIN_TURNS, Math.min(MAX_TURNS, parsed));
    }
  }

  // LOGIC CHANGE 2026-03-26: Extract SKILL: for loading skill templates.
  // Skill name is lowercased and trimmed. Used to load skills/<skill>/SKILL.md.
  const skillRaw = matchField('SKILL', singleLine);
  if (skillRaw !== null) {
    const skill = skillRaw.trim().toLowerCase();
    // LOGIC CHANGE 2026-09-14: The skill name is joined into a filesystem path, so
    // it is validated as a single path segment. Without this, "../../.." walked out
    // of the scratch clone and read an arbitrary file into the prompt.
    if (SKILL_PATTERN.test(skill) && !skill.includes('..')) {
      task.skill = skill;
    } else {
      task.errors.push(
        `SKILL: rejected ${describeValue(skill)} - expected a single name using ` +
          `lowercase ${describeCharset(SKILL_PUNCTUATION)}, starting alphanumeric, ` +
          `with no "/" and no ".."`
      );
    }
  }

  // Extract INSTRUCTIONS: (everything after the label, can be multiline)
  const instructions = matchField('INSTRUCTIONS', '([\\s\\S]+)');
  if (instructions !== null) task.instructions = instructions.trim();

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
  // LOGIC CHANGE 2026-09-15: Exported so a task-message GENERATOR normalises a REPO:
  // value exactly as the parser will, rather than keeping a second copy.
  normalizeRepo,
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
  // LOGIC CHANGE 2026-09-14: Exported so the anchoring guard test enumerates the
  // real label list instead of restating it and drifting from it.
  FIELD_LABELS,
  SKILL_PATTERN,
  // LOGIC CHANGE 2026-09-14: Exported so the message/pattern agreement test probes
  // the real declared character set instead of restating it and drifting from it.
  SKILL_PUNCTUATION,
};
