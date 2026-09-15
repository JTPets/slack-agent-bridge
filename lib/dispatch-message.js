'use strict';

/**
 * lib/dispatch-message.js
 *
 * The GENERATOR half of the slash-command dispatch form: it turns five separate
 * modal inputs into a task message that lib/task-parser.js reads back as the same
 * five fields, and it refuses anything it cannot guarantee that for.
 *
 * LOGIC CHANGE 2026-09-15: New file. Part three of the change described in
 * docs/WIRING-AND-SEAMS.md section 7 ("What the NEXT change has to do", steps 3-5).
 *
 * WHY THIS EXISTS. A dispatch reaches the bridge as a Slack message whose first
 * lines carry TASK:/REPO:/BRANCH:/TURNS:/INSTRUCTIONS:. Slack flattens some pasted
 * multi-line input onto one line; the labels stop being line-anchored, `REPO:`
 * absorbs the rest of the message, and the task runs against no repository at the
 * default turn budget. Three tasks failed that way on 2026-09-14 after ten to
 * fifteen minutes of work each. A form with separate inputs cannot be flattened.
 *
 * WHY THE GENERATOR IS THE PART THAT MATTERS. A form that emits something the
 * parser reads differently is the SAME defect arriving from the other direction.
 * Two mechanisms, not one:
 *   1. buildDispatchMessage() emits UPPERCASE, line-anchored labels with
 *      INSTRUCTIONS: last (parseTask's instructions capture is greedy to end of
 *      input, so nothing may follow it).
 *   2. assertRoundTrip() parses the generated message back and compares every
 *      field before it is allowed to leave this module. A drift becomes a caught
 *      failure and a reported error, never a malformed post. The same round trip
 *      is pinned in tests/integration.test.js beside the three generators that were
 *      already pinned there.
 *
 * REJECT, NEVER SANITISE - the rule lib/git-identifiers.js is built on, applied to
 * every field here. REPO: and BRANCH: are validated by that module rather than by a
 * second pattern; a bad value is named back to the operator in the field it came
 * from. Stripping characters to force a pass would dispatch a different repository
 * than was asked for, with nobody told.
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

const {
  parseTask,
  normalizeRepo,
  FIELD_LABELS,
  DEFAULT_TURNS,
  MIN_TURNS,
  MAX_TURNS,
} = require('./task-parser');

// The five inputs, in the order they appear in the form AND in the generated
// message. lib/dispatch-command.js builds its modal blocks from this list, so a
// field cannot exist in the form and not in the generator, or the reverse.
const FIELD_KEYS = ['task', 'repo', 'branch', 'turns', 'instructions'];

/**
 * A line that parseTask would read as a field label - in ANY case, because a
 * non-canonical spelling is not ignored by the parser, it refuses the whole task.
 * Built from the parser's exported FIELD_LABELS so the two cannot drift.
 */
function matchesFieldLabel(line) {
  return new RegExp(`^[ \\t]*(?:${FIELD_LABELS.join('|')}):`, 'i').test(line);
}

/**
 * Normalise transport line endings before anything else looks at the text.
 * Slack may deliver a multiline input with CRLF; a stray "\r" would ride into the
 * instructions body and into every downstream prompt. This removes no character
 * the operator typed as content - it is a transport fix, not a value edit.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n') : '';
}

/**
 * Validate the five raw modal inputs.
 *
 * @param {object} input - { task, repo, branch, turns, instructions } raw strings.
 * @param {string} [githubOrg] - Org to prepend to a bare repo name.
 * @returns {{ ok: boolean, values: object, errors: object }} `errors` is keyed by
 *   FIELD_KEY so the caller can hand Slack a per-field message; `values` is only
 *   meaningful when ok is true.
 */
function validateDispatchFields(input = {}, githubOrg = undefined) {
  const errors = {};
  const values = {};

  // ---- TASK: single line, required -----------------------------------------
  const task = normalizeText(input.task).trim();
  if (!task) {
    errors.task = 'A task description is required.';
  } else if (task.includes('\n')) {
    // TASK: is a single-line field in the parser; a second line would be read as
    // part of the header block or lost entirely.
    errors.task = 'The task description must be a single line.';
  } else if (matchesFieldLabel(task)) {
    errors.task = `A task description may not start with a field label. Got ${describeValue(task)}.`;
  } else {
    values.task = task;
  }

  // ---- REPO: optional, validated by lib/git-identifiers.js -------------------
  const repoRaw = normalizeText(input.repo).trim();
  if (!repoRaw) {
    values.repo = '';
  } else {
    const repo = normalizeRepo(repoRaw, githubOrg);
    if (isValidRepo(repo)) {
      values.repo = repo;
    } else {
      errors.repo =
        `Rejected ${describeValue(repoRaw)} - expected owner/name, where owner uses ` +
        `${describeCharset(OWNER_PUNCTUATION)} and starts and ends alphanumeric, and ` +
        `name uses ${describeCharset(NAME_PUNCTUATION)}.`;
    }
  }

  // ---- BRANCH: optional, defaults to main ------------------------------------
  const branchRaw = normalizeText(input.branch).trim();
  const branch = branchRaw || 'main';
  if (isValidBranch(branch)) {
    values.branch = branch;
  } else {
    errors.branch =
      `Rejected ${describeValue(branchRaw)} - expected a git ref name using ` +
      `${describeCharset(BRANCH_PUNCTUATION)}, starting alphanumeric.`;
  }

  // ---- TURNS: optional, same floor and ceiling the parser enforces ------------
  // The parser CLAMPS an out-of-range value and IGNORES a non-numeric one. The form
  // rejects both instead: silently running 200 turns as 100, or "fifty" as 50, is
  // the class of silent downgrade this whole change exists to remove. Because the
  // emitted value is always in range, the two never disagree on a generated message.
  const turnsRaw = normalizeText(input.turns).trim();
  if (!turnsRaw) {
    values.turns = DEFAULT_TURNS;
  } else if (!/^[0-9]+$/.test(turnsRaw)) {
    errors.turns = `Rejected ${describeValue(turnsRaw)} - the turn budget must be a whole number.`;
  } else {
    const parsed = parseInt(turnsRaw, 10);
    if (parsed < MIN_TURNS || parsed > MAX_TURNS) {
      errors.turns = `Rejected ${turnsRaw} - the turn budget must be between ${MIN_TURNS} and ${MAX_TURNS}.`;
    } else {
      values.turns = parsed;
    }
  }

  // ---- INSTRUCTIONS: multiline, required, no field labels inside --------------
  // parseTask searches the WHOLE message for each label, so a line inside the
  // instructions body that begins "REPO:" would be read as the repo field, and one
  // beginning "Repo:" would refuse the entire task. Either way the operator's five
  // separate inputs stop being five separate fields - the defect, from inside.
  const instructions = normalizeText(input.instructions).trim();
  if (!instructions) {
    errors.instructions = 'Instructions are required.';
  } else {
    const offending = instructions
      .split('\n')
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(({ line }) => matchesFieldLabel(line));
    if (offending.length > 0) {
      const { line, number } = offending[0];
      errors.instructions =
        `Line ${number} starts with a task field label (${describeValue(line.trim().split(':')[0])}), ` +
        `which the task parser would read as a field rather than as instructions. ` +
        `Field labels are ${FIELD_LABELS.join(', ')}. Reword the line or indent it behind other text.`;
    } else {
      values.instructions = instructions;
    }
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}

/**
 * Build the task message from validated values.
 *
 * INSTRUCTIONS: is last and unconditional: parseTask captures it with [\s\S]+, so
 * any field emitted after it would be swallowed into the instructions body.
 * REPO: is omitted entirely when empty rather than emitted blank - the parser
 * records "label is present but carries no value" as an ERROR, so a blank line
 * would refuse the task.
 *
 * @param {object} values - Output of validateDispatchFields().values.
 * @returns {string}
 */
function buildDispatchMessage(values) {
  const lines = [`TASK: ${values.task}`];
  if (values.repo) lines.push(`REPO: ${values.repo}`);
  lines.push(`BRANCH: ${values.branch}`);
  lines.push(`TURNS: ${values.turns}`);
  lines.push(`INSTRUCTIONS: ${values.instructions}`);
  return lines.join('\n');
}

/**
 * Parse the generated message back and confirm every field survived unchanged.
 * Throws rather than returning false: a mismatch means the generator and the
 * parser have drifted, and posting the message anyway is the failure this guards.
 *
 * @param {string} message - Output of buildDispatchMessage().
 * @param {object} values - The values it was built from.
 * @param {string} [githubOrg]
 * @returns {object} The parsed task, when it matches.
 * @throws {Error} With the first mismatch named.
 */
function assertRoundTrip(message, values, githubOrg = undefined) {
  const parsed = githubOrg === undefined ? parseTask(message) : parseTask(message, githubOrg);

  if (parsed.errors.length > 0) {
    throw new Error(`the parser rejected the generated message: ${parsed.errors.join('; ')}`);
  }

  const mismatches = [];
  if (parsed.description !== values.task) mismatches.push('TASK');
  if (parsed.repo !== values.repo) mismatches.push('REPO');
  if (parsed.branch !== values.branch) mismatches.push('BRANCH');
  if (parsed.turns !== values.turns) mismatches.push('TURNS');
  if (parsed.instructions !== values.instructions) mismatches.push('INSTRUCTIONS');

  if (mismatches.length > 0) {
    throw new Error(
      `the generated message does not round-trip through parseTask; ` +
        `${mismatches.join(', ')} changed. This is a generator/parser drift, not bad input.`
    );
  }

  return parsed;
}

/**
 * Validate, generate and self-check in one call - the only entry point a handler
 * needs.
 *
 * @param {object} input - Raw modal values.
 * @param {string} [githubOrg]
 * @returns {{ ok: boolean, message?: string, values?: object, errors?: object }}
 *   `errors` keyed by field on rejection, INCLUDING a round-trip failure, which is
 *   reported against the instructions field because that is the only free-form one.
 */
function composeDispatchMessage(input = {}, githubOrg = undefined) {
  const { ok, values, errors } = validateDispatchFields(input, githubOrg);
  if (!ok) return { ok: false, errors };

  const message = buildDispatchMessage(values);
  try {
    assertRoundTrip(message, values, githubOrg);
  } catch (err) {
    return {
      ok: false,
      errors: { instructions: `This task could not be composed safely: ${err.message}` },
    };
  }

  return { ok: true, message, values };
}

module.exports = {
  FIELD_KEYS,
  matchesFieldLabel,
  normalizeText,
  validateDispatchFields,
  buildDispatchMessage,
  assertRoundTrip,
  composeDispatchMessage,
};
