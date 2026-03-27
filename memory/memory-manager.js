'use strict';

// LOGIC CHANGE 2026-03-26: Refactored to integrate with tiered memory system.
// Maintains backward compatibility with legacy memory files while supporting
// per-agent tiered memory (context, working, short-term, long-term, archive).

const fs = require('fs');
const path = require('path');

// Legacy file paths for backward compatibility
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const CONTEXT_FILE = path.join(__dirname, 'context.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Lazy-load memory-tiers to avoid circular dependencies
let memoryTiers = null;
function getTiers() {
    if (!memoryTiers) {
        memoryTiers = require('../lib/memory-tiers');
    }
    return memoryTiers;
}

// Get base directory for the project
function getBaseDir() {
    return path.join(__dirname, '..');
}

function loadMemory(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return file.includes('tasks') || file.includes('history') ? [] : {};
        }
        throw err;
    }
}

function saveMemory(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function addTask(task) {
    const tasks = loadMemory(TASKS_FILE);
    const newTask = {
        id: Date.now().toString(),
        created: new Date().toISOString(),
        status: 'active',
        ...task
    };
    tasks.push(newTask);
    saveMemory(TASKS_FILE, tasks);
    return newTask;
}

function completeTask(id, outcome) {
    const tasks = loadMemory(TASKS_FILE);
    const history = loadMemory(HISTORY_FILE);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = tasks.splice(idx, 1)[0];
    task.status = 'completed';
    task.outcome = outcome;
    task.completedAt = new Date().toISOString();
    history.push(task);

    saveMemory(TASKS_FILE, tasks);
    saveMemory(HISTORY_FILE, history);
    return task;
}

function failTask(id, error) {
    const tasks = loadMemory(TASKS_FILE);
    const history = loadMemory(HISTORY_FILE);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = tasks.splice(idx, 1)[0];
    task.status = 'failed';
    task.error = error;
    task.failedAt = new Date().toISOString();
    history.push(task);

    saveMemory(TASKS_FILE, tasks);
    saveMemory(HISTORY_FILE, history);
    return task;
}

function getActiveTasks() {
    return loadMemory(TASKS_FILE).filter(t => t.status === 'active');
}

function getContext() {
    return loadMemory(CONTEXT_FILE);
}

function updateContext(key, value) {
    const context = loadMemory(CONTEXT_FILE);
    context[key] = value;
    saveMemory(CONTEXT_FILE, context);
    return context;
}

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

/**
 * Add entry to agent's working memory (cleared after task)
 * @param {string} agentId - Agent ID
 * @param {object} entry - Entry with { content, source }
 * @returns {object} Created entry
 */
function addAgentWorkingMemory(agentId, entry) {
    const tiers = getTiers();
    return tiers.addWorkingMemory(agentId, getBaseDir(), entry);
}

/**
 * Clear agent's working memory (call after task completion)
 * @param {string} agentId - Agent ID
 */
function clearAgentWorkingMemory(agentId) {
    const tiers = getTiers();
    tiers.clearWorkingMemory(agentId, getBaseDir());
}

/**
 * Add entry to agent's short-term memory with TTL
 * @param {string} agentId - Agent ID
 * @param {object} entry - Entry with { content, source }
 * @param {number} ttlHours - Time to live in hours (default: 48)
 * @returns {object} Created entry
 */
function addAgentShortTerm(agentId, entry, ttlHours) {
    const tiers = getTiers();
    return tiers.addShortTerm(agentId, getBaseDir(), entry, ttlHours);
}

/**
 * Promote entry from short-term to long-term memory
 * @param {string} agentId - Agent ID
 * @param {string} entryId - Entry ID to promote
 * @returns {object|null} Promoted entry or null
 */
function promoteAgentMemory(agentId, entryId) {
    const tiers = getTiers();
    return tiers.promoteToLongTerm(agentId, getBaseDir(), entryId);
}

/**
 * Add permanent context to agent's memory
 * @param {string} agentId - Agent ID
 * @param {string} key - Context key
 * @param {*} value - Value to store
 * @returns {object} Updated context
 */
function setAgentPermanent(agentId, key, value) {
    const tiers = getTiers();
    return tiers.addPermanent(agentId, getBaseDir(), key, value);
}

/**
 * Run memory cleanup for an agent
 * @param {string} agentId - Agent ID
 * @returns {object} Cleanup summary
 */
function cleanupAgentMemory(agentId) {
    const tiers = getTiers();
    return tiers.cleanupMemory(agentId, getBaseDir());
}

/**
 * Run auto-promotion for an agent
 * @param {string} agentId - Agent ID
 * @returns {array} List of promoted entry IDs
 */
function autoPromoteAgentMemory(agentId) {
    const tiers = getTiers();
    return tiers.autoPromote(agentId, getBaseDir());
}

/**
 * Run startup cleanup for all agents
 * @param {array} agentIds - List of agent IDs
 * @returns {object} Cleanup summary per agent
 */
function startupMemoryCleanup(agentIds) {
    const tiers = getTiers();
    return tiers.startupCleanup(getBaseDir(), agentIds);
}

/**
 * Migrate legacy memory files to tiered structure
 * @param {string} agentId - Agent ID
 * @returns {object} Migration summary
 */
function migrateAgentMemory(agentId) {
    const tiers = getTiers();
    // Use current memory directory as legacy source
    return tiers.migrateToTiers(agentId, getBaseDir(), __dirname);
}

module.exports = {
    // Legacy functions (backward compatible)
    loadMemory,
    saveMemory,
    addTask,
    completeTask,
    failTask,
    getActiveTasks,
    getContext,
    updateContext,
    buildTaskContext,

    // Per-agent tiered memory functions
    buildAgentContext,
    addAgentWorkingMemory,
    clearAgentWorkingMemory,
    addAgentShortTerm,
    promoteAgentMemory,
    setAgentPermanent,
    cleanupAgentMemory,
    autoPromoteAgentMemory,
    startupMemoryCleanup,
    migrateAgentMemory
};
