'use strict';

/**
 * lib/git-identifiers.js
 *
 * Validation for the two Slack-controlled git identifiers a task carries: the
 * REPO: value (owner/name) and the BRANCH: value (a git ref name).
 *
 * LOGIC CHANGE 2026-09-14: New module. The 2026-09-14 security review confirmed a
 * taint chain from Slack message text -> parseTask() -> cloneRepo() -> execSync
 * shell strings. The sink is fixed separately (cloneRepo now uses execFileSync
 * with an argv array, so nothing is shell-parsed), but a sink-only fix leaves the
 * bridge cloning whatever string arrives. These predicates are the boundary half:
 * lib/task-parser.js rejects a bad value at parse time and lib/clone-lifecycle.js
 * asserts again at the sink, so neither layer trusts the other.
 *
 * REJECT, never sanitise. Stripping metacharacters out of "jtpets/my;repo" yields
 * "jtpets/myrepo" — a different repository than the operator asked for, cloned
 * without anyone being told. A rejection is visible and correctable.
 *
 * Patterns:
 *   owner  — 1-39 chars of [A-Za-z0-9-], first and last alphanumeric. GitHub's own
 *            account-name rule. Case is preserved, not folded: "JTPets" is valid.
 *   name   — 1-100 chars of [A-Za-z0-9._-], with ".." rejected outright so a repo
 *            value can never walk the URL path.
 *   branch — 1-255 chars of [A-Za-z0-9._/-] starting alphanumeric, plus the
 *            git-check-ref-format rules that character class does not cover
 *            ("..", "//", trailing "/" or ".", a path component starting with "."
 *            or ending in ".lock"). The class alone already excludes every shell
 *            metacharacter, whitespace, newline and ASCII control byte, and makes
 *            "@{" unrepresentable.
 */

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/**
 * Render an untrusted value for an error message. JSON.stringify escapes control
 * characters and newlines, so a rejected value cannot smuggle line breaks into a
 * Slack error post, and the length cap keeps a pasted blob from flooding it.
 *
 * @param {*} value
 * @returns {string}
 */
function describeValue(value) {
  const asString = typeof value === 'string' ? value : String(value);
  const capped = asString.length > 80 ? `${asString.slice(0, 80)}...` : asString;
  return JSON.stringify(capped);
}

/**
 * @param {*} repo - Candidate "owner/name" value.
 * @returns {boolean}
 */
function isValidRepo(repo) {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  if (parts.length !== 2) return false;
  const [owner, name] = parts;
  if (!OWNER_PATTERN.test(owner)) return false;
  if (!NAME_PATTERN.test(name)) return false;
  if (name.includes('..')) return false;
  return true;
}

/**
 * @param {*} branch - Candidate git ref name.
 * @returns {boolean}
 */
function isValidBranch(branch) {
  if (typeof branch !== 'string') return false;
  if (!BRANCH_PATTERN.test(branch)) return false;
  if (branch.includes('..') || branch.includes('//')) return false;
  if (branch.endsWith('/') || branch.endsWith('.')) return false;
  return branch
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * @param {*} repo
 * @returns {string} The validated repo.
 * @throws {Error} If the value is not a valid owner/name.
 */
function assertValidRepo(repo) {
  if (!isValidRepo(repo)) {
    throw new Error(
      `Rejected REPO value ${describeValue(repo)}: expected owner/name, where owner is ` +
        '1-39 characters of [A-Za-z0-9-] and name is 1-100 characters of [A-Za-z0-9._-]'
    );
  }
  return repo;
}

/**
 * @param {*} branch
 * @returns {string} The validated branch.
 * @throws {Error} If the value is not a git-legal ref name within the allowlist.
 */
function assertValidBranch(branch) {
  if (!isValidBranch(branch)) {
    throw new Error(
      `Rejected BRANCH value ${describeValue(branch)}: expected a git ref name of ` +
        '1-255 characters of [A-Za-z0-9._/-] starting with a letter or digit'
    );
  }
  return branch;
}

module.exports = {
  OWNER_PATTERN,
  NAME_PATTERN,
  BRANCH_PATTERN,
  isValidRepo,
  isValidBranch,
  assertValidRepo,
  assertValidBranch,
  describeValue,
};
