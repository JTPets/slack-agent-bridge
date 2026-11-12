'use strict';

/**
 * lib/clone-delivery.js
 *
 * Whether a scratch clone's work reached the remote (detectUndeliveredWork), so
 * processTask deletes only a delivered clone. Every git call is an execFileSync argv
 * array; the SHAs git returns are shape-asserted (SHA_PATTERN) before they are passed
 * back to git. Moved unchanged out of lib/clone-lifecycle.js (WORK-TODO #10, B28,
 * 2026-11-12), which re-exports both names as the same objects.
 */

const { execFileSync } = require('child_process');

const { assertValidTargetDir } = require('./clone-target');

// A 40-character lowercase hex object name. detectUndeliveredWork reads SHAs back
// out of git and passes them to git again; this asserts the shape rather than
// assuming it, so a surprising output can never become an argument.
const SHA_PATTERN = /^[0-9a-f]{40}$/;

// LOGIC CHANGE 2026-09-13: Decide whether a scratch clone is safe to delete.
// "Delivered" means the work reached the remote (pushed). Deleting a clone that
// still holds uncommitted changes or local commits the remote never received
// silently destroys finished work — the exact failure that lost three tasks
// before the deploy key was wired (see cloneRepo). Cleanup must now gate on this.
//
// Why ls-remote and not `git log --not --remotes`: scratch clones are created
// with `--branch --single-branch`, whose fetch refspec is
// `+refs/heads/<branch>:refs/remotes/origin/<branch>`. Pushing the agent's work
// to any OTHER branch (the common `git checkout -b feature/x && git push` flow)
// never creates a local `origin/feature/x` tracking ref, so `--not --remotes`
// reports delivered commits as unpushed. ls-remote asks the remote directly and
// is immune to that, so tip-SHA matching against it is the source of truth.
//
// LOGIC CHANGE 2026-09-14: converted from execSync shell strings to execFileSync
// argv arrays (see the module header for why the old justification did not hold).
// Two things changed with it:
//   - The `--format='%(objectname)'` value no longer carries its single quotes.
//     Those quotes existed ONLY to stop /bin/sh reading the parentheses as a
//     subshell. With no shell, they would be passed through to git as part of the
//     format and it would emit literal quotes around each SHA — so removing them is
//     required, not cosmetic.
//   - The revisions handed to `git log` are asserted to be 40-hex object names
//     before use. They come from git, but "it comes from git" was an assumption
//     nothing checked, and it was load-bearing in the old header's argument that a
//     shell was safe here.
//
// Returns { undelivered: boolean, reason: string }. On genuine uncertainty it
// errs toward undelivered=true (preserve the clone) rather than risk data loss.
function detectUndeliveredWork(dir) {
  // `dir` is only ever the child process's cwd — never an argument, and never
  // shell-parsed. It is still asserted, so this function cannot be handed a target
  // cloneRepo itself would have refused.
  assertValidTargetDir(dir);

  const git = (args, timeout = 15000) =>
    execFileSync('git', args, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // GIT_TERMINAL_PROMPT=0 keeps ls-remote from blocking on a credential
      // prompt when the remote is private and unreachable — it fails fast instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout,
    })
      .toString()
      .trim();

  // Not a git repo (e.g. the clone failed before init) — no committed work to lose.
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch (e) {
    return { undelivered: false, reason: '' };
  }

  // Uncommitted changes (tracked edits or untracked files) would be destroyed by
  // cleanup. gitignored files are not reported by --porcelain, so test artifacts
  // do not trip this.
  let status;
  try {
    status = git(['status', '--porcelain']);
  } catch (e) {
    return { undelivered: true, reason: `delivery status unknown: ${e.message}` };
  }
  if (status) {
    return { undelivered: true, reason: 'uncommitted changes in the clone' };
  }

  // The commits that would be lost with the clone: every local branch tip + HEAD.
  const localTips = new Set();
  try {
    localTips.add(git(['rev-parse', 'HEAD']));
    const branchTips = git(['for-each-ref', '--format=%(objectname)', 'refs/heads']);
    for (const sha of branchTips.split('\n')) {
      if (sha) localTips.add(sha);
    }
  } catch (e) {
    return { undelivered: true, reason: `delivery status unknown: ${e.message}` };
  }

  // Ask the remote what it actually holds.
  let remoteShas;
  try {
    const lsRemote = git(['ls-remote', '--', 'origin'], 30000);
    remoteShas = new Set(
      lsRemote.split('\n').map((line) => line.split(/\s+/)[0]).filter(Boolean)
    );
  } catch (e) {
    // Remote unreachable — e.g. a READ-ONLY clone that could never push, the
    // exact case that lost work before. Fall back to local-only evidence: any
    // local commit missing from the tracking refs we do have is unverified, so
    // preserve. A clean clone with nothing local still cleans up.
    const revisions = [...localTips].filter((sha) => SHA_PATTERN.test(sha));
    if (revisions.length !== localTips.size || revisions.length === 0) {
      // git returned something that is not an object name (or nothing at all). Do
      // not pass it on as an argument and do not guess: preserve the clone.
      return {
        undelivered: true,
        reason: 'remote unreachable; local commit list unreadable',
      };
    }
    let unpushed = '';
    try {
      // Deliberately NO `--` separator here: after `git log`, "--" begins a
      // PATHSPEC, so adding one would change the question being asked rather than
      // harden it. The revisions are hex-asserted above instead, which is the same
      // guarantee by a different route — a value that could be read as an option
      // never reaches this array.
      unpushed = git(['log', ...revisions, '--not', '--remotes', '--oneline']);
    } catch (_) {
      /* leave empty — cannot enumerate, treated as no local-only commits */
    }
    if (unpushed) {
      return {
        undelivered: true,
        reason: `remote unreachable; ${unpushed.split('\n').length} local commit(s) unverified`,
      };
    }
    return { undelivered: false, reason: '' };
  }

  // A local tip present on the remote as some ref's tip is delivered (this is
  // true for a clean clone: HEAD == origin/<branch> tip, which ls-remote reports).
  const missing = [...localTips].filter((sha) => !remoteShas.has(sha));
  if (missing.length > 0) {
    return {
      undelivered: true,
      reason: `${missing.length} local commit(s) not found on the remote`,
    };
  }
  return { undelivered: false, reason: '' };
}

module.exports = { detectUndeliveredWork, SHA_PATTERN };
