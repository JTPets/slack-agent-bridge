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
 */

'use strict';

// LOGIC CHANGE 2026-04-01: Default configuration with env var support.
// These defaults can be overridden via environment variables or the configure() function.
const DEFAULT_CONFIG = {
    // Maximum emails to process per window
    maxEmailsPerWindow: parseInt(process.env.EMAIL_RATE_LIMIT_EMAILS_PER_WINDOW, 10) || 50,

    // Maximum bulletins to post per window (vendor_deal posts, etc.)
    maxBulletinsPerWindow: parseInt(process.env.EMAIL_RATE_LIMIT_BULLETINS_PER_WINDOW, 10) || 10,

    // Maximum Slack messages to post per window
    maxSlackMessagesPerWindow: parseInt(process.env.EMAIL_RATE_LIMIT_SLACK_PER_WINDOW, 10) || 20,

    // Sliding window size in milliseconds (default: 5 minutes)
    windowSizeMs: parseInt(process.env.EMAIL_RATE_LIMIT_WINDOW_MS, 10) || 5 * 60 * 1000,

    // Cooldown period after hitting limit (default: 1 minute)
    cooldownMs: parseInt(process.env.EMAIL_RATE_LIMIT_COOLDOWN_MS, 10) || 60 * 1000,
};

// Sliding window state
const windowState = {
    emails: {
        timestamps: [],
        lastReset: Date.now(),
    },
    bulletins: {
        timestamps: [],
        lastReset: Date.now(),
    },
    slackMessages: {
        timestamps: [],
        lastReset: Date.now(),
    },
    // Track suppressed items for aggregation
    suppressed: {
        emails: 0,
        bulletins: [],
        slackMessages: 0,
    },
    // Cooldown state
    cooldownUntil: null,
};

// User-configurable limits (merged with defaults)
let config = { ...DEFAULT_CONFIG };

/**
 * Configure rate limiter settings.
 *
 * @param {Object} newConfig - Configuration overrides
 * @returns {Object} Current configuration
 */
function configure(newConfig = {}) {
    config = { ...DEFAULT_CONFIG, ...newConfig };
    return { ...config };
}

/**
 * Get current configuration.
 *
 * @returns {Object} Current configuration
 */
function getConfig() {
    return { ...config };
}

/**
 * Clean up old timestamps outside the sliding window.
 *
 * @param {string} bucket - Bucket name ('emails', 'bulletins', 'slackMessages')
 */
function cleanupWindow(bucket) {
    const now = Date.now();
    const cutoff = now - config.windowSizeMs;

    if (windowState[bucket]) {
        windowState[bucket].timestamps = windowState[bucket].timestamps.filter(
            ts => ts > cutoff
        );
    }
}

/**
 * Check if currently in cooldown period.
 *
 * @returns {boolean} True if in cooldown
 */
function isInCooldown() {
    if (!windowState.cooldownUntil) return false;
    if (Date.now() >= windowState.cooldownUntil) {
        windowState.cooldownUntil = null;
        return false;
    }
    return true;
}

/**
 * Start a cooldown period.
 */
function startCooldown() {
    windowState.cooldownUntil = Date.now() + config.cooldownMs;
    console.warn(`[email-rate-limiter] Cooldown started, expires at ${new Date(windowState.cooldownUntil).toISOString()}`);
}

/**
 * Check if an email can be processed (within rate limit).
 *
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canProcessEmail() {
    cleanupWindow('emails');

    if (isInCooldown()) {
        return {
            allowed: false,
            reason: 'Rate limit cooldown active',
            remaining: 0,
        };
    }

    const count = windowState.emails.timestamps.length;
    const remaining = Math.max(0, config.maxEmailsPerWindow - count);

    if (count >= config.maxEmailsPerWindow) {
        startCooldown();
        return {
            allowed: false,
            reason: `Email rate limit exceeded (${count}/${config.maxEmailsPerWindow} in window)`,
            remaining: 0,
        };
    }

    return { allowed: true, remaining };
}

/**
 * Record that an email was processed.
 */
function recordEmailProcessed() {
    windowState.emails.timestamps.push(Date.now());
}

/**
 * Record that an email was suppressed (for aggregation reporting).
 */
function recordEmailSuppressed() {
    windowState.suppressed.emails++;
}

/**
 * Check if a bulletin can be posted (within rate limit).
 *
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canPostBulletin() {
    cleanupWindow('bulletins');

    if (isInCooldown()) {
        return {
            allowed: false,
            reason: 'Rate limit cooldown active',
            remaining: 0,
        };
    }

    const count = windowState.bulletins.timestamps.length;
    const remaining = Math.max(0, config.maxBulletinsPerWindow - count);

    if (count >= config.maxBulletinsPerWindow) {
        return {
            allowed: false,
            reason: `Bulletin rate limit exceeded (${count}/${config.maxBulletinsPerWindow} in window)`,
            remaining: 0,
        };
    }

    return { allowed: true, remaining };
}

/**
 * Record that a bulletin was posted.
 */
function recordBulletinPosted() {
    windowState.bulletins.timestamps.push(Date.now());
}

/**
 * Record that a bulletin was suppressed.
 *
 * @param {Object} bulletinData - The suppressed bulletin data (for aggregation)
 */
function recordBulletinSuppressed(bulletinData) {
    windowState.suppressed.bulletins.push({
        timestamp: Date.now(),
        data: bulletinData,
    });
}

/**
 * Check if a Slack message can be posted (within rate limit).
 *
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function canPostSlackMessage() {
    cleanupWindow('slackMessages');

    if (isInCooldown()) {
        return {
            allowed: false,
            reason: 'Rate limit cooldown active',
            remaining: 0,
        };
    }

    const count = windowState.slackMessages.timestamps.length;
    const remaining = Math.max(0, config.maxSlackMessagesPerWindow - count);

    if (count >= config.maxSlackMessagesPerWindow) {
        return {
            allowed: false,
            reason: `Slack message rate limit exceeded (${count}/${config.maxSlackMessagesPerWindow} in window)`,
            remaining: 0,
        };
    }

    return { allowed: true, remaining };
}

/**
 * Record that a Slack message was posted.
 */
function recordSlackMessagePosted() {
    windowState.slackMessages.timestamps.push(Date.now());
}

/**
 * Record that a Slack message was suppressed.
 */
function recordSlackMessageSuppressed() {
    windowState.suppressed.slackMessages++;
}

/**
 * Get suppressed item counts and reset counters.
 *
 * @returns {{ emails: number, bulletins: Array, slackMessages: number }}
 */
function getSuppressedAndReset() {
    const suppressed = {
        emails: windowState.suppressed.emails,
        bulletins: [...windowState.suppressed.bulletins],
        slackMessages: windowState.suppressed.slackMessages,
    };

    // Reset counters
    windowState.suppressed.emails = 0;
    windowState.suppressed.bulletins = [];
    windowState.suppressed.slackMessages = 0;

    return suppressed;
}

/**
 * Get current rate limit status.
 *
 * @returns {Object} Rate limit status for all buckets
 */
function getStatus() {
    cleanupWindow('emails');
    cleanupWindow('bulletins');
    cleanupWindow('slackMessages');

    return {
        inCooldown: isInCooldown(),
        cooldownExpiresAt: windowState.cooldownUntil,
        emails: {
            count: windowState.emails.timestamps.length,
            max: config.maxEmailsPerWindow,
            remaining: Math.max(0, config.maxEmailsPerWindow - windowState.emails.timestamps.length),
        },
        bulletins: {
            count: windowState.bulletins.timestamps.length,
            max: config.maxBulletinsPerWindow,
            remaining: Math.max(0, config.maxBulletinsPerWindow - windowState.bulletins.timestamps.length),
        },
        slackMessages: {
            count: windowState.slackMessages.timestamps.length,
            max: config.maxSlackMessagesPerWindow,
            remaining: Math.max(0, config.maxSlackMessagesPerWindow - windowState.slackMessages.timestamps.length),
        },
        suppressed: {
            emails: windowState.suppressed.emails,
            bulletins: windowState.suppressed.bulletins.length,
            slackMessages: windowState.suppressed.slackMessages,
        },
    };
}

/**
 * Reset all rate limit state (for testing or manual recovery).
 */
function reset() {
    windowState.emails.timestamps = [];
    windowState.bulletins.timestamps = [];
    windowState.slackMessages.timestamps = [];
    windowState.suppressed.emails = 0;
    windowState.suppressed.bulletins = [];
    windowState.suppressed.slackMessages = 0;
    windowState.cooldownUntil = null;
}

/**
 * Format a summary message for suppressed items.
 *
 * @param {Object} suppressed - Suppressed item counts from getSuppressedAndReset()
 * @returns {string|null} Summary message or null if nothing was suppressed
 */
function formatSuppressedSummary(suppressed) {
    const parts = [];

    if (suppressed.emails > 0) {
        parts.push(`${suppressed.emails} email${suppressed.emails !== 1 ? 's' : ''} skipped`);
    }

    if (suppressed.bulletins.length > 0) {
        // Group bulletins by type for summary
        const byType = {};
        for (const b of suppressed.bulletins) {
            const type = b.data?.type || 'unknown';
            byType[type] = (byType[type] || 0) + 1;
        }
        const typeSummary = Object.entries(byType)
            .map(([type, count]) => `${count} ${type}`)
            .join(', ');
        parts.push(`${suppressed.bulletins.length} bulletin${suppressed.bulletins.length !== 1 ? 's' : ''} suppressed (${typeSummary})`);
    }

    if (suppressed.slackMessages > 0) {
        parts.push(`${suppressed.slackMessages} notification${suppressed.slackMessages !== 1 ? 's' : ''} batched`);
    }

    if (parts.length === 0) {
        return null;
    }

    return `:warning: *Rate limit summary:* ${parts.join(', ')}. This protects Slack from email flood attacks.`;
}

module.exports = {
    // Configuration
    configure,
    getConfig,

    // Email rate limiting
    canProcessEmail,
    recordEmailProcessed,
    recordEmailSuppressed,

    // Bulletin rate limiting
    canPostBulletin,
    recordBulletinPosted,
    recordBulletinSuppressed,

    // Slack message rate limiting
    canPostSlackMessage,
    recordSlackMessagePosted,
    recordSlackMessageSuppressed,

    // Status and aggregation
    getStatus,
    getSuppressedAndReset,
    formatSuppressedSummary,

    // Utility
    reset,
    isInCooldown,

    // Exported for testing
    DEFAULT_CONFIG,
};
