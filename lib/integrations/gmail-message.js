/**
 * lib/integrations/gmail-message.js
 *
 * Turning a Gmail API message into the plain email object the rest of the bridge
 * reads: MIME body extraction, HTML stripping, header lookup, and the prompt-injection
 * sanitisation of body and snippet. Pure — no network, no credentials.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/integrations/gmail.js
 * unchanged, on the boundary #10 names (auth vs. MIME decoding vs. the read API). The
 * decoder is the part that handles untrusted input, and it is now testable without the
 * googleapis client in scope. lib/integrations/gmail.js re-exports every function, so
 * no caller changed.
 */

'use strict';

// LOGIC CHANGE 2026-04-01: Import email sanitizer for prompt injection protection.
// Lazy-loaded to handle cases where the module might not be available.
// LOGIC CHANGE 2026-04-01: Added sanitizeMetadata to no-op fallback for snippet sanitization.
let emailSanitizer = null;
function getSanitizer() {
    if (!emailSanitizer) {
        try {
            emailSanitizer = require('./email-sanitizer');
        } catch (err) {
            console.warn('[gmail] email-sanitizer not available, using no-op sanitization');
            // Provide no-op fallback
            emailSanitizer = {
                sanitizeEmailContent: (content) => ({ content, sanitized: false, injectionDetected: false }),
                sanitizeMetadata: (value) => ({ value, sanitized: false, injectionDetected: false, truncated: false }),
            };
        }
    }
    return emailSanitizer;
}

/**
 * Strip HTML tags from text content.
 *
 * @param {string} html - HTML content
 * @returns {string} Plain text content
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Decode base64url encoded string.
 *
 * @param {string} data - Base64url encoded string
 * @returns {string} Decoded string
 */
function decodeBase64Url(data) {
    if (!data) return '';
    // Replace URL-safe chars with standard base64 chars
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Extract header value from email headers array.
 *
 * @param {Array<{name: string, value: string}>} headers - Email headers
 * @param {string} name - Header name (case-insensitive)
 * @returns {string} Header value or empty string
 */
function getHeader(headers, name) {
    if (!headers || !Array.isArray(headers)) return '';
    const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
    return header ? header.value : '';
}

/**
 * Extract email body from message payload.
 * Handles both simple and multipart messages.
 *
 * @param {Object} payload - Gmail message payload
 * @returns {string} Plain text body content
 */
function extractBody(payload) {
    if (!payload) return '';

    // Simple message with direct body
    if (payload.body && payload.body.data) {
        const decoded = decodeBase64Url(payload.body.data);
        // If it's HTML, strip tags
        if (payload.mimeType === 'text/html') {
            return stripHtml(decoded);
        }
        return decoded;
    }

    // Multipart message - look for text parts
    if (payload.parts && Array.isArray(payload.parts)) {
        // Prefer text/plain over text/html
        const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body && textPart.body.data) {
            return decodeBase64Url(textPart.body.data);
        }

        // Fall back to text/html
        const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
        if (htmlPart && htmlPart.body && htmlPart.body.data) {
            return stripHtml(decodeBase64Url(htmlPart.body.data));
        }

        // Recursively check nested multipart
        for (const part of payload.parts) {
            if (part.parts) {
                const nested = extractBody(part);
                if (nested) return nested;
            }
        }
    }

    return '';
}

/**
 * Transform a Gmail message to a simple email object.
 *
 * LOGIC CHANGE 2026-04-01: Now sanitizes snippet field in addition to body.
 * Snippet is Gmail's preview text and could contain injection attempts.
 *
 * @param {Object} message - Gmail API message object (full format)
 * @param {Object} [options] - Transform options
 * @param {boolean} [options.sanitize=true] - Sanitize body for LLM safety
 * @param {boolean} [options.sanitizeSnippet=true] - Sanitize snippet for LLM safety
 * @returns {{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[], body: string, sanitized?: boolean, injectionDetected?: boolean, snippetInjectionDetected?: boolean }}
 */
function transformEmail(message, options = {}) {
    const { sanitize = true, sanitizeSnippet = true } = options;
    const headers = message.payload?.headers || [];

    const rawBody = extractBody(message.payload);
    let body = rawBody;
    let sanitized = false;
    let injectionDetected = false;

    // LOGIC CHANGE 2026-04-01: Sanitize email body by default to prevent prompt injection.
    // Email content from external sources should never be trusted when passed to LLMs.
    if (sanitize && rawBody) {
        const sanitizer = getSanitizer();
        const result = sanitizer.sanitizeEmailContent(rawBody, {
            rejectOnInjection: true,  // Replace malicious content with safe message
            escape: true,              // Escape special characters
            truncate: true,            // Limit length
        });
        body = result.content;
        sanitized = result.sanitized;
        injectionDetected = result.injectionDetected;

        if (injectionDetected) {
            console.warn(`[gmail] Prompt injection detected in email from: ${getHeader(headers, 'From')}, subject: ${getHeader(headers, 'Subject')}`);
        }
    }

    // LOGIC CHANGE 2026-04-01: Sanitize snippet field to prevent prompt injection.
    // Snippet is Gmail's preview text extracted from the email body, and attackers
    // could craft emails where the preview shows malicious instructions.
    let snippet = message.snippet || '';
    let snippetInjectionDetected = false;
    if (sanitizeSnippet && snippet) {
        const sanitizer = getSanitizer();
        const snippetResult = sanitizer.sanitizeMetadata(snippet, {
            detectInjection: true,
            escape: true,
            maxLength: 500, // Snippets are typically short
        });
        snippet = snippetResult.value;
        if (snippetResult.injectionDetected) {
            snippetInjectionDetected = true;
            sanitized = true;
            console.warn(`[gmail] Prompt injection detected in email snippet from: ${getHeader(headers, 'From')}`);
        } else if (snippetResult.sanitized) {
            sanitized = true;
        }
    }

    return {
        id: message.id || '',
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        date: getHeader(headers, 'Date'),
        snippet,
        labels: message.labelIds || [],
        body,
        ...(sanitize ? { sanitized, injectionDetected, snippetInjectionDetected } : {}),
    };
}

module.exports = {
    getSanitizer,
    stripHtml,
    decodeBase64Url,
    getHeader,
    extractBody,
    transformEmail,
};
