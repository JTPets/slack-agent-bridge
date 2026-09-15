'use strict';

/**
 * lib/agent-activation.js
 *
 * Turning a tracked agent DEFINITION into a running agent in THIS workspace:
 * resolve the channel name it declares to a Slack id, record that id, and record
 * the activation decision. Both records are workspace-local
 * (`lib/bridge-state.js`), never tracked.
 *
 * LOGIC CHANGE 2026-09-15: New file, replacing `activateAgent()` in
 * lib/agent-registry.js. Three things changed, each deliberate:
 *
 *   1. IT NEVER CREATES A SLACK CHANNEL. The old implementation called
 *      `ensureChannel()`, which creates one when the name is not found. Creating a
 *      channel is an owner action with a cost outside this repository — a channel
 *      the bot joins on every boot and a place output accumulates unread. Where the
 *      declared channel does not exist this REFUSES and says so, which is the same
 *      behaviour the scheduler already has for an agent with no channel and is the
 *      correct one.
 *   2. IT WRITES LOCAL STATE, NOT THE REGISTRY. The old one deleted `status` from
 *      `agents/agents.json` and wrote the file back — a live edit to a TRACKED
 *      file, which auto-update's `git reset --hard HEAD` discards. Twice observed.
 *      An activation now survives a restart AND a pull because the file it lands in
 *      is gitignored.
 *   3. ACTIVATION AND CHANNEL RESOLUTION ARE ONE OPERATION. They were separate and
 *      could disagree; an agent could be active with an unresolvable channel.
 *
 * WHAT IT STILL CANNOT DO: make a change reach the poll loop or the scheduler
 * without a restart, unless the caller re-registers them. `channelsToPoll` and the
 * cron jobs are derived once at startup (docs/AGENTS.md -> "How agent state is
 * actually held"). `activateAgent` reports that in its verdict rather than implying
 * otherwise.
 */

const bridgeState = require('./bridge-state');
const { loadAgents, getAgent } = require('./agent-registry');

/**
 * Resolve the channel an agent declares, WITHOUT creating anything.
 *
 * Order: the local channel map first (so an already-known channel costs no API call
 * and cannot be mis-resolved by a name that drifted), then Slack by name.
 *
 * @param {object} agent - Registry record; needs `channel_name`.
 * @param {object} [slackClient] - lib/slack-client.js wrapper. Omit for cache-only.
 * @returns {Promise<{ resolved: boolean, channelId: string|null, source: string, reason?: string }>}
 */
async function resolveAgentChannel(agent, slackClient) {
    const name = agent && agent.channel_name ? String(agent.channel_name).replace(/^#/, '') : null;
    if (!name) {
        return { resolved: false, channelId: null, source: 'none', reason: 'the definition declares no channel_name' };
    }

    const cached = bridgeState.getChannelId(name);
    if (cached) return { resolved: true, channelId: cached, source: 'cache' };

    if (!slackClient || typeof slackClient.findChannelByName !== 'function') {
        return { resolved: false, channelId: null, source: 'cache', reason: `#${name} is not in the local channel map and no Slack client was supplied` };
    }

    let found;
    try {
        found = await slackClient.findChannelByName(name);
    } catch (err) {
        return { resolved: false, channelId: null, source: 'slack', reason: `Slack lookup for #${name} failed: ${err.message}` };
    }

    if (!found || !found.channelId) {
        return {
            resolved: false,
            channelId: null,
            source: 'slack',
            reason: `#${name} does not exist in this workspace. Nothing here creates a channel — create it, then activate again.`,
        };
    }

    bridgeState.setChannelId(name, found.channelId);
    return { resolved: true, channelId: found.channelId, source: 'slack' };
}

/**
 * Activate an agent: resolve its channel, join it, and record the decision.
 *
 * Refuses, changing nothing, when the declared channel cannot be resolved. A
 * half-activated agent — active with no channel — is the state that produces work
 * nothing collects, so it is not a state this function can leave behind.
 *
 * @param {string} id - Agent id.
 * @param {object} [slackClient] - lib/slack-client.js wrapper.
 * @param {object} [meta] - Provenance recorded with the decision, e.g. { by: 'U123' }.
 * @returns {Promise<{ ok: boolean, agent: object|null, channelId: string|null, joined: boolean, reason?: string, note?: string }>}
 */
async function activateAgent(id, slackClient, meta = {}) {
    const agent = getAgent(id);
    if (!agent) return { ok: false, agent: null, channelId: null, joined: false, reason: `Agent not found: ${id}` };

    if (agent.status !== 'planned') {
        return { ok: false, agent, channelId: agent.channel, joined: false, reason: `${id} is already active` };
    }

    const resolution = await resolveAgentChannel(agent, slackClient);
    if (!resolution.resolved) {
        return { ok: false, agent, channelId: null, joined: false, reason: resolution.reason };
    }

    let joined = false;
    if (slackClient && typeof slackClient.joinAgentChannels === 'function') {
        try {
            const result = await slackClient.joinAgentChannels([{ channelId: resolution.channelId, agentId: id }]);
            joined = Boolean(result && result.joined > 0);
        } catch (err) {
            return {
                ok: false, agent, channelId: resolution.channelId, joined: false,
                reason: `Resolved #${agent.channel_name} to a channel but could not join it: ${err.message}`,
            };
        }
        if (!joined) {
            return {
                ok: false, agent, channelId: resolution.channelId, joined: false,
                reason: `Resolved #${agent.channel_name} but the join was rejected. Check the channels:join scope, or invite the bot manually.`,
            };
        }
    }

    bridgeState.setActivation(id, true, { ...meta, channel: resolution.channelId, channel_name: agent.channel_name });

    return {
        ok: true,
        agent: getAgent(id),
        channelId: resolution.channelId,
        joined,
        note: 'Recorded in agents/shared/agent-activation.json, which is gitignored — this survives a restart and a pull. The poll set and the scheduler are derived at startup, so polling and any schedule begin at the next restart unless the caller registers them now.',
    };
}

/**
 * Deactivate an agent: record the decision, touch nothing else.
 *
 * The channel id stays in the local map deliberately — deactivating is not
 * forgetting where the channel is, and re-activating should not need Slack again.
 *
 * @param {string} id
 * @param {object} [meta]
 * @returns {{ ok: boolean, agent: object|null, reason?: string }}
 */
function deactivateAgent(id, meta = {}) {
    const agent = getAgent(id);
    if (!agent) return { ok: false, agent: null, reason: `Agent not found: ${id}` };
    bridgeState.setActivation(id, false, meta);
    return { ok: true, agent: getAgent(id) };
}

/**
 * Forget a local activation decision, so the definition's `default_status` governs.
 *
 * @param {string} id
 * @returns {{ ok: boolean, cleared: boolean }}
 */
function resetActivation(id) {
    return { ok: true, cleared: bridgeState.clearActivation(id) };
}

/**
 * Agents this workspace has not activated.
 *
 * LOGIC CHANGE 2026-09-15: was "planned AND no channel". The `and` hid exactly the
 * agent that most needed listing — one whose channel is known but which nothing
 * polls, which is story-bot. Now: every agent that is not active, each carrying
 * whether its declared channel already resolves, so a caller can tell an agent that
 * is one command away from running from one that needs a channel created first.
 *
 * @returns {Array<{ id: string, name: string, channel_name: string|null, channel: string|null, resolvable: boolean }>}
 */
function getAgentsNeedingActivation() {
    return loadAgents()
        .filter(agent => agent.status === 'planned')
        .map(agent => ({
            id: agent.id,
            name: agent.name || agent.id,
            channel_name: agent.channel_name || null,
            channel: agent.channel || null,
            resolvable: Boolean(agent.channel),
        }));
}

module.exports = {
    resolveAgentChannel,
    activateAgent,
    deactivateAgent,
    resetActivation,
    getAgentsNeedingActivation,
};
