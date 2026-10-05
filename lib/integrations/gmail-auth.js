/**
 * lib/integrations/gmail-auth.js
 *
 * Building an authenticated, READ-ONLY Gmail client (scope gmail.readonly) from the
 * environment: a service-account key file, or the OAuth trio. Reports WHY it could
 * not, rather than returning a bare null.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/integrations/gmail.js
 * unchanged. lib/integrations/gmail.js re-exports every function, so no caller changed.
 *
 * Required env vars (one of):
 *   GOOGLE_SERVICE_ACCOUNT_KEY - Path to service account JSON key file
 *   OR
 *   GOOGLE_REFRESH_TOKEN (or GOOGLE_CALENDAR_REFRESH_TOKEN), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 */

'use strict';

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

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
    getRefreshToken,
    createGmailClient,
    getGmailClient,
    hasCredentials,
};
