/**
 * lib/agent-context-ops.js
 *
 * The data contexts for the agents that run the business and the code: the secretary
 * (calendar and owner tasks), the security auditor (findings and changes to review) and
 * the code agents (their own and the team's recent changes).
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of lib/agent-context.js,
 * which re-exports all three builders and still owns the switch that picks one.
 */

'use strict';

// LOGIC CHANGE 2026-10-04 (WORK-TODO #32): one timestamp helper for every bulletin rendering;
// the security and story-bot contexts now get the time as well as the date.
const { formatTimestamp } = require('./time-format');
const { googleCalendar, ownerTasks, bulletinBoard, formatEventsForPrompt } = require('./agent-context-sources');

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

    // LOGIC CHANGE 2026-03-28: Improved pending tasks display - grouped by priority,
    // limited to 5 items max, HIGH priority first. Prevents overwhelming the owner.
    // Get pending owner tasks
    try {
        const pendingTasks = ownerTasks.getPendingTasks();
        if (pendingTasks.length > 0) {
            // Group by priority
            const highPriority = pendingTasks.filter(t => t.priority === 'high');
            const mediumPriority = pendingTasks.filter(t => t.priority === 'medium');
            const lowPriority = pendingTasks.filter(t => t.priority === 'low');

            // Combine in priority order, limit to 5 total
            const prioritized = [...highPriority, ...mediumPriority, ...lowPriority].slice(0, 5);

            lines.push('PENDING OWNER TASKS (top 5 by priority):');
            for (const task of prioritized) {
                const priorityLabel = task.priority === 'high' ? '[HIGH]' : task.priority === 'low' ? '[LOW]' : '[MED]';
                lines.push(`- ${priorityLabel} [${task.agentName}] ${task.description}`);
            }
            if (pendingTasks.length > 5) {
                lines.push(`(${pendingTasks.length - 5} more tasks not shown)`);
            }
        } else {
            lines.push('PENDING OWNER TASKS: All complete!');
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
                const time = formatTimestamp(b.timestamp);
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

module.exports = {
    buildSecretaryContext,
    buildSecurityContext,
    buildCodeAgentContext,
};
