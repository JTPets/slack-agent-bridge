#!/usr/bin/env node

/**
 * morning-digest.js
 *
 * Sends a daily digest DM summarizing task activity from the last 24 hours.
 * Designed to run via cron - exits after sending.
 *
 * Cron line (7am daily):
 *   0 7 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node morning-digest.js
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 */

'use strict';

const { WebClient } = require('@slack/web-api');
const memory = require('./memory/memory-manager');
const path = require('path');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

if (!SLACK_BOT_TOKEN) {
    console.error('[morning-digest] Missing required env var: SLACK_BOT_TOKEN');
    process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// ---- Helpers ----

function getTasksLast24Hours(history) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return history.filter(task => {
        const timestamp = task.completedAt || task.failedAt;
        if (!timestamp) return false;
        return new Date(timestamp).getTime() >= cutoff;
    });
}

function formatTaskList(tasks, maxItems = 10) {
    if (tasks.length === 0) return '_None_';

    const lines = tasks.slice(0, maxItems).map(task => {
        const desc = task.description || task.repo || 'Unknown task';
        const repo = task.repo ? ` (\`${task.repo}\`)` : '';
        return `  - ${desc}${repo}`;
    });

    if (tasks.length > maxItems) {
        lines.push(`  _...and ${tasks.length - maxItems} more_`);
    }

    return lines.join('\n');
}

function buildDigestMessage(recentTasks, activeTasks) {
    const completed = recentTasks.filter(t => t.status === 'completed');
    const failed = recentTasks.filter(t => t.status === 'failed');
    const pending = activeTasks.filter(t => t.status === 'active' || t.status === 'pending');

    // If no activity at all, send quiet message
    if (recentTasks.length === 0 && pending.length === 0) {
        return 'All quiet. No tasks ran yesterday.';
    }

    const sections = [];
    sections.push(':sunrise: *Morning Digest*\n');

    // Completed tasks
    if (completed.length > 0) {
        sections.push(`:white_check_mark: *Completed Tasks* (${completed.length})`);
        sections.push(formatTaskList(completed));
        sections.push('');
    }

    // Failed tasks
    if (failed.length > 0) {
        sections.push(`:x: *Failed Tasks* (${failed.length})`);
        sections.push(formatTaskList(failed));
        sections.push('');
    }

    // Still pending/active
    if (pending.length > 0) {
        sections.push(`:hourglass_flowing_sand: *Still Pending* (${pending.length})`);
        sections.push(formatTaskList(pending));
        sections.push('');
    }

    // Summary line
    if (recentTasks.length > 0) {
        const successRate = completed.length > 0
            ? Math.round((completed.length / recentTasks.length) * 100)
            : 0;
        sections.push(`_${recentTasks.length} tasks processed, ${successRate}% success rate_`);
    }

    return sections.join('\n');
}

// ---- Main ----

async function main() {
    try {
        // Load context to get slack_user_id
        const context = memory.getContext();
        const slackUserId = context.slack_user_id;

        if (!slackUserId) {
            console.error('[morning-digest] No slack_user_id found in memory/context.json');
            process.exit(1);
        }

        // Load task data
        const HISTORY_FILE = path.join(__dirname, 'memory', 'history.json');
        const TASKS_FILE = path.join(__dirname, 'memory', 'tasks.json');
        const history = memory.loadMemory(HISTORY_FILE);
        const activeTasks = memory.loadMemory(TASKS_FILE);

        // Filter to last 24 hours
        const recentTasks = getTasksLast24Hours(history);

        // Build message
        const message = buildDigestMessage(recentTasks, activeTasks);

        // Send DM to user (use slack_user_id as channel_id)
        await slack.chat.postMessage({
            channel: slackUserId,
            text: message,
            unfurl_links: false,
        });

        console.log(`[morning-digest] Sent digest to ${slackUserId}`);
        console.log(`  Completed: ${recentTasks.filter(t => t.status === 'completed').length}`);
        console.log(`  Failed: ${recentTasks.filter(t => t.status === 'failed').length}`);
        console.log(`  Pending: ${activeTasks.filter(t => t.status === 'active').length}`);

    } catch (err) {
        console.error('[morning-digest] Error:', err.message);
        process.exit(1);
    }
}

main();
