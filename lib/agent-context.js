/**
 * lib/agent-context.js
 *
 * LOGIC CHANGE 2026-03-28: Added agent context builder to inject real data into
 * agent prompts, preventing hallucination of calendar events, meetings, and other data.
 *
 * Each agent type gets relevant real data injected into their prompts:
 * - Secretary: calendar events, pending owner tasks
 * - Security: recent security bulletins
 * - Jester: recent bulletins, milestones
 * - Story-bot: recent milestones, task completions
 * - Code agents: backlog items
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the data sources and the shared rule moved to
 * lib/agent-context-sources.js, and the builders to lib/agent-context-ops.js (secretary,
 * security, code agents) and lib/agent-context-voices.js (jester, story-bot, generic).
 * This file keeps the switch that picks a builder and the ASK: prompt assembler, and
 * re-exports every name it exported before.
 */

'use strict';

const { ANTI_HALLUCINATION_RULE, formatEventsForPrompt } = require('./agent-context-sources');
const {
    buildSecretaryContext,
    buildSecurityContext,
    buildCodeAgentContext,
} = require('./agent-context-ops');
const {
    buildJesterContext,
    buildStoryBotContext,
    buildGenericContext,
} = require('./agent-context-voices');

/**
 * THE per-agent data context: the real data an agent is given so it does not invent
 * any. One switch, one place.
 *
 * LOGIC CHANGE 2026-09-15: extracted verbatim from `buildEnrichedPrompt`, which is
 * still its only other caller and is unchanged in behaviour. It was extracted because
 * `buildEnrichedPrompt` has exactly ONE production call site — `processConversation`
 * in bridge-agent.js — so everything this module does was reachable from `ASK:` and
 * from nothing else. A scheduled agent's own `TASK:` got the agent's personality and
 * none of its data, which for story-bot means being asked to draft posts about the
 * week's milestones without being told what they were. That is the hallucination this
 * module exists to prevent, on the one path that runs unattended.
 *
 * Returns '' rather than the generic placeholder for an agent with no builder, so a
 * caller can decide whether an "I have no data for you" line earns its place in the
 * prompt. `buildEnrichedPrompt` keeps the placeholder by passing `generic: true`.
 *
 * @param {string} agentId - Agent id.
 * @param {object} [options]
 * @param {boolean} [options.generic] - Emit the generic placeholder for unknown agents.
 * @returns {Promise<string>} Formatted context string, possibly empty.
 */
async function buildAgentDataContext(agentId, options = {}) {
    const { generic = false } = options;
    try {
        switch (agentId) {
            case 'secretary':
                return await buildSecretaryContext();
            case 'security':
                return buildSecurityContext();
            case 'jester':
                return buildJesterContext();
            case 'story-bot':
                return buildStoryBotContext();
            case 'bridge':
            case 'code-bridge':
            case 'code-sqtools':
                return buildCodeAgentContext(agentId);
            default:
                return generic ? buildGenericContext() : '';
        }
    } catch (err) {
        console.error(`[agent-context] Failed to build context for ${agentId}:`, err.message);
        return 'Context data unavailable.';
    }
}

/**
 * Build the full enriched prompt for an agent's ASK response.
 * Combines the system prompt with anti-hallucination rule and real data.
 *
 * @param {object} agent - Agent config object
 * @param {string} question - The user's question
 * @param {object} [additionalContext] - Optional additional context
 * @param {string} [additionalContext.memoryContext] - Memory context string
 * @param {string} [additionalContext.bulletinContext] - Bulletin context string
 * @returns {Promise<string>} Full enriched prompt
 */
async function buildEnrichedPrompt(agent, question, additionalContext = {}) {
    const agentId = agent?.id || 'unknown';
    const systemPrompt = agent?.system_prompt || 'You are a helpful assistant.';

    const parts = [systemPrompt, '', ANTI_HALLUCINATION_RULE, ''];

    // Add agent-specific context
    const agentSpecificContext = await buildAgentDataContext(agentId, { generic: true });

    if (agentSpecificContext) {
        parts.push(agentSpecificContext);
        parts.push('');
    }

    // Add additional context if provided
    if (additionalContext.memoryContext) {
        parts.push(additionalContext.memoryContext);
        parts.push('');
    }

    if (additionalContext.bulletinContext) {
        parts.push(additionalContext.bulletinContext);
        parts.push('');
    }

    // Add the user's question
    parts.push(`User question: ${question}`);

    return parts.filter(Boolean).join('\n');
}

module.exports = {
    // Main function
    buildEnrichedPrompt,

    // The per-agent data context on its own, for the TASK: path (see its doc block)
    buildAgentDataContext,

    // Context builders (exported for testing)
    buildSecretaryContext,
    buildSecurityContext,
    buildJesterContext,
    buildStoryBotContext,
    buildCodeAgentContext,
    buildGenericContext,

    // Helpers (exported for testing)
    formatEventsForPrompt,
    ANTI_HALLUCINATION_RULE,
};

