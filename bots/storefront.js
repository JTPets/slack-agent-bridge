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
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { WebClient } = require('@slack/web-api');
const { runLLM } = require('../lib/llm-runner');

// Configuration
const PORT = parseInt(process.env.STOREFRONT_PORT || '3001', 10);
const STORE_INBOX_CHANNEL_ID = process.env.STORE_INBOX_CHANNEL_ID || 'C0APPBSAP4H';
const ALLOWED_ORIGINS = (process.env.STOREFRONT_ALLOWED_ORIGINS || 'http://localhost:3000,https://jtpets.ca').split(',');

// LOGIC CHANGE 2026-03-27: Session storage for conversation context.
// Maps session IDs to conversation history. Sessions expire after 1 hour.
const SESSION_TTL_MS = parseInt(process.env.STOREFRONT_SESSION_TTL_MS || '3600000', 10);
const sessions = new Map();

// Slack client for logging
let slackClient = null;
if (process.env.SLACK_BOT_TOKEN) {
    slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);
}

// Storefront agent configuration from agents.json
const STOREFRONT_AGENT_CONFIG = {
    name: 'Storefront Agent',
    role: 'Customer-facing AI for product inquiries, nutrition consults, order creation',
    maxTurns: 15,
    systemPrompt: `You are the Storefront Agent for JT Pets, a premium pet food store in Toronto.
You help customers with product inquiries, provide pet nutrition consultations, and assist with order creation.

Guidelines:
- Be friendly, warm, and approachable
- Be knowledgeable about pet nutrition, dietary needs, and product benefits
- Recommend products based on pet age, breed, and health conditions
- Be helpful and patient, always prioritize pet wellbeing
- Keep responses concise but informative
- If asked about pricing or availability, let customers know they can visit the store or call for current details
- Never share internal business information or make promises about delivery times

Store Information:
- Name: JT Pets
- Location: Toronto, Ontario
- Specialization: Premium pet food and nutrition
- Services: Pet nutrition consultations, custom diet recommendations`,
};

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

// Run session cleanup every 5 minutes
setInterval(cleanExpiredSessions, 5 * 60 * 1000);

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
 * Build a prompt from conversation history.
 * @param {Array} history - Array of { role, content } messages
 * @param {string} userMessage - Current user message
 * @returns {string} Formatted prompt for the LLM
 */
function buildPrompt(history, userMessage) {
    let prompt = STOREFRONT_AGENT_CONFIG.systemPrompt + '\n\n';

    // Add conversation history (last 10 messages to keep context manageable)
    const recentHistory = history.slice(-10);
    if (recentHistory.length > 0) {
        prompt += 'Previous conversation:\n';
        for (const msg of recentHistory) {
            const role = msg.role === 'user' ? 'Customer' : 'Agent';
            prompt += `${role}: ${msg.content}\n`;
        }
        prompt += '\n';
    }

    prompt += `Customer: ${userMessage}\n\nAgent:`;
    return prompt;
}

/**
 * Log a conversation to Slack #store-inbox channel.
 * @param {string} sessionId - Session ID
 * @param {string} userMessage - Customer message
 * @param {string} agentResponse - Agent response
 */
async function logToSlack(sessionId, userMessage, agentResponse) {
    if (!slackClient) {
        console.log('[storefront] No Slack client configured, skipping log');
        return;
    }

    try {
        // LOGIC CHANGE 2026-03-27: Format conversation log for Slack.
        // Uses thread to group conversation sessions.
        const shortSessionId = sessionId.substring(0, 8);
        const message = `*Chat Session ${shortSessionId}*\n` +
            `> *Customer:* ${userMessage}\n` +
            `> *Agent:* ${agentResponse}`;

        await slackClient.chat.postMessage({
            channel: STORE_INBOX_CHANNEL_ID,
            text: message,
            unfurl_links: false,
            unfurl_media: false,
        });
    } catch (err) {
        // Don't fail the chat if logging fails
        console.error('[storefront] Failed to log to Slack:', err.message);
    }
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

// Create Express app
const app = express();

// CORS configuration
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            return callback(null, true);
        }
        if (ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'X-Session-ID'],
    credentials: true,
}));

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

// POST /api/chat - Handle chat messages
app.post('/api/chat', async (req, res) => {
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
        const sessionId = providedSessionId || crypto.randomUUID();
        const session = getOrCreateSession(sessionId);

        // Build prompt with conversation history
        const prompt = buildPrompt(session.history, sanitizedMessage);

        // Run LLM
        console.log(`[storefront] Processing message for session ${sessionId.substring(0, 8)}`);
        const { output } = await runLLM(prompt, {
            maxTurns: STOREFRONT_AGENT_CONFIG.maxTurns,
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
};
