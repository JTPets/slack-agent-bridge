'use strict';

/**
 * lib/slack-channel-ensure.js
 *
 * The composed channel operations behind lib/slack-client.js createSlackClient:
 * ensureChannel (the channel-map cache first, then find, then create) and
 * joinAgentChannels (the startup join of every agent channel). Each takes the Web API
 * client as its first argument.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B34): moved out of createSlackClient with the
 * operations in lib/slack-channel-ops.js; bodies unchanged apart from passing `client` on.
 */

const { normalizeChannelName, validateChannelName } = require('./slack-channel-names');
const { createChannel, inviteBotToChannel, setChannelTopic, findChannelByName } = require('./slack-channel-ops');
const bridgeState = require('./bridge-state');

function loadChannelMap() {
    return bridgeState.loadChannelMap();
}

function saveChannelMap(map) {
    return bridgeState.saveChannelMap(map);
}

/**
 * Ensure a channel exists, creating it if necessary.
 * Uses conversations.list to check first, then creates if needed.
 * On missing_scope from create, falls back to searching and logging clearly.
 * Results are cached in agents/shared/channel-map.json.
 *
 * LOGIC CHANGE 2026-03-28: On missing_scope from createChannel, fall back to
 * searching for existing channel. If not found, log clearly with fix instructions.
 * Cache resolved channel IDs in channel-map.json to avoid repeated API calls.
 *
 * @param {string} name - Channel name
 * @param {string} [topic] - Optional topic to set
 * @returns {Promise<{ channelId: string, name: string, created: boolean }>}
 * @throws {Error} On API error
 */
async function ensureChannel(client, name, topic = '') {
    const normalizedName = normalizeChannelName(name);
    const validation = validateChannelName(normalizedName);

    if (!validation.valid) {
        throw new Error(validation.error);
    }

    // LOGIC CHANGE 2026-03-28: Check channel-map cache first to avoid API calls.
    const channelMap = loadChannelMap();
    if (channelMap[normalizedName]) {
        const cachedId = channelMap[normalizedName];
        // Verify the channel is still joinable
        try {
            await client.conversations.join({ channel: cachedId });
        } catch (joinErr) {
            if (joinErr.data?.error !== 'already_in_channel' &&
                joinErr.data?.error !== 'method_not_supported_for_channel_type') {
                // Cache miss - channel may have been deleted, remove from cache
                delete channelMap[normalizedName];
                saveChannelMap(channelMap);
                // Fall through to normal lookup
            } else {
                return { channelId: cachedId, name: normalizedName, created: false };
            }
        }
    }

    // First, check if channel exists
    const existing = await findChannelByName(client, normalizedName);
    if (existing) {
        // Channel exists - join it and optionally set topic
        await inviteBotToChannel(client, existing.channelId);
        if (topic) {
            await setChannelTopic(client, existing.channelId, topic);
        }
        // Cache the result
        channelMap[normalizedName] = existing.channelId;
        saveChannelMap(channelMap);
        return {
            channelId: existing.channelId,
            name: existing.name,
            created: false,
        };
    }

    // Channel doesn't exist - try to create it
    try {
        const created = await createChannel(client, normalizedName);

        // Bot is automatically joined when creating a channel, but set topic if provided
        if (topic) {
            await setChannelTopic(client, created.channelId, topic);
        }

        // Cache the result
        channelMap[normalizedName] = created.channelId;
        saveChannelMap(channelMap);
        return created;
    } catch (createErr) {
        // LOGIC CHANGE 2026-03-28: If we can't create due to missing_scope, search
        // one more time (in case channel was just created externally) and log clearly.
        if (createErr.message && createErr.message.includes('Missing Slack scope')) {
            // Re-check in case channel appeared between our check and create attempt
            const retry = await findChannelByName(client, normalizedName).catch(() => null);
            if (retry) {
                await inviteBotToChannel(client, retry.channelId).catch(() => {});
                channelMap[normalizedName] = retry.channelId;
                saveChannelMap(channelMap);
                return { channelId: retry.channelId, name: retry.name, created: false };
            }
            // Channel doesn't exist and we can't create it
            console.error(`[slack-client] Cannot create #${normalizedName} - add channels:manage scope OR create manually at slack.com`);
        }
        throw createErr;
    }
}

/**
 * Join all agent channels on startup.
 * Called every startup so the bot is always a member of agent channels,
 * even if channels were recreated while the bot was offline.
 *
 * LOGIC CHANGE 2026-03-28: Added joinAgentChannels to ensure bot is in all
 * agent channels before polling starts. Wraps each join in try/catch so a
 * single failure never blocks other channels from being joined.
 *
 * @param {Array<{channelId: string, agentId: string}>} channels - Array of channel info objects
 * @returns {Promise<{joined: number, failed: number, total: number}>}
 */
async function joinAgentChannels(client, channels) {
    let joined = 0;
    let failed = 0;
    const channelsWithIds = channels.filter(c => c.channelId);
    const total = channelsWithIds.length;

    for (const channelInfo of channelsWithIds) {
        const { channelId, agentId } = channelInfo;
        try {
            await client.conversations.join({ channel: channelId });
            joined++;
        } catch (err) {
            // already_in_channel and method_not_supported are success cases
            if (err.data?.error === 'already_in_channel' ||
                err.data?.error === 'method_not_supported_for_channel_type') {
                joined++;
                continue;
            }
            if (err.data?.error === 'missing_scope') {
                console.error(`[slack-client] Cannot join ${channelId} (${agentId}) - add channels:join scope at api.slack.com/apps`);
            } else {
                console.error(`[slack-client] Failed to join channel ${channelId} (${agentId}):`, err.message);
            }
            failed++;
        }
    }

    if (failed === 0) {
        console.log(`[bridge-agent] Joined ${joined}/${total} agent channels`);
    } else {
        console.log(`[bridge-agent] Joined ${joined}/${total} agent channels (${failed} failed - check scopes)`);
    }

    return { joined, failed, total };
}

module.exports = {
    ensureChannel,
    joinAgentChannels,
};
