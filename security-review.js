#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so a restarted process retains
// its env vars. LOGIC CHANGE 2026-09-14: was "so PM2 restarts retain env vars"; the
// reason stands, the supervisor named is not this one (there is no pm2 here).
require('dotenv').config();

/**
 * security-review.js
 *
 * Manual entry point for the security review of the last 24 hours of commits across
 * the configured repositories, delivered to the owner DM and #sqtools-ops.
 *
 * Nothing schedules it: its cron host was the Raspberry Pi, which is dead. The same
 * review runs inside the bridge as the security agent's task `nightly-audit`
 * (lib/nightly-security-review.js, WORK-TODO #83). Run by hand with:
 *   node security-review.js
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

const { runLLM } = require('./lib/llm-runner');
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

// LOGIC CHANGE 2026-11-25 (WORK-TODO #83): the review itself (clone, 24-hour diff, the
// model call with no tools in an empty temp dir, the report, the bulletin and follow-up)
// moved to lib/nightly-security-review.js, which the bridge now runs in-process as the
// scheduled task `nightly-audit`. This script is the manual/cron entry point: it runs the
// same review and delivers to the owner DM and #sqtools-ops as it always did. Nothing
// schedules it since the Raspberry Pi died.
const review = require('./lib/nightly-security-review');
const { resolveAgentLlm } = require('./lib/agent-llm-resolver');
const { getAgent } = require('./lib/agent-registry');

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

    const agent = getAgent('security') || { id: 'security' };
    const resolved = resolveAgentLlm(agent);
    const outcome = await review.reviewAll(REPOS, skillPrompt, {
        git: require('./lib/security-review-git'),
        llm: { runLLM },
        llmOptions: { provider: resolved.provider, model: resolved.model, agentId: 'security', agentRecord: review.toolless(agent) },
    });
    const { results } = outcome;
    const report = review.buildReport(outcome, REPOS);

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

        // LOGIC CHANGE 2026-03-28 / 2026-04-01: bulletin per repo, then the follow-up
        // pipeline (CRITICAL/HIGH -> approval queue). Shared with the in-process run.
        const failures = await review.publishFindings(results, {
            slack, bulletinBoard, securityFollowup, config, report: postToOps,
        });
        for (const f of failures) console.error(`[security-review] ${f}`);
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
