/**
 * lib/bulletin-watcher.js
 *
 * Event-driven bulletin watcher for inter-agent communication.
 * When a bulletin is posted, notifies agents that watch that bulletin type
 * by posting an ASK message to their channel.
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of bulletin watcher.
 * Enables agents to react to events from other agents (e.g., security agent
 * watching for task_completed to audit new code, marketing watching for
 * vendor_deal bulletins to plan promotions).
 */

'use strict';

const { loadAgents } = require('./agent-registry');

// Rate limiting: max 1 trigger per agent per 5 minutes
const RATE_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
const lastTriggerTimes = new Map();

/**
 * Check if an agent is rate-limited (triggered within the last 5 minutes).
 *
 * @param {string} agentId - Agent ID
 * @returns {boolean} - True if rate-limited
 */
function isRateLimited(agentId) {
    const lastTrigger = lastTriggerTimes.get(agentId);
    if (!lastTrigger) return false;
    return (Date.now() - lastTrigger) < RATE_LIMIT_MS;
}

/**
 * Record a trigger time for rate limiting.
 *
 * @param {string} agentId - Agent ID
 */
function recordTrigger(agentId) {
    lastTriggerTimes.set(agentId, Date.now());
}

/**
 * Clear rate limit state (for testing).
 */
function clearRateLimits() {
    lastTriggerTimes.clear();
}

/**
 * Get agents that watch a specific bulletin type.
 *
 * @param {string} bulletinType - The bulletin type (e.g., 'task_completed')
 * @returns {Array} - Array of agents that watch this type
 */
function getWatchingAgents(bulletinType) {
    let agents;
    try {
        agents = loadAgents();
    } catch (err) {
        console.error('[bulletin-watcher] Failed to load agents:', err.message);
        return [];
    }

    return agents.filter(agent => {
        if (!agent.watches || !agent.watches.bulletin_types) {
            return false;
        }
        return agent.watches.bulletin_types.includes(bulletinType);
    });
}

/**
 * Format a bulletin summary for the notification message.
 *
 * @param {object} bulletin - The bulletin object
 * @returns {string} - Formatted summary
 */
function formatBulletinSummary(bulletin) {
    const { type, agentId, data } = bulletin;

    // Extract a human-readable summary from the bulletin data
    let summary = '';
    if (data.description) {
        summary = data.description;
    } else if (data.title) {
        summary = data.title;
    } else if (data.message) {
        summary = data.message;
    } else {
        // Fallback to stringified data
        summary = JSON.stringify(data).slice(0, 100);
    }

    // Truncate if too long
    if (summary.length > 150) {
        summary = summary.slice(0, 147) + '...';
    }

    return `[${type}] from ${agentId}: ${summary}`;
}

/**
 * Build an ASK message to notify an agent about a bulletin.
 *
 * @param {object} bulletin - The bulletin object
 * @returns {string} - The ASK message to post
 */
function buildNotificationMessage(bulletin) {
    const summary = formatBulletinSummary(bulletin);
    return `ASK: New bulletin posted. ${summary}\n\nReview and respond if action is needed.`;
}

/**
 * Process a new bulletin and notify watching agents.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {object} bulletin - The bulletin object
 * @param {object} [options] - Options
 * @param {Function} [options.onNotify] - Callback when an agent is notified (for testing)
 * @param {boolean} [options.skipRateLimit] - Skip rate limiting (for testing)
 * @returns {Promise<{ notified: string[], skipped: string[], errors: Array<{agentId: string, error: string}> }>}
 */
async function processBulletin(slack, bulletin, options = {}) {
    const { onNotify, skipRateLimit } = options;
    const { type } = bulletin;

    const result = {
        notified: [],
        skipped: [],
        errors: [],
    };

    // Find agents watching this bulletin type
    const watchingAgents = getWatchingAgents(type);

    if (watchingAgents.length === 0) {
        console.log(`[bulletin-watcher] No agents watching bulletin type: ${type}`);
        return result;
    }

    console.log(`[bulletin-watcher] Processing ${type} bulletin for ${watchingAgents.length} watching agent(s)`);

    for (const agent of watchingAgents) {
        // Skip agents without channels
        if (!agent.channel) {
            console.log(`[bulletin-watcher] Skipping ${agent.id}: no channel assigned`);
            result.skipped.push(agent.id);
            continue;
        }

        // Skip the agent that posted the bulletin (don't notify yourself)
        if (agent.id === bulletin.agentId) {
            console.log(`[bulletin-watcher] Skipping ${agent.id}: posted this bulletin`);
            result.skipped.push(agent.id);
            continue;
        }

        // Check rate limit
        if (!skipRateLimit && isRateLimited(agent.id)) {
            console.log(`[bulletin-watcher] Skipping ${agent.id}: rate limited`);
            result.skipped.push(agent.id);
            continue;
        }

        // Build and post notification
        const message = buildNotificationMessage(bulletin);

        try {
            await slack.chat.postMessage({
                channel: agent.channel,
                text: message,
                unfurl_links: false,
            });

            // Record trigger time for rate limiting
            recordTrigger(agent.id);
            result.notified.push(agent.id);

            console.log(`[bulletin-watcher] Notified ${agent.id} about ${type} bulletin`);

            // Call optional callback (for testing)
            if (onNotify) {
                onNotify(agent.id, bulletin);
            }
        } catch (postErr) {
            console.error(`[bulletin-watcher] Failed to notify ${agent.id}:`, postErr.message);
            result.errors.push({ agentId: agent.id, error: postErr.message });
        }
    }

    return result;
}

/**
 * Create a wrapper for the bulletin board postBulletin function that
 * automatically triggers the watcher.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {Function} originalPostBulletin - The original postBulletin function
 * @param {object} [options] - Options passed to processBulletin
 * @returns {Function} - Wrapped postBulletin function
 */
function createWatchedPostBulletin(slack, originalPostBulletin, options = {}) {
    return async function watchedPostBulletin(agentId, type, data) {
        // Call the original postBulletin
        const result = originalPostBulletin(agentId, type, data);

        // If successful, trigger the watcher
        if (result.success && result.bulletin) {
            // Process asynchronously - don't block the original poster
            setImmediate(async () => {
                try {
                    await processBulletin(slack, result.bulletin, options);
                } catch (err) {
                    console.error('[bulletin-watcher] Error processing bulletin:', err.message);
                }
            });
        }

        return result;
    };
}

/**
 * Get the rate limit status for an agent (for testing/debugging).
 *
 * @param {string} agentId - Agent ID
 * @returns {{ rateLimited: boolean, remainingMs: number }}
 */
function getRateLimitStatus(agentId) {
    const lastTrigger = lastTriggerTimes.get(agentId);
    if (!lastTrigger) {
        return { rateLimited: false, remainingMs: 0 };
    }

    const elapsed = Date.now() - lastTrigger;
    const remaining = RATE_LIMIT_MS - elapsed;

    return {
        rateLimited: remaining > 0,
        remainingMs: Math.max(0, remaining),
    };
}

module.exports = {
    processBulletin,
    getWatchingAgents,
    formatBulletinSummary,
    buildNotificationMessage,
    createWatchedPostBulletin,
    isRateLimited,
    recordTrigger,
    clearRateLimits,
    getRateLimitStatus,
    RATE_LIMIT_MS,
};
