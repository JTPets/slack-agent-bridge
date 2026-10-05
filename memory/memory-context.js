'use strict';

// memory/memory-context.js
//
// The text a prompt is given from memory: recent task history for a TASK: prompt
// (buildTaskContext) and one agent's tiered memory for its prompt (buildAgentContext).
// Reads only.
//
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of memory/memory-manager.js
// unchanged, on the boundary #10 names (task/context storage vs. the prompt-context
// builders, which are rendering). memory/memory-manager.js re-exports every name.

const { TASKS_FILE, CONTEXT_FILE, HISTORY_FILE, getTiers, getBaseDir, loadMemory } = require('./memory-store');

// LOGIC CHANGE 2026-03-26: Added buildTaskContext() to provide CC with historical
// context from previous tasks, enabling it to avoid duplicate work and build on
// previous results. Returns a formatted string for prepending to task prompts.
function buildTaskContext() {
    try {
        // Load context.json (owner info, preferences)
        const context = loadMemory(CONTEXT_FILE);

        // Load history.json and get last 10 entries (most recent first)
        const history = loadMemory(HISTORY_FILE);
        const recentHistory = history.slice(-10).reverse();

        // Load all active tasks from tasks.json
        const activeTasks = loadMemory(TASKS_FILE).filter(t => t.status === 'active');

        // Check if we have any meaningful data
        const hasContext = context && Object.keys(context).length > 0;
        const hasHistory = recentHistory.length > 0;
        const hasActiveTasks = activeTasks.length > 0;

        if (!hasContext && !hasHistory && !hasActiveTasks) {
            return 'AGENT CONTEXT:\nNo task history available.';
        }

        // Build context string
        let result = 'AGENT CONTEXT:\n';

        // Add owner info from context.json
        if (hasContext) {
            if (context.owner) result += `Owner: ${context.owner}\n`;
            if (context.timezone) result += `Timezone: ${context.timezone}\n`;
        }

        // Add recent task history
        if (hasHistory) {
            result += '\nRECENT TASK HISTORY (last 10):\n';
            for (const task of recentHistory) {
                const timestamp = task.completedAt || task.failedAt || task.created;
                const status = task.status || 'unknown';
                const desc = task.description || 'No description';
                const repo = task.repo ? ` (repo: ${task.repo})` : '';
                result += `- [${timestamp}] [${status}] ${desc}${repo}\n`;
            }
        }

        // Add currently active tasks
        if (hasActiveTasks) {
            result += '\nCURRENTLY ACTIVE TASKS:\n';
            for (const task of activeTasks) {
                const desc = task.description || 'No description';
                const started = task.created || 'unknown';
                result += `- ${desc} (started: ${started})\n`;
            }
        }

        result += '\nUse this context to avoid duplicate work and build on previous results.';

        return result;
    } catch (err) {
        // If anything fails, return minimal string - never block task execution
        return 'AGENT CONTEXT:\nNo task history available.';
    }
}

// ============================================================================
// Per-Agent Tiered Memory Functions
// LOGIC CHANGE 2026-03-26: New tiered memory API for multi-agent support
// ============================================================================

/**
 * Build context for a specific agent using tiered memory
 * @param {string} agentId - Agent ID (e.g., 'bridge', 'secretary')
 * @returns {string} Formatted context string for prompts
 */
function buildAgentContext(agentId) {
    try {
        const tiers = getTiers();
        const baseDir = getBaseDir();
        const memory = tiers.getRelevantMemory(agentId, baseDir);

        // Check if we have any meaningful data
        const hasContext = memory.context && Object.keys(memory.context).length > 0;
        const hasWorking = memory.working && memory.working.length > 0;
        const hasShortTerm = memory.shortTerm && memory.shortTerm.length > 0;
        const hasLongTerm = memory.longTerm && memory.longTerm.length > 0;

        if (!hasContext && !hasWorking && !hasShortTerm && !hasLongTerm) {
            return 'AGENT CONTEXT:\nNo memory available.';
        }

        let result = 'AGENT CONTEXT:\n';

        // Add permanent context (owner info, preferences)
        if (hasContext) {
            const ctx = memory.context;
            if (ctx.owner) result += `Owner: ${ctx.owner}\n`;
            if (ctx.timezone) result += `Timezone: ${ctx.timezone}\n`;

            // Add any other permanent preferences
            const skipKeys = ['owner', 'timezone', '_lastUpdated'];
            for (const [key, value] of Object.entries(ctx)) {
                if (!skipKeys.includes(key)) {
                    result += `${key}: ${JSON.stringify(value)}\n`;
                }
            }
        }

        // Add working memory (current task state)
        if (hasWorking) {
            result += '\nCURRENT SESSION:\n';
            for (const entry of memory.working.slice(-5)) {
                const content = typeof entry.content === 'string'
                    ? entry.content
                    : JSON.stringify(entry.content);
                result += `- ${content}\n`;
            }
        }

        // Add recent short-term memory (last 48-72h)
        if (hasShortTerm) {
            result += '\nRECENT (last 48h):\n';
            for (const entry of memory.shortTerm.slice(-10)) {
                const content = typeof entry.content === 'string'
                    ? entry.content
                    : (entry.content.description || JSON.stringify(entry.content));
                result += `- [${entry.source}] ${content}\n`;
            }
        }

        // Add long-term patterns/history (most accessed first)
        if (hasLongTerm) {
            result += '\nLEARNED PATTERNS:\n';
            for (const entry of memory.longTerm.slice(0, 5)) {
                const content = typeof entry.content === 'string'
                    ? entry.content
                    : (entry.content.description || JSON.stringify(entry.content));
                result += `- ${content} (accessed ${entry.accessCount}x)\n`;
            }
        }

        result += '\nUse this context to avoid duplicate work and build on previous results.';

        return result;
    } catch (err) {
        // Fallback to legacy context builder
        return buildTaskContext();
    }
}

module.exports = { buildTaskContext, buildAgentContext };
