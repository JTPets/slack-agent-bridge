/**
 * lib/email-rate-window.js
 *
 * The sliding-window limiter behind lib/email-rate-limiter.js: the configuration, one
 * window of timestamps per bucket (emails, bulletins, Slack messages), and the shared
 * cooldown.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved out of lib/email-rate-limiter.js,
 * and the three copies of "clean the window, refuse in cooldown, refuse at the limit"
 * (one per bucket) are now ONE function, checkBucket, driven by the BUCKETS table. The
 * behaviour is unchanged, including the one difference between buckets: only the email
 * bucket starts the cooldown when it is exceeded (`cooldownOnExceed`). Reason strings
 * are generated from the table's labels and read exactly as before.
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

/**
 * THE buckets. `maxKey` names the config limit; `label` starts the refusal reason;
 * `cooldownOnExceed` says whether exceeding this bucket starts the shared cooldown
 * (the email bucket only, as before the split).
 */
const BUCKETS = Object.freeze({
    emails: { maxKey: 'maxEmailsPerWindow', label: 'Email', cooldownOnExceed: true },
    bulletins: { maxKey: 'maxBulletinsPerWindow', label: 'Bulletin', cooldownOnExceed: false },
    slackMessages: { maxKey: 'maxSlackMessagesPerWindow', label: 'Slack message', cooldownOnExceed: false },
});

// Sliding window state: one timestamp list per bucket, and the shared cooldown.
const timestamps = { emails: [], bulletins: [], slackMessages: [] };
let cooldownUntil = null;

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
 * Drop timestamps that have left the sliding window.
 *
 * @param {string} bucket - A BUCKETS key
 */
function cleanupWindow(bucket) {
    const cutoff = Date.now() - config.windowSizeMs;
    timestamps[bucket] = timestamps[bucket].filter(ts => ts > cutoff);
}

/**
 * Check if currently in cooldown period.
 *
 * @returns {boolean} True if in cooldown
 */
function isInCooldown() {
    if (!cooldownUntil) return false;
    if (Date.now() >= cooldownUntil) {
        cooldownUntil = null;
        return false;
    }
    return true;
}

/**
 * Start a cooldown period.
 */
function startCooldown() {
    cooldownUntil = Date.now() + config.cooldownMs;
    console.warn(`[email-rate-limiter] Cooldown started, expires at ${new Date(cooldownUntil).toISOString()}`);
}

/**
 * May one more item go through this bucket now?
 *
 * @param {string} bucket - A BUCKETS key
 * @returns {{ allowed: boolean, reason?: string, remaining: number }}
 */
function checkBucket(bucket) {
    const spec = BUCKETS[bucket];
    cleanupWindow(bucket);

    if (isInCooldown()) {
        return { allowed: false, reason: 'Rate limit cooldown active', remaining: 0 };
    }

    const max = config[spec.maxKey];
    const count = timestamps[bucket].length;
    if (count >= max) {
        if (spec.cooldownOnExceed) startCooldown();
        return {
            allowed: false,
            reason: `${spec.label} rate limit exceeded (${count}/${max} in window)`,
            remaining: 0,
        };
    }
    return { allowed: true, remaining: Math.max(0, max - count) };
}

/**
 * Record one item that went through this bucket.
 *
 * @param {string} bucket - A BUCKETS key
 */
function recordIn(bucket) {
    timestamps[bucket].push(Date.now());
}

/**
 * The cooldown and every bucket's count, limit and headroom, after cleaning each window.
 *
 * @returns {{ inCooldown: boolean, cooldownExpiresAt: number|null,
 *             emails: object, bulletins: object, slackMessages: object }}
 */
function windowStatus() {
    const status = {};
    for (const bucket of Object.keys(BUCKETS)) cleanupWindow(bucket);
    status.inCooldown = isInCooldown();
    status.cooldownExpiresAt = cooldownUntil;
    for (const [bucket, spec] of Object.entries(BUCKETS)) {
        const count = timestamps[bucket].length;
        const max = config[spec.maxKey];
        status[bucket] = { count, max, remaining: Math.max(0, max - count) };
    }
    return status;
}

/**
 * Empty every window and end the cooldown.
 */
function resetWindow() {
    for (const bucket of Object.keys(BUCKETS)) timestamps[bucket] = [];
    cooldownUntil = null;
}

module.exports = {
    DEFAULT_CONFIG,
    BUCKETS,
    configure,
    getConfig,
    isInCooldown,
    checkBucket,
    recordIn,
    windowStatus,
    resetWindow,
};
