'use strict';

/**
 * bots/storefront-prompt.js
 *
 * What the storefront agent is told: the product catalog it searches (loaded once),
 * its persona, and the prompt built from the conversation and the product matches.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of bots/storefront.js, which
 * re-exports every name it exported before from here; the catalog flag is read through
 * isCatalogInitialized(), because a re-exported `let` would be a copy taken at load. It reads its configuration from the environment at load, after
 * bots/storefront.js has run dotenv.
 */

// LOGIC CHANGE 2026-03-27: Added catalog search for product recommendations
const { initCatalog, getCatalogStats } = require('../lib/integrations/catalog-search');
const { loadCatalog } = require('../lib/integrations/square-catalog');

// ---- Catalog initialization ----

// LOGIC CHANGE 2026-03-27: Initialize catalog on startup for product search
let catalogInitialized = false;

async function initializeCatalog() {
    try {
        console.log('[storefront] Loading product catalog...');
        const items = await loadCatalog();
        if (items.length > 0) {
            initCatalog(items);
            catalogInitialized = true;
            const stats = getCatalogStats();
            console.log(`[storefront] Catalog initialized: ${stats.itemCount} products, ${stats.categories} categories`);
        } else {
            console.log('[storefront] No catalog items available');
        }
    } catch (err) {
        console.error('[storefront] Failed to initialize catalog:', err.message);
    }
}

/** Whether initializeCatalog() has loaded a non-empty catalog. */
function isCatalogInitialized() {
    return catalogInitialized;
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
 * Build a prompt from conversation history.
 * @param {Array} history - Array of { role, content } messages
 * @param {string} userMessage - Current user message
 * @param {Array} [productMatches] - Optional array of matching products from catalog search
 * @returns {string} Formatted prompt for the LLM
 */
function buildPrompt(history, userMessage, productMatches = []) {
    let prompt = STOREFRONT_AGENT_CONFIG.systemPrompt + '\n\n';

    // LOGIC CHANGE 2026-03-27: Include matching products from catalog search
    if (productMatches.length > 0) {
        prompt += 'Relevant products from our catalog that may help answer this question:\n';
        for (const match of productMatches) {
            const priceStr = match.price ? `$${match.price.toFixed(2)}` : 'Price varies';
            const categoryStr = match.category ? ` (${match.category})` : '';
            prompt += `- ${match.name}${categoryStr}: ${priceStr}\n`;
        }
        prompt += '\nUse these products to provide specific recommendations when relevant.\n\n';
    }

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

module.exports = {
    initializeCatalog,
    isCatalogInitialized,
    STOREFRONT_AGENT_CONFIG,
    buildPrompt,
};
