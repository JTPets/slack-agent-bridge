'use strict';

// LOGIC CHANGE 2026-03-26: Refactored to integrate with tiered memory system.
// Maintains backward compatibility with legacy memory files while supporting
// per-agent tiered memory (context, working, short-term, long-term, archive).
//
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the legacy file store moved to
// memory/memory-store.js and the prompt-context builders to memory/memory-context.js.
// This file keeps the per-agent tiered wrappers and re-exports every name it had.

const {
    getTiers, getBaseDir, loadMemory, saveMemory, addTask, completeTask, failTask,
    getTaskHistory, getActiveTasks, getContext, updateContext,
} = require('./memory-store');
const { buildTaskContext, buildAgentContext } = require('./memory-context');

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
    getTaskHistory,
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
