'use strict';

/**
 * lib/task-parser.js
 *
 * Task parsing and message detection, extracted from bridge-agent.js for testability.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): a facade. Every name it exported is
 * still exported here and is the same object as in the part it moved to
 * (tests/module-splits.test.js):
 *   - lib/task-message.js  reading a TASK message: FIELD_LABELS, parseTask (the hub),
 *                          findUnclaimedLines
 *   - lib/task-fields.js   each field's value rule (normalizeRepo, SKILL_PATTERN, ...)
 *   - lib/task-turns.js    the task and conversation turn budgets
 *   - lib/message-kind.js  TASK / ASK / natural message, already processed
 *   - lib/ask-commands.js  the phrase-matched ASK: built-in recognisers
 * New code may require the part it needs directly.
 */

const { FIELD_LABELS, parseTask, findUnclaimedLines } = require('./task-message');
const { normalizeRepo, SKILL_PATTERN, SKILL_PUNCTUATION } = require('./task-fields');
const turns = require('./task-turns');
const kind = require('./message-kind');
const askCommands = require('./ask-commands');

module.exports = {
  parseTask,
  // LOGIC CHANGE 2026-09-20: Exported so the regression guard exercises the real
  // claim rule rather than restating it and drifting from it.
  findUnclaimedLines,
  // LOGIC CHANGE 2026-09-15: Exported so a task-message GENERATOR normalises a REPO:
  // value exactly as the parser will, rather than keeping a second copy.
  normalizeRepo,
  ...kind,
  ...askCommands,
  ...turns,
  // LOGIC CHANGE 2026-09-14: Exported so the anchoring guard test enumerates the
  // real label list instead of restating it and drifting from it.
  FIELD_LABELS,
  SKILL_PATTERN,
  // LOGIC CHANGE 2026-09-14: Exported so the message/pattern agreement test probes
  // the real declared character set instead of restating it and drifting from it.
  SKILL_PUNCTUATION,
};
