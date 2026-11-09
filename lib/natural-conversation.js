'use strict';

/**
 * lib/natural-conversation.js
 *
 * WORK-TODO #49, the owner's answer of 2026-11-08: natural conversation (a message with
 * no TASK:/ASK: prefix) is answered "in their assigned channels ... restrict it ... like
 * secretary could be natural language, but once she can write an email it should be
 * restricted to avoid injection." So an unprefixed message is answered only by an agent
 * whose model run can WRITE NOTHING.
 *
 * LOGIC CHANGE 2026-11-09: new file.
 *
 * What "can write nothing" means here, and why it is an allowlist. The agent's model run
 * gets exactly the Claude tools lib/agent-tools.js resolves from its definition. The
 * run qualifies only when that set is not the full set (`claude-code`) and every tool in
 * it is a READ tool. Any other tool, including one added later for an integration (a
 * mail-send tool, say), disqualifies the agent the day it is granted, without anyone
 * editing this file. A permission the bridge's own code performs (gmail-read,
 * twilio-outbound, ...) gives the model no tool, so it does not reach a reply.
 *
 * The master switch stays NATURAL_CONVERSATION_MODE (off by default): the owner turns
 * the mode on, and this decides which channels it reaches.
 *
 * Pure: decides, never posts.
 */

// Through the module object, so a test can stand in a tool set no definition grants yet.
const agentTools = require('./agent-tools');

/**
 * @param {object|null} agent - the channel's agent record
 * @returns {{ allowed: boolean, reason: string }}
 */
function naturalConversationVerdict(agent) {
    if (!agent || !agent.id) return { allowed: false, reason: 'the channel has no agent' };
    const tools = agentTools.resolveClaudeTools(agent);
    if (tools.full) {
        return { allowed: false, reason: `${agent.id} holds the full tool set; talk to it with ASK: or TASK:` };
    }
    const writing = tools.tools.filter(t => !agentTools.READ_TOOLS.includes(t));
    if (writing.length) {
        return { allowed: false, reason: `${agent.id} can use ${writing.join(', ')}; talk to it with ASK: or TASK:` };
    }
    return { allowed: true, reason: `${agent.id} can write nothing (${tools.tools.length ? tools.tools.join(', ') : 'no tools'})` };
}

module.exports = { naturalConversationVerdict };
