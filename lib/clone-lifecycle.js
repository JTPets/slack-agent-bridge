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
 *
 * LOGIC CHANGE 2026-09-14: Extracted verbatim from bridge-agent.js (seam A in
 * docs/WIRING-AND-SEAMS.md). These three functions had zero coupling to bridge
 * module state — their only external references are `fs`, `execSync`, and
 * `process.env.DEPLOY_KEY_PATH` — so lifting them out is a pure refactor. Behaviour
 * and signatures are unchanged; each function's original dated LOGIC CHANGE comment
 * is preserved below. Regression coverage lives in tests/undelivered-work.test.js
 * and tests/clone-lifecycle.test.js.
 */

const { execSync } = require('child_process');
const fs = require('fs');

// LOGIC CHANGE 2026-03-26: Added try/catch with fallback to main branch when
// specified branch is not found. Cleans up partial clone before retrying.
function cloneRepo(repo, branch, targetDir) {
  const url = `https://github.com/${repo}.git`;
  console.log(`[bridge-agent] Cloning ${url} (branch: ${branch}) -> ${targetDir}`);
  try {
    execSync(`git clone --depth 1 --branch ${branch} ${url} ${targetDir}`, {
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err) {
    if (branch !== 'main') {
      console.warn(`[bridge-agent] Branch ${branch} not found, falling back to main`);
      // Clean up any partial clone before retrying
      fs.rmSync(targetDir, { recursive: true, force: true });
      execSync(`git clone --depth 1 --branch main ${url} ${targetDir}`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    } else {
      throw err;
    }
  }

  // LOGIC CHANGE 2026-09-13: Configure the clone to push via the deploy key.
  // Without this the clone is read-only and finished work cannot be delivered;
  // three tasks committed locally and were deleted by cleanup.
  const keyPath = process.env.DEPLOY_KEY_PATH || "/bridge/.deploy_key";
  if (fs.existsSync(keyPath)) {
    try {
      execSync(`git -C ${targetDir} remote set-url origin git@github.com:${repo}.git`, {stdio:"pipe"});
      execSync(`git -C ${targetDir} config core.sshCommand "ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"`, {stdio:"pipe"});
      execSync(`git -C ${targetDir} fetch origin`, {stdio:"pipe", timeout:60000});
      console.log("[bridge-agent] Clone configured for push via deploy key (fetch verified)");
    } catch (e) {
      console.warn("[bridge-agent] Push config failed, clone is READ-ONLY:", e.message);
    }
  } else {
    console.warn(`[bridge-agent] No deploy key at ${keyPath} - clone is READ-ONLY, pushes will fail`);
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
// Returns { undelivered: boolean, reason: string }. On genuine uncertainty it
// errs toward undelivered=true (preserve the clone) rather than risk data loss.
function detectUndeliveredWork(dir) {
  const git = (args, timeout = 15000) =>
    execSync(`git ${args}`, {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
      // GIT_TERMINAL_PROMPT=0 keeps ls-remote from blocking on a credential
      // prompt when the remote is private and unreachable — it fails fast instead.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout,
    }).toString().trim();

  // Not a git repo (e.g. the clone failed before init) — no committed work to lose.
  try {
    git('rev-parse --is-inside-work-tree');
  } catch (e) {
    return { undelivered: false, reason: '' };
  }

  // Uncommitted changes (tracked edits or untracked files) would be destroyed by
  // cleanup. gitignored files are not reported by --porcelain, so test artifacts
  // do not trip this.
  let status;
  try {
    status = git('status --porcelain');
  } catch (e) {
    return { undelivered: true, reason: `delivery status unknown: ${e.message}` };
  }
  if (status) {
    return { undelivered: true, reason: 'uncommitted changes in the clone' };
  }

  // The commits that would be lost with the clone: every local branch tip + HEAD.
  const localTips = new Set();
  try {
    localTips.add(git('rev-parse HEAD'));
    // Quote the format: execSync runs through /bin/sh, which treats the
    // parentheses in %(objectname) as a subshell and errors out unquoted.
    const branchTips = git("for-each-ref --format='%(objectname)' refs/heads");
    for (const sha of branchTips.split('\n')) {
      if (sha) localTips.add(sha);
    }
  } catch (e) {
    return { undelivered: true, reason: `delivery status unknown: ${e.message}` };
  }

  // Ask the remote what it actually holds.
  let remoteShas;
  try {
    const lsRemote = git('ls-remote origin', 30000);
    remoteShas = new Set(
      lsRemote.split('\n').map((line) => line.split(/\s+/)[0]).filter(Boolean)
    );
  } catch (e) {
    // Remote unreachable — e.g. a READ-ONLY clone that could never push, the
    // exact case that lost work before. Fall back to local-only evidence: any
    // local commit missing from the tracking refs we do have is unverified, so
    // preserve. A clean clone with nothing local still cleans up.
    let unpushed = '';
    try {
      unpushed = git(`log ${[...localTips].join(' ')} --not --remotes --oneline`);
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
};
