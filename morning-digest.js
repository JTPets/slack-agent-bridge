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
const https = require('https');
const fs = require('fs');
const path = require('path');
const { getAllTodayEvents, getAllYesterdayEvents } = require('./lib/integrations/google-calendar');

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

    lines.push('*Task summary:*');
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
        const digest = await buildDigest();
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
