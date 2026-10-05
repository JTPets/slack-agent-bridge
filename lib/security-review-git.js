'use strict';

/**
 * lib/security-review-git.js
 *
 * The git reads behind the nightly security review: clone a repository with enough
 * history to cover a day (`--depth 100`), list the last 24 hours of non-merge commits,
 * and produce the diff and a one-line-per-commit log for the reviewer's prompt. Every
 * call is spawn with an argv array, never a shell.
 *
 * LOGIC CHANGE 2026-10-05: Moved unchanged out of security-review.js (WORK-TODO #10,
 * wave 3), which was over the 300-line limit and whose git half was tested by nothing.
 * The wave plan said to swap this clone for lib/clone-lifecycle.js cloneRepo; that
 * would have been wrong: that clone is `--depth 1` and configures the push key, and the
 * review needs a day of history and no push. So this is a move, not a de-duplication.
 * tests/security-review-git.test.js runs the readers against a real temporary repo.
 */

const { spawn } = require('child_process');
const { assertValidRepo } = require('./git-identifiers');

/**
 * Execute a command and return stdout.
 * Uses spawn for safety (no shell injection).
 */
function execCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            ...options,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout.trim());
            } else {
                reject(new Error(`Command failed with code ${code}: ${stderr}`));
            }
        });

        child.on('error', (err) => {
            reject(new Error(`Spawn failed: ${err.message}`));
        });
    });
}

/**
 * Clone a repository into a temp directory.
 *
 * LOGIC CHANGE 2026-09-14: `repo` is asserted here and `--` separates the
 * positional arguments. execCommand already uses spawn with an argv array, so no
 * shell was ever involved — but two gaps in the same class were still open:
 * an entry in REPOS goes into a URL AND into the mkdtemp prefix in reviewRepo
 * (via repo.replace('/', '-')), unvalidated; and without `--`, git's own option
 * parser would read a positional beginning with "-" as a flag no matter how it
 * arrived. REPOS is operator-set, not Slack-set, so this is the boundary half of
 * the same closure, not a live defect. A rejected entry throws; main()'s per-repo
 * catch records it and the nightly report names it, so one bad entry cannot
 * silently skip a repo or take the whole review down.
 */
async function cloneRepo(repo, tempDir) {
    assertValidRepo(repo);
    const repoUrl = `https://github.com/${repo}.git`;
    console.log(`[security-review] Cloning ${repo}...`);

    await execCommand('git', ['clone', '--depth', '100', '--', repoUrl, tempDir]);
    console.log(`[security-review] Cloned ${repo} to ${tempDir}`);
}

/**
 * Get commits from the last 24 hours.
 * Returns array of commit hashes.
 */
async function getRecentCommits(repoDir) {
    try {
        const output = await execCommand(
            'git',
            ['log', '--since=24 hours ago', '--format=%H', '--no-merges'],
            { cwd: repoDir }
        );

        if (!output) {
            return [];
        }

        return output.split('\n').filter(Boolean);
    } catch (err) {
        console.error('[security-review] Failed to get commits:', err.message);
        return [];
    }
}

/**
 * Get the diff for specified commits.
 */
async function getDiff(repoDir, commits) {
    if (commits.length === 0) {
        return '';
    }

    // Get diff from oldest commit's parent to newest commit
    const oldest = commits[commits.length - 1];
    const newest = commits[0];

    try {
        // Try to get diff from parent of oldest commit
        const diff = await execCommand(
            'git',
            ['diff', `${oldest}^`, newest],
            { cwd: repoDir }
        );
        return diff;
    } catch {
        // If oldest commit has no parent (initial commit), show all changes
        try {
            const diff = await execCommand(
                'git',
                ['show', '--format=', ...commits],
                { cwd: repoDir }
            );
            return diff;
        } catch (err) {
            console.error('[security-review] Failed to get diff:', err.message);
            return '';
        }
    }
}

/**
 * Get commit log summary for display.
 */
async function getCommitLog(repoDir, commits) {
    if (commits.length === 0) {
        return 'No commits in the last 24 hours.';
    }

    try {
        const log = await execCommand(
            'git',
            ['log', '--since=24 hours ago', '--format=%h %s (%an)', '--no-merges'],
            { cwd: repoDir }
        );
        return log;
    } catch (err) {
        return `${commits.length} commits`;
    }
}

module.exports = {
    execCommand,
    cloneRepo,
    getRecentCommits,
    getDiff,
    getCommitLog,
};
