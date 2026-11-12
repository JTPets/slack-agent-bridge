/**
 * lib/integrations/email-categorizer-rules.js
 *
 * THE RULES half of the email categorizer: where the rules live (RULES_FILE, read on
 * every check by loadRules, DEFAULT_RULES when it is missing or corrupt), and every
 * question asked of one category's rule — does its keyword list match the fields it
 * names (containsKeyword, wholeWordPattern, searchableTextFor), does its sender list
 * match (matchesSender), and what action and priority it resolves to
 * (determineAction, determinePriority). Pure apart from reading the rules file.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): moved unchanged out of
 * lib/integrations/email-categorizer.js, which re-exports every name here as the same
 * object. The walk over the categories (categorizeEmail) stays there; the bulletin
 * side effect is lib/integrations/email-categorizer-push.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

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
function containsKeyword(text, keywords, options = {}) {
    if (!text || !keywords || !Array.isArray(keywords)) return false;
    if (options.wholeWord) {
        return keywords.some(keyword => wholeWordPattern(keyword).test(text));
    }
    const lowerText = text.toLowerCase();
    return keywords.some(keyword => lowerText.includes(keyword.toLowerCase()));
}

/**
 * Build a case-insensitive pattern matching `keyword` as a whole word.
 *
 * LOGIC CHANGE 2026-10-02: added for a category's `whole_word: true`. Plain
 * substring matching made `sale` fire inside "Sales", "wholesale" and "resale",
 * which is how a Square Cash Drawer Report was flagged as a vendor deal. A
 * boundary is only asserted on a side where the keyword itself starts or ends
 * with a letter or digit, so `% off` still matches "40% off".
 *
 * @param {string} keyword - Keyword to match
 * @returns {RegExp}
 */
function wholeWordPattern(keyword) {
    const kw = String(keyword);
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const before = /^[a-z0-9]/i.test(kw) ? '(?<![a-z0-9])' : '';
    const after = /[a-z0-9]$/i.test(kw) ? '(?![a-z0-9])' : '';
    return new RegExp(`${before}${escaped}${after}`, 'i');
}

// Email fields a category's keywords may be matched against. A category may
// narrow this with `match_in` (LOGIC CHANGE 2026-10-02); the default is all three,
// which is the behaviour every category had before.
const MATCHABLE_FIELDS = ['subject', 'snippet', 'body'];

/**
 * The text a category's keywords are matched against: the fields its
 * `match_in` names, or all of MATCHABLE_FIELDS. An unknown field name is
 * ignored rather than guessed at, and a `match_in` naming none of them falls
 * back to the default so a typo cannot silently disable a category.
 *
 * @param {Object} email - Email object
 * @param {Object} config - Category config from rules.json
 * @returns {string}
 */
function searchableTextFor(email, config) {
    const declared = Array.isArray(config.match_in)
        ? config.match_in.filter(f => MATCHABLE_FIELDS.includes(f))
        : [];
    const fields = declared.length > 0 ? declared : MATCHABLE_FIELDS;
    return fields.map(f => email[f] || '').join(' ');
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

module.exports = {
    loadRules,
    containsKeyword,
    wholeWordPattern,
    searchableTextFor,
    matchesSender,
    determinePriority,
    determineAction,
    DEFAULT_RULES,
    RULES_FILE,
    MATCHABLE_FIELDS,
};
