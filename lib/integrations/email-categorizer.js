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
 *
 * LOGIC CHANGE 2026-09-14: categorizeEmail() no longer runs a hardcoded if-chain
 * over six fixed category names. It now iterates rules.categories in declared
 * (insertion) order and matches each on its own `keywords` OR `senders`, reading
 * `action`/`priority` from the file via determineAction/determinePriority. The
 * operator's rules file is now the whole specification: adding a category — or a
 * keyword to `urgent`/`important`, which the old chain never consulted — changes
 * behaviour. The bulletin side-effect (previously hardwired to `vendor_deal`) now
 * fires for any category whose resolved action is `push_to_secretary`, posting a
 * bulletin typed by the category name (identical to before for `vendor_deal`, whose
 * type other agents watch in agents.json). Closes WORK-TODO #28.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const bulletinBoard = require('../bulletin-board');
const rateLimiter = require('../email-rate-limiter');

// LOGIC CHANGE 2026-04-01: Import email sanitizer for metadata sanitization
// before posting to bulletin board or using in categorization.
let emailSanitizer = null;
function getSanitizer() {
    if (!emailSanitizer) {
        try {
            emailSanitizer = require('./email-sanitizer');
        } catch (err) {
            console.warn('[email-categorizer] email-sanitizer not available');
            // Provide no-op fallback
            emailSanitizer = {
                sanitizeMetadata: (value) => ({ value, sanitized: false, injectionDetected: false }),
            };
        }
    }
    return emailSanitizer;
}

// Path to rules file
const RULES_FILE = path.join(__dirname, '../../agents/email-monitor/memory/rules.json');

// Default rules if file doesn't exist. Key order is significant: categorizeEmail
// walks these in declared (insertion) order and returns the first match, so this
// order is the precedence. It mirrors the old if-chain (vendor_deal, customer_inquiry,
// invoice, shipping, newsletter, spam) so a missing/corrupt file behaves exactly as
// before this became a generic pass.
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
        newsletter: {
            action: 'ignore',
            auto_unsubscribe: false,
            keywords: ['newsletter', 'unsubscribe', 'update', 'digest']
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

    // Default priorities by category — a fallback for a file that declares a
    // category but omits `priority`. The file's own `priority` always wins above.
    const defaultPriorities = {
        urgent: 'high',
        important: 'medium',
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

    // Default actions by category — a fallback for a file that declares a category
    // but omits `action`. The file's own `action` always wins above.
    const defaultActions = {
        urgent: 'notify_immediately',
        important: 'include_in_digest',
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
 * Push a matched email to the Secretary via the bulletin board. Fired for any
 * category whose resolved action is `push_to_secretary` (previously hardwired to
 * `vendor_deal`). The bulletin is typed by the category name — for `vendor_deal`
 * that is identical to before, and other agents watch that type in agents.json.
 *
 * Sanitises sender/subject before they leave this module (prompt-injection
 * protection for LLMs that later read bulletins) and honours the bulletin rate
 * limit, suppressing rather than posting when the window is full.
 *
 * @param {string} category - The matched category name (used as the bulletin type)
 * @param {{ from: string, subject: string }} email - Email object
 * @param {Object} rules - Rules configuration (for trusted_vendors)
 * @returns {void}
 */
function pushToSecretary(category, email, rules) {
    const isTrustedVendor = matchesSender(email.from, rules.trusted_vendors);

    // LOGIC CHANGE 2026-04-01: Sanitize email metadata before including in bulletins.
    // This prevents prompt injection via malicious sender names or subject lines
    // that could later be processed by LLMs when agents read bulletins.
    const sanitizer = getSanitizer();
    const sanitizedFrom = sanitizer.sanitizeMetadata(email.from || '', { escape: true });
    const sanitizedSubject = sanitizer.sanitizeMetadata(email.subject || '', { escape: true });

    // Log injection attempts in email metadata
    if (sanitizedFrom.injectionDetected || sanitizedSubject.injectionDetected) {
        console.warn('[email-categorizer] Prompt injection detected in email metadata');
    }

    // LOGIC CHANGE 2026-04-01: Rate-limit bulletin posting to prevent flood attacks.
    // If bulletin rate limit is exceeded, suppress this bulletin and track for later summary.
    const bulletinData = {
        from: sanitizedFrom.value,
        subject: sanitizedSubject.value,
        isTrustedVendor,
        timestamp: new Date().toISOString(),
        metadataSanitized: sanitizedFrom.sanitized || sanitizedSubject.sanitized,
    };

    const canPost = rateLimiter.canPostBulletin();
    if (canPost.allowed) {
        try {
            bulletinBoard.postBulletin('email-monitor', category, bulletinData);
            rateLimiter.recordBulletinPosted();
        } catch (err) {
            console.error('[email-categorizer] Failed to post bulletin:', err.message);
        }
    } else {
        console.warn(`[email-categorizer] Bulletin suppressed: ${canPost.reason}`);
        rateLimiter.recordBulletinSuppressed({ type: category, ...bulletinData });
    }
}

/**
 * Categorize an email based on rules.
 *
 * LOGIC CHANGE 2026-09-14: generic pass over rules.categories in declared order,
 * replacing the hardcoded six-branch if-chain (WORK-TODO #28). Each category is
 * matched on its own `keywords` OR `senders`, and its `action`/`priority` are read
 * from the file — so the operator's rules.json is the whole specification and
 * every category it declares (including `urgent`/`important`, which the old chain
 * never consulted) actually fires. Order in rules.categories is the precedence.
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

    const categories = rules.categories || {};

    // Walk declared categories in order; first keyword OR sender match wins.
    for (const category of Object.keys(categories)) {
        const config = categories[category];
        if (!config) continue;

        const matched = containsKeyword(searchableText, config.keywords)
            || matchesSender(email.from, config.senders);
        if (!matched) continue;

        const action = determineAction(category, rules);
        const priority = determinePriority(category, email, rules);

        // The bulletin side-effect follows the action, not a hardcoded category name.
        if (action === 'push_to_secretary') {
            pushToSecretary(category, email, rules);
        }

        return { category, priority, action };
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

    // Build category breakdown, highest-precedence categories first. urgent and
    // important were added 2026-09-14 when the categorizer began honouring them
    // (WORK-TODO #28) — before that they could never appear in a count.
    const categoryParts = [];
    if (summary.byCategory.urgent) {
        categoryParts.push(`${summary.byCategory.urgent} urgent`);
    }
    if (summary.byCategory.important) {
        categoryParts.push(`${summary.byCategory.important} important`);
    }
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

    // Add flagged items note. `flagged` is anything high-priority or push_to_secretary
    // (categorizeEmails), which is no longer only vendor deals now that `urgent` fires —
    // so the label is category-neutral. formatOkMessage lists each with its category.
    if (summary.flagged.length > 0) {
        parts.push(`${summary.flagged.length} flagged for attention.`);
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
