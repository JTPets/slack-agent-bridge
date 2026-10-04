#!/usr/bin/env node
// LOGIC CHANGE 2026-03-28: Load .env file on startup so a restarted process retains
// its env vars. LOGIC CHANGE 2026-09-14: was "so PM2 restarts retain env vars"; the
// reason stands, the supervisor named is not this one (there is no pm2 here).
require('dotenv').config();

/**
 * scripts/watercooler.js
 *
 * Standalone script that runs the team standup conversation.
 * Each active agent shares an update in their personality voice, reacting
 * to what previous agents said. The Jester gets the final word.
 *
 * LOGIC CHANGE 2026-03-28: Added support for two standup types:
 * - kickoff: Monday 8:30 AM - "What are we focused on this week?"
 * - retro: Friday 5:00 PM - "What did we accomplish? What failed?"
 *
 * Usage:
 *   node scripts/watercooler.js [kickoff|retro]
 *
 * If no type is specified, auto-detects based on day (Monday=kickoff, Friday=retro).
 *
 * Cron schedules:
 *   30 8 * * 1 cd <repo> && set -a && source .env && set +a && node scripts/watercooler.js kickoff
 *   0 17 * * 5 cd <repo> && set -a && source .env && set +a && node scripts/watercooler.js retro
 *
 * <repo> is the repo path as the cron host sees it. The Raspberry Pi path
 * (/home/jtpets/jt-agent) is dead; the bridge now runs in the `jt-agent` container.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 *   OPS_CHANNEL_ID      #sqtools-ops channel ID
 *
 * Optional env vars:
 *   GEMINI_API_KEY      Google Gemini API key (required for most agents)
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient, sendDM: slackSendDM } = require('../lib/slack-web');
const { runStandup, parseStandupType, STANDUP_TYPES } = require('../lib/watercooler');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
const OWNER_USER_ID = 'U02QKNHHU7J';

// Validate required config
if (!SLACK_BOT_TOKEN) {
    console.error('[watercooler] Missing required env var: SLACK_BOT_TOKEN');
    process.exit(1);
}

if (!OPS_CHANNEL_ID) {
    console.error('[watercooler] Missing required env var: OPS_CHANNEL_ID');
    process.exit(1);
}

const slack = createWebClient(SLACK_BOT_TOKEN);

// ---- Slack helpers ----

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30): delegates to lib/slack-web.js sendDM, which
// redacts and returns whether the DM landed. This copy already swallowed; now it says so.
async function sendDM(userId, text) {
    const ok = await slackSendDM(slack, userId, text, 'watercooler');
    if (!ok) console.error('[watercooler] Could not send the DM');
    return ok;
}

// ---- Main ----

async function main() {
    // Parse standup type from command line argument
    const arg = process.argv[2];
    const standupType = parseStandupType(arg || '');
    const typeConfig = STANDUP_TYPES[standupType];

    console.log(`[watercooler] Starting ${typeConfig.name}`);

    try {
        const result = await runStandup(slack, OPS_CHANNEL_ID, standupType);

        if (result.success) {
            console.log(`[watercooler] ${typeConfig.name} completed: ${result.messagesPosted} messages posted`);
            if (result.errors.length > 0) {
                // LOGIC CHANGE 2026-09-14: a partial failure was logged and nothing
                // else. A standup that "succeeded" while an agent's contribution was
                // dropped looks identical, from Slack, to one where that agent had
                // nothing to say. Same class as the scheduler's `not_in_channel`.
                console.log(`[watercooler] Warnings: ${result.errors.join(', ')}`);
                await sendDM(
                    OWNER_USER_ID,
                    `:warning: ${typeConfig.name} completed with ${result.errors.length} problem(s), ` +
                    `${result.messagesPosted} message(s) posted:\n${result.errors.map(e => `• ${e}`).join('\n')}`
                );
            }
        } else {
            console.error(`[watercooler] ${typeConfig.name} failed:`, result.errors.join(', '));
            await sendDM(
                OWNER_USER_ID,
                `:warning: ${typeConfig.name} had issues: ${result.errors.join(', ')}`
            );
        }

        console.log('[watercooler] Done');
        process.exit(result.success ? 0 : 1);

    } catch (err) {
        console.error(`[watercooler] ${typeConfig.name} fatal error:`, err.message);
        console.error(err.stack);

        await sendDM(OWNER_USER_ID, `:x: ${typeConfig.name} failed: ${err.message}`);

        process.exit(1);
    }
}

main();
