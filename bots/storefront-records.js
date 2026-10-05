'use strict';

/**
 * bots/storefront-records.js
 *
 * What the storefront writes down: every conversation and every delivery quote logged
 * to #store-inbox, and the delivery-quotes JSON file.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of bots/storefront.js, which
 * re-exports every name it exported before from here. It reads its configuration from the environment at load, after
 * bots/storefront.js has run dotenv.
 */

const path = require('path');
const fs = require('fs').promises;
// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient } = require('../lib/slack-web');

const STORE_INBOX_CHANNEL_ID = process.env.STORE_INBOX_CHANNEL_ID || 'C0APPBSAP4H';

// LOGIC CHANGE 2026-03-27: Delivery quotes storage file path
const DELIVERY_QUOTES_FILE = process.env.DELIVERY_QUOTES_FILE || path.join(__dirname, '..', 'data', 'delivery-quotes.json');

// Slack client for logging
let slackClient = null;
if (process.env.SLACK_BOT_TOKEN) {
    slackClient = createWebClient(process.env.SLACK_BOT_TOKEN);
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
 * LOGIC CHANGE 2026-03-27: Load delivery quotes from JSON file.
 * @returns {Promise<Array>} Array of quote objects
 */
async function loadDeliveryQuotes() {
    try {
        const data = await fs.readFile(DELIVERY_QUOTES_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
}

/**
 * LOGIC CHANGE 2026-03-27: Save delivery quotes to JSON file.
 * @param {Array} quotes - Array of quote objects
 */
async function saveDeliveryQuotes(quotes) {
    // Ensure data directory exists
    const dataDir = path.dirname(DELIVERY_QUOTES_FILE);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(DELIVERY_QUOTES_FILE, JSON.stringify(quotes, null, 2));
}

/**
 * LOGIC CHANGE 2026-03-27: Log delivery quote request to Slack.
 * @param {Object} quoteData - The quote request data
 */
async function logDeliveryQuoteToSlack(quoteData) {
    if (!slackClient) {
        console.log('[storefront] No Slack client configured, skipping delivery quote log');
        return;
    }

    try {
        const priceText = quoteData.quote.contactRequired
            ? 'Contact required (20km+)'
            : `$${quoteData.quote.price}`;

        const message = `*New Delivery Quote Request*\n` +
            `> *Business:* ${quoteData.businessName}\n` +
            `> *Contact:* ${quoteData.contactName}\n` +
            `> *Phone:* ${quoteData.phone}\n` +
            `> *Email:* ${quoteData.email}\n` +
            `> *Pickup:* ${quoteData.pickupAddress}\n` +
            `> *Delivery:* ${quoteData.deliveryAddress}\n` +
            `> *Distance:* ${quoteData.quote.distance.toFixed(1)} km\n` +
            `> *Quote:* ${priceText}`;

        await slackClient.chat.postMessage({
            channel: STORE_INBOX_CHANNEL_ID,
            text: message,
            unfurl_links: false,
            unfurl_media: false,
        });
    } catch (err) {
        console.error('[storefront] Failed to log delivery quote to Slack:', err.message);
    }
}

module.exports = {
    STORE_INBOX_CHANNEL_ID,
    DELIVERY_QUOTES_FILE,
    logToSlack,
    loadDeliveryQuotes,
    saveDeliveryQuotes,
    logDeliveryQuoteToSlack,
};
