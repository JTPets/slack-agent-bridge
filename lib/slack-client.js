'use strict';

/**
 * lib/slack-client.js
 *
 * Slack client wrapper with channel management functions.
 * Provides utilities for creating channels, inviting bots, and managing topics.
 *
 * LOGIC CHANGE 2026-03-26: Initial implementation of Slack channel management.
 * Requires the 'channels:manage' scope for creating and managing channels.
 */

const { WebClient } = require('@slack/web-api');

// LOGIC CHANGE 2026-03-26: Channel name validation constants.
// Slack channel names must be lowercase, no spaces, max 80 chars.
const CHANNEL_NAME_MAX_LENGTH = 80;
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * Create a SlackClient wrapper instance.
 * @param {string} token - Slack bot OAuth token (xoxb-)
 * @returns {Object} SlackClient wrapper with channel management methods
 */
function createSlackClient(token) {
    if (!token) {
        throw new Error('SLACK_BOT_TOKEN is required');
    }

    const client = new WebClient(token);

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

    /**
     * Create a public channel.
     * @param {string} name - Channel name (will be normalized)
     * @returns {Promise<{ channelId: string, name: string, created: boolean }>}
     * @throws {Error} On API error or missing scope
     */
    async function createChannel(name) {
        const normalizedName = normalizeChannelName(name);
        const validation = validateChannelName(normalizedName);

        if (!validation.valid) {
            throw new Error(validation.error);
        }

        try {
            const result = await client.conversations.create({
                name: normalizedName,
                is_private: false,
            });

            return {
                channelId: result.channel.id,
                name: result.channel.name,
                created: true,
            };
        } catch (err) {
            // LOGIC CHANGE 2026-03-26: Handle missing_scope error with helpful message.
            if (err.data?.error === 'missing_scope') {
                const scopeNeeded = err.data?.needed || 'channels:manage';
                console.error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
                throw new Error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
            }

            // LOGIC CHANGE 2026-03-26: Handle name_taken error gracefully.
            if (err.data?.error === 'name_taken') {
                throw new Error(`Channel name '${normalizedName}' is already taken`);
            }

            throw err;
        }
    }

    /**
     * Invite the bot user to a channel.
     * @param {string} channelId - Channel ID to invite bot to
     * @returns {Promise<{ success: boolean }>}
     * @throws {Error} On API error
     */
    async function inviteBotToChannel(channelId) {
        if (!channelId) {
            throw new Error('Channel ID is required');
        }

        try {
            // Get bot user ID from auth.test
            const authResult = await client.auth.test();
            const botUserId = authResult.user_id;

            await client.conversations.join({
                channel: channelId,
            });

            return { success: true };
        } catch (err) {
            // LOGIC CHANGE 2026-03-26: Handle already_in_channel as success.
            if (err.data?.error === 'already_in_channel') {
                return { success: true };
            }

            if (err.data?.error === 'missing_scope') {
                const scopeNeeded = err.data?.needed || 'channels:join';
                console.error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
                throw new Error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
            }

            throw err;
        }
    }

    /**
     * Set a channel's topic/description.
     * @param {string} channelId - Channel ID
     * @param {string} topic - Topic text
     * @returns {Promise<{ success: boolean, topic: string }>}
     * @throws {Error} On API error
     */
    async function setChannelTopic(channelId, topic) {
        if (!channelId) {
            throw new Error('Channel ID is required');
        }

        try {
            const result = await client.conversations.setTopic({
                channel: channelId,
                topic: topic || '',
            });

            return {
                success: true,
                topic: result.channel?.topic?.value || topic,
            };
        } catch (err) {
            if (err.data?.error === 'missing_scope') {
                const scopeNeeded = err.data?.needed || 'channels:manage';
                console.error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
                throw new Error(`Missing Slack scope: ${scopeNeeded}. Add it at api.slack.com/apps`);
            }

            throw err;
        }
    }

    /**
     * Find a channel by name.
     * @param {string} name - Channel name to search for
     * @returns {Promise<{ channelId: string, name: string } | null>}
     */
    async function findChannelByName(name) {
        if (!name) return null;

        const normalizedName = normalizeChannelName(name);

        try {
            let cursor;
            do {
                const result = await client.conversations.list({
                    types: 'public_channel',
                    limit: 200,
                    cursor,
                });

                for (const channel of result.channels || []) {
                    if (channel.name === normalizedName) {
                        return {
                            channelId: channel.id,
                            name: channel.name,
                        };
                    }
                }

                cursor = result.response_metadata?.next_cursor;
            } while (cursor);

            return null;
        } catch (err) {
            if (err.data?.error === 'missing_scope') {
                console.error('Missing Slack scope: channels:read. Add it at api.slack.com/apps');
                throw new Error('Missing Slack scope: channels:read. Add it at api.slack.com/apps');
            }
            throw err;
        }
    }

    /**
     * Ensure a channel exists, creating it if necessary.
     * Uses conversations.list to check first, then creates if needed.
     *
     * @param {string} name - Channel name
     * @param {string} [topic] - Optional topic to set
     * @returns {Promise<{ channelId: string, name: string, created: boolean }>}
     * @throws {Error} On API error
     */
    async function ensureChannel(name, topic = '') {
        const normalizedName = normalizeChannelName(name);
        const validation = validateChannelName(normalizedName);

        if (!validation.valid) {
            throw new Error(validation.error);
        }

        // First, check if channel exists
        const existing = await findChannelByName(normalizedName);
        if (existing) {
            // Channel exists - join it and optionally set topic
            await inviteBotToChannel(existing.channelId);
            if (topic) {
                await setChannelTopic(existing.channelId, topic);
            }
            return {
                channelId: existing.channelId,
                name: existing.name,
                created: false,
            };
        }

        // Channel doesn't exist - create it
        const created = await createChannel(normalizedName);

        // Bot is automatically joined when creating a channel, but set topic if provided
        if (topic) {
            await setChannelTopic(created.channelId, topic);
        }

        return created;
    }

    return {
        client,
        normalizeChannelName,
        validateChannelName,
        createChannel,
        inviteBotToChannel,
        setChannelTopic,
        findChannelByName,
        ensureChannel,
        CHANNEL_NAME_MAX_LENGTH,
        CHANNEL_NAME_PATTERN,
    };
}

module.exports = {
    createSlackClient,
    CHANNEL_NAME_MAX_LENGTH,
    CHANNEL_NAME_PATTERN,
};
