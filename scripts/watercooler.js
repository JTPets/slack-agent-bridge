#!/usr/bin/env node
// LOGIC CHANGE 2026-03-28: Load .env file on startup so PM2 restarts retain env vars
require('dotenv').config();

/**
 * scripts/watercooler.js
 *
 * Standalone script that runs the weekly team standup conversation.
 * Each active agent shares an update in their personality voice, reacting
 * to what previous agents said. The Jester gets the final word.
 *
 * Runs via cron (Friday 5PM) or manually:
 *   node scripts/watercooler.js
 *
 * Or scheduled via cron:
 *   0 17 * * 5 cd /home/jtpets/jt-agent && set -a && source .env && set +a && node scripts/watercooler.js
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 *   OPS_CHANNEL_ID      #sqtools-ops channel ID
 *
 * Optional env vars:
 *   GEMINI_API_KEY      Google Gemini API key (required for most agents)
 */

'use strict';

const { WebClient } = require('@slack/web-api');
const { runStandup } = require('../lib/watercooler');

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
        console.log('[watercooler] Error notification sent');
    } catch (err) {
        console.error('[watercooler] Failed to send DM:', err.message);
    }
}

// ---- Main ----

async function main() {
    console.log('[watercooler] Starting weekly team standup');

    try {
        const result = await runStandup(slack, OPS_CHANNEL_ID);

        if (result.success) {
            console.log(`[watercooler] Standup completed: ${result.messagesPosted} messages posted`);
            if (result.errors.length > 0) {
                console.log(`[watercooler] Warnings: ${result.errors.join(', ')}`);
            }
        } else {
            console.error('[watercooler] Standup failed:', result.errors.join(', '));
            await sendDM(
                OWNER_USER_ID,
                `:warning: Weekly standup had issues: ${result.errors.join(', ')}`
            );
        }

        console.log('[watercooler] Done');
        process.exit(result.success ? 0 : 1);

    } catch (err) {
        console.error('[watercooler] Fatal error:', err.message);
        console.error(err.stack);

        try {
            await sendDM(
                OWNER_USER_ID,
                `:x: Weekly standup failed: ${err.message}`
            );
        } catch {
            console.error('[watercooler] Could not send error notification');
        }

        process.exit(1);
    }
}

main();
