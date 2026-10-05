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
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): split three ways on the boundary #10 names.
 * Client construction is lib/integrations/gmail-auth.js; MIME decoding and sanitisation
 * is lib/integrations/gmail-message.js; this file keeps the read API and re-exports both,
 * so every existing `require('./integrations/gmail')` still answers for the whole surface.
 */

'use strict';

const { createGmailClient, getGmailClient, getRefreshToken, hasCredentials } = require('./gmail-auth');
const {
    getSanitizer, stripHtml, decodeBase64Url, getHeader, extractBody, transformEmail,
} = require('./gmail-message');

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
