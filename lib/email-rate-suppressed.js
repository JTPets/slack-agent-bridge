/**
 * lib/email-rate-suppressed.js
 *
 * What the email rate limiter held back: a count of skipped emails and batched Slack
 * notifications, and the suppressed bulletins themselves (so the summary can name their
 * types), plus the one summary line that reports them.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved unchanged out of
 * lib/email-rate-limiter.js, which re-exports it. Aggregation is a separate concern from
 * the window that decides what is suppressed (lib/email-rate-window.js).
 */

'use strict';

const suppressed = {
    emails: 0,
    bulletins: [],
    slackMessages: 0,
};

/**
 * Record that an email was suppressed (for aggregation reporting).
 */
function recordEmailSuppressed() {
    suppressed.emails++;
}

/**
 * Record that a bulletin was suppressed.
 *
 * @param {Object} bulletinData - The suppressed bulletin data (for aggregation)
 */
function recordBulletinSuppressed(bulletinData) {
    suppressed.bulletins.push({
        timestamp: Date.now(),
        data: bulletinData,
    });
}

/**
 * Record that a Slack message was suppressed.
 */
function recordSlackMessageSuppressed() {
    suppressed.slackMessages++;
}

/**
 * Get suppressed item counts and reset counters.
 *
 * @returns {{ emails: number, bulletins: Array, slackMessages: number }}
 */
function getSuppressedAndReset() {
    const taken = {
        emails: suppressed.emails,
        bulletins: [...suppressed.bulletins],
        slackMessages: suppressed.slackMessages,
    };
    resetSuppressed();
    return taken;
}

/**
 * The counts only, for getStatus().
 *
 * @returns {{ emails: number, bulletins: number, slackMessages: number }}
 */
function suppressedCounts() {
    return {
        emails: suppressed.emails,
        bulletins: suppressed.bulletins.length,
        slackMessages: suppressed.slackMessages,
    };
}

/**
 * Forget everything held back.
 */
function resetSuppressed() {
    suppressed.emails = 0;
    suppressed.bulletins = [];
    suppressed.slackMessages = 0;
}

/**
 * Format a summary message for suppressed items.
 *
 * @param {Object} taken - Suppressed item counts from getSuppressedAndReset()
 * @returns {string|null} Summary message or null if nothing was suppressed
 */
function formatSuppressedSummary(taken) {
    const parts = [];

    if (taken.emails > 0) {
        parts.push(`${taken.emails} email${taken.emails !== 1 ? 's' : ''} skipped`);
    }

    if (taken.bulletins.length > 0) {
        // Group bulletins by type for summary
        const byType = {};
        for (const b of taken.bulletins) {
            const type = b.data?.type || 'unknown';
            byType[type] = (byType[type] || 0) + 1;
        }
        const typeSummary = Object.entries(byType)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');
        parts.push(`${taken.bulletins.length} bulletin${taken.bulletins.length !== 1 ? 's' : ''} suppressed (${typeSummary})`);
    }

    if (taken.slackMessages > 0) {
        parts.push(`${taken.slackMessages} notification${taken.slackMessages !== 1 ? 's' : ''} batched`);
    }

    if (parts.length === 0) {
        return null;
    }

    return `:warning: *Rate limit summary:* ${parts.join(', ')}. This protects Slack from email flood attacks.`;
}

module.exports = {
    recordEmailSuppressed,
    recordBulletinSuppressed,
    recordSlackMessageSuppressed,
    getSuppressedAndReset,
    suppressedCounts,
    resetSuppressed,
    formatSuppressedSummary,
};
