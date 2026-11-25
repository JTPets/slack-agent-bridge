/**
 * lib/email-rate-limiter.js
 *
 * Rate-limiting for email-to-Slack pipeline to prevent flood attacks.
 * Uses a sliding window approach with configurable limits.
 *
 * LOGIC CHANGE 2026-04-01: Initial implementation to prevent flood attacks.
 * When large volumes of emails arrive (spam, attack, or legitimate burst),
 * this module prevents overwhelming Slack with notifications by:
 * 1. Limiting emails processed per window
 * 2. Limiting bulletins/notifications posted per window
 * 3. Aggregating excess notifications into summary messages
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): the hub. The window and cooldown are
 * lib/email-rate-window.js (one checkBucket for all three buckets, where there were
 * three copies); what was held back and its summary line are
 * lib/email-rate-suppressed.js. This file keeps the per-bucket names every caller uses,
 * each a one-line call into the window, and composes getStatus() and reset() from both.
 * Every name it exported is still exported (tests/module-splits.test.js).
 */

'use strict';

const rateWindow = require('./email-rate-window');
const suppressed = require('./email-rate-suppressed');

/**
 * Check if an email can be processed (within rate limit). Exceeding it starts the cooldown.
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canProcessEmail() {
    return rateWindow.checkBucket('emails');
}

/** Record that an email was processed. */
function recordEmailProcessed() {
    rateWindow.recordIn('emails');
}

/**
 * Check if a bulletin can be posted (within rate limit).
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canPostBulletin() {
    return rateWindow.checkBucket('bulletins');
}

/** Record that a bulletin was posted. */
function recordBulletinPosted() {
    rateWindow.recordIn('bulletins');
}

/**
 * Check if a Slack message can be posted (within rate limit).
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canPostSlackMessage() {
    return rateWindow.checkBucket('slackMessages');
}

/** Record that a Slack message was posted. */
function recordSlackMessagePosted() {
    rateWindow.recordIn('slackMessages');
}

/**
 * Get current rate limit status.
 *
 * @returns {Object} Rate limit status for all buckets
 */
function getStatus() {
    return { ...rateWindow.windowStatus(), suppressed: suppressed.suppressedCounts() };
}

/**
 * Reset all rate limit state (for testing or manual recovery).
 */
function reset() {
    rateWindow.resetWindow();
    suppressed.resetSuppressed();
}

module.exports = {
    // Configuration
    configure: rateWindow.configure,
    getConfig: rateWindow.getConfig,

    // Email rate limiting
    canProcessEmail,
    recordEmailProcessed,
    recordEmailSuppressed: suppressed.recordEmailSuppressed,

    // Bulletin rate limiting
    canPostBulletin,
    recordBulletinPosted,
    recordBulletinSuppressed: suppressed.recordBulletinSuppressed,

    // Slack message rate limiting
    canPostSlackMessage,
    recordSlackMessagePosted,
    recordSlackMessageSuppressed: suppressed.recordSlackMessageSuppressed,

    // Status and aggregation
    getStatus,
    getSuppressedAndReset: suppressed.getSuppressedAndReset,
    formatSuppressedSummary: suppressed.formatSuppressedSummary,

    // Utility
    reset,
    isInCooldown: rateWindow.isInCooldown,

    // Exported for testing
    DEFAULT_CONFIG: rateWindow.DEFAULT_CONFIG,
};
