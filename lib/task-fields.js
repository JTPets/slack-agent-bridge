'use strict';

/**
 * lib/task-fields.js
 *
 * THE value rules for the single-line task fields: what a REPO:, BRANCH:, TURNS: or
 * SKILL: value may be, and the rejection message for one that may not. Each field has
 * one function taking the raw captured value and returning `{ value }` (accepted),
 * `{ error }` (refused, never sanitised) or `{}` (absent or ignored, the default stands).
 * Pure: no I/O. lib/task-message.js parseTask is the hub that calls them.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved out of lib/task-parser.js, whose
 * parseTask held every field's rule inline. The rules and the messages are unchanged;
 * normalizeRepo, SKILL_PATTERN and SKILL_PUNCTUATION are re-exported by the facade.
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
const { MIN_TURNS, TURNS_CEILING } = require('./task-turns');

// Default GitHub org used when REPO doesn't include an org
const DEFAULT_GITHUB_ORG = process.env.GITHUB_ORG || 'jtpets';

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

/**
 * REPO: handles "org/repo", "https://github.com/org/repo", or just "repo".
 *
 * @param {string} raw - The captured value
 * @param {string} githubOrg
 * @returns {{ value?: string, error?: string }}
 */
function parseRepoField(raw, githubOrg = DEFAULT_GITHUB_ORG) {
  const repo = normalizeRepo(raw, githubOrg);
  // LOGIC CHANGE 2026-09-14: Reject, never sanitise. An unvalidated repo reached
  // cloneRepo's shell strings; stripping the offending characters instead would
  // clone a different repository than the operator asked for, without saying so.
  if (isValidRepo(repo)) return { value: repo };
  // LOGIC CHANGE 2026-09-14: Message generated from the same character lists the
  // patterns use. It previously said the whole value could use "." and "_",
  // which is true of the NAME half only — OWNER_PATTERN admits neither, so
  // "jt.pets/app" was refused by a message asserting it was legal.
  return {
    error:
      `REPO: rejected ${describeValue(raw.trim())} - expected owner/name, where ` +
      `owner uses ${describeCharset(OWNER_PUNCTUATION)} and starts and ends ` +
      `alphanumeric, and name uses ${describeCharset(NAME_PUNCTUATION)}`,
  };
}

/**
 * BRANCH: empty or "none" keeps the default.
 *
 * @param {string} raw
 * @returns {{ value?: string, error?: string }}
 */
function parseBranchField(raw) {
  const branch = raw.trim();
  if (!branch || branch === 'none') return {};
  // LOGIC CHANGE 2026-09-14: Same boundary rejection as REPO — branch was
  // interpolated into `git clone --branch <branch>` as a shell string.
  if (isValidBranch(branch)) return { value: branch };
  return {
    error:
      `BRANCH: rejected ${describeValue(branch)} - expected a git ref name using ` +
      `${describeCharset(BRANCH_PUNCTUATION)}, starting alphanumeric`,
  };
}

/**
 * TURNS: parsed as an integer and clamped to MIN_TURNS-TURNS_CEILING. A non-numeric
 * value is ignored (the default stands); the /dispatch form refuses both cases instead.
 *
 * LOGIC CHANGE 2026-03-26: Extract TURNS: for per-task LLM turn control.
 *
 * @param {string} raw
 * @returns {{ value?: number }}
 */
function parseTurnsField(raw) {
  const parsed = parseInt(raw.trim(), 10);
  if (isNaN(parsed)) return {};
  return { value: Math.max(MIN_TURNS, Math.min(TURNS_CEILING, parsed)) };
}

/**
 * SKILL: lowercased and trimmed; used to load skills/<skill>/SKILL.md.
 *
 * @param {string} raw
 * @returns {{ value?: string, error?: string }}
 */
function parseSkillField(raw) {
  const skill = raw.trim().toLowerCase();
  // LOGIC CHANGE 2026-09-14: The skill name is joined into a filesystem path, so
  // it is validated as a single path segment. Without this, "../../.." walked out
  // of the scratch clone and read an arbitrary file into the prompt.
  if (SKILL_PATTERN.test(skill) && !skill.includes('..')) return { value: skill };
  return {
    error:
      `SKILL: rejected ${describeValue(skill)} - expected a single name using ` +
      `lowercase ${describeCharset(SKILL_PUNCTUATION)}, starting alphanumeric, ` +
      `with no "/" and no ".."`,
  };
}

module.exports = {
  DEFAULT_GITHUB_ORG,
  SKILL_PATTERN,
  SKILL_PUNCTUATION,
  normalizeRepo,
  parseRepoField,
  parseBranchField,
  parseTurnsField,
  parseSkillField,
};
