'use strict';

/**
 * lib/clone-lifecycle.js
 *
 * Git/clone lifecycle helpers for per-task scratch clones:
 *   cloneRepo             — shallow-clone a repo (branch, with main fallback) and
 *                           configure it to push via the deploy key.
 *   cleanupDir            — remove a scratch clone directory.
 *   detectUndeliveredWork — classify a clone as delivered (safe to delete) or
 *                           undelivered (must be preserved) before cleanup runs.
 *   assertValidTargetDir  — boundary check for the clone target path.
 *
 * LOGIC CHANGE 2026-09-14: Extracted verbatim from bridge-agent.js (seam A in
 * docs/WIRING-AND-SEAMS.md). These functions had zero coupling to bridge module
 * state — their only external references are `fs`, child_process and
 * `process.env.DEPLOY_KEY_PATH` — so lifting them out is a pure refactor.
 * Regression coverage lives in tests/undelivered-work.test.js and
 * tests/clone-lifecycle.test.js.
 *
 * LOGIC CHANGE 2026-09-14: cloneRepo no longer builds shell command strings. It
 * takes an argv array through execFileSync and validates repo/branch via
 * lib/git-identifiers.js, closing the Slack -> parseTask -> execSync command
 * injection the 2026-09-14 security review confirmed.
 *
 * LOGIC CHANGE 2026-09-14 (this change): NO function in this module builds a shell
 * command string any more. The previous header claimed detectUndeliveredWork could
 * keep execSync because "every argument it passes is a literal or a SHA read back
 * from git itself". That justification was incomplete in two ways, and an
 * incomplete justification for a shell is indistinguishable from a wrong one:
 *
 *   1. It enumerated only the COMMAND arguments. The clone directory is also passed
 *      to execSync — as `cwd` — and it is not a literal: it is
 *      `path.join(WORK_DIR, 'task-' + msg.ts...)` in bridge-agent.js's processTask,
 *      built from an environment variable and a Slack API field, neither validated.
 *      cwd is not shell-parsed, so this was never live injection; but the sentence
 *      that was supposed to prove the shell safe never looked at it.
 *   2. "A SHA read back from git" is an assumption about git's output, not a check.
 *      Nothing asserted it. The SHAs are now asserted to be 40 hex characters
 *      before they are used as arguments.
 *
 * Rather than write a longer justification, the shell is gone: every git call here
 * is execFileSync with an argv array. The `--` separator is added wherever git
 * accepts one, because an argv array defeats a SHELL, not git's own option parser —
 * a positional value beginning with "-" is read by git as a flag no matter how it
 * arrived. tests/no-shell-execution.test.js is the enumerating guard for the whole
 * repo; this module is no longer a special case in it.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { assertValidRepo, assertValidBranch } = require('./git-identifiers');

// A 40-character lowercase hex object name. detectUndeliveredWork reads SHAs back
// out of git and passes them to git again; this asserts the shape rather than
// assuming it, so a surprising output can never become an argument.
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Boundary check for a clone target directory. Reject, never sanitise — the same
 * rule lib/git-identifiers.js applies to REPO and BRANCH, and for the same reason:
 * rewriting a path silently clones into somewhere other than the caller asked for.
 *
 * LOGIC CHANGE 2026-09-14: cloneRepo previously checked targetDir only for
 * "non-empty string". That is not enough for two reasons:
 *
 *   - argv arrays defeat shells, not git's option parsing. `git clone ... <dir>`
 *     with a dir of "--upload-pack=..." is read by git as an OPTION, not a path.
 *     The `--` separator cloneRepo now passes closes that for the positional
 *     arguments; this check closes it for the value itself, so neither stands alone.
 *   - targetDir is the one cloneRepo argument with no validated provenance. Its only
 *     caller today builds it as path.join(WORK_DIR, `task-${msg.ts...}`) — WORK_DIR
 *     is an unvalidated environment variable and msg.ts an unvalidated Slack API
 *     field. Neither is operator-typed Slack text today, and NOTHING PREVENTS A
 *     FUTURE CALLER FROM MAKING IT SO: the function is exported, the parameter is
 *     documented as "a path", and a dirName built from task.description or
 *     task.branch would read as an obvious convenience. An absolute, non-flag path
 *     is the invariant every current caller already satisfies, so asserting it costs
 *     nothing and removes the standing invitation.
 *
 * @param {*} targetDir
 * @returns {string} The validated path.
 * @throws {Error} If the value is not an absolute, non-flag, NUL-free path.
 */
function assertValidTargetDir(targetDir) {
  const reject = (why) => {
    throw new Error(`Rejected clone target directory: ${why}`);
  };
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    reject('expected a non-empty path');
  }
  if (targetDir.includes('\0')) {
    reject('path contains a NUL byte');
  }
  if (targetDir.startsWith('-')) {
    // git reads a leading "-" as an option even through an argv array.
    reject('path starts with "-", which git would read as an option');
  }
  if (!path.isAbsolute(targetDir)) {
    reject(`expected an absolute path, got a relative one`);
  }
  return targetDir;
}

// LOGIC CHANGE 2026-03-26: Added try/catch with fallback to main branch when
// specified branch is not found. Cleans up partial clone before retrying.
//
// LOGIC CHANGE 2026-09-14: Every git invocation here ran through execSync, which
// executes its argument as a /bin/sh command string. repo, branch and targetDir
// were interpolated into those strings unescaped, and repo/branch come straight
// from a Slack message via parseTask() — a confirmed command-injection chain
// (2026-09-14 security review). Three changes close it:
//   1. execFileSync with an argv array. The arguments are handed to git directly;
//      no shell parses them, so a metacharacter is just a character.
//   2. assertValid{Repo,Branch,TargetDir} at the sink. The parser already rejects
//      bad REPO/BRANCH values at the boundary; asserting again here means a future
//      caller that skips the parser cannot reintroduce the hole. Rejection throws —
//      processTask's catch reports it to Slack — rather than sanitising, because a
//      silently-rewritten repo name clones something other than what was asked for.
//   3. A `--` separator before the positional url/path arguments. Removing the
//      shell does not remove GIT's option parsing: without `--`, a positional that
//      begins with "-" is still taken as a flag (`--upload-pack=...` being the
//      classic). assertValidTargetDir and assertValidBranch reject such values, and
//      `--` means git would not honour one even if a check were ever relaxed.
function cloneRepo(repo, branch, targetDir) {
  assertValidRepo(repo);
  assertValidBranch(branch);
  assertValidTargetDir(targetDir);

  // No shell involved, so args need no quoting — but they are still validated above.
  const git = (args, options = {}) =>
    execFileSync('git', args, { stdio: 'pipe', ...options });

  const url = `https://github.com/${repo}.git`;
  console.log(`[bridge-agent] Cloning ${url} (branch: ${branch}) -> ${targetDir}`);
  try {
    git(['clone', '--depth', '1', '--branch', branch, '--', url, targetDir], {
      timeout: 60000,
    });
  } catch (err) {
    if (branch !== 'main') {
      console.warn(`[bridge-agent] Branch ${branch} not found, falling back to main`);
      // Clean up any partial clone before retrying
      fs.rmSync(targetDir, { recursive: true, force: true });
      git(['clone', '--depth', '1', '--branch', 'main', '--', url, targetDir], {
        timeout: 60000,
      });
    } else {
      throw err;
    }
  }

  // LOGIC CHANGE 2026-09-13: Configure the clone to push via the deploy key.
  // Without this the clone is read-only and finished work cannot be delivered;
  // three tasks committed locally and were deleted by cleanup.
  //
  // LOGIC CHANGE 2026-09-14: core.sshCommand is the one value git itself hands to a
  // shell when it later invokes ssh, so the key path is single-quoted and a path
  // containing a single quote is refused. DEPLOY_KEY_PATH is operator-set rather
  // than Slack-set, so this is defence in depth, not the reported defect.
  //
  // LOGIC CHANGE 2026-09-14: that refusal used to `return` out of cloneRepo. It
  // skipped exactly the right things TODAY — the push configuration is the last
  // thing the function does, so the early return and the "no key file" else-branch
  // reach the same end state, and no caller observes a difference. But its
  // correctness rested on statement POSITION, not on what it meant: anything
  // appended to cloneRepo later would be silently skipped for one operator
  // misconfiguration, with a warning that says nothing about it. The three paths
  // are now an if/else-if/else chain that scopes the skip to the block it belongs
  // to, so the function always runs to completion.
  const keyPath = process.env.DEPLOY_KEY_PATH || '/bridge/.deploy_key';
  if (!fs.existsSync(keyPath)) {
    console.warn(`[bridge-agent] No deploy key at ${keyPath} - clone is READ-ONLY, pushes will fail`);
  } else if (keyPath.includes("'")) {
    console.warn(
      `[bridge-agent] DEPLOY_KEY_PATH contains a quote character - refusing to configure push; clone is READ-ONLY`
    );
  } else {
    try {
      git(['-C', targetDir, 'remote', 'set-url', 'origin', `git@github.com:${repo}.git`]);
      git([
        '-C',
        targetDir,
        'config',
        '--',
        'core.sshCommand',
        `ssh -i '${keyPath}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
      ]);
      git(['-C', targetDir, 'fetch', '--', 'origin'], { timeout: 60000 });
      console.log('[bridge-agent] Clone configured for push via deploy key (fetch verified)');
    } catch (e) {
      console.warn('[bridge-agent] Push config failed, clone is READ-ONLY:', e.message);
    }
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[bridge-agent] Cleaned up ${dir}`);
  } catch (err) {
    console.error(`[bridge-agent] Cleanup failed for ${dir}:`, err.message);
  }
}

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

module.exports = {
  cloneRepo,
  cleanupDir,
  detectUndeliveredWork,
  assertValidTargetDir,
  SHA_PATTERN,
};
