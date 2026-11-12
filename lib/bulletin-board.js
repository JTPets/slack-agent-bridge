/**
 * lib/bulletin-board.js
 *
 * Inter-agent communication via a shared bulletin board.
 * All agents can post bulletins and read bulletins from other agents.
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of bulletin board system.
 * Enables agents to share information across channels without direct coupling.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): split by job, no behaviour change.
 * The file and every read and write of it are lib/bulletin-board-store.js; rendering
 * is lib/bulletin-board-format.js. This file keeps the command recogniser
 * (isBulletinQuery) and re-exports every name it exported before as the same object;
 * BULLETIN_FILE is read through the store, so init() here still moves it
 * (tests/module-splits.test.js).
 */

'use strict';

const store = require('./bulletin-board-store');
const {
    postBulletin,
    getBulletins,
    markRead,
    cleanupOldBulletins,
    BULLETIN_TYPES,
    init,
    DEFAULT_BULLETIN_FILE,
    DEFAULT_CLEANUP_DAYS,
    loadBulletins,
    saveBulletins,
} = store;
const { formatBulletinsForSlack, formatBulletinsForContext, formatBulletinData } = require('./bulletin-board-format');

/**
 * Check if query is a bulletin command (bulletins, what's new).
 *
 * @param {string} text - Query text (already stripped of ASK: prefix)
 * @returns {boolean}
 */
function isBulletinQuery(text) {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    // Match exact commands: "bulletins", "bulletin", "what's new", "show bulletins"
    // Don't match partial sentences like "bulletin board rules"
    return /^bulletins?$/i.test(lower) ||
           /^what'?s\s+new$/i.test(lower) ||
           /^show\s+bulletins?$/i.test(lower);
}

module.exports = {
    // Core functions
    postBulletin,
    getBulletins,
    markRead,
    cleanupOldBulletins,

    // Formatting helpers
    formatBulletinsForSlack,
    formatBulletinsForContext,
    formatBulletinData,

    // Query detection
    isBulletinQuery,

    // Constants (exported for testing)
    BULLETIN_TYPES,
    init,
    DEFAULT_BULLETIN_FILE,
    get BULLETIN_FILE() { return store.BULLETIN_FILE; },
    DEFAULT_CLEANUP_DAYS,

    // Internal functions (exported for testing)
    loadBulletins,
    saveBulletins,
};
