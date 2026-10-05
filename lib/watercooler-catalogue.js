/**
 * lib/watercooler-catalogue.js
 *
 * WHAT a standup is: the two standup types with their themes and schedules, each
 * agent's prompt per type, the speaking order (the jester last), who takes part, and
 * the command recognisers that pick a type. Pure data and pure functions.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/watercooler.js unchanged,
 * on the boundary #10 names (catalogue vs. context gathering vs. orchestration). 
 * lib/watercooler.js re-exports every name, so no caller changed.
 */

'use strict';

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

// Standup types and their themes
const STANDUP_TYPES = {
    kickoff: {
        name: 'Kickoff Standup',
        emoji: ':sunrise:',
        theme: 'What are we focused on this week? What opportunities do you see?',
        dayOfWeek: 1, // Monday
        hour: 8,
        minute: 30,
        bulletinLookbackDays: 3, // Weekend bulletins (Friday evening through Monday morning)
    },
    retro: {
        name: 'Retro Standup',
        emoji: ':coffee:',
        theme: 'What did we accomplish? What failed? What surprised us?',
        dayOfWeek: 5, // Friday
        hour: 17,
        minute: 0,
        bulletinLookbackDays: 5, // Past 5 days (Monday through Friday)
    },
};

// Default standup type
const DEFAULT_STANDUP_TYPE = 'retro';

// Agent-specific prompts for different standup types
const AGENT_STANDUP_PROMPTS = {
    kickoff: {
        secretary: 'Open the standup by sharing the calendar for the week - key dates, deadlines, and important events.',
        marketing: 'What campaigns or content are due this week? What marketing initiatives need attention?',
        'social-media': 'Share your content calendar for the week. What posts are planned? Any trending topics to leverage?',
        'story-bot': 'Are there any LinkedIn posts queued? Any stories from last week worth amplifying?',
        security: 'Report any overnight findings or weekend security events. What should we watch for this week?',
        'code-bridge': 'What\'s in the pipeline? What code tasks are queued for this week?',
        'code-sqtools': 'What\'s in the SqTools pipeline? Any integrations or features coming up?',
        jester: 'Challenge the weekly plan. Pick one thing that should be killed or questioned. Be constructively critical.',
    },
    retro: {
        secretary: 'Open the retro by recapping the week - tasks completed vs planned, key accomplishments.',
        marketing: 'What marketing wins or losses happened this week? Any campaign results to share?',
        'social-media': 'How did content perform this week? What posts got engagement? What flopped?',
        'story-bot': 'Flag the best moments from this week that deserve a LinkedIn post. What stories emerged?',
        security: 'Any security incidents this week? What vulnerabilities were found and fixed?',
        'code-bridge': 'What code shipped this week? What failed? Any technical surprises?',
        'code-sqtools': 'What SqTools updates went out? Any integration issues or wins?',
        jester: 'Grade the week A-F. Name the MVP agent. Roast the weakest performer (keep it funny).',
    },
};

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
           /^weekly\s+standup$/i.test(lower) ||
           /^kickoff\s+standup$/i.test(lower) ||
           /^retro\s+standup$/i.test(lower) ||
           /^monday\s+standup$/i.test(lower) ||
           /^friday\s+standup$/i.test(lower);
}

/**
 * Parse standup type from command text.
 *
 * @param {string} text - Query text
 * @returns {string} Standup type ('kickoff' or 'retro')
 */
function parseStandupType(text) {
    if (!text) return DEFAULT_STANDUP_TYPE;
    const lower = text.toLowerCase().trim();

    if (/kickoff|monday/i.test(lower)) {
        return 'kickoff';
    }
    if (/retro|friday/i.test(lower)) {
        return 'retro';
    }

    // Auto-detect based on current day
    const today = new Date();
    const dayOfWeek = today.getDay();

    if (dayOfWeek === 1) { // Monday
        return 'kickoff';
    }
    if (dayOfWeek === 5) { // Friday
        return 'retro';
    }

    // Default to retro for other days
    return DEFAULT_STANDUP_TYPE;
}

/**
 * Get the standup schedule configuration.
 *
 * @returns {{ kickoff: Object, retro: Object }}
 */
function getStandupSchedule() {
    return {
        kickoff: {
            dayOfWeek: STANDUP_TYPES.kickoff.dayOfWeek,
            hour: STANDUP_TYPES.kickoff.hour,
            minute: STANDUP_TYPES.kickoff.minute,
            cron: '30 8 * * 1', // Monday 8:30 AM
            description: 'Monday Kickoff Standup',
        },
        retro: {
            dayOfWeek: STANDUP_TYPES.retro.dayOfWeek,
            hour: STANDUP_TYPES.retro.hour,
            minute: STANDUP_TYPES.retro.minute,
            cron: '0 17 * * 5', // Friday 5:00 PM
            description: 'Friday Retro Standup',
        },
    };
}

module.exports = {
    AGENT_DISPLAY,
    STANDUP_TYPES,
    DEFAULT_STANDUP_TYPE,
    AGENT_STANDUP_PROMPTS,
    getAgentDisplay,
    sortAgentsForStandup,
    filterStandupParticipants,
    isStandupCommand,
    parseStandupType,
    getStandupSchedule,
};
