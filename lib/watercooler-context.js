/**
 * lib/watercooler-context.js
 *
 * WHAT a standup is told: the last-standup timestamp (its one durable state file),
 * bulletins since then, recent completions from memory/history.json, and an agent's
 * backlog. Reads files; writes only the last-standup timestamp.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/watercooler.js unchanged,
 * on the boundary #10 names (catalogue vs. context gathering vs. orchestration). The state-file path and its init() override live here, with the only code that reads them.
 * lib/watercooler.js re-exports every name, so no caller changed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const bulletinBoard = require('./bulletin-board');

// Memory and history file paths
const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const HISTORY_FILE = path.join(MEMORY_DIR, 'history.json');

// State file for tracking last standup.
//
// LOGIC CHANGE 2026-09-15: the module-scope `const` became a `let` with an `init()`
// override. This is WORK-TODO #24's prescribed fix for this module, applied for the
// reason #24 predicted: `tests/watercooler.test.js` drives `runStandup()`, which
// calls `saveLastStandupTime()`, which was writing the LIVE
// `agents/shared/watercooler-state.json` on every test run. The default is unchanged,
// so an unset option preserves the current path exactly. Shape copied from
// `lib/bridge-state.js init()`.
const DEFAULT_WATERCOOLER_STATE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'watercooler-state.json');
let WATERCOOLER_STATE_FILE = DEFAULT_WATERCOOLER_STATE_FILE;

/**
 * Override the durable state path. Tests point this at a temp directory; production
 * never calls it, so production behaviour is byte-identical to before.
 *
 * @param {object} [options]
 * @param {string} [options.stateFile] - Where the last-standup timestamp lives.
 * @returns {string} The path now in effect.
 */
function init(options = {}) {
    WATERCOOLER_STATE_FILE = options.stateFile || DEFAULT_WATERCOOLER_STATE_FILE;
    return WATERCOOLER_STATE_FILE;
}

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
 * Get bulletins since last standup or for a specific lookback period.
 *
 * @param {number} [daysBack] - Optional number of days to look back (overrides lastStandup)
 * @returns {Array} Array of bulletin objects
 */
function getBulletinsSinceLastStandup(daysBack) {
    const filters = { limit: 50 };

    if (daysBack) {
        // Use explicit lookback period
        const cutoff = new Date(Date.now() - (daysBack * 24 * 60 * 60 * 1000));
        filters.since = cutoff.toISOString();
    } else {
        // Use last standup time
        const lastStandup = getLastStandupTime();
        if (lastStandup) {
            filters.since = lastStandup;
        }
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

module.exports = {
    init,
    getStateFile: () => WATERCOOLER_STATE_FILE,
    DEFAULT_WATERCOOLER_STATE_FILE,
    loadJsonFile,
    getLastStandupTime,
    saveLastStandupTime,
    getBulletinsSinceLastStandup,
    getRecentCompletions,
    getAgentBacklog,
};
