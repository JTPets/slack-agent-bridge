/**
 * lib/integrations/gmail.js
 *
 * Gmail API integration for fetching emails.
 * Read-only. Never send, delete, or modify emails.
 *
 * LOGIC CHANGE 2026-03-28: Created gmail.js for email monitoring integration.
 * Uses same OAuth credentials as google-calendar.js (GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN).
 *
 * LOGIC CHANGE 2026-04-01: Added prompt injection sanitization via email-sanitizer.
 * All public API functions now sanitize email bodies by default to prevent
 * prompt injection attacks when email content is passed to LLM prompts.
 *
 * Required env vars (one of):
 *   GOOGLE_SERVICE_ACCOUNT_KEY - Path to service account JSON key file
 *   OR
 *   GOOGLE_REFRESH_TOKEN (or GOOGLE_CALENDAR_REFRESH_TOKEN), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET - OAuth credentials
 */

'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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

// ---- Auth helpers ----

/**
 * Get the OAuth refresh token from environment variables.
 * Supports both GOOGLE_REFRESH_TOKEN and GOOGLE_CALENDAR_REFRESH_TOKEN.
 *
 * @returns {string|undefined} Refresh token or undefined
 */
function getRefreshToken() {
    // LOGIC CHANGE 2026-03-28: Added GOOGLE_REFRESH_TOKEN as alias for
    // GOOGLE_CALENDAR_REFRESH_TOKEN. Same token covers both Gmail and Calendar.
    return process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
}

/**
 * Create an authenticated Gmail client, reporting WHY when it cannot.
 *
 * LOGIC CHANGE 2026-09-14: Split out of getGmailClient(). The old function
 * returned `null` for three different situations - no credentials configured, a
 * service-account key file that is not on disk, and the googleapis constructor
 * throwing - and every caller collapsed that null into an empty result. A
 * scheduled inbox check that found nothing and one that was never authenticated
 * were indistinguishable at every layer above this. The reason string is what
 * lib/email-check.js escalates on.
 *
 * @returns {Promise<{ client: import('googleapis').gmail_v1.Gmail|null, reason: string|null, error: string|null }>}
 */
async function createGmailClient() {
    try {
        let auth;

        // Option 1: Service account
        const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (serviceAccountPath) {
            const keyPath = path.resolve(serviceAccountPath);
            if (!fs.existsSync(keyPath)) {
                console.warn('[gmail] Service account key file not found:', keyPath);
                return {
                    client: null,
                    reason: 'service_account_key_missing',
                    // Never the key contents - only the configured path, which is
                    // a path, not a credential.
                    error: `GOOGLE_SERVICE_ACCOUNT_KEY points at a file that does not exist: ${keyPath}`,
                };
            }

            const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            auth = new google.auth.GoogleAuth({
                credentials: keyFile,
                scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            });
        }
        // Option 2: OAuth refresh token
        else if (
            getRefreshToken() &&
            process.env.GOOGLE_CLIENT_ID &&
            process.env.GOOGLE_CLIENT_SECRET
        ) {
            const oauth2Client = new google.auth.OAuth2(
                process.env.GOOGLE_CLIENT_ID,
                process.env.GOOGLE_CLIENT_SECRET
            );
            oauth2Client.setCredentials({
                refresh_token: getRefreshToken(),
            });
            auth = oauth2Client;
        } else {
            console.warn('[gmail] No authentication configured. Set GOOGLE_SERVICE_ACCOUNT_KEY or OAuth credentials (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).');
            return {
                client: null,
                reason: 'no_credentials',
                error: 'No Gmail authentication configured. Set GOOGLE_SERVICE_ACCOUNT_KEY, or all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN.',
            };
        }

        return { client: google.gmail({ version: 'v1', auth }), reason: null, error: null };
    } catch (err) {
        console.error('[gmail] Failed to create Gmail client:', err.message);
        return { client: null, reason: 'client_error', error: err.message };
    }
}

/**
 * Create an authenticated Gmail client.
 * Tries service account first, then OAuth refresh token.
 *
 * Kept as the null-returning shape its existing callers expect; the reason is
 * available from createGmailClient() for callers that need to tell the failure
 * modes apart.
 *
 * @returns {Promise<import('googleapis').gmail_v1.Gmail|null>} Gmail client or null on failure
 */
async function getGmailClient() {
    const { client } = await createGmailClient();
    return client;
}

// ---- Email transformation helpers ----

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

// ---- Public API ----

/**
 * Fetch recent emails from Gmail, returning an explicit verdict.
 *
 * LOGIC CHANGE 2026-09-14: Added alongside getRecentEmails(). getRecentEmails()
 * returns `[]` for "the inbox is empty", for "Gmail is not authenticated", and
 * for "the Gmail API returned an error" - three facts a scheduled check must be
 * able to tell apart, because two of them mean a human has to do something and
 * one means everything is fine. This function never collapses them: `ok` is
 * false for every failure, `reason` names which, and partial failures (some
 * message bodies unfetchable) are counted rather than dropped silently.
 *
 * Read-only: this issues messages.list and messages.get only. It never sends,
 * deletes, labels or otherwise modifies the mailbox.
 *
 * @param {Date|string|number} [since] - Fetch emails after this time
 * @param {number} [maxResults=50] - Maximum number of emails to return
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.sanitize=true] - Sanitize email bodies for LLM safety
 * @returns {Promise<{ ok: boolean, emails: Array<Object>, reason: string|null, error: string|null, listed: number, failed: number }>}
 */
async function fetchRecentEmails(since, maxResults = 50, options = {}) {
    const { sanitize = true } = options;

    const { client: gmail, reason, error } = await createGmailClient();
    if (!gmail) {
        return { ok: false, emails: [], reason, error, listed: 0, failed: 0 };
    }

    // Build query for messages after the specified time
    let query = 'in:inbox';
    if (since) {
        const sinceDate = new Date(since);
        // Gmail query uses epoch seconds
        const afterTimestamp = Math.floor(sinceDate.getTime() / 1000);
        query += ` after:${afterTimestamp}`;
    }

    let messages;
    try {
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults,
        });
        messages = listResponse.data.messages || [];
    } catch (err) {
        console.error('[gmail] messages.list failed:', err.message);
        return { ok: false, emails: [], reason: 'list_failed', error: err.message, listed: 0, failed: 0 };
    }

    if (messages.length === 0) {
        // Genuinely empty - an ok verdict with zero emails, NOT a failure.
        return { ok: true, emails: [], reason: null, error: null, listed: 0, failed: 0 };
    }

    // Fetch full message details for each. A per-message failure is counted, not
    // swallowed: 40 listed and 40 failed must not read as a successful fetch.
    const emails = [];
    let failed = 0;
    let lastError = null;
    for (const msg of messages) {
        try {
            const fullMessage = await gmail.users.messages.get({
                userId: 'me',
                id: msg.id,
                format: 'full',
            });
            emails.push(transformEmail(fullMessage.data, { sanitize }));
        } catch (err) {
            failed++;
            lastError = err.message;
            console.error(`[gmail] Failed to fetch message ${msg.id}:`, err.message);
        }
    }

    // Every listed message failed to fetch: the API is answering list but not
    // get. That is a failed check, not an empty inbox.
    if (failed === messages.length) {
        return {
            ok: false,
            emails: [],
            reason: 'all_messages_failed',
            error: `All ${failed} listed message(s) failed to fetch. Last error: ${lastError}`,
            listed: messages.length,
            failed,
        };
    }

    return {
        ok: true,
        emails,
        reason: failed > 0 ? 'partial' : null,
        error: failed > 0 ? `${failed} of ${messages.length} message(s) failed to fetch. Last error: ${lastError}` : null,
        listed: messages.length,
        failed,
    };
}

/**
 * Fetch recent emails from Gmail.
 *
 * SECURITY: Email bodies are sanitized by default to prevent prompt injection
 * when content is passed to LLMs. Set options.sanitize=false only for internal
 * processing that does not involve LLM prompts.
 *
 * LOGIC CHANGE 2026-09-14: Now delegates to fetchRecentEmails(). The
 * `[]`-on-any-failure contract is unchanged for its existing caller
 * (morning-digest.js:368), which treats an empty result as "no email section" -
 * correct for a digest, wrong for a monitor. New callers that must distinguish
 * empty from broken use fetchRecentEmails() instead.
 *
 * @param {Date|string|number} [since] - Fetch emails after this time (Date, ISO string, or timestamp)
 * @param {number} [maxResults=50] - Maximum number of emails to return
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.sanitize=true] - Sanitize email bodies for LLM safety
 * @returns {Promise<Array<Object>>}
 */
async function getRecentEmails(since, maxResults = 50, options = {}) {
    try {
        const result = await fetchRecentEmails(since, maxResults, options);
        return result.emails;
    } catch (err) {
        console.error('[gmail] Failed to fetch recent emails:', err.message);
        return [];
    }
}

/**
 * Fetch a single email by ID.
 *
 * SECURITY: Email body is sanitized by default to prevent prompt injection
 * when content is passed to LLMs. Set options.sanitize=false only for internal
 * processing that does not involve LLM prompts.
 *
 * @param {string} id - Gmail message ID
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.sanitize=true] - Sanitize email body for LLM safety
 * @returns {Promise<{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[], body: string, sanitized?: boolean, injectionDetected?: boolean }|null>}
 */
async function getEmailById(id, options = {}) {
    const { sanitize = true } = options;

    try {
        const gmail = await getGmailClient();
        if (!gmail) {
            return null;
        }

        const response = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'full',
        });

        return transformEmail(response.data, { sanitize });
    } catch (err) {
        console.error(`[gmail] Failed to fetch email ${id}:`, err.message);
        return null;
    }
}

/**
 * Fetch email headers only (lighter weight than full email).
 *
 * SECURITY: Headers are sanitized by default to prevent prompt injection
 * when header content is passed to LLMs. Set options.sanitize=false only for
 * internal processing that does not involve LLM prompts.
 *
 * LOGIC CHANGE 2026-04-01: Added sanitization for headers and snippet to prevent
 * prompt injection attacks. Previously this function returned raw header values
 * which could contain malicious content designed to manipulate LLMs.
 *
 * @param {string} id - Gmail message ID
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.sanitize=true] - Sanitize headers and snippet for LLM safety
 * @returns {Promise<{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[], sanitized?: boolean, injectionDetected?: boolean }|null>}
 */
async function getEmailHeaders(id, options = {}) {
    const { sanitize = true } = options;

    try {
        const gmail = await getGmailClient();
        if (!gmail) {
            return null;
        }

        const response = await gmail.users.messages.get({
            userId: 'me',
            id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        });

        const headers = response.data.payload?.headers || [];
        const rawFrom = getHeader(headers, 'From');
        const rawTo = getHeader(headers, 'To');
        const rawSubject = getHeader(headers, 'Subject');
        const rawDate = getHeader(headers, 'Date');
        const rawSnippet = response.data.snippet || '';

        // LOGIC CHANGE 2026-04-01: Sanitize header values to prevent prompt injection.
        // Attackers can craft emails with malicious subject lines or from names that
        // attempt to manipulate LLMs when the metadata is included in prompts.
        if (sanitize) {
            const sanitizer = getSanitizer();
            let sanitized = false;
            let injectionDetected = false;

            const fromResult = sanitizer.sanitizeMetadata(rawFrom, { detectInjection: true, escape: true });
            const toResult = sanitizer.sanitizeMetadata(rawTo, { detectInjection: true, escape: true });
            const subjectResult = sanitizer.sanitizeMetadata(rawSubject, { detectInjection: true, escape: true });
            const snippetResult = sanitizer.sanitizeMetadata(rawSnippet, { detectInjection: true, escape: true, maxLength: 500 });

            if (fromResult.sanitized || toResult.sanitized || subjectResult.sanitized || snippetResult.sanitized) {
                sanitized = true;
            }
            if (fromResult.injectionDetected || toResult.injectionDetected ||
                subjectResult.injectionDetected || snippetResult.injectionDetected) {
                injectionDetected = true;
                sanitized = true;
                console.warn(`[gmail] Prompt injection detected in email headers for id: ${id}`);
            }

            return {
                id: response.data.id || '',
                from: fromResult.value,
                to: toResult.value,
                subject: subjectResult.value,
                date: rawDate, // Date field is typically safe, but could add sanitization if needed
                snippet: snippetResult.value,
                labels: response.data.labelIds || [],
                sanitized,
                injectionDetected,
            };
        }

        // Return raw headers when sanitization is disabled
        return {
            id: response.data.id || '',
            from: rawFrom,
            to: rawTo,
            subject: rawSubject,
            date: rawDate,
            snippet: rawSnippet,
            labels: response.data.labelIds || [],
        };
    } catch (err) {
        console.error(`[gmail] Failed to fetch email headers ${id}:`, err.message);
        return null;
    }
}

/**
 * Check if Gmail credentials are configured.
 *
 * @returns {boolean} True if credentials are available
 */
function hasCredentials() {
    const hasServiceAccount = !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    const hasOAuth = !!(
        getRefreshToken() &&
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET
    );
    return hasServiceAccount || hasOAuth;
}

module.exports = {
    getRecentEmails,
    fetchRecentEmails,
    getEmailById,
    getEmailHeaders,
    hasCredentials,
    // Export for testing
    createGmailClient,
    getRefreshToken,
    stripHtml,
    decodeBase64Url,
    getHeader,
    extractBody,
    transformEmail,
};
