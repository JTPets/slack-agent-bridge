/**
 * lib/bulletin-board-format.js
 *
 * How bulletins are RENDERED: for a Slack reply (formatBulletinsForSlack), one
 * payload as a line (formatBulletinData), and the stream injected into every agent's
 * prompt (formatBulletinsForContext). Writes nothing. Moved unchanged out of
 * lib/bulletin-board.js (WORK-TODO #10, B28, 2026-11-12), which re-exports all three.
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #32): bulletin times come from the one shared helper.
const { formatTimestamp } = require('./time-format');
const { getBulletins } = require('./bulletin-board-store');

/**
 * Format bulletins for display in Slack.
 *
 * @param {Array} bulletins - Array of bulletin objects
 * @param {number} [maxItems] - Maximum items to display (default: 10)
 * @returns {string} Formatted string for Slack
 */
function formatBulletinsForSlack(bulletins, maxItems = 10) {
    if (!bulletins || bulletins.length === 0) {
        return 'No new bulletins.';
    }

    const toShow = bulletins.slice(0, maxItems);
    const lines = ['*Recent Bulletins:*', ''];

    for (const b of toShow) {
        const time = formatTimestamp(b.timestamp);

        // Type emoji
        const typeEmoji = {
            milestone: ':trophy:',
            alert: ':warning:',
            vendor_deal: ':dollar:',
            customer_insight: ':mag:',
            task_completed: ':white_check_mark:',
            security_finding: ':lock:',
            content_idea: ':bulb:',
        }[b.type] || ':memo:';

        // Format data summary
        let summary = '';
        if (b.data.description) {
            summary = b.data.description;
        } else if (b.data.title) {
            summary = b.data.title;
        } else if (b.data.message) {
            summary = b.data.message;
        } else {
            summary = JSON.stringify(b.data).slice(0, 100);
        }

        // Truncate long summaries
        if (summary.length > 80) {
            summary = summary.slice(0, 77) + '...';
        }

        lines.push(`${typeEmoji} *${b.agentId}* (${time})`);
        lines.push(`   ${summary}`);
        lines.push('');
    }

    if (bulletins.length > maxItems) {
        lines.push(`_...and ${bulletins.length - maxItems} more_`);
    }

    return lines.join('\n');
}

/**
 * Render one bulletin's `data` payload as compact `key=value` pairs.
 *
 * LOGIC CHANGE 2026-09-15: this exists because the stream did not carry enough to
 * be worth reading. Every renderer picked `description || title || message ||
 * JSON.stringify(data).slice(0,150)` — so a bulletin whose payload has none of
 * those three keys (which is every bulletin `pushToSecretary` posts: its keys are
 * `from`, `subject`, `isTrustedVendor`) was shown as a truncated JSON fragment, and
 * one with a long `description` lost everything else in the payload. An agent
 * cannot notice a supplier shortage in a string that was cut at 150 characters.
 *
 * Scalars only, deliberately: a nested object in a bulletin payload is a design
 * smell, and flattening one here would reintroduce the unbounded-length problem.
 *
 * @param {object} data - Bulletin payload.
 * @param {number} [maxValue] - Per-VALUE cap, so one long field cannot crowd out
 *                              the others. The whole payload is never truncated.
 * @returns {string}
 */
function formatBulletinData(data, maxValue = 200) {
    if (!data || typeof data !== 'object') return '';
    const parts = [];
    for (const [key, value] of Object.entries(data)) {
        if (value === null || value === undefined || value === '') continue;
        if (typeof value === 'object') {
            parts.push(`${key}=<${Array.isArray(value) ? `${value.length} items` : 'object'}>`);
            continue;
        }
        let text = String(value);
        if (text.length > maxValue) text = `${text.slice(0, maxValue - 3)}...`;
        parts.push(`${key}=${text}`);
    }
    return parts.join(' | ');
}

/**
 * Format bulletins for inclusion in agent prompt context.
 *
 * THE STREAM, as an agent sees it. Every ACTIVE agent gets this on every ASK —
 * `processConversation` injects it for whichever agent owns the channel — so this
 * is what "every agent can see what the others produce" actually consists of. It is
 * not gated on `watches`: `watches` controls being PUSHED a notification, which is
 * opt-in because it costs a Slack post and an LLM dispatch per bulletin. Seeing the
 * stream is not opt-in.
 *
 * WHAT IT CARRIES: the bulletin type, which agent posted it, when (America/Toronto,
 * named explicitly like every other date site in this repo), and every scalar field
 * of the payload with each value capped at 200 characters.
 *
 * WHAT IT DOES NOT CARRY: anything older than the newest `limit`; the bulletin id,
 * so an agent cannot refer to one or mark it read; any thread or Slack permalink
 * back to the work that produced it; and nothing at all once a bulletin ages past
 * `cleanupOldBulletins`'s 7-day retention. It is a recent-events feed, not a log.
 *
 * `unreadBy` is applied, but NOTHING IN PRODUCTION CALLS `markRead` — regenerate
 * with `grep -rn "markRead" --include=*.js . | grep -v node_modules | grep -v tests`
 * — so in practice every agent sees the newest `limit` bulletins on every ASK,
 * including ones it has already seen. That is deliberate for now: an agent that saw
 * a bulletin once has no memory of it on the next ASK, so filtering it out would
 * make the stream emptier, not cleaner.
 *
 * @param {string} agentId - ID of the agent to get bulletins for.
 * @param {number} [limit] - Maximum bulletins to include.
 * @returns {string} Formatted context string, or '' when there is nothing to say.
 */
function formatBulletinsForContext(agentId, limit = 10) {
    const unread = getBulletins({ unreadBy: agentId, limit });

    if (unread.length === 0) {
        return '';
    }

    const lines = [
        `RECENT BULLETINS FROM OTHER AGENTS (newest first, up to ${limit}, 7-day retention):`,
    ];

    for (const b of unread) {
        const when = formatTimestamp(b.timestamp);
        const payload = formatBulletinData(b.data);
        lines.push(`- [${b.type}] ${b.agentId} (${when}): ${payload || '(no payload)'}`);
    }

    lines.push('');
    return lines.join('\n');
}

module.exports = { formatBulletinsForSlack, formatBulletinData, formatBulletinsForContext };
