#!/usr/bin/env node

/**
 * morning-digest.js
 *
 * Standalone script that sends a daily digest DM to the owner with
 * task statistics from the last 24 hours.
 *
 * Runs via cron, not PM2:
 *   0 8 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node morning-digest.js
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 */

'use strict';

const { WebClient } = require('@slack/web-api');
const fs = require('fs');
const path = require('path');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OWNER_USER_ID = 'U02QKNHHU7J';

const MEMORY_DIR = path.join(__dirname, 'memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');
const TASKS_FILE = path.join(MEMORY_DIR, 'tasks.json');
const CONTEXT_FILE = path.join(MEMORY_DIR, 'context.json');

// Validate required config
if (!SLACK_BOT_TOKEN) {
    console.error('[morning-digest] Missing required env var: SLACK_BOT_TOKEN');
    process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// ---- File helpers ----

function loadJsonFile(filePath, defaultValue) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return defaultValue;
        }
        console.error(`[morning-digest] Failed to load ${filePath}:`, err.message);
        return defaultValue;
    }
}

// ---- Slack helpers ----

async function sendDM(userId, text) {
    try {
        // Open a DM channel with the user
        const openResult = await slack.conversations.open({ users: userId });
        const dmChannel = openResult.channel.id;

        // Send the message
        await slack.chat.postMessage({
            channel: dmChannel,
            text,
            unfurl_links: false,
        });
        console.log('[morning-digest] DM sent successfully');
    } catch (err) {
        console.error('[morning-digest] Failed to send DM:', err.message);
        throw err;
    }
}

// ---- Digest logic ----

function isWithinLast24Hours(isoTimestamp) {
    if (!isoTimestamp) return false;
    const timestamp = new Date(isoTimestamp).getTime();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    return timestamp >= twentyFourHoursAgo;
}

function buildDigest() {
    const history = loadJsonFile(HISTORY_FILE, []);
    const tasks = loadJsonFile(TASKS_FILE, []);
    const context = loadJsonFile(CONTEXT_FILE, {});

    // Get owner name from context, fallback to "John"
    const ownerName = context.owner_name || 'John';

    // Filter history for last 24 hours
    const completedLast24h = history.filter(
        (t) => t.status === 'completed' && isWithinLast24Hours(t.completedAt)
    );
    const failedLast24h = history.filter(
        (t) => t.status === 'failed' && isWithinLast24Hours(t.failedAt)
    );

    // Active tasks (still in tasks.json)
    const activeTasks = tasks.filter((t) => t.status === 'active');

    // Build message
    const lines = [];
    lines.push(`Good morning ${ownerName}. Here is your daily digest:`);
    lines.push('');
    lines.push(`• ${completedLast24h.length} task${completedLast24h.length !== 1 ? 's' : ''} completed yesterday`);
    lines.push(`• ${failedLast24h.length} task${failedLast24h.length !== 1 ? 's' : ''} failed`);
    lines.push(`• ${activeTasks.length} task${activeTasks.length !== 1 ? 's' : ''} still active`);

    // List failed tasks if any
    if (failedLast24h.length > 0) {
        lines.push('');
        lines.push('*Failed tasks:*');
        for (const task of failedLast24h) {
            const desc = task.description || 'No description';
            const error = task.error ? ` - ${task.error.slice(0, 100)}` : '';
            lines.push(`  - ${desc}${error}`);
        }
    }

    // List active tasks if any
    if (activeTasks.length > 0) {
        lines.push('');
        lines.push('*Active tasks:*');
        for (const task of activeTasks) {
            const desc = task.description || 'No description';
            const repo = task.repo ? ` (${task.repo})` : '';
            lines.push(`  - ${desc}${repo}`);
        }
    }

    return lines.join('\n');
}

// ---- Main ----

async function main() {
    console.log('[morning-digest] Starting');

    try {
        const digest = buildDigest();
        console.log('[morning-digest] Digest built, sending DM...');

        await sendDM(OWNER_USER_ID, digest);

        console.log('[morning-digest] Done');
        process.exit(0);
    } catch (err) {
        // ALWAYS report errors - send error notification to owner
        console.error('[morning-digest] Failed:', err.message);
        try {
            await sendDM(
                OWNER_USER_ID,
                `❌ Morning digest failed: ${err.message}`
            );
        } catch {
            // Can't even send error message, just log and exit
            console.error('[morning-digest] Could not send error notification');
        }
        process.exit(1);
    }
}

main();
