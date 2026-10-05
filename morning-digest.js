#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so a restarted process retains
// its env vars. LOGIC CHANGE 2026-09-14: was "so PM2 restarts retain env vars"; the
// reason stands, the supervisor named is not this one (there is no pm2 here).
require('dotenv').config();

/**
 * morning-digest.js
 *
 * Standalone script that sends a daily digest DM to the owner with
 * task statistics from the last 24 hours.
 *
 * Runs via cron, not PM2:
 *   0 8 * * * cd <repo> && set -a && source .env && set +a && node morning-digest.js
 *
 * <repo> is the repo path as the cron host sees it. The Raspberry Pi path
 * (/home/jtpets/jt-agent) is dead; the bridge now runs in the `jt-agent` container.
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient, sendDM: slackSendDM } = require('./lib/slack-web');
const { dayKey, STORE_TIME_ZONE } = require('./lib/time-format');
const path = require('path');
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the digest's sections and the weather fetch
// moved to lib/digest-sections.js and lib/integrations/weather.js. This file keeps the
// token check, the Slack client, sendDM and main().
const { buildDigest, loadJsonFile, isWithinLast24Hours } = require('./lib/digest-sections');
// LOGIC CHANGE 2026-03-28: Added bulletin board integration for milestone posting
const bulletinBoard = require('./lib/bulletin-board');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OWNER_USER_ID = 'U02QKNHHU7J';

const MEMORY_DIR = path.join(__dirname, 'memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');

// Validate required config
if (!SLACK_BOT_TOKEN) {
    console.error('[morning-digest] Missing required env var: SLACK_BOT_TOKEN');
    process.exit(1);
}

const slack = createWebClient(SLACK_BOT_TOKEN);

// ---- Slack helpers ----

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30): delegates to lib/slack-web.js sendDM, which
// redacts (this copy did not, and the digest carries email senders and subjects) and
// returns whether the DM landed instead of throwing. main() fails on a false.
function sendDM(userId, text) {
    return slackSendDM(slack, userId, text, 'morning-digest');
}

// ---- Main ----

async function main() {
    console.log('[morning-digest] Starting');

    try {
        const digest = await buildDigest({ memoryDir: MEMORY_DIR });
        console.log('[morning-digest] Digest built, sending DM...');

        if (!(await sendDM(OWNER_USER_ID, digest))) {
            throw new Error('the digest DM was not delivered');
        }

        // LOGIC CHANGE 2026-03-28: Post daily milestone bulletin for inter-agent awareness.
        // Other agents can see that the morning digest was sent.
        try {
            const history = loadJsonFile(HISTORY_FILE, []);
            const completedLast24h = history.filter(
                (t) => t.status === 'completed' && isWithinLast24Hours(t.completedAt)
            );
            const failedLast24h = history.filter(
                (t) => t.status === 'failed' && isWithinLast24Hours(t.failedAt)
            );

            bulletinBoard.postBulletin('secretary', 'milestone', {
                description: `Morning digest sent: ${completedLast24h.length} tasks completed, ${failedLast24h.length} failed`,
                tasksCompleted: completedLast24h.length,
                tasksFailed: failedLast24h.length,
                // LOGIC CHANGE 2026-10-04 (WORK-TODO #33): the store's day, not a UTC one.
                date: dayKey(new Date(), STORE_TIME_ZONE),
            });
        } catch (bulletinErr) {
            console.error('[morning-digest] Failed to post milestone bulletin:', bulletinErr.message);
        }

        // LOGIC CHANGE 2026-03-28: Cleanup old bulletins daily during morning digest.
        try {
            const cleanup = bulletinBoard.cleanupOldBulletins(7);
            if (cleanup.removed > 0) {
                console.log(`[morning-digest] Cleaned up ${cleanup.removed} old bulletins`);
            }
        } catch (cleanupErr) {
            console.error('[morning-digest] Bulletin cleanup failed:', cleanupErr.message);
        }

        console.log('[morning-digest] Done');
        process.exit(0);
    } catch (err) {
        // ALWAYS report errors - send error notification to owner
        console.error('[morning-digest] Failed:', err.message);
        if (!(await sendDM(OWNER_USER_ID, `❌ Morning digest failed: ${err.message}`))) {
            // Can't even send error message, just log and exit
            console.error('[morning-digest] Could not send error notification');
        }
        process.exit(1);
    }
}

main();
