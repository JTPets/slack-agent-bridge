'use strict';

/**
 * lib/slack-channel-names.js
 *
 * Slack's channel-name rules: normalizeChannelName and validateChannelName, with their two
 * constants. Pure. Moved unchanged out of createSlackClient in lib/slack-client.js on
 * 2026-11-25 (WORK-TODO #10, B34), where they were closures that used nothing of the
 * client; re-exported by it.
 */

// LOGIC CHANGE 2026-03-26: Channel name validation constants.
// Slack channel names must be lowercase, no spaces, max 80 chars.
const CHANNEL_NAME_MAX_LENGTH = 80;
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * Normalize a channel name to meet Slack requirements.
 * - Lowercase
 * - Replace spaces with hyphens
 * - Remove leading # if present
 * - Remove invalid characters
 * - Truncate to 80 chars
 *
 * @param {string} name - Raw channel name
 * @returns {string} Normalized channel name
 */
function normalizeChannelName(name) {
    if (!name) return '';
    let normalized = name.toLowerCase().trim();
    // Remove leading # if present
    normalized = normalized.replace(/^#/, '');
    // Replace spaces with hyphens
    normalized = normalized.replace(/\s+/g, '-');
    // Remove invalid characters (keep only lowercase letters, numbers, hyphens, underscores)
    normalized = normalized.replace(/[^a-z0-9-_]/g, '');
    // Ensure it starts with alphanumeric
    normalized = normalized.replace(/^[^a-z0-9]+/, '');
    // Truncate to max length
    normalized = normalized.slice(0, CHANNEL_NAME_MAX_LENGTH);
    return normalized;
}

/**
 * Validate a channel name meets Slack requirements.
 * @param {string} name - Channel name to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateChannelName(name) {
    if (!name) {
        return { valid: false, error: 'Channel name is required' };
    }
    if (name.length > CHANNEL_NAME_MAX_LENGTH) {
        return { valid: false, error: `Channel name must be ${CHANNEL_NAME_MAX_LENGTH} characters or less` };
    }
    if (!CHANNEL_NAME_PATTERN.test(name)) {
        return { valid: false, error: 'Channel name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores' };
    }
    return { valid: true };
}

module.exports = {
    normalizeChannelName,
    validateChannelName,
    CHANNEL_NAME_MAX_LENGTH,
    CHANNEL_NAME_PATTERN,
};
