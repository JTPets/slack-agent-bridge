/**
 * lib/watercooler.js
 *
 * Multi-agent standup conversation orchestrator.
 * Reads bulletins, backlogs, and recent task completions, then has each active
 * agent share an update in their personality voice. Agents can reference and
 * respond to what previous agents said, creating a natural conversation.
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of watercooler standup system.
 * Enables weekly team standups where agents share updates, concerns, and opportunities.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { loadAgents, getActiveAgents } = require('./agent-registry');
const bulletinBoard = require('./bulletin-board');
const { runLLM } = require('./llm-runner');

// Memory and history file paths
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');

// State file for tracking last standup
const WATERCOOLER_STATE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'watercooler-state.json');

// Agent display configuration (emoji and order)
const AGENT_DISPLAY = {
    'secretary': { emoji: ':calendar:', order: 1 },
    'security': { emoji: ':shield:', order: 2 },
    'jester': { emoji: ':performing_arts:', order: 3 },
    'story-bot': { emoji: ':pen:', order: 4 },
    'social-media': { emoji: ':camera:', order: 5 },
    'marketing': { emoji: ':chart_with_upwards_trend:', order: 6 },
    'code-bridge': { emoji: ':hammer_and_wrench:', order: 7 },
    'code-sqtools': { emoji: ':gear:', order: 8 },
    'storefront': { emoji: ':shopping_trolley:', order: 9 },
    'bridge': { emoji: ':robot_face:', order: 10 },
};

// Default channel for standup (ops channel)
const DEFAULT_STANDUP_CHANNEL = process.env.OPS_CHANNEL_ID;

/**
 * Load JSON file with fallback to default value.
 *
 * @param {string} filePath - Path to JSON file
 * @param {any} defaultValue - Default value if file doesn't exist
 * @returns {any} Parsed JSON or default value
 */
function loadJsonFile(filePath, defaultValue) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        if (!data || !data.trim()) return defaultValue;
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') return defaultValue;
        console.error(`[watercooler] Failed to load ${filePath}:`, err.message);
        return defaultValue;
    }
}

/**
 * Save JSON file.
 *
 * @param {string} filePath - Path to JSON file
 * @param {any} data - Data to save
 */
function saveJsonFile(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Get the last standup timestamp.
 *
 * @returns {string|null} ISO timestamp of last standup or null
 */
function getLastStandupTime() {
    const state = loadJsonFile(WATERCOOLER_STATE_FILE, {});
    return state.lastStandup || null;
}

/**
 * Save the last standup timestamp.
 *
 * @param {string} timestamp - ISO timestamp
 */
function saveLastStandupTime(timestamp) {
    const state = loadJsonFile(WATERCOOLER_STATE_FILE, {});
    state.lastStandup = timestamp;
    saveJsonFile(WATERCOOLER_STATE_FILE, state);
}

/**
 * Get bulletins since last standup.
 *
 * @returns {Array} Array of bulletin objects
 */
function getBulletinsSinceLastStandup() {
    const lastStandup = getLastStandupTime();
    const filters = { limit: 50 };
    if (lastStandup) {
        filters.since = lastStandup;
    }
    return bulletinBoard.getBulletins(filters);
}

/**
 * Get recent task completions from history.
 *
 * @param {number} daysBack - Number of days to look back
 * @returns {Array} Array of completed tasks
 */
function getRecentCompletions(daysBack = 7) {
    const history = loadJsonFile(HISTORY_FILE, []);
    const cutoff = Date.now() - (daysBack * 24 * 60 * 60 * 1000);

    return history.filter(t => {
        if (t.status !== 'completed') return false;
        const completedAt = t.completedAt ? new Date(t.completedAt).getTime() : 0;
        return completedAt > cutoff;
    });
}

/**
 * Load an agent's backlog from their memory directory.
 *
 * @param {string} agentId - Agent ID
 * @returns {Array} Array of backlog items
 */
function getAgentBacklog(agentId) {
    const backlogPath = path.join(__dirname, '..', 'agents', agentId, 'memory', 'backlog.json');
    const data = loadJsonFile(backlogPath, { backlog: [] });
    return data.backlog || [];
}

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
 * @param {Object} context - Context object with bulletins, completions, etc.
 * @returns {string} Full prompt for the agent
 */
function buildStandupPrompt(agent, context) {
    const { bulletins, completions, backlog, previousMessages, isJesterFinalWord } = context;

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

    // The standup request
    if (isJesterFinalWord) {
        parts.push('=== YOUR TASK ===');
        parts.push('You get the final word at this standup. You\'ve heard everyone else speak.');
        parts.push('In 2-3 sentences, deliver your signature sharp wit. Poke holes in what others said.');
        parts.push('Call out anything overly optimistic or contradictory. Be the devil\'s advocate.');
        parts.push('Keep it clever - you\'re here to make people laugh AND think.');
        parts.push('');
        parts.push('Respond with ONLY your standup message. No preamble, no "Here\'s my update:", just the message.');
    } else {
        parts.push('=== YOUR TASK ===');
        parts.push('Share your standup update in 2-3 sentences in your personality voice.');
        parts.push('Answer: What did you notice this week? What concerns you? What opportunity do you see?');
        parts.push('If other agents have spoken, react to what they said - agree, disagree, build on their ideas.');
        parts.push('Reference other agents by name when responding to them.');
        parts.push('');
        parts.push('Respond with ONLY your standup message. No preamble, no "Here\'s my update:", just the message.');
    }

    return parts.join('\n');
}

/**
 * Get the display info for an agent.
 *
 * @param {string} agentId - Agent ID
 * @param {string} agentName - Agent name
 * @returns {{ emoji: string, order: number }}
 */
function getAgentDisplay(agentId, agentName) {
    const display = AGENT_DISPLAY[agentId];
    if (display) return display;

    // Default for unknown agents
    return { emoji: ':robot_face:', order: 99 };
}

/**
 * Sort agents by standup order.
 * Jester is special - they speak last for final word.
 *
 * @param {Array} agents - Array of agent configs
 * @returns {Array} Sorted agents (Jester last)
 */
function sortAgentsForStandup(agents) {
    return agents.slice().sort((a, b) => {
        // Jester always last
        if (a.id === 'jester') return 1;
        if (b.id === 'jester') return -1;

        const orderA = getAgentDisplay(a.id, a.name).order;
        const orderB = getAgentDisplay(b.id, b.name).order;
        return orderA - orderB;
    });
}

/**
 * Filter agents for standup participation.
 * Only active agents with Gemini configured can participate.
 *
 * @param {Array} agents - Array of all agents
 * @returns {Array} Filtered agents that can participate
 */
function filterStandupParticipants(agents) {
    // Get active agents (no status="planned")
    const active = agents.filter(a => !a.status);

    // Filter to only agents that use Gemini (or Claude for code agents)
    // Code agents use Claude but can still participate
    return active.filter(a => {
        // Always include these agents regardless of provider
        const alwaysInclude = ['secretary', 'security', 'jester', 'story-bot', 'social-media', 'marketing', 'code-bridge', 'code-sqtools'];
        return alwaysInclude.includes(a.id);
    });
}

/**
 * Check if Gemini API is configured.
 *
 * @returns {boolean}
 */
function isGeminiConfigured() {
    return !!process.env.GEMINI_API_KEY;
}

/**
 * Run the standup conversation.
 *
 * @param {Object} slack - Slack WebClient instance
 * @param {string} [channelId] - Channel to post standup (default: OPS_CHANNEL_ID)
 * @returns {Promise<{ success: boolean, messagesPosted: number, errors: Array<string> }>}
 */
async function runStandup(slack, channelId) {
    const targetChannel = channelId || DEFAULT_STANDUP_CHANNEL;

    if (!targetChannel) {
        return { success: false, messagesPosted: 0, errors: ['No channel specified and OPS_CHANNEL_ID not set'] };
    }

    console.log('[watercooler] Starting standup');

    // Check Gemini configuration
    if (!isGeminiConfigured()) {
        console.warn('[watercooler] GEMINI_API_KEY not configured. Standup requires Gemini for most agents.');
    }

    // Load context data
    const bulletins = getBulletinsSinceLastStandup();
    const completions = getRecentCompletions(7);

    console.log(`[watercooler] Context: ${bulletins.length} bulletins, ${completions.length} completions`);

    // Get and filter agents
    const allAgents = loadAgents();
    const participants = filterStandupParticipants(allAgents);
    const sortedParticipants = sortAgentsForStandup(participants);

    if (sortedParticipants.length === 0) {
        return { success: false, messagesPosted: 0, errors: ['No agents available for standup'] };
    }

    console.log(`[watercooler] ${sortedParticipants.length} agents participating: ${sortedParticipants.map(a => a.id).join(', ')}`);

    // Post standup header
    try {
        await slack.chat.postMessage({
            channel: targetChannel,
            text: ':coffee: *Weekly Team Standup* :coffee:\nLet\'s hear from everyone...',
            unfurl_links: false,
        });
    } catch (err) {
        return { success: false, messagesPosted: 0, errors: [`Failed to post standup header: ${err.message}`] };
    }

    // Track conversation history
    const previousMessages = [];
    let messagesPosted = 1; // Count the header
    const errors = [];

    // Each agent takes a turn
    for (const agent of sortedParticipants) {
        const isJester = agent.id === 'jester';
        const isLastAgent = sortedParticipants.indexOf(agent) === sortedParticipants.length - 1;
        const isJesterFinalWord = isJester && isLastAgent;

        // Get agent-specific backlog
        const backlog = getAgentBacklog(agent.id);

        // Build the prompt
        const context = {
            bulletins,
            completions,
            backlog,
            previousMessages,
            isJesterFinalWord,
        };

        const prompt = buildStandupPrompt(agent, context);

        // Determine provider
        const provider = agent.llm_provider || 'gemini';

        // Check if provider is available
        if (provider === 'gemini' && !isGeminiConfigured()) {
            console.warn(`[watercooler] Skipping ${agent.id} - Gemini not configured`);
            errors.push(`Skipped ${agent.id}: Gemini not configured`);
            continue;
        }

        try {
            console.log(`[watercooler] Generating response for ${agent.id} (${provider})`);

            const result = await runLLM(prompt, {
                provider,
                maxTurns: 5,
                timeout: 60000,
            });

            const message = result.output.trim();

            if (!message) {
                console.warn(`[watercooler] Empty response from ${agent.id}`);
                errors.push(`${agent.id} returned empty response`);
                continue;
            }

            // Format and post the message
            const display = getAgentDisplay(agent.id, agent.name);
            const formattedMessage = `${display.emoji} *${agent.name}:* ${message}`;

            await slack.chat.postMessage({
                channel: targetChannel,
                text: formattedMessage,
                unfurl_links: false,
            });

            messagesPosted++;
            console.log(`[watercooler] Posted ${agent.id}'s standup`);

            // Add to conversation history for next agents
            previousMessages.push({
                agentName: agent.name,
                message: message,
            });

            // Small delay between messages for readability
            await new Promise(resolve => setTimeout(resolve, 1000));

        } catch (err) {
            console.error(`[watercooler] Failed to get response from ${agent.id}:`, err.message);
            errors.push(`${agent.id}: ${err.message}`);
        }
    }

    // Save standup timestamp
    saveLastStandupTime(new Date().toISOString());

    // Post footer
    try {
        const footerLines = [':coffee: *Standup complete!*'];
        if (errors.length > 0) {
            footerLines.push(`_${errors.length} agent(s) skipped due to errors._`);
        }
        await slack.chat.postMessage({
            channel: targetChannel,
            text: footerLines.join('\n'),
            unfurl_links: false,
        });
        messagesPosted++;
    } catch (err) {
        errors.push(`Failed to post footer: ${err.message}`);
    }

    // Post bulletin about standup
    try {
        bulletinBoard.postBulletin('watercooler', 'milestone', {
            description: `Weekly standup completed: ${messagesPosted - 2} agents participated`,
            participants: sortedParticipants.map(a => a.id),
            errors: errors.length,
        });
    } catch (err) {
        console.error('[watercooler] Failed to post standup bulletin:', err.message);
    }

    console.log(`[watercooler] Standup complete: ${messagesPosted} messages posted, ${errors.length} errors`);

    return {
        success: errors.length < sortedParticipants.length,
        messagesPosted,
        errors,
    };
}

/**
 * Check if a query is a standup trigger command.
 *
 * @param {string} text - Query text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isStandupCommand(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return /^team\s+standup$/i.test(lower) ||
           /^standup$/i.test(lower) ||
           /^watercooler$/i.test(lower) ||
           /^weekly\s+standup$/i.test(lower);
}

module.exports = {
    // Main function
    runStandup,

    // Command detection
    isStandupCommand,

    // Helper functions (exported for testing)
    getLastStandupTime,
    saveLastStandupTime,
    getBulletinsSinceLastStandup,
    getRecentCompletions,
    getAgentBacklog,
    formatBulletinsSummary,
    formatCompletionsSummary,
    formatBacklogSummary,
    formatPreviousMessages,
    buildStandupPrompt,
    getAgentDisplay,
    sortAgentsForStandup,
    filterStandupParticipants,
    isGeminiConfigured,

    // Constants (exported for testing)
    AGENT_DISPLAY,
    WATERCOOLER_STATE_FILE,
};
