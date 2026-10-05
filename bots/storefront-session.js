'use strict';

/**
 * bots/storefront-session.js
 *
 * Storefront chat sessions: the in-memory session map, its periodic expiry (an unref'd
 * timer, so requiring the module never pins the event loop), session lookup, and the
 * input sanitiser applied to every customer message.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of bots/storefront.js, which
 * re-exports every name here; `sessions` is the same Map object. It reads its configuration from the environment at load, after
 * bots/storefront.js has run dotenv.
 */

// LOGIC CHANGE 2026-03-27: Session storage for conversation context.
// Maps session IDs to conversation history. Sessions expire after 1 hour.
const SESSION_TTL_MS = parseInt(process.env.STOREFRONT_SESSION_TTL_MS || '3600000', 10);
const sessions = new Map();

/**
 * Clean expired sessions periodically.
 */
function cleanExpiredSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
            sessions.delete(sessionId);
        }
    }
}

// Run session cleanup every 5 minutes.
// .unref() so this module-scope timer does not pin the Node event loop open.
// Without it, `require('bots/storefront')` keeps the process alive forever:
// tests/smoke.test.js require()s this module and jest hung after the suite passed
// ("Jest did not exit one second after the test run has completed"), which blocked
// wiring `npm run test:smoke` into the self-update gate. .unref() lets the process
// exit when this timer is the only thing left, while a real server stays alive on
// its HTTP listener and the cleanup keeps running. See WORK-TODO.md item 1.
const sessionCleanupTimer = setInterval(cleanExpiredSessions, 5 * 60 * 1000);
sessionCleanupTimer.unref();

/**
 * Get or create a session.
 * @param {string} sessionId - Session ID
 * @returns {Object} Session object with history array
 */
function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            id: sessionId,
            history: [],
            lastActivity: Date.now(),
            createdAt: Date.now(),
        });
    }
    const session = sessions.get(sessionId);
    session.lastActivity = Date.now();
    return session;
}

/**
 * Sanitize user input to prevent injection attacks.
 * @param {string} input - Raw user input
 * @returns {string} Sanitized input
 */
function sanitizeInput(input) {
    if (!input || typeof input !== 'string') {
        return '';
    }
    // Remove control characters and limit length
    return input
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim()
        .slice(0, 2000);
}

module.exports = {
    SESSION_TTL_MS,
    sessions,
    cleanExpiredSessions,
    getOrCreateSession,
    sanitizeInput,
};
