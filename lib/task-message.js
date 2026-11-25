'use strict';

/**
 * lib/task-message.js
 *
 * Reading a TASK message: where each field label is (FIELD_LABELS, uppercase and
 * line-anchored), parseTask, the hub that finds each label and hands its value to that
 * field's rule in lib/task-fields.js, and findUnclaimedLines, the check that no body
 * text is dropped in silence. Pure.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved out of lib/task-parser.js, which
 * re-exports every name. parseTask now reads top to bottom as its steps (find each
 * label, apply its rule, check for unclaimed body); the per-field rules it held inline
 * are lib/task-fields.js. Behaviour and every message are unchanged
 * (tests/task-parser.test.js, unchanged, runs through the facade).
 */

const { describeValue } = require('./git-identifiers');
const { DEFAULT_TURNS } = require('./task-turns');
const {
  DEFAULT_GITHUB_ORG,
  parseRepoField,
  parseBranchField,
  parseTurnsField,
  parseSkillField,
} = require('./task-fields');

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

const SINGLE_LINE = '(.+?)(?:\\n|$)';

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
 *
 * LOGIC CHANGE 2026-11-25 (B37): was a closure inside parseTask; it takes the source
 * and the errors array explicitly now. Same patterns, same messages.
 */
const matchField = (source, errors, label, capture) => {
  const canonical = source.match(new RegExp(`^[ \\t]*${label}:[ \\t]*${capture}`, 'm'));
  if (canonical) return canonical[1];
  // The label did not yield a value. Say which of the two reasons it was, rather
  // than blaming the casing of a label that is correctly cased but empty.
  if (new RegExp(`^[ \\t]*${label}:`, 'm').test(source)) {
    errors.push(`${label}: label is present but carries no value`);
  } else if (new RegExp(`^[ \\t]*${label}:`, 'im').test(source)) {
    errors.push(`${label}: label must be UPPERCASE at the start of its own line`);
  }
  return null;
};

/** Record one field rule's verdict on the task: the value, the refusal, or nothing. */
function applyField(task, key, verdict) {
  if (verdict.error) task.errors.push(verdict.error);
  else if (verdict.value !== undefined) task[key] = verdict.value;
}

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
  const field = (label, capture = SINGLE_LINE) => matchField(source, task.errors, label, capture);

  const description = field('TASK');
  if (description !== null) task.description = description.trim();

  const repoRaw = field('REPO');
  if (repoRaw !== null) applyField(task, 'repo', parseRepoField(repoRaw, githubOrg));

  const branchRaw = field('BRANCH');
  if (branchRaw !== null) applyField(task, 'branch', parseBranchField(branchRaw));

  const turnsRaw = field('TURNS');
  if (turnsRaw !== null) applyField(task, 'turns', parseTurnsField(turnsRaw));

  const skillRaw = field('SKILL');
  if (skillRaw !== null) applyField(task, 'skill', parseSkillField(skillRaw));

  // INSTRUCTIONS: everything after the label, can be multiline
  const instructions = field('INSTRUCTIONS', '([\\s\\S]+)');
  if (instructions !== null) task.instructions = instructions.trim();

  const unclaimedError = describeUnclaimed(findUnclaimedLines(source));
  if (unclaimedError) task.errors.push(unclaimedError);

  return task;
}

/**
 * The refusal for body text no label claims, or null when there is none.
 *
 * LOGIC CHANGE 2026-09-20: Refuse a task message that carries body content no
 * field label claims, instead of dropping it in silence.
 *
 * THE DEFECT THIS CLOSES. Every single-line field (TASK/REPO/BRANCH/TURNS/SKILL)
 * captures only the remainder of its own line, and INSTRUCTIONS: is the ONLY label
 * whose capture is multiline. So a dispatch written as a TASK: one-liner followed
 * by paragraphs of body — no INSTRUCTIONS: label anywhere — parsed to
 * `instructions: ''` with `errors: []`, and the prompt builders fall back to
 * `task.instructions || task.description` (lib/review-prompt.js buildPrompt,
 * bridge-agent.js). The executor therefore received the one-line
 * description and nothing else. Observed 2026-09-20: a 634-byte dispatch body
 * delivered 70 bytes, no error raised, and the executor correctly reported it had
 * been handed no payload.
 *
 * This is the same defect the 2026-09-14 non-canonical-label rule was written
 * against, arriving from the other direction. That comment (above) states the
 * doctrine in as many words: a task must not "run ... with no instructions, and
 * nobody would be told". A label in a non-canonical FORM was already refused; body
 * content in a non-canonical PLACE was not. It is now.
 *
 * Deliberately NOT a silent promotion of the stray text to `instructions`. A
 * generator emits INSTRUCTIONS: unconditionally (lib/agent-scheduler.js,
 * lib/dispatch-message.js, lib/security-followup.js, lib/subtask-format.js), so
 * unclaimed content means a HUMAN wrote the message
 * by hand and the label is missing; guessing which of their paragraphs were meant as
 * instructions is the "sanitise rather than reject" failure this parser refuses
 * everywhere else. Refusing posts the reason to Slack (processTask throws on a
 * non-empty errors array) and the operator re-sends with the label.
 *
 * A bare `TASK: do the thing` with no body is UNAFFECTED: it has no unclaimed
 * content, so no error, and the description-fallback keeps working as before.
 *
 * @param {Array<{ line: number, text: string }>} unclaimed
 * @returns {string|null}
 */
function describeUnclaimed(unclaimed) {
  if (unclaimed.length === 0) return null;
  const shown = describeValue(unclaimed[0].text.slice(0, 80));
  const more = unclaimed.length > 1 ? ` (and ${unclaimed.length - 1} more)` : '';
  return (
    `INSTRUCTIONS: label is missing, so ${unclaimed.length} line(s) of body text ` +
    `would have been dropped - first at line ${unclaimed[0].line}: ${shown}${more}. ` +
    `Put the body under an INSTRUCTIONS: label (UPPERCASE, at the start of its own line).`
  );
}

/**
 * Lines of a task message that no field label claims, and that would therefore be
 * dropped silently by parseTask.
 *
 * A single-line label claims its own line only. INSTRUCTIONS: claims its own line and
 * EVERY line after it, because its capture is `[\s\S]+` and runs greedily to the end
 * of the message. Blank lines are never reported: they carry nothing to lose.
 *
 * Scanning starts at the FIRST field-label line, so a preamble ahead of the header
 * block is not reported. That preamble is Slack presentation, not lost instructions:
 * `lib/security-followup.js` opens its remediation message with a
 * ":warning: *Security Remediation Required*" banner above `TASK:`, and
 * `tests/integration.test.js` asserts that generator parses with no rejected fields.
 * The loss this function exists to catch is body text BELOW the header block, which is
 * where a hand-written dispatch puts it and where nothing claims it.
 *
 * A label written in a non-canonical case is treated as claimed here so that a
 * lowercase `repo:` line produces the one precise error matchField already records for
 * it rather than two overlapping ones.
 *
 * LOGIC CHANGE 2026-09-20: Added with the unclaimed-content refusal above.
 *
 * @param {string} source - Raw message text
 * @returns {Array<{ line: number, text: string }>} 1-based line numbers and text
 */
function findUnclaimedLines(source) {
  const labelLine = new RegExp(`^[ \t]*(?:${FIELD_LABELS.join('|')}):`, 'i');
  const instructionsLine = /^[ \t]*INSTRUCTIONS:/i;
  const unclaimed = [];
  let seenLabel = false;

  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // INSTRUCTIONS: swallows the remainder of the message - nothing after it is lost.
    if (instructionsLine.test(line)) return unclaimed;
    if (labelLine.test(line)) {
      seenLabel = true;
      continue;
    }
    if (!seenLabel) continue;
    if (!line.trim()) continue;
    unclaimed.push({ line: i + 1, text: line.trim() });
  }

  return unclaimed;
}

module.exports = {
  FIELD_LABELS,
  parseTask,
  findUnclaimedLines,
};
