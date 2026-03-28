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
 */

'use strict';

const googleCalendar = require('./integrations/google-calendar');
const ownerTasks = require('./owner-tasks');
const bulletinBoard = require('./bulletin-board');

// Anti-hallucination instruction added to ALL agent prompts
const ANTI_HALLUCINATION_RULE = `
IMPORTANT: Only reference real data provided below. If you don't have information about something, say "I don't have access to that yet" instead of making something up. NEVER invent meetings, people, events, emails, or data.
`.trim();

/**
 * Format calendar events as plain text for prompt injection.
 *
 * @param {Array} events - Array of calendar events
 * @returns {string} Formatted event list or empty message
 */
function formatEventsForPrompt(events) {
    if (!events || events.length === 0) {
        return 'No events scheduled.';
    }

    return events.map(event => {
        // Parse start time for display
        let timeStr = 'All day';
        if (event.start && event.start.includes('T')) {
            const startDate = new Date(event.start);
            timeStr = startDate.toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true,
                timeZone: 'America/Toronto',
            });
        }

        return `- ${timeStr}: ${event.title}`;
    }).join('\n');
}

/**
 * Build context for the secretary agent.
 * Includes today's calendar, tomorrow's calendar, and pending owner tasks.
 *
 * @returns {Promise<string>} Formatted context string
 */
async function buildSecretaryContext() {
    const lines = [];

    // Get today's date formatted nicely
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Toronto',
    });

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'America/Toronto',
    });

    // Fetch calendar data
    let todayEvents = [];
    let tomorrowEvents = [];
    try {
        todayEvents = await googleCalendar.getAllTodayEvents();
    } catch (err) {
        console.error('[agent-context] Failed to fetch today events:', err.message);
    }

    try {
        tomorrowEvents = await googleCalendar.getAllTomorrowEvents();
    } catch (err) {
        console.error('[agent-context] Failed to fetch tomorrow events:', err.message);
    }

    lines.push(`TODAY'S CALENDAR (${todayStr}):`);
    lines.push(formatEventsForPrompt(todayEvents));
    lines.push('');
    lines.push(`TOMORROW'S CALENDAR (${tomorrowStr}):`);
    lines.push(formatEventsForPrompt(tomorrowEvents));
    lines.push('');

    // Get pending owner tasks
    try {
        const pendingTasks = ownerTasks.getPendingTasks();
        if (pendingTasks.length > 0) {
            lines.push('PENDING OWNER TASKS:');
            for (const task of pendingTasks.slice(0, 10)) {
                const priorityEmoji = task.priority === 'high' ? '[HIGH]' : task.priority === 'low' ? '[LOW]' : '';
                lines.push(`- ${priorityEmoji} ${task.description}`.trim());
            }
            if (pendingTasks.length > 10) {
                lines.push(`(and ${pendingTasks.length - 10} more)`);
            }
        } else {
            lines.push('PENDING OWNER TASKS: None');
        }
    } catch (err) {
        console.error('[agent-context] Failed to fetch owner tasks:', err.message);
        lines.push('PENDING OWNER TASKS: Unable to load');
    }

    return lines.join('\n');
}

/**
 * Build context for the security auditor agent.
 * Includes recent security-related bulletins.
 *
 * @returns {string} Formatted context string
 */
function buildSecurityContext() {
    const lines = [];

    try {
        // Get recent security findings from bulletins
        const securityBulletins = bulletinBoard.getBulletins({
            type: 'security_finding',
            limit: 10,
        });

        if (securityBulletins.length > 0) {
            lines.push('RECENT SECURITY FINDINGS:');
            for (const b of securityBulletins) {
                const desc = b.data.description || b.data.title || JSON.stringify(b.data).slice(0, 100);
                const time = new Date(b.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'America/Toronto',
                });
                lines.push(`- [${time}] ${desc}`);
            }
        } else {
            lines.push('RECENT SECURITY FINDINGS: None in the past 7 days');
        }

        // Get recent task completions that might need review
        const taskBulletins = bulletinBoard.getBulletins({
            type: 'task_completed',
            limit: 5,
        });

        if (taskBulletins.length > 0) {
            lines.push('');
            lines.push('RECENT CODE CHANGES TO REVIEW:');
            for (const b of taskBulletins) {
                const desc = b.data.description || 'No description';
                const repo = b.data.repo || 'unknown repo';
                lines.push(`- ${desc} (${repo})`);
            }
        }
    } catch (err) {
        console.error('[agent-context] Failed to build security context:', err.message);
        lines.push('SECURITY DATA: Unable to load');
    }

    return lines.join('\n');
}

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
                const time = new Date(b.timestamp).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    timeZone: 'America/Toronto',
                });
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
 * Build context for code agents (bridge, code-bridge, code-sqtools).
 * Includes recent task completions and any backlog items.
 *
 * @param {string} agentId - The specific code agent ID
 * @returns {string} Formatted context string
 */
function buildCodeAgentContext(agentId) {
    const lines = [];

    try {
        // Get recent task completions from this agent
        const myTasks = bulletinBoard.getBulletins({
            agentId,
            type: 'task_completed',
            limit: 5,
        });

        if (myTasks.length > 0) {
            lines.push('YOUR RECENT COMPLETED TASKS:');
            for (const b of myTasks) {
                const desc = b.data.description || 'Unnamed task';
                lines.push(`- ${desc}`);
            }
            lines.push('');
        }

        // Get recent tasks from all code agents
        const allCodeTasks = bulletinBoard.getBulletins({
            type: 'task_completed',
            limit: 10,
        }).filter(b => ['bridge', 'code-bridge', 'code-sqtools'].includes(b.agentId));

        if (allCodeTasks.length > 0) {
            lines.push('RECENT TEAM CODE CHANGES:');
            for (const b of allCodeTasks) {
                const desc = b.data.description || 'Unnamed task';
                const repo = b.data.repo || '';
                lines.push(`- [${b.agentId}] ${desc}${repo ? ` (${repo})` : ''}`);
            }
        }
    } catch (err) {
        console.error('[agent-context] Failed to build code agent context:', err.message);
        lines.push('TASK DATA: Unable to load');
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
    let agentSpecificContext = '';
    try {
        switch (agentId) {
            case 'secretary':
                agentSpecificContext = await buildSecretaryContext();
                break;
            case 'security':
                agentSpecificContext = buildSecurityContext();
                break;
            case 'jester':
                agentSpecificContext = buildJesterContext();
                break;
            case 'story-bot':
                agentSpecificContext = buildStoryBotContext();
                break;
            case 'bridge':
            case 'code-bridge':
            case 'code-sqtools':
                agentSpecificContext = buildCodeAgentContext(agentId);
                break;
            default:
                agentSpecificContext = buildGenericContext();
        }
    } catch (err) {
        console.error(`[agent-context] Failed to build context for ${agentId}:`, err.message);
        agentSpecificContext = 'Context data unavailable.';
    }

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
