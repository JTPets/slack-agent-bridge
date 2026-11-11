'use strict';

/**
 * lib/update-git.js
 *
 * The self-update loop's git and npm porcelain, run in the deploy tree
 * (LOCAL_REPO_DIR). Moved out of auto-update.js unchanged on 2026-11-11
 * (WORK-TODO #10, Wave 4); auto-update.js re-exports what it exported and puts
 * the rest in its dependency bag. Every call is spawnSync with an argv array.
 */

const { spawnSync } = require('child_process');
const { LOCAL_REPO_DIR } = require('./update-config');

/**
 * Run a git command in the repo directory
 * @param {string[]} args - Git command arguments
 * @returns {{ success: boolean, stdout: string, stderr: string }}
 */
// LOGIC CHANGE 2026-11-08 (WORK-TODO #17): `-c safe.directory` per call. The checkout is
// owned by the NAS user and git in the container runs as another, which git refuses as
// "dubious ownership" otherwise. Per call, never `git config --global`.
function runGit(args) {
    const result = spawnSync('git', ['-c', `safe.directory=${LOCAL_REPO_DIR}`, ...args], {
        cwd: LOCAL_REPO_DIR,
        encoding: 'utf8',
        timeout: 60000 // 60 second timeout
    });

    return {
        success: result.status === 0,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim()
    };
}

/**
 * Get the current local HEAD commit hash
 * @returns {string|null}
 */
function getLocalHead() {
    const result = runGit(['rev-parse', 'HEAD']);
    return result.success ? result.stdout : null;
}

/**
 * Get the remote origin/main commit hash
 * @returns {string|null}
 */
function getRemoteHead() {
    const result = runGit(['rev-parse', 'origin/main']);
    return result.success ? result.stdout : null;
}

/**
 * Get commit message for a given hash
 * @param {string} hash - Commit hash
 * @returns {string}
 */
function getCommitMessage(hash) {
    const result = runGit(['log', '-1', '--format=%s', hash]);
    return result.success ? result.stdout : '(unknown)';
}

/**
 * Fetch from origin
 * @returns {{ success: boolean, error?: string }}
 */
function gitFetch() {
    const result = runGit(['fetch', 'origin', 'main']);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

/**
 * Move the deploy tree to exactly `commit`, fast-forward only.
 *
 * LOGIC CHANGE 2026-11-08 (WORK-TODO #17): was `git pull origin main`, which fetches
 * again and lands on whatever main is NOW. With the gate in front of the deploy, main can
 * move during the gate run, and "deploy exactly what the gate judged" is the rule. The
 * commit was fetched at the top of the cycle; a refused fast-forward is a stop, never a
 * force.
 * @param {string} commit - the sha to land on
 * @returns {{ success: boolean, error?: string }}
 */
function gitPull(commit) {
    if (!/^[0-9a-f]{40}$/.test(commit || '')) return { success: false, error: 'no 40-hex commit to fast-forward to' };
    const result = runGit(['merge', '--ff-only', commit]);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-03-26: Added git reset --hard HEAD before pull to ensure any local
// modifications (from npm install modifying package.json, or stray files) don't block the pull
/**
 * Reset local repo to HEAD (discard any local modifications)
 * @returns {{ success: boolean, error?: string }}
 */
function gitResetHard() {
    const result = runGit(['reset', '--hard', 'HEAD']);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-09-13: Removed removePackageLock(). It existed only because
// package-lock.json was gitignored while npm install kept recreating it locally.
// The lockfile is now committed, so deleting it before every pull would be
// deleting a tracked file; `git reset --hard HEAD` above already restores it.

// LOGIC CHANGE 2026-09-13: Added gitResetTo() for guard (a). When verification
// of a pulled commit fails, the working tree goes back to the commit that was
// running a moment ago, so the process keeps serving code that is known to start.
/**
 * Reset local repo to a specific commit (used to revert a bad update)
 * @param {string} commit - Commit hash to reset to
 * @returns {{ success: boolean, error?: string }}
 */
function gitResetTo(commit) {
    const result = runGit(['reset', '--hard', commit]);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-03-26: Added npm install after git pull so new dependencies get installed
// automatically when the repo is updated
/**
 * Run npm install in the repo directory
 * @returns {{ success: boolean, error?: string }}
 */
function npmInstall() {
    const result = spawnSync('npm', ['install'], {
        cwd: LOCAL_REPO_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000 // 2 minute timeout for npm install
    });

    return {
        success: result.status === 0,
        error: result.status === 0 ? undefined : (result.stderr || result.stdout || 'Unknown npm error').trim()
    };
}

module.exports = {
    runGit,
    getLocalHead,
    getRemoteHead,
    getCommitMessage,
    gitFetch,
    gitPull,
    gitResetHard,
    gitResetTo,
    npmInstall,
};
