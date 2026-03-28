#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so PM2 restarts retain env vars
require('dotenv').config();

/**
 * security-review.js
 *
 * Standalone cron script that performs automated security reviews
 * of commits from the last 24 hours across configured repositories.
 *
 * Runs via cron, not PM2:
 *   0 1 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node security-review.js
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 *   OPS_CHANNEL_ID      Channel for ops notifications
 *
 * Optional env vars:
 *   REPOS               Comma-separated list of repos (default: jtpets/slack-agent-bridge,jtpets/SquareDashboardTool)
 */

'use strict';

const { WebClient } = require('@slack/web-api');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { runLLM } = require('./lib/llm-runner');
const bulletinBoard = require('./lib/bulletin-board');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
const OWNER_USER_ID = 'U02QKNHHU7J';

// Default repos if not specified
const DEFAULT_REPOS = 'jtpets/slack-agent-bridge,jtpets/SquareDashboardTool';
const REPOS = (process.env.REPOS || DEFAULT_REPOS)
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

// Load skill prompt
const SKILL_PATH = path.join(__dirname, 'skills', 'security-review', 'SKILL.md');

// Validate required config
if (!SLACK_BOT_TOKEN) {
    console.error('[security-review] Missing required env var: SLACK_BOT_TOKEN');
    process.exit(1);
}

if (!OPS_CHANNEL_ID) {
    console.error('[security-review] Missing required env var: OPS_CHANNEL_ID');
    process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// ---- Slack helpers ----

async function sendDM(userId, text) {
    try {
        const openResult = await slack.conversations.open({ users: userId });
        const dmChannel = openResult.channel.id;

        await slack.chat.postMessage({
            channel: dmChannel,
            text,
            unfurl_links: false,
        });
        console.log('[security-review] DM sent successfully');
    } catch (err) {
        console.error('[security-review] Failed to send DM:', err.message);
        throw err;
    }
}

async function postToOps(text) {
    try {
        await slack.chat.postMessage({
            channel: OPS_CHANNEL_ID,
            text,
            unfurl_links: false,
        });
        console.log('[security-review] Posted to ops channel');
    } catch (err) {
        console.error('[security-review] Failed to post to ops:', err.message);
        throw err;
    }
}

// ---- Git helpers ----

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
 */
async function cloneRepo(repo, tempDir) {
    const repoUrl = `https://github.com/${repo}.git`;
    console.log(`[security-review] Cloning ${repo}...`);

    await execCommand('git', ['clone', '--depth', '100', repoUrl, tempDir]);
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

// ---- Main logic ----

async function reviewRepo(repo, skillPrompt) {
    let tempDir;

    try {
        // Create temp directory
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `security-review-${repo.replace('/', '-')}-`));

        // Clone the repo
        await cloneRepo(repo, tempDir);

        // Get recent commits
        const commits = await getRecentCommits(tempDir);

        if (commits.length === 0) {
            console.log(`[security-review] No commits in last 24h for ${repo}, skipping`);
            return null;
        }

        console.log(`[security-review] Found ${commits.length} commits in ${repo}`);

        // Get commit log and diff
        const commitLog = await getCommitLog(tempDir, commits);
        const diff = await getDiff(tempDir, commits);

        if (!diff) {
            console.log(`[security-review] No diff available for ${repo}, skipping`);
            return null;
        }

        // Build prompt
        const prompt = `${skillPrompt}

## Repository: ${repo}

## Commits from last 24 hours:
${commitLog}

## Diff to review:
\`\`\`
${diff.slice(0, 50000)}
\`\`\`
${diff.length > 50000 ? '\n(diff truncated to 50KB)' : ''}

Review these changes for security issues.`;

        // Run LLM
        console.log(`[security-review] Running security review for ${repo}...`);
        const { output } = await runLLM(prompt, {
            cwd: tempDir,
            maxTurns: 10,
        });

        return {
            repo,
            commitCount: commits.length,
            commitLog,
            review: output,
        };
    } finally {
        // Always cleanup temp directory
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            console.log(`[security-review] Cleaned up ${tempDir}`);
        }
    }
}

async function main() {
    console.log('[security-review] Starting security review');
    console.log(`[security-review] Repos to review: ${REPOS.join(', ')}`);

    let skillPrompt;
    try {
        skillPrompt = await fs.readFile(SKILL_PATH, 'utf8');
    } catch (err) {
        console.error(`[security-review] Failed to load skill prompt: ${err.message}`);
        process.exit(1);
    }

    const results = [];
    const errors = [];

    for (const repo of REPOS) {
        try {
            const result = await reviewRepo(repo, skillPrompt);
            if (result) {
                results.push(result);
            }
        } catch (err) {
            console.error(`[security-review] Error reviewing ${repo}:`, err.message);
            errors.push({ repo, error: err.message });
        }
    }

    // Build report
    const lines = [];
    lines.push('*Daily Security Review*');
    lines.push('');

    if (results.length === 0 && errors.length === 0) {
        lines.push('No commits to review in the last 24 hours across all repos.');
    } else {
        for (const result of results) {
            lines.push(`*${result.repo}* (${result.commitCount} commits)`);
            lines.push('');
            lines.push(result.review);
            lines.push('');
            lines.push('---');
            lines.push('');
        }

        if (errors.length > 0) {
            lines.push('*Errors:*');
            for (const { repo, error } of errors) {
                lines.push(`- ${repo}: ${error}`);
            }
        }
    }

    const report = lines.join('\n');

    // Send to owner DM and ops channel
    try {
        await sendDM(OWNER_USER_ID, report);
        await postToOps(report);
        console.log('[security-review] Report sent successfully');

        // LOGIC CHANGE 2026-03-28: Post security findings to bulletin board.
        // Each repo with findings gets its own bulletin for inter-agent visibility.
        for (const result of results) {
            try {
                bulletinBoard.postBulletin('security', 'security_finding', {
                    description: `Security review of ${result.repo}: ${result.commitCount} commit(s) reviewed`,
                    repo: result.repo,
                    commitCount: result.commitCount,
                    summary: result.review.slice(0, 500),
                });
            } catch (bulletinErr) {
                console.error(`[security-review] Failed to post bulletin for ${result.repo}:`, bulletinErr.message);
            }
        }
    } catch (err) {
        console.error('[security-review] Failed to send report:', err.message);
        // Try to at least notify about the failure
        try {
            await sendDM(OWNER_USER_ID, `Security review failed: ${err.message}`);
        } catch {
            console.error('[security-review] Could not send error notification');
        }
        process.exit(1);
    }

    console.log('[security-review] Done');
    process.exit(0);
}

main();
