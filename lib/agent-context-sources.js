/**
 * lib/agent-context-sources.js
 *
 * What every agent context builder reads from, and the rule they all carry: the three
 * data sources loaded in degraded mode (a missing credential or a broken module leaves
 * a minimal stand-in rather than killing every ASK handler), the anti-hallucination
 * instruction, and calendar-event formatting.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of lib/agent-context.js,
 * which re-exports ANTI_HALLUCINATION_RULE and formatEventsForPrompt. The degraded-mode
 * requires live here only, so the builders in agent-context-ops.js and
 * agent-context-voices.js share one fallback instead of each carrying a copy.
 */

'use strict';

// LOGIC CHANGE 2026-03-30: Wrap all three requires in try/catch so a missing
// credential file or broken module at startup cannot kill all ASK handlers.
// Each fallback provides the minimum API shape the context builders need.
let googleCalendar = { getAllTodayEvents: async () => [], getAllTomorrowEvents: async () => [] };
let ownerTasks = { getPendingTasks: () => [] };
let bulletinBoard = { getBulletins: () => [], formatBulletinsForContext: () => '' };

try {
    googleCalendar = require('./integrations/google-calendar');
} catch (err) {
    console.error('[agent-context] Failed to load google-calendar (degraded mode):', err.message);
}
try {
    ownerTasks = require('./owner-tasks');
} catch (err) {
    console.error('[agent-context] Failed to load owner-tasks (degraded mode):', err.message);
}
try {
    bulletinBoard = require('./bulletin-board');
} catch (err) {
    console.error('[agent-context] Failed to load bulletin-board (degraded mode):', err.message);
}

// Anti-hallucination instruction added to ALL agent prompts
const ANTI_HALLUCINATION_RULE = `
IMPORTANT: Only reference real data provided below. If you don't have information about something, say "I don't have access to that yet" instead of making something up. NEVER invent meetings, people, events, emails, or data.
`.trim();


/**
 * Format calendar events as plain text for prompt injection.
 *
 * @param {Array} events - Array of calendar events
 * @returns {string} Formatted event list or empty message
 */
function formatEventsForPrompt(events) {
    if (!events || events.length === 0) {
        return 'No events scheduled.';
    }

    return events.map(event => {
        // Parse start time for display
        let timeStr = 'All day';
        if (event.start && event.start.includes('T')) {
            const startDate = new Date(event.start);
            timeStr = startDate.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: 'America/Toronto',
            });
        }

        return `- ${timeStr}: ${event.title}`;
    }).join('\n');
}

module.exports = {
    googleCalendar,
    ownerTasks,
    bulletinBoard,
    ANTI_HALLUCINATION_RULE,
    formatEventsForPrompt,
};
