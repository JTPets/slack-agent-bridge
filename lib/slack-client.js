'use strict';

/**
 * lib/slack-client.js
 *
 * Slack client wrapper with channel management functions.
 * Provides utilities for creating channels, inviting bots, and managing topics.
 *
 * LOGIC CHANGE 2026-03-26: Initial implementation of Slack channel management.
 * Requires the 'channels:manage' scope for creating and managing channels.
 *
 * LOGIC CHANGE 2026-03-28: Added joinAgentChannels() to join all agent channels on
 * every startup. Added channel-map.json support for caching resolved channel IDs.
 * LOGIC CHANGE 2026-09-15: ownership of channel-map.json moved to lib/bridge-state.js;
 * the two functions here are now thin delegates kept for their existing callers.
 * Fixed ensureChannel to handle missing_scope from createChannel gracefully.
 */

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient } = require('./slack-web');

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B34): the name rules and the channel operations
// moved to lib/slack-channel-names.js, lib/slack-channel-ops.js and lib/slack-channel-ensure.js.
const {
    normalizeChannelName, validateChannelName, CHANNEL_NAME_MAX_LENGTH, CHANNEL_NAME_PATTERN,
} = require('./slack-channel-names');
const ops = Object.assign({}, require('./slack-channel-ops'), require('./slack-channel-ensure'));

// LOGIC CHANGE 2026-09-15: channel-map.json moved to lib/bridge-state.js, which is
// the single owner of the bridge's durable local state. It is the same file, the
// same format and the same behaviour — only the owner moved, because a tracked agent
// definition may no longer carry a Slack channel id and this map is now the store
// that answers "which id does this channel name have in THIS workspace"
// (docs/AGENTS.md -> "How agent state is actually held").
//
// Re-exported below so every existing caller and test is unchanged.
const bridgeState = require('./bridge-state');

/**
 * Load the channel-name -> Slack-id map. Delegates to lib/bridge-state.js.
 * @returns {Object} Map of channel name -> channelId
 */
function loadChannelMap() {
    return bridgeState.loadChannelMap();
}

/**
 * Save the channel-name -> Slack-id map. Delegates to lib/bridge-state.js.
 * @param {Object} map - Map of channel name -> channelId
 */
function saveChannelMap(map) {
    return bridgeState.saveChannelMap(map);
}

/**
 * Create a SlackClient wrapper instance.
 * @param {string} token - Slack bot OAuth token (xoxb-)
 * @returns {Object} SlackClient wrapper with channel management methods
 */
function createSlackClient(token) {
    if (!token) {
        throw new Error('SLACK_BOT_TOKEN is required');
    }

    const client = createWebClient(token);

    // LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B34): the operations live in
    // lib/slack-channel-ops.js and take the client first; this binds them.
    const bind = (fn) => (...args) => fn(client, ...args);

    return {
        client,
        normalizeChannelName,
        validateChannelName,
        createChannel: bind(ops.createChannel),
        inviteBotToChannel: bind(ops.inviteBotToChannel),
        setChannelTopic: bind(ops.setChannelTopic),
        findChannelByName: bind(ops.findChannelByName),
        ensureChannel: bind(ops.ensureChannel),
        joinAgentChannels: bind(ops.joinAgentChannels),
        CHANNEL_NAME_MAX_LENGTH,
        CHANNEL_NAME_PATTERN,
    };
}

module.exports = {
    createSlackClient,
    loadChannelMap,
    saveChannelMap,
    CHANNEL_NAME_MAX_LENGTH,
    CHANNEL_NAME_PATTERN,
};
