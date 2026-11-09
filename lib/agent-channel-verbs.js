'use strict';

/**
 * lib/agent-channel-verbs.js
 *
 * WORK-TODO #64, the owner's answer of 2026-11-08: "they can run in any channel and
 * refuse changes until we define what's approved." A bridge verb typed on its own in an
 * agent's channel RUNS when it only reads (`kind: 'report'` in lib/command-router.js),
 * and is REFUSED, with the reason, when it changes something or starts work
 * (`mutate`, `scheduled`). Before this every verb was refused there, and before that a
 * model answered it as conversation.
 *
 * LOGIC CHANGE 2026-11-09: new file.
 *
 * Why the kind decides and not a list of names. The command table already says which
 * verbs only read; a second list here could drift from it. A new `report` verb answers
 * in any channel the day it is registered, and a new `mutate` verb is refused there the
 * same day, without anyone remembering this file.
 *
 * Pure: decides and builds text, runs nothing.
 */

const commandRouter = require('./command-router');

/** The only kind that runs outside #claude-bridge. */
const RUNS_ANYWHERE = 'report';

/**
 * @param {string} text - the ASK body
 * @param {string[]} agentIds - ids that count as a verb argument (isBareCommand)
 * @returns {{ action: 'run'|'refuse'|null, verb?: string, kind?: string }}
 *   null action = not a bare verb; the message is the agent's to answer.
 */
function decideAgentChannelVerb(text, agentIds = []) {
    if (!commandRouter.isBareCommand(text, agentIds)) return { action: null };
    const { verb } = commandRouter.parseCommand(text);
    const kind = commandRouter.COMMANDS[verb].kind;
    return { action: kind === RUNS_ANYWHERE ? 'run' : 'refuse', verb, kind };
}

/** The reply for a verb that changes something, typed outside #claude-bridge. */
function describeVerbRefusal(verb, bridgeChannelId) {
    return `:information_source: \`${verb}\` changes something or starts work, so it runs only in <#${bridgeChannelId}> ` +
        `until approval rules for agent channels are defined. Read-only commands (${readOnlyVerbs().join(', ')}) ` +
        'answer here. Nothing was run.';
}

/** Generated from the table, so the reply cannot list a verb that would be refused. */
function readOnlyVerbs() {
    return commandRouter.listVerbs().filter(v => commandRouter.COMMANDS[v].kind === RUNS_ANYWHERE);
}

module.exports = { decideAgentChannelVerb, describeVerbRefusal, readOnlyVerbs, RUNS_ANYWHERE };
