'use strict';

/**
 * lib/memory-tiers-store.js
 *
 * The tiered memory's file layer: the tier file names, the TTL constants, the entry
 * shape, per-agent paths, tolerant load/save, and the expiry and decay predicates.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/memory-tiers.js unchanged,
 * on the boundary #10 names (entry lifecycle + file I/O vs. maintenance).
 * lib/memory-tiers.js re-exports every name, so no caller changed.
 */

// LOGIC CHANGE 2026-03-26: New tiered memory system with context, working, short-term,
// long-term, and archive files per agent. Provides TTL-based expiry, auto-promotion
// based on access patterns, and cleanup/archival of decayed items.

const fs = require('fs');
const path = require('path');

// Default TTLs in hours
const DEFAULT_SHORT_TERM_TTL = 48;
const DEFAULT_LONG_TERM_DECAY_DAYS = 30;
const AUTO_PROMOTE_THRESHOLD = 3; // Number of re-adds to trigger promotion

/**
 * Memory file names for each tier
 */
const MEMORY_FILES = {
    context: 'context.json',      // Permanent: owner info, preferences
    working: 'working.json',      // Session only: current task state
    shortTerm: 'short-term.json', // 24-72 hour TTL
    longTerm: 'long-term.json',   // Weeks/months with decay
    archive: 'archive.json'       // Decayed long-term items
};

/**
 * Create a memory entry with required metadata
 * @param {string|object} content - The content to store
 * @param {string} source - Where this entry came from (e.g., 'task', 'user', 'system')
 * @param {number} ttlHours - Time to live in hours (0 = no expiry)
 * @returns {object} Memory entry with metadata
 */
function createEntry(content, source, ttlHours = 0) {
    const now = new Date().toISOString();
    return {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        content,
        created: now,
        lastAccessed: now,
        ttl: ttlHours > 0 ? ttlHours * 60 * 60 * 1000 : 0, // Convert to ms, 0 = no expiry
        accessCount: 1,
        source
    };
}

/**
 * Get the absolute path to an agent's memory directory
 * @param {string} agentId - The agent ID
 * @param {string} baseDir - Base directory for the project
 * @returns {string} Absolute path to memory directory
 */
function getAgentMemoryPath(agentId, baseDir) {
    return path.join(baseDir, 'agents', agentId, 'memory');
}

/**
 * Ensure the agent's memory directory exists
 * @param {string} memoryDir - Path to memory directory
 */
function ensureMemoryDir(memoryDir) {
    if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
    }
}

/**
 * Load a memory file, returning empty structure if not found
 * @param {string} filePath - Path to the memory file
 * @param {boolean} isArray - Whether the file should contain an array (default: false = object)
 * @returns {object|array} Parsed contents or empty structure
 */
// LOGIC CHANGE 2026-03-27: Added corruption resilience. If JSON.parse fails
// (empty file, invalid JSON), reset to default and log a warning instead of crashing.
function loadMemoryFile(filePath, isArray = false) {
    const defaultValue = isArray ? [] : {};
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        if (!data || !data.trim()) {
            console.warn(`[memory-tiers] Empty file detected: ${filePath}, resetting to default`);
            saveMemoryFile(filePath, defaultValue);
            return defaultValue;
        }
        const parsed = JSON.parse(data);
        if (isArray && !Array.isArray(parsed)) {
            console.warn(`[memory-tiers] Expected array in ${filePath}, got ${typeof parsed}. Resetting.`);
            saveMemoryFile(filePath, defaultValue);
            return defaultValue;
        }
        return parsed;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return defaultValue;
        }
        console.warn(`[memory-tiers] Corrupted file ${filePath}: ${err.message}. Resetting to default.`);
        try {
            saveMemoryFile(filePath, defaultValue);
        } catch (saveErr) {
            console.error(`[memory-tiers] Failed to reset ${filePath}:`, saveErr.message);
        }
        return defaultValue;
    }
}

/**
 * Save data to a memory file
 * @param {string} filePath - Path to the memory file
 * @param {object|array} data - Data to save
 */
function saveMemoryFile(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Check if an entry has expired based on its TTL
 * @param {object} entry - Memory entry
 * @returns {boolean} True if expired
 */
function isExpired(entry) {
    if (!entry.ttl || entry.ttl === 0) return false;
    const created = new Date(entry.created).getTime();
    const now = Date.now();
    return (now - created) > entry.ttl;
}

/**
 * Check if a long-term entry should decay to archive
 * @param {object} entry - Memory entry
 * @param {number} decayDays - Days until decay (default: 30)
 * @returns {boolean} True if should be archived
 */
function shouldDecay(entry, decayDays = DEFAULT_LONG_TERM_DECAY_DAYS) {
    const lastAccessed = new Date(entry.lastAccessed).getTime();
    const now = Date.now();
    const decayMs = decayDays * 24 * 60 * 60 * 1000;
    return (now - lastAccessed) > decayMs;
}

module.exports = {
    MEMORY_FILES,
    DEFAULT_SHORT_TERM_TTL,
    DEFAULT_LONG_TERM_DECAY_DAYS,
    AUTO_PROMOTE_THRESHOLD,
    createEntry,
    getAgentMemoryPath,
    ensureMemoryDir,
    loadMemoryFile,
    saveMemoryFile,
    isExpired,
    shouldDecay,
};
