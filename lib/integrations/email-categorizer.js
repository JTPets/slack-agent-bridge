/**
 * lib/integrations/email-categorizer.js
 *
 * Email categorization based on sender/subject patterns.
 * Reads rules from agents/email-monitor/memory/rules.json.
 *
 * LOGIC CHANGE 2026-03-28: Created email-categorizer.js for categorizing
 * emails by type (vendor_deal, customer_inquiry, newsletter, invoice, shipping, spam).
 * Vendor deals trigger bulletin board posts for Secretary awareness.
 *
 * LOGIC CHANGE 2026-04-01: Integrated rate limiting to prevent flood attacks.
 * Large email volumes no longer overwhelm Slack with bulletin notifications.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const bulletinBoard = require('../bulletin-board');
const rateLimiter = require('../email-rate-limiter');

// Path to rules file
const RULES_FILE = path.join(__dirname, '../../agents/email-monitor/memory/rules.json');

// Default rules if file doesn't exist
const DEFAULT_RULES = {
    categories: {
        vendor_deal: {
            action: 'push_to_secretary',
            priority: 'high',
            extract_pricing: true,
            keywords: ['sale', 'discount', 'promo', 'clearance', '% off', 'special pricing', 'bulk']
        },
        customer_inquiry: {
            action: 'include_in_digest',
            priority: 'medium',
            keywords: ['question', 'help', 'inquiry', 'order', 'delivery']
        },
        newsletter: {
            action: 'ignore',
            auto_unsubscribe: false,
            keywords: ['newsletter', 'unsubscribe', 'update', 'digest']
        },
        invoice: {
            action: 'include_in_digest',
            priority: 'medium',
            keywords: ['invoice', 'receipt', 'payment due', 'statement']
        },
        shipping: {
            action: 'include_in_digest',
            priority: 'low',
            keywords: ['shipped', 'tracking', 'delivery', 'in transit', 'out for delivery']
        },
        spam: {
            action: 'ignore',
            keywords: ['unsubscribe', 'click here', 'limited time', 'act now', 'free money']
        }
    },
    trusted_vendors: [],
    auto_unsubscribe_list: []
};

/**
 * Load categorization rules from file.
 *
 * @returns {Object} Rules configuration
 */
function loadRules() {
    try {
        if (fs.existsSync(RULES_FILE)) {
            const data = fs.readFileSync(RULES_FILE, 'utf8');
            return JSON.parse(data);
        }
    } catch (err) {
        console.error('[email-categorizer] Failed to load rules:', err.message);
    }
    return DEFAULT_RULES;
}

/**
 * Check if text contains any of the keywords (case-insensitive).
 *
 * @param {string} text - Text to search
 * @param {string[]} keywords - Keywords to look for
 * @returns {boolean} True if any keyword found
 */
function containsKeyword(text, keywords) {
    if (!text || !keywords || !Array.isArray(keywords)) return false;
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Check if email is from a sender matching the pattern.
 *
 * @param {string} from - Email from address
 * @param {string[]} senders - List of sender patterns to match
 * @returns {boolean} True if sender matches any pattern
 */
function matchesSender(from, senders) {
    if (!from || !senders || !Array.isArray(senders)) return false;
    const lowerFrom = from.toLowerCase();
    return senders.some(sender => lowerFrom.includes(sender.toLowerCase()));
}

/**
 * Determine priority based on category and content.
 *
 * @param {string} category - Email category
 * @param {Object} email - Email object
 * @param {Object} rules - Rules configuration
 * @returns {string} Priority level (high, medium, low)
 */
function determinePriority(category, email, rules) {
    const categoryConfig = rules.categories?.[category];

    // Check if category has explicit priority
    if (categoryConfig?.priority) {
        return categoryConfig.priority;
    }

    // Default priorities by category
    const defaultPriorities = {
        vendor_deal: 'high',
        customer_inquiry: 'medium',
        invoice: 'medium',
        shipping: 'low',
        newsletter: 'low',
        spam: 'low',
    };

    return defaultPriorities[category] || 'low';
}

/**
 * Determine action based on category.
 *
 * @param {string} category - Email category
 * @param {Object} rules - Rules configuration
 * @returns {string} Action to take
 */
function determineAction(category, rules) {
    const categoryConfig = rules.categories?.[category];

    if (categoryConfig?.action) {
        return categoryConfig.action;
    }

    // Default actions by category
    const defaultActions = {
        vendor_deal: 'push_to_secretary',
        customer_inquiry: 'include_in_digest',
        invoice: 'include_in_digest',
        shipping: 'include_in_digest',
        newsletter: 'ignore',
        spam: 'ignore',
    };

    return defaultActions[category] || 'ignore';
}

/**
 * Categorize an email based on rules.
 *
 * @param {{ from: string, to: string, subject: string, body: string, snippet: string }} email - Email object
 * @returns {{ category: string, priority: string, action: string }}
 */
function categorizeEmail(email) {
    const rules = loadRules();

    // Combine subject, snippet, and body for keyword matching
    const searchableText = [
        email.subject || '',
        email.snippet || '',
        email.body || ''
    ].join(' ');

    // Check for vendor deals first (high priority)
    const vendorDealConfig = rules.categories?.vendor_deal;
    if (vendorDealConfig && containsKeyword(searchableText, vendorDealConfig.keywords)) {
        // Check if from trusted vendor
        const isTrustedVendor = matchesSender(email.from, rules.trusted_vendors);

        // LOGIC CHANGE 2026-04-01: Rate-limit bulletin posting to prevent flood attacks.
        // If bulletin rate limit is exceeded, suppress this bulletin and track for later summary.
        const bulletinData = {
            from: email.from,
            subject: email.subject,
            isTrustedVendor,
            timestamp: new Date().toISOString(),
        };

        const canPost = rateLimiter.canPostBulletin();
        if (canPost.allowed) {
            // Post to bulletin board for vendor deals
            try {
                bulletinBoard.postBulletin('email-monitor', 'vendor_deal', bulletinData);
                rateLimiter.recordBulletinPosted();
            } catch (err) {
                console.error('[email-categorizer] Failed to post vendor deal bulletin:', err.message);
            }
        } else {
            // Suppress bulletin due to rate limiting
            console.warn(`[email-categorizer] Bulletin suppressed: ${canPost.reason}`);
            rateLimiter.recordBulletinSuppressed({ type: 'vendor_deal', ...bulletinData });
        }

        return {
            category: 'vendor_deal',
            priority: 'high',
            action: 'push_to_secretary',
        };
    }

    // Check for customer inquiries
    const customerConfig = rules.categories?.customer_inquiry;
    if (customerConfig && containsKeyword(searchableText, customerConfig.keywords)) {
        return {
            category: 'customer_inquiry',
            priority: determinePriority('customer_inquiry', email, rules),
            action: determineAction('customer_inquiry', rules),
        };
    }

    // Check for invoices
    const invoiceConfig = rules.categories?.invoice;
    if (invoiceConfig && containsKeyword(searchableText, invoiceConfig.keywords)) {
        return {
            category: 'invoice',
            priority: determinePriority('invoice', email, rules),
            action: determineAction('invoice', rules),
        };
    }

    // Check for shipping notifications
    const shippingConfig = rules.categories?.shipping;
    if (shippingConfig && containsKeyword(searchableText, shippingConfig.keywords)) {
        return {
            category: 'shipping',
            priority: determinePriority('shipping', email, rules),
            action: determineAction('shipping', rules),
        };
    }

    // Check for newsletters
    const newsletterConfig = rules.categories?.newsletter;
    if (newsletterConfig && containsKeyword(searchableText, newsletterConfig.keywords)) {
        return {
            category: 'newsletter',
            priority: 'low',
            action: 'ignore',
        };
    }

    // Check for spam indicators
    const spamConfig = rules.categories?.spam;
    if (spamConfig && containsKeyword(searchableText, spamConfig.keywords)) {
        return {
            category: 'spam',
            priority: 'low',
            action: 'ignore',
        };
    }

    // Default to uncategorized (include in digest for review)
    return {
        category: 'uncategorized',
        priority: 'low',
        action: 'include_in_digest',
    };
}

/**
 * Categorize multiple emails and return summary.
 * LOGIC CHANGE 2026-04-01: Added rate limiting for batch processing.
 * If email rate limit is exceeded, remaining emails are counted but not fully processed.
 *
 * @param {Array<{ from: string, subject: string, body: string, snippet: string }>} emails - Array of emails
 * @returns {{ byCategory: Object<string, number>, flagged: Array, total: number, rateLimited: number }}
 */
function categorizeEmails(emails) {
    const byCategory = {};
    const flagged = [];
    let rateLimited = 0;

    for (const email of emails) {
        // LOGIC CHANGE 2026-04-01: Check rate limit before processing each email.
        // This prevents overwhelming the system with large email batches.
        const canProcess = rateLimiter.canProcessEmail();
        if (!canProcess.allowed) {
            // Skip processing but count as rate limited
            rateLimited++;
            rateLimiter.recordEmailSuppressed();
            continue;
        }

        rateLimiter.recordEmailProcessed();
        const result = categorizeEmail(email);

        // Count by category
        byCategory[result.category] = (byCategory[result.category] || 0) + 1;

        // Track flagged items (high priority or special actions)
        if (result.priority === 'high' || result.action === 'push_to_secretary') {
            flagged.push({
                email,
                ...result,
            });
        }
    }

    // Log rate limit warning if any emails were skipped
    if (rateLimited > 0) {
        console.warn(`[email-categorizer] Rate limited: ${rateLimited}/${emails.length} emails skipped`);
    }

    return {
        byCategory,
        flagged,
        total: emails.length,
        rateLimited,
    };
}

/**
 * Format email summary for morning digest.
 * LOGIC CHANGE 2026-04-01: Added rate limit warning to summary output.
 *
 * @param {{ byCategory: Object<string, number>, flagged: Array, total: number, rateLimited?: number }} summary - Categorization summary
 * @returns {string} Formatted summary string
 */
function formatSummary(summary) {
    if (summary.total === 0) {
        return 'Email: No new emails in the last 24 hours.';
    }

    const parts = [`Email: ${summary.total} new`];

    // Build category breakdown
    const categoryParts = [];
    if (summary.byCategory.vendor_deal) {
        categoryParts.push(`${summary.byCategory.vendor_deal} vendor`);
    }
    if (summary.byCategory.customer_inquiry) {
        categoryParts.push(`${summary.byCategory.customer_inquiry} customer`);
    }
    if (summary.byCategory.invoice) {
        categoryParts.push(`${summary.byCategory.invoice} invoice`);
    }
    if (summary.byCategory.shipping) {
        categoryParts.push(`${summary.byCategory.shipping} shipping`);
    }
    if (summary.byCategory.newsletter) {
        categoryParts.push(`${summary.byCategory.newsletter} newsletter`);
    }

    if (categoryParts.length > 0) {
        parts[0] += ` (${categoryParts.join(', ')})`;
    }

    // Add flagged items note
    if (summary.flagged.length > 0) {
        parts.push(`${summary.flagged.length} vendor deal${summary.flagged.length !== 1 ? 's' : ''} flagged.`);
    }

    // LOGIC CHANGE 2026-04-01: Show rate limit warning if emails were skipped
    if (summary.rateLimited && summary.rateLimited > 0) {
        parts.push(`:warning: ${summary.rateLimited} email${summary.rateLimited !== 1 ? 's' : ''} skipped (rate limit).`);
    }

    return parts.join('. ');
}

module.exports = {
    categorizeEmail,
    categorizeEmails,
    formatSummary,
    loadRules,
    // Export for testing
    containsKeyword,
    matchesSender,
    determinePriority,
    determineAction,
    DEFAULT_RULES,
    RULES_FILE,
};
