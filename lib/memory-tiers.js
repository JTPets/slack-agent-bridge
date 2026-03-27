'use strict';

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
function loadMemoryFile(filePath, isArray = false) {
    try {
        const data = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return isArray ? [] : {};
        }
        throw err;
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
    // Constants
    MEMORY_FILES,
    DEFAULT_SHORT_TERM_TTL,
    DEFAULT_LONG_TERM_DECAY_DAYS,
    AUTO_PROMOTE_THRESHOLD,

    // Helpers
    createEntry,
    getAgentMemoryPath,
    ensureMemoryDir,
    loadMemoryFile,
    saveMemoryFile,
    isExpired,
    shouldDecay,

    // Core functions
    addWorkingMemory,
    clearWorkingMemory,
    addShortTerm,
    promoteToLongTerm,
    addPermanent,
    getRelevantMemory,
    cleanupMemory,
    autoPromote,
    startupCleanup,
    migrateToTiers,
    touchEntry
};
