'use strict';

/**
 * lib/redact-secrets.js
 *
 * Scrub secrets out of any string before it reaches an external sink (Slack)
 * or the process logs. The motivating leak: a spawned LLM process's stderr was
 * surfaced verbatim to #sqtools-ops and console.log, so a stack trace or a
 * subprocess that echoed its own environment could publish live tokens to a
 * channel (and to log aggregation) with no redaction.
 *
 * LOGIC CHANGE 2026-09-13: Created redact-secrets.js. Two layers:
 *   1. Value-driven — every sensitive-looking env var's live value is scrubbed
 *      by exact match. This catches whatever is actually secret on THIS box,
 *      regardless of the token's shape.
 *   2. Pattern-driven — well-known secret formats (Slack/Anthropic/Google/
 *      GitHub tokens, PEM private keys, OAuth refresh tokens, bearer headers)
 *      are scrubbed even if they never passed through process.env (e.g. a key
 *      pasted into an email body or echoed by a child process).
 */

// Env var NAMES whose values are treated as secrets. Value-driven scrubbing
// keys off the name so we never have to enumerate token formats to catch a leak.
const SENSITIVE_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY|CREDENTIAL|PRIVATE|REFRESH|AUTH)/i;

// Env values shorter than this are ignored: channel IDs, booleans, small ints,
// and process names are not secrets and would create noisy false positives.
const MIN_SECRET_LEN = 8;

// Structural secret patterns. Each entry is [regex, replacement]. Ordered
// most-specific first; the PEM block must run before anything greedy.
const PATTERNS = [
    [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, '[REDACTED:PRIVATE_KEY]'],
    [/\bxox[abpsr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:SLACK_TOKEN]'],
    [/\bxapp-[A-Za-z0-9-]{10,}/g, '[REDACTED:SLACK_APP_TOKEN]'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[REDACTED:ANTHROPIC_KEY]'],
    [/\bAIza[A-Za-z0-9_-]{20,}/g, '[REDACTED:GOOGLE_API_KEY]'],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED:GITHUB_PAT]'],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED:GITHUB_TOKEN]'],
    [/\bya29\.[A-Za-z0-9_-]{20,}/g, '[REDACTED:GOOGLE_OAUTH_TOKEN]'],
    // Google OAuth refresh tokens are of the form "1//<base64url>".
    [/\b1\/\/[A-Za-z0-9_-]{20,}/g, '[REDACTED:GOOGLE_REFRESH_TOKEN]'],
    // Authorization: Bearer <token> — keep the scheme, drop the credential.
    [/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1[REDACTED]'],
];

/**
 * Collect [name, value] pairs of sensitive env vars worth scrubbing.
 * Sorted longest-value-first so a value that contains a shorter secret is
 * replaced as a whole rather than being partially clobbered.
 *
 * @param {object} [env=process.env] - Environment map to read.
 * @returns {Array<[string, string]>}
 */
function secretValuesFromEnv(env = process.env) {
    const values = [];
    for (const [name, val] of Object.entries(env || {})) {
        if (typeof val === 'string' && val.length >= MIN_SECRET_LEN && SENSITIVE_NAME.test(name)) {
            values.push([name, val]);
        }
    }
    values.sort((a, b) => b[1].length - a[1].length);
    return values;
}

/**
 * Redact secrets from a string. Safe to call on any value; non-strings are
 * coerced to string first, null/undefined pass through unchanged.
 *
 * @param {*} input - Text (or value) to scrub.
 * @param {object} [options]
 * @param {object} [options.env=process.env] - Environment map for value-driven scrubbing.
 * @returns {*} Redacted string, or the original value if it was null/undefined.
 */
function redact(input, options = {}) {
    if (input === null || input === undefined) {
        return input;
    }

    let out = typeof input === 'string' ? input : String(input);
    const env = options.env || process.env;

    // 1. Value-driven: scrub live env secret values by literal match.
    for (const [name, val] of secretValuesFromEnv(env)) {
        if (out.includes(val)) {
            out = out.split(val).join(`[REDACTED:${name}]`);
        }
    }

    // 2. Pattern-driven: scrub well-known secret formats.
    for (const [re, replacement] of PATTERNS) {
        out = out.replace(re, replacement);
    }

    return out;
}

module.exports = {
    redact,
    secretValuesFromEnv,
    SENSITIVE_NAME,
    MIN_SECRET_LEN,
    PATTERNS,
};
