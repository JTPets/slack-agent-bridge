'use strict';

/**
 * lib/memory-tiers-maintenance.js
 *
 * Keeping the tiers honest over time: expiring and archiving (cleanupMemory),
 * promoting frequently re-added short-term entries (autoPromote), the startup sweep
 * across agents, and the one-time migration from the legacy memory layout.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/memory-tiers.js unchanged,
 * on the boundary #10 names (entry lifecycle + file I/O vs. maintenance).
 * lib/memory-tiers.js re-exports every name, so no caller changed.
 */

const fs = require('fs');
const path = require('path');
const {
    MEMORY_FILES, AUTO_PROMOTE_THRESHOLD, getAgentMemoryPath, ensureMemoryDir, loadMemoryFile, saveMemoryFile, isExpired, shouldDecay,
} = require('./memory-tiers-store');
const { promoteToLongTerm } = require('./memory-tiers-entries');

/**
 * Cleanup memory: purge expired short-term, move decayed long-term to archive
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @returns {object} Summary of cleanup actions { expiredCount, archivedCount }
 */
function cleanupMemory(agentId, baseDir) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);

    let expiredCount = 0;
    let archivedCount = 0;

    // Cleanup short-term: remove expired entries
    const shortTermPath = path.join(memoryDir, MEMORY_FILES.shortTerm);
    if (fs.existsSync(shortTermPath)) {
        const shortTerm = loadMemoryFile(shortTermPath, true);
        const validShortTerm = shortTerm.filter(e => {
            if (isExpired(e)) {
                expiredCount++;
                return false;
            }
            return true;
        });
        saveMemoryFile(shortTermPath, validShortTerm);
    }

    // Cleanup long-term: move decayed to archive
    const longTermPath = path.join(memoryDir, MEMORY_FILES.longTerm);
    const archivePath = path.join(memoryDir, MEMORY_FILES.archive);

    if (fs.existsSync(longTermPath)) {
        const longTerm = loadMemoryFile(longTermPath, true);
        const archive = loadMemoryFile(archivePath, true);

        const activeLongTerm = [];
        for (const entry of longTerm) {
            if (shouldDecay(entry)) {
                entry.archivedAt = new Date().toISOString();
                archive.push(entry);
                archivedCount++;
            } else {
                activeLongTerm.push(entry);
            }
        }

        saveMemoryFile(longTermPath, activeLongTerm);
        saveMemoryFile(archivePath, archive);
    }

    return { expiredCount, archivedCount };
}

/**
 * Auto-promote short-term items that have been re-added 3+ times
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @returns {array} List of promoted entry IDs
 */
function autoPromote(agentId, baseDir) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    const shortTermPath = path.join(memoryDir, MEMORY_FILES.shortTerm);

    if (!fs.existsSync(shortTermPath)) {
        return [];
    }

    const shortTerm = loadMemoryFile(shortTermPath, true);
    const promoted = [];

    for (const entry of shortTerm) {
        if (entry.accessCount >= AUTO_PROMOTE_THRESHOLD) {
            const result = promoteToLongTerm(agentId, baseDir, entry.id);
            if (result) {
                promoted.push(entry.id);
            }
        }
    }

    return promoted;
}

/**
 * Run startup cleanup for all agents
 * @param {string} baseDir - Base directory
 * @param {array} agentIds - List of agent IDs to cleanup
 * @returns {object} Cleanup summary per agent
 */
function startupCleanup(baseDir, agentIds) {
    const results = {};

    for (const agentId of agentIds) {
        try {
            const cleanup = cleanupMemory(agentId, baseDir);
            const promoted = autoPromote(agentId, baseDir);

            results[agentId] = {
                expiredCount: cleanup.expiredCount,
                archivedCount: cleanup.archivedCount,
                promotedCount: promoted.length,
                promotedIds: promoted
            };

            if (cleanup.expiredCount > 0 || cleanup.archivedCount > 0 || promoted.length > 0) {
                console.log(`[memory-tiers] Cleanup for ${agentId}: expired=${cleanup.expiredCount}, archived=${cleanup.archivedCount}, promoted=${promoted.length}`);
            }
        } catch (err) {
            console.error(`[memory-tiers] Error cleaning up ${agentId}:`, err.message);
            results[agentId] = { error: err.message };
        }
    }

    return results;
}

/**
 * Migrate existing memory files to new tiered structure
 * Moves tasks.json and history.json into appropriate tiers
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {string} legacyMemoryDir - Path to legacy memory directory
 * @returns {object} Migration summary
 */
function migrateToTiers(agentId, baseDir, legacyMemoryDir) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    ensureMemoryDir(memoryDir);

    const result = {
        migratedTasks: 0,
        migratedHistory: 0,
        migratedContext: false
    };

    // Check if migration marker exists
    const markerPath = path.join(memoryDir, '.migrated');
    if (fs.existsSync(markerPath)) {
        return { alreadyMigrated: true };
    }

    // Migrate context.json (permanent)
    const legacyContextPath = path.join(legacyMemoryDir, 'context.json');
    const newContextPath = path.join(memoryDir, MEMORY_FILES.context);

    if (fs.existsSync(legacyContextPath) && !fs.existsSync(newContextPath)) {
        const context = loadMemoryFile(legacyContextPath);
        saveMemoryFile(newContextPath, context);
        result.migratedContext = true;
    }

    // Migrate tasks.json (active tasks -> working memory)
    const legacyTasksPath = path.join(legacyMemoryDir, 'tasks.json');
    const workingPath = path.join(memoryDir, MEMORY_FILES.working);

    if (fs.existsSync(legacyTasksPath)) {
        const tasks = loadMemoryFile(legacyTasksPath, true);
        const workingEntries = tasks.map(task => ({
            id: task.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            content: task,
            created: task.created || new Date().toISOString(),
            lastAccessed: new Date().toISOString(),
            ttl: 0,
            accessCount: 1,
            source: 'migrated-task'
        }));

        const existing = loadMemoryFile(workingPath, true);
        saveMemoryFile(workingPath, [...existing, ...workingEntries]);
        result.migratedTasks = workingEntries.length;
    }

    // Migrate history.json (completed tasks -> long-term memory)
    const legacyHistoryPath = path.join(legacyMemoryDir, 'history.json');
    const longTermPath = path.join(memoryDir, MEMORY_FILES.longTerm);

    if (fs.existsSync(legacyHistoryPath)) {
        const history = loadMemoryFile(legacyHistoryPath, true);
        const longTermEntries = history.map(task => ({
            id: task.id || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            content: task,
            created: task.created || new Date().toISOString(),
            lastAccessed: task.completedAt || task.failedAt || new Date().toISOString(),
            ttl: 0,
            accessCount: 1,
            source: 'migrated-history',
            promotedAt: new Date().toISOString()
        }));

        const existing = loadMemoryFile(longTermPath, true);
        saveMemoryFile(longTermPath, [...existing, ...longTermEntries]);
        result.migratedHistory = longTermEntries.length;
    }

    // Write migration marker
    if (result.migratedTasks > 0 || result.migratedHistory > 0 || result.migratedContext) {
        fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
        console.log(`[memory-tiers] Migrated ${agentId}: tasks=${result.migratedTasks}, history=${result.migratedHistory}, context=${result.migratedContext}`);
    }

    return result;
}

module.exports = {
    cleanupMemory,
    autoPromote,
    startupCleanup,
    migrateToTiers,
};
