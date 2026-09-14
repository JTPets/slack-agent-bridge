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
 *
 * LOGIC CHANGE 2026-09-14: The human-readable half of each rejection message is now
 * GENERATED from the same *_PUNCTUATION arrays the patterns are built around, rather
 * than being retyped prose beside them. It was retyped prose, and it had drifted:
 * lib/task-parser.js told the operator a REPO could use "." and "_" throughout, but
 * OWNER_PATTERN admits neither, so "jt.pets/app" was refused by a message that said
 * it was legal. A rejection message that names the wrong rule is worse than no
 * message — it sends the operator to retry a value that cannot ever pass.
 * tests/git-identifiers.test.js probes every ASCII punctuation character against
 * each pattern and fails if the declared set and the pattern disagree, so the two
 * cannot drift apart again.
 */

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

// The non-alphanumeric characters each pattern admits ANYWHERE in its value. These
// are the single source of truth for the prose in every rejection message (here and
// in lib/task-parser.js); describeCharset() renders them. Positional rules the
// character class cannot express — owner must start and end alphanumeric, branch
// must start alphanumeric — are stated separately in the message text.
const OWNER_PUNCTUATION = ['-'];
const NAME_PUNCTUATION = ['.', '_', '-'];
const BRANCH_PUNCTUATION = ['.', '_', '/', '-'];

/**
 * Render an allowed-character set as the prose half of a rejection message.
 * describeCharset(['.', '_', '-']) -> 'letters, digits, ".", "_" and "-"'
 *
 * @param {string[]} punctuation - Non-alphanumeric characters the pattern admits.
 * @returns {string}
 */
function describeCharset(punctuation) {
  const quoted = punctuation.map((c) => `"${c}"`);
  if (quoted.length === 0) return 'letters and digits';
  if (quoted.length === 1) return `letters, digits and ${quoted[0]}`;
  return `letters, digits, ${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

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
        `1-39 characters of ${describeCharset(OWNER_PUNCTUATION)} starting and ending ` +
        `alphanumeric, and name is 1-100 characters of ` +
        `${describeCharset(NAME_PUNCTUATION)} with no ".."`
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
        `1-255 characters of ${describeCharset(BRANCH_PUNCTUATION)}, starting with a ` +
        `letter or digit, with no "..", "//", trailing "/" or ".", no path component ` +
        `starting "." or ending ".lock"`
    );
  }
  return branch;
}

module.exports = {
  OWNER_PATTERN,
  NAME_PATTERN,
  BRANCH_PATTERN,
  OWNER_PUNCTUATION,
  NAME_PUNCTUATION,
  BRANCH_PUNCTUATION,
  describeCharset,
  isValidRepo,
  isValidBranch,
  assertValidRepo,
  assertValidBranch,
  describeValue,
};
