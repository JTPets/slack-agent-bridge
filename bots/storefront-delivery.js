'use strict';

/**
 * bots/storefront-delivery.js
 *
 * The delivery-quote intake behind POST /api/delivery-quote (the courier page,
 * public/delivery.html): validate the submission, save it to the quotes file, post it to
 * #store-inbox.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #87): moved out of bots/storefront.js unchanged apart
 * from the #87 fixes (the price check and the log line), to keep the facade under 300
 * lines once the request guards were wired in. bots/storefront.js registers it behind its
 * rate limit.
 */

const crypto = require('crypto');
const { sanitizeInput } = require('./storefront-session');
const {
    loadDeliveryQuotes,
    saveDeliveryQuotes,
    logDeliveryQuoteToSlack,
} = require('./storefront-records');
const { logSafe } = require('../lib/untrusted-text');

// LOGIC CHANGE 2026-03-27: Added delivery quote intake endpoint for courier service.
async function handleDeliveryQuote(req, res) {
    try {
        const {
            businessName,
            contactName,
            phone,
            email,
            pickupAddress,
            deliveryAddress,
            pickupCoords,
            deliveryCoords,
            quote
        } = req.body;

        // Validate required fields
        if (!businessName || !contactName || !phone || !email || !pickupAddress || !deliveryAddress) {
            return res.status(400).json({
                error: 'All fields are required',
                code: 'MISSING_FIELDS'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                error: 'Invalid email format',
                code: 'INVALID_EMAIL'
            });
        }

        // Validate quote data
        // LOGIC CHANGE 2026-11-25 (WORK-TODO #87): the price is posted to #store-inbox, so it
        // must be what the delivery page sends (a number, or null when contact is required),
        // not any value a caller chooses. Distance must be a finite number for toFixed.
        const price = quote && quote.price;
        if (!quote || !Number.isFinite(quote.distance)
            || !(price === null || price === undefined || Number.isFinite(price))) {
            return res.status(400).json({
                error: 'Invalid quote data',
                code: 'INVALID_QUOTE'
            });
        }

        // Build quote record
        const quoteRecord = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            businessName: sanitizeInput(businessName),
            contactName: sanitizeInput(contactName),
            phone: sanitizeInput(phone),
            email: sanitizeInput(email),
            pickupAddress: sanitizeInput(pickupAddress),
            deliveryAddress: sanitizeInput(deliveryAddress),
            pickupCoords,
            deliveryCoords,
            quote: {
                distance: quote.distance,
                price: quote.price,
                contactRequired: quote.contactRequired
            },
            status: 'pending'
        };

        // Save to JSON file
        const quotes = await loadDeliveryQuotes();
        quotes.push(quoteRecord);
        await saveDeliveryQuotes(quotes);

        // LOGIC CHANGE 2026-11-25 (WORK-TODO #87): this line printed the RAW businessName, so
        // a name carrying a newline wrote a second, forged log line. logSafe quotes and escapes.
        console.log(`[storefront] Delivery quote saved: ${quoteRecord.id} - ${logSafe(quoteRecord.businessName)}`);

        // Post to Slack (async, don't block response)
        logDeliveryQuoteToSlack(quoteRecord).catch(() => {});

        res.json({
            success: true,
            quoteId: quoteRecord.id,
            message: 'Quote request received. We will follow up shortly.'
        });

    } catch (err) {
        console.error('[storefront] Delivery quote error:', err.message);
        res.status(500).json({
            error: 'Failed to process quote request',
            code: 'INTERNAL_ERROR'
        });
    }
}

module.exports = { handleDeliveryQuote };
