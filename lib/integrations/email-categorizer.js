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
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): split by job. The rules and every
 * question asked of one rule are lib/integrations/email-categorizer-rules.js; the
 * bulletin side effect is lib/integrations/email-categorizer-push.js. This file keeps
 * the walk over the categories (categorizeEmail), the batch (categorizeEmails) and its
 * digest line (formatSummary), and re-exports every name it exported before as the same
 * object (tests/module-splits.test.js).
 */

'use strict';

const rateLimiter = require('../email-rate-limiter');
const {
    loadRules,
    containsKeyword,
    wholeWordPattern,
    searchableTextFor,
    matchesSender,
    determinePriority,
    determineAction,
    DEFAULT_RULES,
    RULES_FILE,
} = require('./email-categorizer-rules');
const { pushToSecretary } = require('./email-categorizer-push');

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

    const categories = rules.categories || {};

    // Walk declared categories in order; first keyword OR sender match wins.
    for (const category of Object.keys(categories)) {
        const config = categories[category];
        if (!config) continue;

        // LOGIC CHANGE 2026-10-02: each category chooses which fields its keywords
        // read (`match_in`) and whether they match whole words (`whole_word`). Both
        // default to the old behaviour - all fields, substring - so only a category
        // that opts in changes. See agents/email-monitor/memory/rules.json.
        const matched = containsKeyword(searchableTextFor(email, config), config.keywords, { wholeWord: config.whole_word === true })
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
    wholeWordPattern,
    searchableTextFor,
    matchesSender,
    determinePriority,
    determineAction,
    DEFAULT_RULES,
    RULES_FILE,
};
