/**
 * lib/integrations/gmail.js
 *
 * Gmail API integration for fetching and managing emails.
 *
 * LOGIC CHANGE 2026-03-28: Created gmail.js for email monitoring integration.
 * Uses same OAuth credentials as google-calendar.js (GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN).
 *
 * LOGIC CHANGE 2026-04-01: Added prompt injection sanitization via email-sanitizer.
 * All public API functions now sanitize email bodies by default to prevent
 * prompt injection attacks when email content is passed to LLM prompts.
 *
 * LOGIC CHANGE 2026-04-01: Added markAsRead function requiring gmail.modify scope.
 * The module now supports two scope levels:
 *   - gmail.readonly: Read emails only (default, backwards compatible)
 *   - gmail.modify: Read + mark as read/unread (required for markAsRead)
 * When gmail.modify scope is not available, markAsRead fails gracefully.
 *
 * Required env vars (one of):
 *   GOOGLE_SERVICE_ACCOUNT_KEY - Path to service account JSON key file
 *   OR
 *   GOOGLE_REFRESH_TOKEN (or GOOGLE_CALENDAR_REFRESH_TOKEN), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET - OAuth credentials
 *
 * Scope requirements documented in CLAUDE.md.
 */

'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// LOGIC CHANGE 2026-04-01: Import email sanitizer for prompt injection protection.
// Lazy-loaded to handle cases where the module might not be available.
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

// Available scopes
const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/**
 * Create an authenticated Gmail client with the specified scope.
 * Tries service account first, then OAuth refresh token.
 *
 * LOGIC CHANGE 2026-04-01: Added scope parameter to support both readonly and modify.
 * - 'readonly' (default): Only read emails
 * - 'modify': Read + mark as read/unread (required for markAsRead)
 *
 * @param {Object} [options] - Client options
 * @param {string} [options.scope='readonly'] - Scope level: 'readonly' or 'modify'
 * @returns {Promise<import('googleapis').gmail_v1.Gmail|null>} Gmail client or null on failure
 */
async function getGmailClient(options = {}) {
    const { scope = 'readonly' } = options;
    const scopeUrl = scope === 'modify' ? SCOPE_MODIFY : SCOPE_READONLY;

    try {
        let auth;

        // Option 1: Service account
        const serviceAccountPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
        if (serviceAccountPath) {
            const keyPath = path.resolve(serviceAccountPath);
            if (!fs.existsSync(keyPath)) {
                console.warn('[gmail] Service account key file not found:', keyPath);
                return null;
            }

            const keyFile = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
            auth = new google.auth.GoogleAuth({
                credentials: keyFile,
                scopes: [scopeUrl],
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
            return null;
        }

        return google.gmail({ version: 'v1', auth });
    } catch (err) {
        console.error('[gmail] Failed to create Gmail client:', err.message);
        return null;
    }
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
 * @param {Object} message - Gmail API message object (full format)
 * @param {Object} [options] - Transform options
 * @param {boolean} [options.sanitize=true] - Sanitize body for LLM safety
 * @returns {{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[], body: string, sanitized?: boolean, injectionDetected?: boolean }}
 */
function transformEmail(message, options = {}) {
    const { sanitize = true } = options;
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

    return {
        id: message.id || '',
        from: getHeader(headers, 'From'),
        to: getHeader(headers, 'To'),
        subject: getHeader(headers, 'Subject'),
        date: getHeader(headers, 'Date'),
        snippet: message.snippet || '',
        labels: message.labelIds || [],
        body,
        ...(sanitize ? { sanitized, injectionDetected } : {}),
    };
}

// ---- Public API ----

/**
 * Fetch recent emails from Gmail.
 *
 * SECURITY: Email bodies are sanitized by default to prevent prompt injection
 * when content is passed to LLMs. Set options.sanitize=false only for internal
 * processing that does not involve LLM prompts.
 *
 * @param {Date|string|number} [since] - Fetch emails after this time (Date, ISO string, or timestamp)
 * @param {number} [maxResults=50] - Maximum number of emails to return
 * @param {Object} [options] - Fetch options
 * @param {boolean} [options.sanitize=true] - Sanitize email bodies for LLM safety
 * @returns {Promise<Array<{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[], body: string, sanitized?: boolean, injectionDetected?: boolean }>>}
 */
async function getRecentEmails(since, maxResults = 50, options = {}) {
    const { sanitize = true } = options;

    try {
        const gmail = await getGmailClient();
        if (!gmail) {
            return [];
        }

        // Build query for messages after the specified time
        let query = 'in:inbox';
        if (since) {
            const sinceDate = new Date(since);
            // Gmail query uses epoch seconds
            const afterTimestamp = Math.floor(sinceDate.getTime() / 1000);
            query += ` after:${afterTimestamp}`;
        }

        // List message IDs
        const listResponse = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults,
        });

        const messages = listResponse.data.messages || [];
        if (messages.length === 0) {
            return [];
        }

        // Fetch full message details for each
        const emails = [];
        for (const msg of messages) {
            try {
                const fullMessage = await gmail.users.messages.get({
                    userId: 'me',
                    id: msg.id,
                    format: 'full',
                });
                emails.push(transformEmail(fullMessage.data, { sanitize }));
            } catch (err) {
                console.error(`[gmail] Failed to fetch message ${msg.id}:`, err.message);
            }
        }

        return emails;
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
 * @param {string} id - Gmail message ID
 * @returns {Promise<{ id: string, from: string, to: string, subject: string, date: string, snippet: string, labels: string[] }|null>}
 */
async function getEmailHeaders(id) {
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
        return {
            id: response.data.id || '',
            from: getHeader(headers, 'From'),
            to: getHeader(headers, 'To'),
            subject: getHeader(headers, 'Subject'),
            date: getHeader(headers, 'Date'),
            snippet: response.data.snippet || '',
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

/**
 * Mark one or more emails as read by removing the UNREAD label.
 *
 * LOGIC CHANGE 2026-04-01: Added markAsRead function to prevent re-processing emails.
 * Requires gmail.modify scope. If the OAuth token was generated with only gmail.readonly,
 * this function will fail with a scope error. See CLAUDE.md for scope requirements.
 *
 * @param {string|string[]} ids - Gmail message ID(s) to mark as read
 * @returns {Promise<{ success: boolean, marked: string[], failed: string[], error?: string }>}
 */
async function markAsRead(ids) {
    const messageIds = Array.isArray(ids) ? ids : [ids];

    if (messageIds.length === 0) {
        return { success: true, marked: [], failed: [] };
    }

    try {
        // LOGIC CHANGE 2026-04-01: Use modify scope for label changes.
        // The gmail.readonly scope does not allow label modifications.
        const gmail = await getGmailClient({ scope: 'modify' });
        if (!gmail) {
            return {
                success: false,
                marked: [],
                failed: messageIds,
                error: 'Gmail client not available. Check credentials.',
            };
        }

        const marked = [];
        const failed = [];

        for (const id of messageIds) {
            try {
                await gmail.users.messages.modify({
                    userId: 'me',
                    id,
                    requestBody: {
                        removeLabelIds: ['UNREAD'],
                    },
                });
                marked.push(id);
            } catch (err) {
                // Check for scope mismatch error
                if (err.message?.includes('Insufficient Permission') ||
                    err.code === 403 ||
                    err.message?.includes('scope')) {
                    console.error(`[gmail] markAsRead requires gmail.modify scope. Current token may only have gmail.readonly. Error: ${err.message}`);
                    return {
                        success: false,
                        marked,
                        failed: messageIds.filter(msgId => !marked.includes(msgId)),
                        error: 'Insufficient scope: gmail.modify required. Regenerate OAuth token with gmail.modify scope.',
                    };
                }
                console.error(`[gmail] Failed to mark email ${id} as read:`, err.message);
                failed.push(id);
            }
        }

        return {
            success: failed.length === 0,
            marked,
            failed,
        };
    } catch (err) {
        console.error('[gmail] markAsRead failed:', err.message);
        return {
            success: false,
            marked: [],
            failed: messageIds,
            error: err.message,
        };
    }
}

/**
 * Mark one or more emails as unread by adding the UNREAD label.
 *
 * LOGIC CHANGE 2026-04-01: Added markAsUnread as inverse of markAsRead.
 * Requires gmail.modify scope.
 *
 * @param {string|string[]} ids - Gmail message ID(s) to mark as unread
 * @returns {Promise<{ success: boolean, marked: string[], failed: string[], error?: string }>}
 */
async function markAsUnread(ids) {
    const messageIds = Array.isArray(ids) ? ids : [ids];

    if (messageIds.length === 0) {
        return { success: true, marked: [], failed: [] };
    }

    try {
        const gmail = await getGmailClient({ scope: 'modify' });
        if (!gmail) {
            return {
                success: false,
                marked: [],
                failed: messageIds,
                error: 'Gmail client not available. Check credentials.',
            };
        }

        const marked = [];
        const failed = [];

        for (const id of messageIds) {
            try {
                await gmail.users.messages.modify({
                    userId: 'me',
                    id,
                    requestBody: {
                        addLabelIds: ['UNREAD'],
                    },
                });
                marked.push(id);
            } catch (err) {
                if (err.message?.includes('Insufficient Permission') ||
                    err.code === 403 ||
                    err.message?.includes('scope')) {
                    console.error(`[gmail] markAsUnread requires gmail.modify scope. Error: ${err.message}`);
                    return {
                        success: false,
                        marked,
                        failed: messageIds.filter(msgId => !marked.includes(msgId)),
                        error: 'Insufficient scope: gmail.modify required. Regenerate OAuth token with gmail.modify scope.',
                    };
                }
                console.error(`[gmail] Failed to mark email ${id} as unread:`, err.message);
                failed.push(id);
            }
        }

        return {
            success: failed.length === 0,
            marked,
            failed,
        };
    } catch (err) {
        console.error('[gmail] markAsUnread failed:', err.message);
        return {
            success: false,
            marked: [],
            failed: messageIds,
            error: err.message,
        };
    }
}

module.exports = {
    getRecentEmails,
    getEmailById,
    getEmailHeaders,
    hasCredentials,
    markAsRead,
    markAsUnread,
    // Export for testing
    getRefreshToken,
    stripHtml,
    decodeBase64Url,
    getHeader,
    extractBody,
    transformEmail,
    getGmailClient,
    // Export scope constants for testing
    SCOPE_READONLY,
    SCOPE_MODIFY,
};
