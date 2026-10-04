/**
 * lib/email-check-report.js
 *
 * What a successful inbox check says in Slack, and whether it says anything.
 *
 * LOGIC CHANGE 2026-10-02: Created, split out of lib/email-check.js. Every
 * scheduled check used to post an "Inbox check OK" line - 26 posts a day on the
 * `*\/30 9-21 * * *` schedule, almost all of them saying nothing happened. The
 * owner called it spam, and a channel nobody reads is where a real flag gets
 * missed. A routine check now posts only when there is something to act on.
 *
 * Silence must not hide a broken check, so three things still post:
 *   - a FAILED check escalates exactly as before (lib/email-check.js escalate());
 *   - the first successful check of each Toronto day posts a one-line heartbeat,
 *     so a job that has stopped running shows up as a missing morning line;
 *   - a gap of more than GAP_ALERT_MS since the previous successful check on the
 *     same day says so, so a job that stalled and came back is not invisible.
 * An on-demand check (the `check-inbox` verb) always posts: someone asked.
 */

'use strict';

const { dayKey, STORE_TIME_ZONE } = require('./time-format');

// Longer than three missed half-hour ticks of the declared schedule
// (agents/email-monitor/agent.md, `*/30 9-21 * * *`). A gap only counts within
// one Toronto day: the 21:00 -> 09:00 overnight gap is the schedule, not a fault.
const GAP_ALERT_MS = 90 * 60 * 1000;

// Why a check posted. A check with no reason posts nothing.
const POST_REASON = {
    ON_DEMAND: 'on_demand',
    FLAGGED: 'flagged',
    PARTIAL: 'partial',
    RATE_LIMITED: 'rate_limited',
    GAP: 'gap',
    DAILY_HEARTBEAT: 'daily_heartbeat',
};

/**
 * The Toronto calendar day of `date` as YYYY-MM-DD. There is no canonical
 * zone-aware day key yet (docs/CANONICAL-HELPERS.md section 6 records the UTC
 * one in lib/llm-metrics.js and why it is wrong for a store day).
 *
 * @param {Date} date
 * @returns {string}
 */
// LOGIC CHANGE 2026-10-04 (WORK-TODO #33): delegates to lib/time-format.js dayKey, the
// canonical zone-taking day key; same YYYY-MM-DD output. Kept as a named export because
// lib/email-check.js and its suite call it.
function torontoDay(date) {
    return dayKey(date, STORE_TIME_ZONE);
}

/**
 * Decide whether a successful check posts, and why.
 *
 * @param {Object} input
 * @param {Object} input.summary - categorizeEmails() result
 * @param {string|null} input.partial - Partial-fetch error, or null
 * @param {boolean} input.onDemand - True when a person ran the check
 * @param {Date} input.now - Time of this check
 * @param {string|null} input.lastSuccessfulCheckAt - Previous successful check (ISO), or null
 * @param {string|null} input.lastHeartbeatDay - Toronto day the heartbeat last posted, or null
 * @returns {{ post: boolean, reasons: string[], gapMs: number|null }}
 */
function decidePost({ summary, partial, onDemand, now, lastSuccessfulCheckAt, lastHeartbeatDay }) {
    const reasons = [];
    if (onDemand) reasons.push(POST_REASON.ON_DEMAND);
    if (summary.flagged.length > 0) reasons.push(POST_REASON.FLAGGED);
    if (partial) reasons.push(POST_REASON.PARTIAL);
    if (summary.rateLimited > 0) reasons.push(POST_REASON.RATE_LIMITED);

    let gapMs = null;
    if (lastSuccessfulCheckAt) {
        const last = new Date(lastSuccessfulCheckAt);
        const elapsed = now.getTime() - last.getTime();
        if (elapsed > GAP_ALERT_MS && torontoDay(last) === torontoDay(now)) {
            gapMs = elapsed;
            reasons.push(POST_REASON.GAP);
        }
    }

    if (lastHeartbeatDay !== torontoDay(now)) reasons.push(POST_REASON.DAILY_HEARTBEAT);

    return { post: reasons.length > 0, reasons, gapMs };
}

/**
 * Render a duration as "2h 5m" / "45m".
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    const minutes = Math.round(ms / 60000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Format a successful check for Slack. The zero case says "0 new messages"
 * explicitly and names the window; it must never be mistakable for a failure,
 * which is why this is only ever called on a successful check.
 *
 * @param {{ since: Date, summary: Object, partial: string|null, reasons?: string[], gapMs?: number|null }} verdict
 * @param {Object} [categorizer] - Module exposing formatSummary (default: the real categorizer)
 * @returns {string} Slack message text
 */
function formatOkMessage({ since, summary, partial, reasons = [], gapMs = null }, categorizer = require('./integrations/email-categorizer')) {
    const window = since.toLocaleString('en-US', {
        timeZone: 'America/Toronto',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });

    const lines = [];
    if (summary.total === 0) {
        lines.push(`:inbox_tray: *Inbox check OK* - 0 new messages since ${window}.`);
    } else {
        lines.push(`:inbox_tray: *Inbox check OK* - ${categorizer.formatSummary(summary)}`);
        lines.push(`Window: since ${window}. Filtered by \`agents/email-monitor/memory/rules.json\`.`);

        for (const item of summary.flagged.slice(0, 5)) {
            // Subject and sender are already sanitized by gmail.transformEmail.
            lines.push(`  • [${item.category}/${item.priority}] ${item.email.subject || '(no subject)'} - ${item.email.from || '(unknown sender)'}`);
        }
        if (summary.flagged.length > 5) {
            lines.push(`  • (${summary.flagged.length - 5} more flagged)`);
        }
    }

    if (partial) {
        lines.push(`:warning: Partial fetch: ${partial}`);
    }
    if (gapMs !== null) {
        lines.push(`:warning: No successful inbox check for ${formatDuration(gapMs)} before this one (scheduled every 30 minutes).`);
    }
    if (reasons.includes(POST_REASON.DAILY_HEARTBEAT) && !reasons.includes(POST_REASON.ON_DEMAND)) {
        lines.push('_First check today. Routine checks stay quiet unless something is flagged; a check that breaks is still reported._');
    }

    return lines.join('\n');
}

module.exports = {
    GAP_ALERT_MS,
    POST_REASON,
    torontoDay,
    decidePost,
    formatOkMessage,
    formatDuration,
};
