'use strict';

/**
 * lib/memory-tiers-entries.js
 *
 * Writing to and reading from one agent's tiers: working, short-term (with re-add
 * counting), promotion to long-term, permanent context, the relevant-memory read, and
 * touching an entry's lastAccessed.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/memory-tiers.js unchanged,
 * on the boundary #10 names (entry lifecycle + file I/O vs. maintenance).
 * lib/memory-tiers.js re-exports every name, so no caller changed.
 */

const fs = require('fs');
const path = require('path');
const {
    MEMORY_FILES, DEFAULT_SHORT_TERM_TTL, createEntry, getAgentMemoryPath, ensureMemoryDir, loadMemoryFile, saveMemoryFile, isExpired,
} = require('./memory-tiers-store');

// ============================================================================
// Core Tiered Memory Functions
// ============================================================================

/**
 * Add an entry to working memory (cleared after each task)
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {object} entry - Entry with { content, source }
 * @returns {object} The created entry
 */
function addWorkingMemory(agentId, baseDir, entry) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    ensureMemoryDir(memoryDir);

    const filePath = path.join(memoryDir, MEMORY_FILES.working);
    const working = loadMemoryFile(filePath, true);

    const newEntry = createEntry(entry.content, entry.source, 0);
    working.push(newEntry);

    saveMemoryFile(filePath, working);
    return newEntry;
}

/**
 * Clear working memory (call after task completion)
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 */
function clearWorkingMemory(agentId, baseDir) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    const filePath = path.join(memoryDir, MEMORY_FILES.working);

    if (fs.existsSync(filePath)) {
        saveMemoryFile(filePath, []);
    }
}

/**
 * Add an entry to short-term memory with TTL
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {object} entry - Entry with { content, source }
 * @param {number} ttlHours - Time to live in hours (default: 48)
 * @returns {object} The created entry
 */
function addShortTerm(agentId, baseDir, entry, ttlHours = DEFAULT_SHORT_TERM_TTL) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    ensureMemoryDir(memoryDir);

    const filePath = path.join(memoryDir, MEMORY_FILES.shortTerm);
    const shortTerm = loadMemoryFile(filePath, true);

    // Check if similar content already exists (for auto-promote tracking)
    const contentStr = typeof entry.content === 'string'
        ? entry.content
        : JSON.stringify(entry.content);

    const existing = shortTerm.find(e => {
        const existingStr = typeof e.content === 'string'
            ? e.content
            : JSON.stringify(e.content);
        return existingStr === contentStr;
    });

    if (existing) {
        // Increment access count and update lastAccessed
        existing.accessCount = (existing.accessCount || 1) + 1;
        existing.lastAccessed = new Date().toISOString();
        // Refresh TTL
        existing.created = new Date().toISOString();
        saveMemoryFile(filePath, shortTerm);
        return existing;
    }

    const newEntry = createEntry(entry.content, entry.source, ttlHours);
    shortTerm.push(newEntry);

    saveMemoryFile(filePath, shortTerm);
    return newEntry;
}

/**
 * Promote an entry from short-term to long-term memory
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {string} entryId - ID of the entry to promote
 * @returns {object|null} The promoted entry or null if not found
 */
function promoteToLongTerm(agentId, baseDir, entryId) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);

    const shortTermPath = path.join(memoryDir, MEMORY_FILES.shortTerm);
    const longTermPath = path.join(memoryDir, MEMORY_FILES.longTerm);

    const shortTerm = loadMemoryFile(shortTermPath, true);
    const longTerm = loadMemoryFile(longTermPath, true);

    const idx = shortTerm.findIndex(e => e.id === entryId);
    if (idx === -1) return null;

    const entry = shortTerm.splice(idx, 1)[0];
    entry.ttl = 0; // No automatic expiry, uses decay instead
    entry.promotedAt = new Date().toISOString();
    entry.lastAccessed = new Date().toISOString();

    longTerm.push(entry);

    saveMemoryFile(shortTermPath, shortTerm);
    saveMemoryFile(longTermPath, longTerm);

    return entry;
}

/**
 * Add a permanent entry to context.json
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {string} key - Key for the context entry
 * @param {*} value - Value to store
 * @returns {object} Updated context
 */
function addPermanent(agentId, baseDir, key, value) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    ensureMemoryDir(memoryDir);

    const filePath = path.join(memoryDir, MEMORY_FILES.context);
    const context = loadMemoryFile(filePath);

    context[key] = value;
    context._lastUpdated = new Date().toISOString();

    saveMemoryFile(filePath, context);
    return context;
}

/**
 * Get relevant memory combined from all tiers
 * Returns: all permanent context + unexpired short-term + long-term sorted by lastAccessed
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @returns {object} Combined memory view { context, working, shortTerm, longTerm }
 */
function getRelevantMemory(agentId, baseDir) {
    const memoryDir = getAgentMemoryPath(agentId, baseDir);

    // Load all tiers
    const context = loadMemoryFile(path.join(memoryDir, MEMORY_FILES.context));
    const working = loadMemoryFile(path.join(memoryDir, MEMORY_FILES.working), true);
    const shortTerm = loadMemoryFile(path.join(memoryDir, MEMORY_FILES.shortTerm), true);
    const longTerm = loadMemoryFile(path.join(memoryDir, MEMORY_FILES.longTerm), true);

    // Filter unexpired short-term entries
    const validShortTerm = shortTerm.filter(e => !isExpired(e));

    // Sort long-term by lastAccessed (most recent first)
    const sortedLongTerm = [...longTerm].sort((a, b) => {
        return new Date(b.lastAccessed).getTime() - new Date(a.lastAccessed).getTime();
    });

    return {
        context,
        working,
        shortTerm: validShortTerm,
        longTerm: sortedLongTerm
    };
}

/**
 * Update lastAccessed timestamp for an entry (for tracking usage)
 * @param {string} agentId - Agent ID
 * @param {string} baseDir - Base directory
 * @param {string} tier - Which tier ('shortTerm' or 'longTerm')
 * @param {string} entryId - Entry ID to update
 * @returns {boolean} True if updated
 */
function touchEntry(agentId, baseDir, tier, entryId) {
    if (!['shortTerm', 'longTerm'].includes(tier)) {
        return false;
    }

    const memoryDir = getAgentMemoryPath(agentId, baseDir);
    const filePath = path.join(memoryDir, MEMORY_FILES[tier]);

    if (!fs.existsSync(filePath)) {
        return false;
    }

    const entries = loadMemoryFile(filePath, true);
    const entry = entries.find(e => e.id === entryId);

    if (!entry) {
        return false;
    }

    entry.lastAccessed = new Date().toISOString();
    entry.accessCount = (entry.accessCount || 1) + 1;

    saveMemoryFile(filePath, entries);
    return true;
}

module.exports = {
    addWorkingMemory,
    clearWorkingMemory,
    addShortTerm,
    promoteToLongTerm,
    addPermanent,
    getRelevantMemory,
    touchEntry,
};
