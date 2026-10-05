#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so a restarted process retains
// its env vars. LOGIC CHANGE 2026-09-14: was "so PM2 restarts retain env vars"; the
// reason stands, the supervisor named is not this one (there is no pm2 here).
require('dotenv').config();

/**
 * security-review.js
 *
 * Standalone cron script that performs automated security reviews
 * of commits from the last 24 hours across configured repositories.
 *
 * Runs via cron, not PM2:
 *   0 1 * * * cd <repo> && set -a && source .env && set +a && node security-review.js
 *
 * <repo> is the repo path as the cron host sees it. The Raspberry Pi path
 * (/home/jtpets/jt-agent) is dead; the bridge now runs in the `jt-agent` container.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 *   OPS_CHANNEL_ID      Channel for ops notifications
 *
 * Optional env vars:
 *   REPOS               Comma-separated list of repos (default: jtpets/slack-agent-bridge;
 *                       the default is owned by DEFAULT_REPOS in lib/config.js)
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient, postText, sendDM: slackSendDM } = require('./lib/slack-web');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { runLLM } = require('./lib/llm-runner');
const { assertValidRepo } = require('./lib/git-identifiers');
const bulletinBoard = require('./lib/bulletin-board');
const securityFollowup = require('./lib/security-followup');
const { config, getConfiguredRepos } = require('./lib/config');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
const OWNER_USER_ID = 'U02QKNHHU7J';

// LOGIC CHANGE 2026-09-15: the REPOS list and its default moved to lib/config.js
// (getConfiguredRepos). This file used to own the only copy; the /dispatch form now
// needs the same list, and a second hardcoded default would be the shape where the
// two silently disagree about which repositories exist. Parsing is unchanged —
// split, trim, drop empties — and the per-entry validation below is unchanged too,
// because "operator-set" is a weaker guarantee than "checked".
const REPOS = getConfiguredRepos();

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

const slack = createWebClient(SLACK_BOT_TOKEN);

// ---- Slack helpers ----

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30): both helpers delegate to lib/slack-web.js. These
// copies did not redact, on the path most likely to quote a credential back out of a diff
// (LLM-written findings), and they rethrew, so a Slack hiccup aborted the bulletin and
// follow-up pipeline. They now return whether the message landed and main() decides.
function sendDM(userId, text) {
    return slackSendDM(slack, userId, text, 'security-review');
}

function postToOps(text) {
    return postText(slack, OPS_CHANNEL_ID, text, 'security-review');
}

// ---- Git helpers ----

// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the clone and the git reads moved to
// lib/security-review-git.js. This file keeps the report, delivery and follow-up.
const { cloneRepo, getRecentCommits, getDiff, getCommitLog } = require('./lib/security-review-git');

// ---- Main logic ----

async function reviewRepo(repo, skillPrompt) {
    let tempDir;

    try {
        // LOGIC CHANGE 2026-09-14: Assert before the value is used to build a path.
        // repo.replace('/', '-') replaces only the FIRST slash, so an entry like
        // "a/../../tmp/x" would otherwise walk out of os.tmpdir() in the prefix.
        assertValidRepo(repo);
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
    let reportPartial = false;
    try {
        const dmOk = await sendDM(OWNER_USER_ID, report);
        const opsOk = await postToOps(report);
        if (!dmOk && !opsOk) {
            throw new Error('the report reached neither the owner DM nor #sqtools-ops');
        }
        if (!dmOk || !opsOk) {
            // Reached one destination: carry on with the pipeline, but exit non-zero.
            console.error(`[security-review] Report delivered to ${dmOk ? 'the owner DM' : '#sqtools-ops'} only`);
            reportPartial = true;
        } else {
            console.log('[security-review] Report sent successfully');
        }

        // LOGIC CHANGE 2026-03-28: Post security findings to bulletin board.
        // Each repo with findings gets its own bulletin for inter-agent visibility.
        // LOGIC CHANGE 2026-04-01: Include full review text for auto-task pipeline.
        for (const result of results) {
            try {
                const bulletinResult = bulletinBoard.postBulletin('security', 'security_finding', {
                    description: `Security review of ${result.repo}: ${result.commitCount} commit(s) reviewed`,
                    repo: result.repo,
                    commitCount: result.commitCount,
                    summary: result.review.slice(0, 500),
                    fullReview: result.review, // Full text for auto-task parsing
                });

                // LOGIC CHANGE 2026-04-01: Trigger security followup pipeline if enabled.
                // Automatically creates TASK messages for CRITICAL/HIGH severity findings.
                if (bulletinResult.success && config.SECURITY_FOLLOWUP_ENABLED) {
                    try {
                        const followupResult = await securityFollowup.processSecurityBulletin(
                            slack,
                            { ...bulletinResult.bulletin, data: { ...bulletinResult.bulletin.data, fullReview: result.review } },
                            { includeMedium: config.SECURITY_FOLLOWUP_INCLUDE_MEDIUM }
                        );

                        if (followupResult.tasks.length > 0) {
                            console.log(`[security-review] Created ${followupResult.tasks.length} remediation task(s) for ${result.repo}`);
                            // Post summary to ops channel
                            const summary = securityFollowup.formatFollowupSummary(followupResult);
                            await postToOps(`*Security Auto-Task Pipeline* (${result.repo})\n${summary}`);
                        }
                    } catch (followupErr) {
                        console.error(`[security-review] Followup pipeline error for ${result.repo}:`, followupErr.message);
                    }
                }
            } catch (bulletinErr) {
                console.error(`[security-review] Failed to post bulletin for ${result.repo}:`, bulletinErr.message);
            }
        }
    } catch (err) {
        console.error('[security-review] Failed to send report:', err.message);
        // Try to at least notify about the failure
        if (!(await sendDM(OWNER_USER_ID, `Security review failed: ${err.message}`))) {
            console.error('[security-review] Could not send error notification');
        }
        process.exit(1);
    }

    console.log('[security-review] Done');
    process.exit(reportPartial ? 1 : 0);
}

main();
