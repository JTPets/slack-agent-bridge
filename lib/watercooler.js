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
 *
 * LOGIC CHANGE 2026-03-28: Added two standup types - "kickoff" (Monday 8:30 AM) and
 * "retro" (Friday 5:00 PM). Each has a different theme and agent prompts.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): split on the boundary #10 names. The
 * catalogue is lib/watercooler-catalogue.js, context gathering and the state file are
 * lib/watercooler-context.js, the per-agent prompt is lib/watercooler-prompt.js. This
 * file keeps runStandup() and re-exports all of it under the names it always had.
 */

'use strict';

const { loadAgents, getActiveAgents } = require('./agent-registry');
const bulletinBoard = require('./bulletin-board');
const { runLLM } = require('./llm-runner');
const catalogue = require('./watercooler-catalogue');
const context = require('./watercooler-context');
const prompt = require('./watercooler-prompt');

const {
    AGENT_DISPLAY, STANDUP_TYPES, DEFAULT_STANDUP_TYPE, AGENT_STANDUP_PROMPTS,
    getAgentDisplay, sortAgentsForStandup, filterStandupParticipants,
    isStandupCommand, parseStandupType, getStandupSchedule,
} = catalogue;
const {
    init, DEFAULT_WATERCOOLER_STATE_FILE, getLastStandupTime, saveLastStandupTime,
    getBulletinsSinceLastStandup, getRecentCompletions, getAgentBacklog,
} = context;
const {
    formatBulletinsSummary, formatCompletionsSummary, formatBacklogSummary,
    formatPreviousMessages, buildStandupPrompt,
} = prompt;

// Default channel for standup (ops channel)
const DEFAULT_STANDUP_CHANNEL = process.env.OPS_CHANNEL_ID;

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
 * @param {string} [standupType] - Type of standup: 'kickoff' or 'retro' (default: 'retro')
 * @returns {Promise<{ success: boolean, messagesPosted: number, errors: Array<string> }>}
 */
async function runStandup(slack, channelId, standupType) {
    const targetChannel = channelId || DEFAULT_STANDUP_CHANNEL;
    const type = standupType || DEFAULT_STANDUP_TYPE;
    const typeConfig = STANDUP_TYPES[type];

    if (!typeConfig) {
        return { success: false, messagesPosted: 0, errors: [`Unknown standup type: ${type}. Use 'kickoff' or 'retro'.`] };
    }

    if (!targetChannel) {
        return { success: false, messagesPosted: 0, errors: ['No channel specified and OPS_CHANNEL_ID not set'] };
    }

    console.log(`[watercooler] Starting ${type} standup`);

    // Check Gemini configuration
    if (!isGeminiConfigured()) {
        console.warn('[watercooler] GEMINI_API_KEY not configured. Standup requires Gemini for most agents.');
    }

    // Load context data - use type-specific lookback period
    const bulletins = getBulletinsSinceLastStandup(typeConfig.bulletinLookbackDays);
    const completions = getRecentCompletions(typeConfig.bulletinLookbackDays);

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
            text: `${typeConfig.emoji} *${typeConfig.name}* ${typeConfig.emoji}\n_${typeConfig.theme}_\nLet\'s hear from everyone...`,
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
            standupType: type,
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

            // LOGIC CHANGE 2026-09-11: Pass agentId so standup calls land in the
            // per-agent provider verdict counter instead of the 'unknown' bucket.
            const result = await runLLM(prompt, {
                provider,
                maxTurns: 5,
                timeout: 60000,
                agentId: agent.id,
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
        const footerLines = [`${typeConfig.emoji} *${typeConfig.name} complete!*`];
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
            description: `${typeConfig.name} completed: ${messagesPosted - 2} agents participated`,
            standupType: type,
            participants: sortedParticipants.map(a => a.id),
            errors: errors.length,
        });
    } catch (err) {
        console.error('[watercooler] Failed to post standup bulletin:', err.message);
    }

    console.log(`[watercooler] ${typeConfig.name} complete: ${messagesPosted} messages posted, ${errors.length} errors`);

    return {
        success: errors.length < sortedParticipants.length,
        messagesPosted,
        errors,
    };
}

module.exports = {
    // Main function
    runStandup,

    // Command detection and parsing
    isStandupCommand,
    parseStandupType,
    getStandupSchedule,

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

    // Path override (WORK-TODO #24)
    init,

    // Constants (exported for testing)
    AGENT_DISPLAY,
    DEFAULT_WATERCOOLER_STATE_FILE,
    // A getter, not a snapshot: exporting the path by value would freeze the
    // pre-init() path into every reader and make the override look like it worked.
    get WATERCOOLER_STATE_FILE() { return context.getStateFile(); },
    STANDUP_TYPES,
    AGENT_STANDUP_PROMPTS,
    DEFAULT_STANDUP_TYPE,
};
