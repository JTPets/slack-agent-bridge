'use strict';

/**
 * lib/digest-sections.js
 *
 * The morning digest's text: buildDigest() assembles every section (holidays, weather,
 * calendar, staff tasks, email, agent task summary, failures, active tasks, action
 * count), plus the small helpers it and morning-digest.js main() share.
 *
 * LOGIC CHANGE 2026-10-05: Moved out of morning-digest.js (WORK-TODO #10, wave 2), which
 * was over the 300-line limit and had no exports, so the digest text was tested by
 * nothing. The only behavioural change is that buildDigest takes its memory dir as an
 * option (default: the repo's memory/, as before) so a test can point it at fixtures.
 * tests/digest-sections.test.js pins the text and was run against the pre-split code.
 * morning-digest.js keeps the token check, the Slack client, sendDM and main().
 */

const fs = require('fs');
const path = require('path');
const { fetchWeather } = require('./integrations/weather');
const { getAllTodayEvents, getAllYesterdayEvents } = require('./integrations/google-calendar');
const { getTodaySpecialDates } = require('./integrations/holidays');
const { categorizeFailures, formatFailureSections } = require('./digest-failures');
// LOGIC CHANGE 2026-03-27: Added staff-tasks integration for morning digest summary
const staffTasks = require('./staff-tasks');
// LOGIC CHANGE 2026-03-28: Added Gmail and email categorizer integration for email summary
const gmail = require('./integrations/gmail');
const emailCategorizer = require('./integrations/email-categorizer');

const DEFAULT_MEMORY_DIR = path.join(__dirname, '..', 'memory');

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

// ---- Digest logic ----

function isWithinLast24Hours(isoTimestamp) {
    if (!isoTimestamp) return false;
    const timestamp = new Date(isoTimestamp).getTime();
    const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
    return timestamp >= twentyFourHoursAgo;
}

/**
 * Build the digest text. Every optional section is wrapped so one failing source is
 * skipped and logged, never fatal.
 *
 * @param {object} [options]
 * @param {string} [options.memoryDir] - Where history.json, tasks.json and context.json
 *   live. Defaults to the repo's memory/ dir, which is what morning-digest.js passes.
 * @returns {Promise<string>}
 */
async function buildDigest({ memoryDir = DEFAULT_MEMORY_DIR } = {}) {
    const history = loadJsonFile(path.join(memoryDir, 'history.json'), []);
    const tasks = loadJsonFile(path.join(memoryDir, 'tasks.json'), []);
    const context = loadJsonFile(path.join(memoryDir, 'context.json'), {});

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

    // LOGIC CHANGE 2026-10-04 (WORK-TODO #31): grouping and wording live in
    // lib/digest-failures.js. It no longer tells the owner that failed tasks "will
    // auto-retry" or were "Auto-requeued": nothing does either, so every failure is
    // action needed.
    const failureReport = formatFailureSections(categorizeFailures(failedLast24h));
    lines.push(...failureReport.lines);
    const actionNeededCount = failureReport.actionNeededCount;

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
    if (actionNeededCount > 0) {
        lines.push(`*Action needed from you:* ${actionNeededCount} item${actionNeededCount !== 1 ? 's' : ''}`);
    } else if (failedLast24h.length === 0) {
        lines.push('*All clear!* No failures requiring attention.');
    }

    return lines.join('\n');
}

module.exports = {
    DEFAULT_MEMORY_DIR,
    buildDigest,
    loadJsonFile,
    isWithinLast24Hours,
    formatEvent,
    formatEventTime,
};
