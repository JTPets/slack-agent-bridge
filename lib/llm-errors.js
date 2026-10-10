/**
 * lib/llm-errors.js
 *
 * How a provider failure is recognised and labelled: the rate-limit and bandwidth
 * patterns, the Claude exit-code diagnostics, the two error classes, and the
 * fallback-reason tags runWithFallback keys on.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const os = require('os');

// LOGIC CHANGE 2026-03-26: Rate limit error patterns to detect in Claude Code output.
// These patterns match common rate limit messages from Claude API.
// LOGIC CHANGE 2026-03-27: Tightened patterns to reduce false positives. Removed
// generic words like "capacity" and "overloaded" which can appear in normal output
// (e.g., "at capacity", "server overloaded" in unrelated contexts). Only match
// specific rate limit error messages that Claude Code CLI actually outputs.
const RATE_LIMIT_PATTERNS = [
  /rate.?limit.?(exceeded|error|reached)/i,  // "rate limit exceeded", "rate_limit_error", "rate limit reached"
  /too many requests/i,                       // HTTP 429 message
  /quota exceeded/i,                          // API quota errors
  /usage limit reached/i,                     // Specific usage limit message (not just "usage limit")
  /\b429\b/,                                  // HTTP 429 status code
];

// LOGIC CHANGE 2026-03-27: Bandwidth/session exhaustion patterns to detect in stderr.
// When Claude CLI exits with code 1 AND output is empty/short (<50 chars), these
// patterns in stderr indicate bandwidth exhaustion rather than task failure.
// The bot should pause and retry rather than marking the task as failed.
const BANDWIDTH_EXHAUSTION_PATTERNS = [
  /usage.?limit/i,                           // "usage limit" anywhere
  /rate.?limit/i,                            // "rate limit" anywhere (more permissive for stderr)
  /bandwidth/i,                              // "bandwidth" anywhere
  /quota/i,                                  // "quota" anywhere
  /\b429\b/,                                 // HTTP 429 status code
  /too many/i,                               // "too many" (requests, etc.)
  /try again later/i,                        // Generic retry message
];

// LOGIC CHANGE 2026-03-27: Minimum output length to consider a task as having
// completed with real output. Below this threshold + exit code 1, we suspect
// bandwidth exhaustion rather than a real task failure.
const MIN_REAL_OUTPUT_LENGTH = 50;

/**
 * Check if output contains rate limit error messages.
 * @param {string} text - Text to check (stdout or stderr)
 * @returns {boolean} True if rate limit error detected
 */
// LOGIC CHANGE 2026-04-01: Re-enabled rate limit detection for fallback purposes only.
// Detection is now used to trigger Claude → Gemini fallback, NOT to pause the entire bot.
// The tight patterns from 2026-03-27 remain to reduce false positives.
function isRateLimitError(text) {
  if (!text) return false;
  return RATE_LIMIT_PATTERNS.some(pattern => pattern.test(text));
}

// LOGIC CHANGE 2026-09-13: Shell convention for a process that dies from, or
// traps and re-raises, signal N: it exits with 128+N. SIGTERM (15) -> 143,
// SIGKILL (9) -> 137, SIGINT (2) -> 130. The Claude CLI wrapper traps its
// signals and exits this way, so a timeout/OOM/shutdown reached processTask as a
// bare "Exit code 143" with no hint of the cause.
const SIGNAL_EXIT_BASE = 128;

/**
 * LOGIC CHANGE 2026-09-13: Map an exit code back to the signal name it encodes,
 * if it is in the 128+N range. Returns null for ordinary exit codes.
 *
 * @param {number} code - Process exit code
 * @returns {string|null} Signal name (e.g. "SIGTERM") or null
 */
function signalFromExitCode(code) {
  if (typeof code !== 'number' || code <= SIGNAL_EXIT_BASE) return null;
  const signals = os.constants && os.constants.signals;
  if (!signals) return null;
  const signum = code - SIGNAL_EXIT_BASE;
  return Object.keys(signals).find(name => signals[name] === signum) || null;
}

/**
 * LOGIC CHANGE 2026-09-13: Build one human-readable diagnostic from a child
 * process's exit so a failed task reports WHY the spawned LLM died, not just a
 * number. Decodes signals in either shape Node can report them — a direct signal
 * kill (code=null, signal set) or a wrapper's 128+N exit code — and always
 * states whether the process produced any stderr, so "(no stderr output)" is an
 * explicit fact rather than a silent gap.
 *
 * @param {number|null} code - Exit code from the close event
 * @param {string|null} signal - Signal name from the close event, if any
 * LOGIC CHANGE 2026-10-10: also takes stdout. `claude -p --output-format text` writes
 * its own failure (an auth, credit or usage-limit message) to STDOUT and exits 1 with
 * stderr empty; checked against the CLI with an invalid key, which printed
 * "Invalid API key · Fix external API key" on stdout and nothing on stderr. Dropping
 * stdout on a failed exit is what made the 2026-10-10 07:00 morning briefing report
 * only "Exit code 1 (no stderr output)". The tail is kept, not the head, because a
 * long run's failure is at the end. Callers redact before any sink (notifyOwner,
 * bridge-agent's catch), as they already do for stderr.
 *
 * @param {string} stderr - Accumulated stderr
 * @param {string} [stdout] - Accumulated stdout
 * @returns {string} A diagnostic message
 */
function describeClaudeExit(code, signal, stderr, stdout) {
  const trimmedErr = (stderr || '').trim();
  const trimmedOut = (stdout || '').trim();
  const decodedSignal = signal || signalFromExitCode(code);

  let head;
  if (typeof code === 'number') {
    head = `Exit code ${code}`;
    if (decodedSignal) head += ` (killed by ${decodedSignal})`;
  } else if (signal) {
    head = `Killed by signal ${signal}`;
  } else {
    head = 'Exited with no code or signal';
  }

  const tail = trimmedErr ? `\n${trimmedErr.slice(0, 2000)}` : '\n(no stderr output)';
  const outTail = trimmedOut ? `\nstdout (last 2000 chars):\n${trimmedOut.slice(-2000)}` : '';
  return head + tail + outTail;
}

/**
 * LOGIC CHANGE 2026-03-27: Check if CLI exit indicates bandwidth exhaustion.
 * This is a combined check: exit code 1 + empty/short output + stderr contains
 * bandwidth-related keywords. This distinguishes real task failures from
 * session/bandwidth limits that should trigger a pause and retry.
 *
 * @param {number} exitCode - Process exit code
 * @param {string} stdout - Standard output from the process
 * @param {string} stderr - Standard error from the process
 * @returns {boolean} True if this looks like bandwidth exhaustion
 */
// DISABLED: Bandwidth exhaustion detection causes false positives. Will re-enable when properly calibrated.
// LOGIC CHANGE 2026-03-27: Rate limit auto-pause disabled due to false positives killing tasks.
// Manual restart is safer than auto-pausing on misdetection.
function isBandwidthExhausted(exitCode, stdout, stderr) {
  return false;
}

/**
 * Custom error class for rate limit errors.
 * Includes isRateLimit flag for easy detection by callers.
 */
class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
    this.isRateLimit = true;
  }
}

/**
 * LOGIC CHANGE 2026-03-27: Custom error class for bandwidth exhaustion.
 * Thrown when Claude CLI exits with code 1, has empty/short output, and stderr
 * contains bandwidth-related keywords. This should NOT be counted as a task
 * failure - the bot should pause and retry.
 */
class BandwidthExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BandwidthExhaustedError';
    this.isBandwidthExhausted = true;
    this.isRateLimit = true; // Also a rate limit for backward compat
  }
}

/**
 * LOGIC CHANGE 2026-09-11: Tag an error with the reason it should trigger a
 * fallback. The presence of `fallbackReason` is what runWithFallback keys on, so
 * a provider failure is never silently swallowed and never silently retried
 * without a recorded cause.
 *
 * @param {Error} err - Error to tag
 * @param {string} reason - One of: timeout, connection_refused, http_error, empty_output, malformed_output, rate_limit
 * @returns {Error} The same error, tagged
 */
function tagFallbackReason(err, reason) {
  err.fallbackReason = reason;
  err.isProviderUnavailable = reason !== 'rate_limit';
  return err;
}

/**
 * LOGIC CHANGE 2026-09-11: Decide whether an error justifies trying the next
 * provider in the chain. Rate limits keep their historical behaviour; the new
 * reasons (timeout / connection refused / non-2xx / empty / malformed) come from
 * adapters that tag the error.
 *
 * @param {Error} err - The error thrown by a provider
 * @returns {string|null} The fallback reason, or null if this error is fatal
 */
function fallbackReasonFor(err) {
  if (!err) return null;
  if (err.fallbackReason) return err.fallbackReason;
  if (err.isRateLimit) return 'rate_limit';
  return null;
}

module.exports = {
  RATE_LIMIT_PATTERNS,
  BANDWIDTH_EXHAUSTION_PATTERNS,
  MIN_REAL_OUTPUT_LENGTH,
  isRateLimitError,
  signalFromExitCode,
  describeClaudeExit,
  isBandwidthExhausted,
  RateLimitError,
  BandwidthExhaustedError,
  tagFallbackReason,
  fallbackReasonFor,
};
