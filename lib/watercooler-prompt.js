/**
 * lib/watercooler-prompt.js
 *
 * The prompt one agent is given for its turn at a standup: its persona, the theme, the
 * gathered context rendered as text, what earlier speakers said, and its task. Pure —
 * builds strings, reads nothing.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/watercooler.js unchanged,
 * on the boundary #10 names (catalogue vs. context gathering vs. orchestration). 
 * lib/watercooler.js re-exports every name, so no caller changed.
 */

'use strict';

const { STANDUP_TYPES, DEFAULT_STANDUP_TYPE, AGENT_STANDUP_PROMPTS } = require('./watercooler-catalogue');

/**
 * Format bulletins summary for agent context.
 *
 * @param {Array} bulletins - Array of bulletin objects
 * @returns {string} Formatted summary
 */
function formatBulletinsSummary(bulletins) {
    if (!bulletins || bulletins.length === 0) {
        return 'No new bulletins since last standup.';
    }

    const typeEmoji = {
        milestone: '🏆',
        alert: '⚠️',
        vendor_deal: '💰',
        customer_insight: '🔍',
        task_completed: '✅',
        security_finding: '🔒',
        content_idea: '💡',
    };

    const lines = [`${bulletins.length} bulletins since last standup:`];
    for (const b of bulletins.slice(0, 10)) {
        const emoji = typeEmoji[b.type] || '📝';
        const summary = b.data.description || b.data.title || b.data.message || JSON.stringify(b.data).slice(0, 80);
        lines.push(`- ${emoji} [${b.agentId}] ${summary}`);
    }
    if (bulletins.length > 10) {
        lines.push(`... and ${bulletins.length - 10} more`);
    }

    return lines.join('\n');
}

/**
 * Format recent completions summary for agent context.
 *
 * @param {Array} completions - Array of completed tasks
 * @returns {string} Formatted summary
 */
function formatCompletionsSummary(completions) {
    if (!completions || completions.length === 0) {
        return 'No task completions this week.';
    }

    const lines = [`${completions.length} tasks completed this week:`];
    for (const t of completions.slice(0, 10)) {
        const desc = t.description || 'No description';
        const repo = t.repo ? ` (${t.repo})` : '';
        lines.push(`- ${desc}${repo}`);
    }
    if (completions.length > 10) {
        lines.push(`... and ${completions.length - 10} more`);
    }

    return lines.join('\n');
}

/**
 * Format agent backlog summary for agent context.
 *
 * @param {Array} backlog - Array of backlog items
 * @returns {string} Formatted summary
 */
function formatBacklogSummary(backlog) {
    if (!backlog || backlog.length === 0) {
        return 'No items in backlog.';
    }

    const pending = backlog.filter(b => b.status === 'pending');
    const inProgress = backlog.filter(b => b.status === 'in_progress');
    const highPriority = pending.filter(b => b.priority === 'high');

    const lines = [];
    lines.push(`Backlog: ${pending.length} pending, ${inProgress.length} in progress`);

    if (highPriority.length > 0) {
        lines.push('High priority items:');
        for (const item of highPriority.slice(0, 3)) {
            lines.push(`- ${item.title}`);
        }
    }

    return lines.join('\n');
}

/**
 * Format previous agent messages for context.
 *
 * @param {Array} previousMessages - Array of {agentName, message} objects
 * @returns {string} Formatted previous messages
 */
function formatPreviousMessages(previousMessages) {
    if (!previousMessages || previousMessages.length === 0) {
        return 'You are the first to speak.';
    }

    const lines = ['What other agents said:'];
    for (const pm of previousMessages) {
        lines.push(`${pm.agentName}: "${pm.message}"`);
    }

    return lines.join('\n');
}

/**
 * Build the standup prompt for an agent.
 *
 * @param {Object} agent - Agent configuration from agents.json
 * @param {Object} context - Context object with bulletins, completions, standupType, etc.
 * @returns {string} Full prompt for the agent
 */
function buildStandupPrompt(agent, context) {
    const { bulletins, completions, backlog, previousMessages, isJesterFinalWord, standupType } = context;
    const typeConfig = STANDUP_TYPES[standupType] || STANDUP_TYPES[DEFAULT_STANDUP_TYPE];
    const agentPrompts = AGENT_STANDUP_PROMPTS[standupType] || AGENT_STANDUP_PROMPTS[DEFAULT_STANDUP_TYPE];

    const parts = [];

    // Agent identity and personality
    parts.push(`You are ${agent.name}, the ${agent.role} for JT Pets.`);
    parts.push(`Your personality: ${agent.personality}`);
    parts.push('');

    // System prompt if available
    if (agent.system_prompt) {
        parts.push(`Your context: ${agent.system_prompt}`);
        parts.push('');
    }

    // Standup theme
    parts.push(`=== ${typeConfig.name.toUpperCase()} ===`);
    parts.push(`Theme: ${typeConfig.theme}`);
    parts.push('');

    // Context information
    parts.push('=== STANDUP CONTEXT ===');
    parts.push(formatBulletinsSummary(bulletins));
    parts.push('');
    parts.push(formatCompletionsSummary(completions));
    parts.push('');
    parts.push(formatBacklogSummary(backlog));
    parts.push('');
    parts.push(formatPreviousMessages(previousMessages));
    parts.push('');

    // The standup request - agent-specific prompts based on standup type
    parts.push('=== YOUR TASK ===');

    if (isJesterFinalWord) {
        // Jester has a special role at the end
        const jesterPrompt = agentPrompts.jester || 'Deliver your signature sharp wit. Challenge what others said.';
        parts.push('You get the final word at this standup. You\'ve heard everyone else speak.');
        parts.push(`Your specific task: ${jesterPrompt}`);
        parts.push('In 2-3 sentences, deliver your take. Be clever - you\'re here to make people laugh AND think.');
    } else {
        // Agent-specific prompt based on standup type
        const specificPrompt = agentPrompts[agent.id];
        if (specificPrompt) {
            parts.push(`Your specific task: ${specificPrompt}`);
        } else {
            parts.push(`Share your update relevant to the theme: ${typeConfig.theme}`);
        }
        parts.push('Share your standup update in 2-3 sentences in your personality voice.');
        parts.push('If other agents have spoken, react to what they said - agree, disagree, build on their ideas.');
        parts.push('Reference other agents by name when responding to them.');
    }
    parts.push('');
    parts.push('Respond with ONLY your standup message. No preamble, no "Here\'s my update:", just the message.');

    return parts.join('\n');
}

module.exports = {
    formatBulletinsSummary,
    formatCompletionsSummary,
    formatBacklogSummary,
    formatPreviousMessages,
    buildStandupPrompt,
};
