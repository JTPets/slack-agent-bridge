/**
 * lib/integrations/email-sanitizer.js
 *
 * Sanitization guards for email content before passing to LLM prompts.
 * Prevents prompt injection attacks via malicious email content.
 *
 * LOGIC CHANGE 2026-04-01: Created email-sanitizer.js as defensive guard
 * against prompt injection. Now integrated with gmail.js to sanitize all
 * email bodies before they reach LLM prompts via the check-inbox task.
 *
 * Attack vectors mitigated:
 * - System prompt override attempts ("Ignore previous instructions...")
 * - Role injection ("You are now a helpful assistant that...")
 * - Delimiter escape ("```\nSYSTEM: new instructions\n```")
 * - Instruction injection via markdown/formatting
 * - Claude-specific jailbreak attempts (DAN, Developer Mode, etc.)
 * - Context confusion via fake conversation history
 * - Hidden instructions in Unicode or encoding tricks
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): split by job, no behaviour change.
 * The patterns and the check are lib/integrations/email-injection-patterns.js; escaping,
 * truncation and the body/header sanitisers are email-content-sanitize.js; the prompt
 * block and prepareEmailForLLM are email-prompt-wrap.js. This file re-exports every
 * name it exported before as the same object (tests/module-splits.test.js).
 */

'use strict';

const { INJECTION_PATTERNS, detectInjectionPatterns } = require('./email-injection-patterns');
const {
    MAX_EMAIL_CONTENT_LENGTH,
    MAX_METADATA_LENGTH,
    ESCAPE_MAP,
    escapeContent,
    truncateContent,
    sanitizeMetadata,
    sanitizeEmailContent,
} = require('./email-content-sanitize');
const { wrapEmailContent, prepareEmailForLLM } = require('./email-prompt-wrap');

module.exports = {
    // Main functions
    sanitizeEmailContent,
    prepareEmailForLLM,
    sanitizeMetadata,

    // Helpers (exported for testing)
    detectInjectionPatterns,
    escapeContent,
    truncateContent,
    wrapEmailContent,

    // Constants (exported for testing)
    INJECTION_PATTERNS,
    MAX_EMAIL_CONTENT_LENGTH,
    MAX_METADATA_LENGTH,
    ESCAPE_MAP,
};
