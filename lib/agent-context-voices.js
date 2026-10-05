/**
 * lib/agent-context-voices.js
 *
 * The data contexts for the agents that write in a voice rather than act: the jester
 * (milestones and completed tasks to critique), story-bot (milestones and accomplishments
 * for posts), and the placeholder for an agent with no builder.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of lib/agent-context.js,
 * which re-exports all three builders and still owns the switch that picks one.
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #32): one timestamp helper for every bulletin rendering;
// the security and story-bot contexts now get the time as well as the date.
const { formatTimestamp } = require('./time-format');
const { bulletinBoard } = require('./agent-context-sources');

/**
 * Build context for the jester agent.
 * Includes recent bulletins and milestones to critique.
 *
 * @returns {string} Formatted context string
 */
function buildJesterContext() {
    const lines = [];

    try {
        // Get recent milestones
        const milestones = bulletinBoard.getBulletins({
            type: 'milestone',
            limit: 5,
        });

        if (milestones.length > 0) {
            lines.push('RECENT MILESTONES (fair game for roasting):');
            for (const b of milestones) {
                const desc = b.data.description || b.data.title || 'Unnamed milestone';
                lines.push(`- ${b.agentId}: ${desc}`);
            }
            lines.push('');
        }

        // Get recent task completions
        const tasks = bulletinBoard.getBulletins({
            type: 'task_completed',
            limit: 5,
        });

        if (tasks.length > 0) {
            lines.push('RECENT COMPLETED TASKS:');
            for (const b of tasks) {
                const desc = b.data.description || 'Unnamed task';
                lines.push(`- ${desc}`);
            }
        }
    } catch (err) {
        console.error('[agent-context] Failed to build jester context:', err.message);
        lines.push('BULLETIN DATA: Unable to load');
    }

    return lines.join('\n');
}

/**
 * Build context for the story-bot agent.
 * Includes recent milestones and task completions for LinkedIn content.
 *
 * @returns {string} Formatted context string
 */
function buildStoryBotContext() {
    const lines = [];

    try {
        // Get recent milestones
        const milestones = bulletinBoard.getBulletins({
            type: 'milestone',
            limit: 10,
        });

        if (milestones.length > 0) {
            lines.push('RECENT MILESTONES (potential LinkedIn content):');
            for (const b of milestones) {
                const desc = b.data.description || b.data.title || 'Unnamed milestone';
                const time = formatTimestamp(b.timestamp);
                lines.push(`- [${time}] ${desc}`);
            }
            lines.push('');
        }

        // Get recent significant task completions
        const tasks = bulletinBoard.getBulletins({
            type: 'task_completed',
            limit: 10,
        });

        if (tasks.length > 0) {
            lines.push('RECENT TECHNICAL ACCOMPLISHMENTS:');
            for (const b of tasks) {
                const desc = b.data.description || 'Unnamed task';
                const repo = b.data.repo || '';
                lines.push(`- ${desc}${repo ? ` (${repo})` : ''}`);
            }
        }
    } catch (err) {
        console.error('[agent-context] Failed to build story-bot context:', err.message);
        lines.push('BULLETIN DATA: Unable to load');
    }

    return lines.join('\n');
}

/**
 * Build context for a generic agent.
 * Returns minimal context with just the anti-hallucination rule.
 *
 * @returns {string} Formatted context string
 */
function buildGenericContext() {
    return 'No specific data context available for this agent.';
}

module.exports = {
    buildJesterContext,
    buildStoryBotContext,
    buildGenericContext,
};
