/**
 * lib/integrations/email-categorizer-push.js
 *
 * THE SIDE EFFECT of the email categorizer: pushing a matched email to the Secretary as
 * a bulletin (pushToSecretary), with sender and subject sanitised first and the bulletin
 * rate limit honoured. Fired by categorizeEmail for any category whose resolved action
 * is `push_to_secretary`.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): moved unchanged out of
 * lib/integrations/email-categorizer.js, which re-exports pushToSecretary as the same
 * object. Its require of ../bulletin-board is the same module path, so a suite's
 * jest.mock('../lib/bulletin-board') still reaches it.
 */

'use strict';

const bulletinBoard = require('../bulletin-board');
const rateLimiter = require('../email-rate-limiter');
const { matchesSender } = require('./email-categorizer-rules');

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
            // LOGIC CHANGE 2026-09-15: check the RETURN VALUE. postBulletin does not
            // throw on a bad type — it returns { success: false, error } — so this
            // try/catch could never fire and a rejected bulletin vanished in silence.
            //
            // The rejection is reachable by configuration, not by accident. This types
            // the bulletin by the CATEGORY NAME, and category names come from
            // agents/email-monitor/memory/rules.json, which is operator-editable,
            // while the valid types come from BULLETIN_TYPES. Today only `vendor_deal`
            // resolves to `push_to_secretary` and it happens to be a valid type, so
            // nothing is being dropped right now. Give `urgent` that action — which is
            // exactly what the file is for — and every one of its bulletins would be
            // rejected with no log line anywhere. tests/bulletin-types.test.js is the
            // enumerating guard; this is the runtime half.
            const result = bulletinBoard.postBulletin('email-monitor', category, bulletinData);
            if (result && result.success === false) {
                console.error(
                    `[email-categorizer] Bulletin REJECTED for category "${category}": ${result.error}. ` +
                    'The category name is used as the bulletin type, so a category in rules.json that is ' +
                    'not one of BULLETIN_TYPES can never post. Nothing was recorded.'
                );
            } else {
                rateLimiter.recordBulletinPosted();
            }
        } catch (err) {
            console.error('[email-categorizer] Failed to post bulletin:', err.message);
        }
    } else {
        console.warn(`[email-categorizer] Bulletin suppressed: ${canPost.reason}`);
        rateLimiter.recordBulletinSuppressed({ type: category, ...bulletinData });
    }
}

module.exports = { pushToSecretary, getSanitizer };
