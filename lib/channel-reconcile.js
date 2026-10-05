'use strict';

/**
 * lib/channel-reconcile.js
 *
 * WORK-TODO #52: the workspace's channels and the repository's agents compared, in both
 * directions. A channel the bot is in that nothing owns is where output goes to die; an
 * agent whose channel the bot is not in is work that never arrives. Neither was reported.
 *
 * LOGIC CHANGE 2026-10-04: new file. Read-only: one paginated `conversations.list`
 * (`channels:read`, already held) and the agent registry. Creates, joins and writes
 * nothing. Public channels only - listing private channels needs `groups:read`, which
 * the bot does not hold, and the report says so rather than implying it saw everything.
 */

/** The env-configured channels the code reads (enumerated by tests/env-documented.test.js). */
const ENV_CHANNEL_VARS = ['BRIDGE_CHANNEL_ID', 'OPS_CHANNEL_ID', 'STORE_TASKS_CHANNEL_ID', 'STORE_INBOX_CHANNEL_ID'];

/**
 * Every public channel the bot is a member of. Throws on a Slack error, so the caller
 * can say the report could not be built rather than printing an empty one.
 * @param {object} slack - A WebClient (lib/slack-web.js createWebClient()).
 * @returns {Promise<Array<{id: string, name: string}>>}
 */
async function listMemberChannels(slack, maxPages = 20) {
    const out = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
        const res = await slack.conversations.list({
            types: 'public_channel', exclude_archived: true, limit: 200, cursor,
        });
        for (const c of res.channels || []) if (c.is_member) out.push({ id: c.id, name: c.name });
        cursor = res.response_metadata && res.response_metadata.next_cursor;
        if (!cursor) return out;
    }
    throw new Error(`more than ${maxPages} pages of channels; the list was not finished`);
}

/**
 * Pure comparison.
 * @param {object} input
 * @param {Array<{id, name}>} input.memberChannels
 * @param {Array<object>} input.agents - Registry records (id, channel, channel_name, status).
 * @param {object} input.env - Source of the *_CHANNEL_ID values.
 * @returns {{ owned: object[], unowned: object[], agentsNotMember: object[], agentsUnresolved: object[] }}
 */
function reconcileChannels({ memberChannels, agents, env }) {
    const owners = new Map();
    const add = (id, owner) => {
        if (!id) return;
        if (!owners.has(id)) owners.set(id, []);
        owners.get(id).push(owner);
    };
    for (const a of agents) add(a.channel, `agent ${a.id}${a.status === 'planned' ? ' (planned)' : ''}`);
    for (const v of ENV_CHANNEL_VARS) add(env[v], v);

    const member = new Set(memberChannels.map((c) => c.id));
    const owned = [];
    const unowned = [];
    for (const c of memberChannels) {
        (owners.has(c.id) ? owned : unowned).push({ ...c, owners: owners.get(c.id) || [] });
    }
    const agentsNotMember = agents
        .filter((a) => a.channel && !member.has(a.channel))
        .map((a) => ({ id: a.id, channel: a.channel, channel_name: a.channel_name || null, status: a.status || 'active' }));
    const agentsUnresolved = agents
        .filter((a) => !a.channel)
        .map((a) => ({ id: a.id, channel_name: a.channel_name || null, status: a.status || 'active' }));
    return { owned, unowned, agentsNotMember, agentsUnresolved };
}

/** @returns {string} Slack text. */
function formatReconciliation(r) {
    const lines = ['*Channels vs agents* (public channels the bot is in; private ones need `groups:read`, not held)'];
    lines.push(`*In, with an owner (${r.owned.length}):* ` +
        (r.owned.map((c) => `#${c.name} (${c.owners.join(', ')})`).join('; ') || 'none'));
    lines.push(`*In, owned by nothing here (${r.unowned.length}):* ` +
        (r.unowned.map((c) => `#${c.name}`).join(', ') || 'none') +
        (r.unowned.length ? ' - output there reaches no agent; leave the channel or give it an owner.' : ''));
    lines.push(`*Agent channels the bot is NOT in (${r.agentsNotMember.length}):* ` +
        (r.agentsNotMember.map((a) => `${a.id} -> <#${a.channel}>`).join(', ') || 'none'));
    lines.push(`*Agents whose channel name never resolved (${r.agentsUnresolved.length}):* ` +
        (r.agentsUnresolved.map((a) => `${a.id}${a.channel_name ? ` (#${a.channel_name})` : ''}${a.status === 'planned' ? ' planned' : ''}`).join(', ') || 'none'));
    return lines.join('\n');
}

module.exports = { ENV_CHANNEL_VARS, listMemberChannels, reconcileChannels, formatReconciliation };
