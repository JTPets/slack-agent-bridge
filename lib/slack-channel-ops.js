'use strict';

/**
 * lib/slack-channel-ops.js
 *
 * The single-call channel operations behind lib/slack-client.js createSlackClient: create,
 * join, set a topic, find by name. Each takes the Web API client as its first argument.
 * The composed ones (ensure, the startup join) are lib/slack-channel-ensure.js.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B34): moved out of createSlackClient, which was
 * one 360-line function holding all of them as closures over `client`. The bodies are
 * unchanged apart from passing `client` on; createSlackClient binds them to its client, so
 * every caller of the wrapper sees the same methods.
 */

const { normalizeChannelName, validateChannelName } = require('./slack-channel-names');

/**
 * Create a public channel.
 * @param {string} name - Channel name (will be normalized)
 * @returns {Promise<{ channelId: string, name: string, created: boolean }>}
 * @throws {Error} On API error or missing scope
 */
async function createChannel(client, name) {
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
async function inviteBotToChannel(client, channelId) {
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
async function setChannelTopic(client, channelId, topic) {
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
async function findChannelByName(client, name) {
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

module.exports = {
    createChannel,
    inviteBotToChannel,
    setChannelTopic,
    findChannelByName,
};
