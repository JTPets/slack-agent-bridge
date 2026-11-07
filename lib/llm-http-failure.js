/**
 * lib/llm-http-failure.js
 *
 * WORK-TODO #79 (2026-11-07): how a non-2xx answer from a hosted model API is labelled.
 * One classifier (classifyHttpFailure), one message builder (describeHttpFailure) and the
 * BillingError class, so every adapter labels the same response the same way and a
 * billing failure can never be reported as a rate limit. Pure: no I/O.
 *
 * Re-exported by lib/llm-errors.js and lib/llm-runner.js.
 */

'use strict';

const { redact } = require('./redact-secrets');

// LOGIC CHANGE 2026-11-07 (WORK-TODO #79): billing / prepaid-credit exhaustion is its
// own failure, not a rate limit. On 2026-11-07 the boot log read "Gemini rate limit:" for
// an HTTP 402 whose body said "Your prepayment credits are depleted" with status
// RESOURCE_EXHAUSTED: the adapter matched RESOURCE_EXHAUSTED before it looked at the
// status, so the operator was told to wait for a fix that waiting cannot bring. These
// patterns are checked BEFORE the rate-limit ones wherever both could match.
const BILLING_PATTERNS = [
  /prepayment credits? (are|is|have been) (depleted|exhausted)/i, // Gemini 402, 2026-11-07
  /credit balance is too low/i,                                    // Anthropic API / Claude CLI
  /insufficient (credits?|funds|balance|quota balance)/i,
  /billing (account|is not enabled|has been disabled|not active)/i, // Google billing-account refusals
  /\bpayment required\b/i,                                         // HTTP 402 reason phrase
];

// LOGIC CHANGE 2026-11-07 (WORK-TODO #79): a refused credential, by body text, for the
// providers that do not answer 401/403 for it (Gemini answers an invalid key with 400
// INVALID_ARGUMENT / API_KEY_INVALID).
const AUTH_PATTERNS = [
  /API[_ ]KEY[_ ]INVALID/i,
  /API key not valid/i,
  /\bUNAUTHENTICATED\b/,
  /\bPERMISSION_DENIED\b/,
];

// The two hosted-API markers of a quota/rate limit, used by classifyHttpFailure only
// (the CLI-output patterns above stay as they are).
const HTTP_RATE_LIMIT_PATTERNS = [/RESOURCE_EXHAUSTED/, /quota/i, /rate.?limit/i, /too many requests/i];

/**
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #79): THE classifier for a non-2xx answer from a
 * hosted model API. One function, so every adapter labels the same response the same
 * way. Order is the point: billing first (a 402, or a billing body under any status,
 * since Gemini sends RESOURCE_EXHAUSTED with a 402), then rate limit (429, or a quota
 * body), then auth (401/403, or an invalid-key body), else http_error.
 *
 * @param {number} status - HTTP status
 * @param {string} bodyText - Response body (may be empty)
 * @returns {'billing'|'rate_limit'|'auth'|'http_error'}
 */
function classifyHttpFailure(status, bodyText) {
  const body = bodyText || '';
  if (status === 402 || isBillingError(body)) return 'billing';
  if (status === 429 || HTTP_RATE_LIMIT_PATTERNS.some(p => p.test(body))) return 'rate_limit';
  if (status === 401 || status === 403 || AUTH_PATTERNS.some(p => p.test(body))) return 'auth';
  return 'http_error';
}

/**
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #79): is this text a billing / credit failure?
 * @param {string} text
 * @returns {boolean}
 */
function isBillingError(text) {
  if (!text) return false;
  return BILLING_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #79): the operator-facing message for a classified
 * HTTP failure, naming the fix. The `<Provider> rate limit:` prefix of the rate-limit
 * case is kept byte for byte, because callers and tests match on it.
 *
 * @param {string} provider - Display name, e.g. 'Gemini'
 * @param {string} reason - A classifyHttpFailure result
 * @param {number} status - HTTP status
 * @param {string} bodyText - Response body
 * @param {{ keyVar?: string }} [opts]
 * @returns {string}
 */
function describeHttpFailure(provider, reason, status, bodyText, opts = {}) {
  const body = redact((bodyText || '').slice(0, 500));
  const keyVar = opts.keyVar ? opts.keyVar : 'the API key';
  switch (reason) {
    case 'billing':
      return `${provider} billing failure (HTTP ${status}): the account's credits or billing are exhausted. ` +
        `This is NOT a rate limit and waiting will not clear it. Fix: top up the ${provider} account, ` +
        `or move the agent off ${provider}. Body: ${body}`;
    case 'rate_limit':
      return `${provider} rate limit: ${body}`;
    case 'auth':
      return `${provider} authentication failure (HTTP ${status}): the credential was refused. ` +
        `Fix: check ${keyVar}. Body: ${body}`;
    default:
      return `${provider} API error (${status}): ${body}`;
  }
}

/**
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #79): a billing failure. Deliberately NOT a
 * RateLimitError and carries no isRateLimit flag, so nothing that treats a rate limit as
 * transient ("busy, try again") treats this one so.
 */
class BillingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BillingError';
    this.isBilling = true;
  }
}

module.exports = {
  BILLING_PATTERNS,
  AUTH_PATTERNS,
  HTTP_RATE_LIMIT_PATTERNS,
  isBillingError,
  classifyHttpFailure,
  describeHttpFailure,
  BillingError,
};
