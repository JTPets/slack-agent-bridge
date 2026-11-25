'use strict';

/**
 * bots/storefront.js
 *
 * Express server for the Storefront Agent chat widget.
 * Provides POST /api/chat endpoint for customer conversations
 * and GET /widget for the embeddable chat widget HTML.
 *
 * LOGIC CHANGE 2026-03-27: Initial implementation of storefront chat bot.
 * Uses lib/llm-runner.js for Claude integration with storefront agent config.
 * Logs all conversations to #store-inbox Slack channel.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): split on the boundary #10 named. Sessions are in
 * bots/storefront-session.js, Slack logging and delivery quotes in bots/storefront-records.js,
 * and the catalog, persona and prompt in bots/storefront-prompt.js. This file keeps the
 * Express app, its routes and the listen, and re-exports every name it exported before.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #87): the request guards (CORS, the rate limits, the
 * session-id check) are bots/storefront-guards.js, and the delivery-quote handler moved to
 * bots/storefront-delivery.js. This file wires them; `rateLimiters` is exported for tests.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { runLLM } = require('../lib/llm-runner');
const { searchCatalog } = require('../lib/integrations/catalog-search');
const {
    sessions,
    cleanExpiredSessions,
    getOrCreateSession,
    sanitizeInput,
} = require('./storefront-session');
const {
    DELIVERY_QUOTES_FILE,
    logToSlack,
    loadDeliveryQuotes,
    saveDeliveryQuotes,
    logDeliveryQuoteToSlack,
    logRateLimitToSlack,
} = require('./storefront-records');
const {
    rateLimitConfig,
    createRateLimiter,
    rateLimitMiddleware,
    buildCorsOptions,
    acceptSessionId,
} = require('./storefront-guards');
const { handleDeliveryQuote } = require('./storefront-delivery');
const {
    initializeCatalog,
    isCatalogInitialized,
    STOREFRONT_AGENT_CONFIG,
    buildPrompt,
} = require('./storefront-prompt');

// Configuration
const PORT = parseInt(process.env.STOREFRONT_PORT || '3001', 10);
const ALLOWED_ORIGINS = (process.env.STOREFRONT_ALLOWED_ORIGINS || 'http://localhost:3000,https://jtpets.ca').split(',');

// LOGIC CHANGE 2026-03-27: Only initialize catalog when running as main process
// to avoid async operations during test imports
if (require.main === module) {
    initializeCatalog();
}

// Create Express app
const app = express();

// LOGIC CHANGE 2026-11-25 (WORK-TODO #87): the request guards live in
// bots/storefront-guards.js. CORS matches origins exactly with credentials off (it allowed
// `*` with credentials), and each public API route has a per-client and a global rate
// limit (there was none, so anyone could run the model at our cost). `trust proxy` is off
// unless STOREFRONT_TRUST_PROXY names a setting, so req.ip is not taken from a header a
// client can forge.
if (process.env.STOREFRONT_TRUST_PROXY) {
    app.set('trust proxy', process.env.STOREFRONT_TRUST_PROXY);
}
const corsConfig = buildCorsOptions(ALLOWED_ORIGINS);
if (corsConfig.ignored.length > 0) {
    console.warn('[storefront] STOREFRONT_ALLOWED_ORIGINS contains "*", which is ignored: list each origin exactly');
}
app.use(cors(corsConfig.options));

const RATE_LIMIT = rateLimitConfig();
const rateLimiters = {
    chat: createRateLimiter(RATE_LIMIT),
    deliveryQuote: createRateLimiter(RATE_LIMIT),
};
const limit = (limiter) => rateLimitMiddleware(limiter, {
    windowMs: RATE_LIMIT.windowMs,
    onGlobalLimit: (route) => { logRateLimitToSlack(route).catch(() => {}); },
});

// Parse JSON bodies
app.use(express.json({ limit: '10kb' }));

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', agent: 'storefront' });
});

// GET /widget - Serve the embeddable chat widget
app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'widget.html'));
});

// GET /delivery - Serve the delivery quote page
app.get('/delivery', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'delivery.html'));
});

// POST /api/delivery-quote - the courier intake (bots/storefront-delivery.js)
app.post('/api/delivery-quote', limit(rateLimiters.deliveryQuote), handleDeliveryQuote);

// POST /api/chat - Handle chat messages
app.post('/api/chat', limit(rateLimiters.chat), async (req, res) => {
    try {
        const { message, sessionId: providedSessionId } = req.body;

        // Validate message
        const sanitizedMessage = sanitizeInput(message);
        if (!sanitizedMessage) {
            return res.status(400).json({
                error: 'Message is required',
                code: 'INVALID_MESSAGE',
            });
        }

        // Get or create session
        // LOGIC CHANGE 2026-11-25 (WORK-TODO #87): a supplied id is kept only in the short id
        // shape acceptSessionId allows; anything else (a number, a newline, 10 KB) gets a new one.
        const sessionId = acceptSessionId(providedSessionId) || crypto.randomUUID();
        const session = getOrCreateSession(sessionId);

        // LOGIC CHANGE 2026-03-27: Search catalog for relevant products before building prompt
        let productMatches = [];
        // LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the flag lives in bots/storefront-prompt.js now,
        // so it is read through its accessor; a re-exported `let` would be a copy taken at load.
        if (isCatalogInitialized()) {
            productMatches = searchCatalog(sanitizedMessage, 3);
            if (productMatches.length > 0) {
                console.log(`[storefront] Found ${productMatches.length} matching products for query`);
            }
        }

        // Build prompt with conversation history and product matches
        const prompt = buildPrompt(session.history, sanitizedMessage, productMatches);

        // Run LLM
        console.log(`[storefront] Processing message for session ${sessionId.substring(0, 8)}`);
        const { output } = await runLLM(prompt, {
            maxTurns: STOREFRONT_AGENT_CONFIG.maxTurns,
            // LOGIC CHANGE 2026-11-07: run as the storefront agent. A customer types this
            // prompt, so on Claude it must get no tools; its definition grants none
            // (lib/agent-tools.js). Before this a Claude run here had a shell.
            agentId: 'storefront',
            timeout: 60000, // 1 minute timeout for chat
        });

        // Clean up the response
        const agentResponse = output.trim();

        // Update session history
        session.history.push({ role: 'user', content: sanitizedMessage });
        session.history.push({ role: 'assistant', content: agentResponse });

        // Log to Slack (async, don't await)
        logToSlack(sessionId, sanitizedMessage, agentResponse).catch(() => {});

        // Return response
        res.json({
            response: agentResponse,
            sessionId,
        });
    } catch (err) {
        console.error('[storefront] Chat error:', err.message);

        // Check for rate limit errors
        if (err.isRateLimit) {
            return res.status(429).json({
                error: 'Service temporarily busy. Please try again in a few minutes.',
                code: 'RATE_LIMITED',
            });
        }

        // Generic error response
        res.status(500).json({
            error: 'Something went wrong. Please try again.',
            code: 'INTERNAL_ERROR',
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[storefront] Unhandled error:', err.message);
    res.status(500).json({
        error: 'An unexpected error occurred.',
        code: 'UNEXPECTED_ERROR',
    });
});

// Start server if run directly
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`[storefront] Server running on port ${PORT}`);
        console.log(`[storefront] Widget available at http://localhost:${PORT}/widget`);
        console.log(`[storefront] Chat API at POST http://localhost:${PORT}/api/chat`);
    });
}

// Export for testing
module.exports = {
    app,
    getOrCreateSession,
    buildPrompt,
    sanitizeInput,
    cleanExpiredSessions,
    sessions,
    STOREFRONT_AGENT_CONFIG,
    loadDeliveryQuotes,
    saveDeliveryQuotes,
    logDeliveryQuoteToSlack,
    DELIVERY_QUOTES_FILE,
    initializeCatalog,
    catalogInitialized: isCatalogInitialized,
    rateLimiters,
};
