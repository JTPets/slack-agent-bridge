/**
 * lib/integrations/email-content-sanitize.js
 *
 * HOW one email field is made safe to quote: escaping, truncation, and the two
 * sanitisers built on them (an email body, a header field). Moved unchanged out of
 * lib/integrations/email-sanitizer.js (WORK-TODO #10, B28, 2026-11-12), which
 * re-exports every name as the same object.
 */

'use strict';

const { detectInjectionPatterns } = require('./email-injection-patterns');

// Maximum safe length for email content in prompts (chars)
const MAX_EMAIL_CONTENT_LENGTH = 10000;

// Characters to escape in email content
// LOGIC CHANGE 2026-04-01: Added more escape characters to prevent template
// injection and delimiter confusion attacks.
const ESCAPE_MAP = {
    '`': '\\`',    // Prevent code block injection
    '$': '\\$',    // Prevent variable interpolation
    '{': '\\{',    // Prevent template injection
    '}': '\\}',    // Prevent template injection
};

// Maximum safe length for email metadata fields (subject, from, etc.)
// LOGIC CHANGE 2026-04-01: Added metadata length limit to prevent buffer-style attacks
const MAX_METADATA_LENGTH = 500;

/**
 * Escape potentially dangerous characters in email content.
 *
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeContent(text) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    let escaped = text;
    for (const [char, replacement] of Object.entries(ESCAPE_MAP)) {
        escaped = escaped.split(char).join(replacement);
    }

    return escaped;
}

/**
 * Truncate content to maximum safe length.
 *
 * @param {string} text - Text to truncate
 * @param {number} [maxLength] - Maximum length (default: MAX_EMAIL_CONTENT_LENGTH)
 * @returns {string} Truncated text
 */
function truncateContent(text, maxLength = MAX_EMAIL_CONTENT_LENGTH) {
    if (!text || typeof text !== 'string') {
        return '';
    }

    if (text.length <= maxLength) {
        return text;
    }

    return text.slice(0, maxLength) + '\n[... content truncated for safety ...]';
}

/**
 * Sanitize email metadata fields (subject, from, date, snippet).
 * Applies escaping, truncation, and optional injection detection.
 *
 * LOGIC CHANGE 2026-04-01: Added sanitizeMetadata() to sanitize email header fields
 * before they are included in LLM prompts. Previously, only email body was sanitized,
 * leaving subject/from/snippet vulnerable to prompt injection attacks.
 *
 * @param {string} value - Metadata field value (subject, from, etc.)
 * @param {object} [options] - Sanitization options
 * @param {boolean} [options.detectInjection=true] - Check for injection patterns
 * @param {boolean} [options.escape=true] - Escape dangerous characters
 * @param {number} [options.maxLength] - Custom max length (default: MAX_METADATA_LENGTH)
 * @returns {{ value: string, sanitized: boolean, injectionDetected: boolean, truncated: boolean }}
 */
function sanitizeMetadata(value, options = {}) {
    const {
        detectInjection = true,
        escape = true,
        maxLength = MAX_METADATA_LENGTH,
    } = options;

    const result = {
        value: '',
        sanitized: false,
        injectionDetected: false,
        truncated: false,
    };

    if (!value || typeof value !== 'string') {
        return result;
    }

    let processed = value;

    // Check for injection patterns
    if (detectInjection) {
        const injectionCheck = detectInjectionPatterns(processed);
        if (injectionCheck.detected) {
            result.injectionDetected = true;
            result.sanitized = true;
            // For metadata, we redact but still include a safe placeholder
            // showing the field type was present but redacted
            console.warn('[email-sanitizer] Prompt injection detected in email metadata');
            result.value = '[REDACTED - suspicious content detected]';
            return result;
        }
    }

    // Escape dangerous characters
    if (escape) {
        const escaped = escapeContent(processed);
        if (escaped !== processed) {
            result.sanitized = true;
        }
        processed = escaped;
    }

    // Truncate if needed
    if (processed.length > maxLength) {
        processed = processed.slice(0, maxLength) + '...';
        result.truncated = true;
        result.sanitized = true;
    }

    result.value = processed;
    return result;
}

/**
 * Sanitize email content for safe inclusion in LLM prompts.
 * Returns the sanitized content and metadata about what was done.
 *
 * @param {string} content - Raw email content (body, subject, etc.)
 * @param {object} [options] - Sanitization options
 * @param {boolean} [options.rejectOnInjection=true] - Return empty string if injection detected
 * @param {boolean} [options.escape=true] - Escape dangerous characters
 * @param {boolean} [options.truncate=true] - Truncate to max length
 * @param {number} [options.maxLength] - Custom max length
 * @returns {{ content: string, sanitized: boolean, injectionDetected: boolean, truncated: boolean, originalLength: number }}
 */
function sanitizeEmailContent(content, options = {}) {
    const {
        rejectOnInjection = true,
        escape = true,
        truncate = true,
        maxLength = MAX_EMAIL_CONTENT_LENGTH,
    } = options;

    const result = {
        content: '',
        sanitized: false,
        injectionDetected: false,
        truncated: false,
        originalLength: content?.length || 0,
    };

    if (!content || typeof content !== 'string') {
        return result;
    }

    // Check for injection patterns
    const injectionCheck = detectInjectionPatterns(content);
    if (injectionCheck.detected) {
        result.injectionDetected = true;
        result.sanitized = true;

        if (rejectOnInjection) {
            console.warn('[email-sanitizer] Prompt injection attempt detected in email content');
            console.warn('[email-sanitizer] Patterns:', injectionCheck.patterns.slice(0, 3).join(', '));
            result.content = '[Email content rejected due to suspicious patterns]';
            return result;
        }
    }

    let processed = content;

    // Escape dangerous characters
    if (escape) {
        const escaped = escapeContent(processed);
        if (escaped !== processed) {
            result.sanitized = true;
        }
        processed = escaped;
    }

    // Truncate if needed
    if (truncate && processed.length > maxLength) {
        processed = truncateContent(processed, maxLength);
        result.truncated = true;
        result.sanitized = true;
    }

    result.content = processed;
    return result;
}

module.exports = {
    MAX_EMAIL_CONTENT_LENGTH,
    MAX_METADATA_LENGTH,
    ESCAPE_MAP,
    escapeContent,
    truncateContent,
    sanitizeMetadata,
    sanitizeEmailContent,
};
