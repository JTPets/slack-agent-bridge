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
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): split by job, no behaviour change.
 * This file makes and removes a clone (cloneRepo, cleanupDir). Judging whether a
 * clone was delivered is lib/clone-delivery.js (detectUndeliveredWork, SHA_PATTERN);
 * the target-path check both use is lib/clone-target.js (assertValidTargetDir). Every
 * name this module exported before is re-exported as the same object
 * (tests/module-splits.test.js).
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

const { assertValidRepo, assertValidBranch } = require('./git-identifiers');

const { assertValidTargetDir } = require('./clone-target');
const { detectUndeliveredWork, SHA_PATTERN } = require('./clone-delivery');

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

module.exports = {
  cloneRepo,
  cleanupDir,
  detectUndeliveredWork,
  assertValidTargetDir,
  SHA_PATTERN,
};
