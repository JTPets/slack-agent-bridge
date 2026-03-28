#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so PM2 restarts retain env vars
require('dotenv').config();

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
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getAllTodayEvents, getAllYesterdayEvents } = require('./lib/integrations/google-calendar');
const { getTodaySpecialDates } = require('./lib/integrations/holidays');
// LOGIC CHANGE 2026-03-27: Added staff-tasks integration for morning digest summary
const staffTasks = require('./lib/staff-tasks');
// LOGIC CHANGE 2026-03-28: Added bulletin board integration for milestone posting
const bulletinBoard = require('./lib/bulletin-board');
// LOGIC CHANGE 2026-03-28: Added Gmail and email categorizer integration for email summary
const gmail = require('./lib/integrations/gmail');
const emailCategorizer = require('./lib/integrations/email-categorizer');

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

// ---- Weather helpers ----

// LOGIC CHANGE 2026-03-26: Added weather section to morning digest using Open-Meteo API
const WEATHER_API_URL = 'https://api.open-meteo.com/v1/forecast?latitude=43.2557&longitude=-79.8711&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode&timezone=America/Toronto&forecast_days=1';

/**
 * Decode WMO weather code to human-readable text
 * @param {number} code - WMO weather code
 * @returns {string} - Human-readable weather condition
 */
function decodeWeatherCode(code) {
    if (code === 0) return 'Clear';
    if (code >= 1 && code <= 3) return 'Partly cloudy';
    if (code >= 45 && code <= 48) return 'Fog';
    if (code >= 51 && code <= 55) return 'Drizzle';
    if (code >= 61 && code <= 65) return 'Rain';
    if (code >= 71 && code <= 75) return 'Snow';
    if (code >= 80 && code <= 82) return 'Showers';
    if (code === 95) return 'Thunderstorm';
    return 'Unknown';
}

/**
 * Fetch weather data from Open-Meteo API
 * @returns {Promise<{high: number, low: number, precipChance: number, conditions: string}|null>}
 */
function fetchWeather() {
    return new Promise((resolve) => {
        https.get(WEATHER_API_URL, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const daily = json.daily;
                    if (!daily) {
                        console.error('[morning-digest] Weather API returned no daily data');
                        resolve(null);
                        return;
                    }
                    resolve({
                        high: Math.round(daily.temperature_2m_max[0]),
                        low: Math.round(daily.temperature_2m_min[0]),
                        precipChance: daily.precipitation_probability_max[0],
                        conditions: decodeWeatherCode(daily.weathercode[0]),
                    });
                } catch (err) {
                    console.error('[morning-digest] Failed to parse weather data:', err.message);
                    resolve(null);
                }
            });
        }).on('error', (err) => {
            console.error('[morning-digest] Weather fetch failed:', err.message);
            resolve(null);
        });
    });
}

// ---- Calendar helpers ----

// LOGIC CHANGE 2026-03-26: Added calendar integration to morning digest.
// Fetches today's and yesterday's events from Google Calendar.

/**
 * Format a calendar event time for display.
 * @param {string} isoString - ISO date/time string
 * @returns {string} - Formatted time (e.g., "9:00 AM" or "All day")
 */
function formatEventTime(isoString) {
    if (!isoString) return '';
    // All-day events come as date only (YYYY-MM-DD)
    if (isoString.length === 10) {
        return 'All day';
    }
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Toronto',
    });
}

/**
 * Format a calendar event for display in the digest.
 * @param {Object} event - Calendar event object
 * @returns {string} - Formatted event string
 */
function formatEvent(event) {
    const time = formatEventTime(event.start);
    const timeStr = time ? `${time}: ` : '';
    return `${timeStr}${event.title}`;
}

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

// LOGIC CHANGE 2026-03-27: Added categorizeFailures() to intelligently classify
// failures into actionable categories instead of just listing them.
/**
 * Categorize failed tasks into actionable groups
 * @param {Array} failedTasks - Array of failed task objects from history
 * @returns {{rateLimit: Array, tempDir: Array, maxTurns: Array, codeFailures: Array}}
 */
function categorizeFailures(failedTasks) {
    const categories = {
        rateLimit: [],
        tempDir: [],
        maxTurns: [],
        codeFailures: [],
    };

    for (const task of failedTasks) {
        const error = (task.error || '').toLowerCase();

        // Rate limit / bandwidth exhaustion - these auto-retry when capacity returns
        if (
            error.includes('rate_limit') ||
            error.includes('rate limit') ||
            error.includes('bandwidth') ||
            error.includes('429') ||
            error.includes('too many requests')
        ) {
            categories.rateLimit.push(task);
            continue;
        }

        // Clone / temp directory issues - infrastructure failures
        if (
            error.includes('clone') ||
            error.includes('temp') ||
            error.includes('enoent') ||
            error.includes('eacces') ||
            error.includes('permission denied') ||
            error.includes('no space') ||
            error.includes('disk full') ||
            error.includes('mkdir')
        ) {
            categories.tempDir.push(task);
            continue;
        }

        // Max turns exceeded - check outcome field for retry info
        // Note: if task.outcome.retried exists, it was already auto-retried
        if (
            error.includes('max turns') ||
            error.includes('max_turns') ||
            (task.outcome && task.outcome.partial)
        ) {
            categories.maxTurns.push(task);
            continue;
        }

        // All other failures are real code/logic failures that need review
        categories.codeFailures.push(task);
    }

    return categories;
}

function isWithinLast24Hours(isoTimestamp) {
    if (!isoTimestamp) return false;
    const timestamp = new Date(isoTimestamp).getTime();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    return timestamp >= twentyFourHoursAgo;
}

async function buildDigest() {
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

    // LOGIC CHANGE 2026-03-27: Added holiday and pet awareness day section to morning digest
    try {
        const specialDates = await getTodaySpecialDates();

        // Show statutory holiday first
        if (specialDates.holiday) {
            lines.push(`*Today:* ${specialDates.holiday.name} (Ontario statutory holiday)`);
            lines.push('');
        }

        // Show pet awareness dates
        if (specialDates.petAwareness.length > 0) {
            for (const awareness of specialDates.petAwareness) {
                if (awareness.type === 'pet_awareness') {
                    // Specific date (e.g., National Pet Day)
                    lines.push(`*Today:* ${awareness.name} - ${awareness.socialTip}`);
                } else if (awareness.type === 'pet_awareness_month') {
                    // Monthly observance
                    lines.push(`*This month:* ${awareness.name} - ${awareness.socialTip}`);
                }
            }
            lines.push('');
        }
    } catch (err) {
        console.error('[morning-digest] Holiday section skipped:', err.message);
    }

    // Fetch weather (skip section if fetch fails)
    try {
        const weather = await fetchWeather();
        if (weather) {
            lines.push('*Weather today in Hamilton:*');
            lines.push(`High: ${weather.high}°C / Low: ${weather.low}°C`);
            lines.push(`Precipitation chance: ${weather.precipChance}%`);
            lines.push(`Conditions: ${weather.conditions}`);
            lines.push('');
        }
    } catch (err) {
        console.error('[morning-digest] Weather section skipped:', err.message);
    }

    // Calendar section - today's events
    try {
        const todayEvents = await getAllTodayEvents();
        if (todayEvents.length > 0) {
            lines.push('*Today\'s calendar:*');
            for (const event of todayEvents) {
                lines.push(`  - ${formatEvent(event)}`);
            }
            lines.push('');
        }
    } catch (err) {
        console.error('[morning-digest] Calendar section skipped:', err.message);
    }

    // Calendar section - yesterday's events
    try {
        const yesterdayEvents = await getAllYesterdayEvents();
        if (yesterdayEvents.length > 0) {
            lines.push('*Yesterday\'s events:*');
            for (const event of yesterdayEvents) {
                lines.push(`  - ${formatEvent(event)}`);
            }
            lines.push('');
        }
    } catch (err) {
        console.error('[morning-digest] Yesterday calendar section skipped:', err.message);
    }

    // LOGIC CHANGE 2026-03-27: Added staff task summary section
    try {
        const staffSummary = staffTasks.formatDigestSummary();
        if (staffSummary) {
            lines.push(staffSummary);
            lines.push('');
        }
    } catch (err) {
        console.error('[morning-digest] Staff tasks section skipped:', err.message);
    }

    // LOGIC CHANGE 2026-03-28: Added email summary section to morning digest.
    // Fetches emails from last 24 hours, categorizes them, and shows summary.
    try {
        if (gmail.hasCredentials()) {
            const twentyFourHoursAgo = new Date(Date.now() - (24 * 60 * 60 * 1000));
            const recentEmails = await gmail.getRecentEmails(twentyFourHoursAgo, 100);

            if (recentEmails.length > 0) {
                const summary = emailCategorizer.categorizeEmails(recentEmails);
                const summaryText = emailCategorizer.formatSummary(summary);
                lines.push(`*${summaryText}*`);
                lines.push('');
            }
        }
    } catch (err) {
        console.error('[morning-digest] Email section skipped:', err.message);
    }

    lines.push('*Agent task summary:*');
    lines.push(`• ${completedLast24h.length} task${completedLast24h.length !== 1 ? 's' : ''} completed yesterday`);
    lines.push(`• ${failedLast24h.length} task${failedLast24h.length !== 1 ? 's' : ''} failed`);
    lines.push(`• ${activeTasks.length} task${activeTasks.length !== 1 ? 's' : ''} still active`);

    // LOGIC CHANGE 2026-03-27: Categorize failures intelligently instead of just listing them.
    // Categories: rate limit/bandwidth (auto-retry), temp dir issues (auto-requeue),
    // max turns exceeded (already auto-retried), real code failures (need review).
    const categorizedFailures = categorizeFailures(failedLast24h);
    let actionNeededCount = 0;
    let autoHandlingCount = 0;

    // Rate limit / bandwidth failures - auto-retry when capacity returns
    if (categorizedFailures.rateLimit.length > 0) {
        lines.push('');
        lines.push(`*Rate limit / bandwidth:* ${categorizedFailures.rateLimit.length} task${categorizedFailures.rateLimit.length !== 1 ? 's' : ''} paused due to rate limits. They will auto-retry.`);
        autoHandlingCount += categorizedFailures.rateLimit.length;
    }

    // Clone/temp dir failures - auto-requeue
    if (categorizedFailures.tempDir.length > 0) {
        lines.push('');
        lines.push(`*Temp directory issues:* ${categorizedFailures.tempDir.length} task${categorizedFailures.tempDir.length !== 1 ? 's' : ''} failed due to temp directory issues. Auto-requeued.`);
        autoHandlingCount += categorizedFailures.tempDir.length;
    }

    // Max turns exceeded - already auto-retried
    if (categorizedFailures.maxTurns.length > 0) {
        lines.push('');
        lines.push(`*Max turns exceeded:* ${categorizedFailures.maxTurns.length} task${categorizedFailures.maxTurns.length !== 1 ? 's' : ''} hit max turns and ${categorizedFailures.maxTurns.length !== 1 ? 'were' : 'was'} auto-retried.`);
        autoHandlingCount += categorizedFailures.maxTurns.length;
    }

    // Real code failures - need review
    if (categorizedFailures.codeFailures.length > 0) {
        lines.push('');
        lines.push(`*Failed with errors - review needed:*`);
        for (const task of categorizedFailures.codeFailures) {
            const desc = task.description || 'No description';
            const error = task.error ? ` - ${task.error.slice(0, 100)}` : '';
            lines.push(`  - ${desc}${error}`);
        }
        actionNeededCount += categorizedFailures.codeFailures.length;
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

    // LOGIC CHANGE 2026-03-27: Add action summary at the end of digest.
    // Shows count of items needing owner attention vs auto-handled items.
    lines.push('');
    lines.push('---');
    if (actionNeededCount > 0 || autoHandlingCount > 0) {
        lines.push(`*Action needed from you:* ${actionNeededCount} item${actionNeededCount !== 1 ? 's' : ''}`);
        lines.push(`*Auto-handling:* ${autoHandlingCount} item${autoHandlingCount !== 1 ? 's' : ''} (no action needed)`);
    } else if (failedLast24h.length === 0) {
        lines.push('*All clear!* No failures requiring attention.');
    }

    return lines.join('\n');
}

// ---- Main ----

async function main() {
    console.log('[morning-digest] Starting');

    try {
        const digest = await buildDigest();
        console.log('[morning-digest] Digest built, sending DM...');

        await sendDM(OWNER_USER_ID, digest);

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
                date: new Date().toISOString().split('T')[0],
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
