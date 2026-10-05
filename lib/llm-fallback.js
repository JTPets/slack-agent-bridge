/**
 * lib/llm-fallback.js
 *
 * The fallback chain: which providers to try after the primary (resolveFallbackChain),
 * whether each is configured (providerAvailability), and runWithFallback, which records
 * one chain-level verdict. Who is on this chain is pinned by docs/WIRING-AND-SEAMS.md §4.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const { recordVerdict } = require('./llm-metrics');
const {
  DEFAULT_PROVIDER, DEFAULT_FALLBACK_PROVIDER, FALLBACK_ENABLED, DEFAULT_FALLBACK_CHAINS,
} = require('./llm-defaults');
const { fallbackReasonFor } = require('./llm-errors');
const { runLLM } = require('./llm-dispatch');

/**
 * LOGIC CHANGE 2026-04-01: Run LLM with automatic fallback on rate limits.
 * Primary provider (default: Claude) is tried first. If it hits a rate limit,
 * falls back to secondary provider (default: Gemini).
 *
 * Fallback conditions:
 * - Primary throws RateLimitError
 * - Fallback is enabled via LLM_FALLBACK_ENABLED env var (default: true)
 * - Fallback provider is configured (GEMINI_API_KEY for Gemini)
 *
 * @param {string} prompt - The prompt to send to the LLM
 * @param {Object} [options={}] - Options for the LLM execution
 * @param {number} [options.maxTurns] - Maximum turns for the LLM (default: 50)
 * @param {number} [options.timeout] - Timeout in ms (default: 600000)
 * @param {string} [options.cwd] - Working directory for execution
 * @param {string} [options.provider] - Primary LLM provider to use (default: claude)
 * @param {string} [options.fallbackProvider] - Fallback provider on rate limit (default: gemini)
 * @param {boolean} [options.enableFallback] - Override env var to enable/disable fallback
 * @returns {Promise<{ output: string, hitMaxTurns: boolean, usedFallback?: boolean, fallbackProvider?: string }>}
 */
/**
 * LOGIC CHANGE 2026-09-11: Resolve the ordered fallback chain for a primary
 * provider. Precedence: explicit array option > explicit single option >
 * LLM_FALLBACK_PROVIDER env (comma-separated is accepted, so the historical
 * single value still works) > the per-primary default chain > the global
 * default single hop.
 *
 * @param {string} primaryProvider - The provider that was tried first
 * @param {Object} options - runWithFallback options
 * @returns {string[]} Ordered list of providers to try after the primary
 */
function resolveFallbackChain(primaryProvider, options = {}) {
  if (Array.isArray(options.fallbackProviders) && options.fallbackProviders.length > 0) {
    return options.fallbackProviders.map(p => p.toLowerCase());
  }
  if (options.fallbackProvider) {
    return [options.fallbackProvider.toLowerCase()];
  }
  if (process.env.LLM_FALLBACK_PROVIDER) {
    return process.env.LLM_FALLBACK_PROVIDER
      .split(',')
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);
  }
  const normalizedPrimary = String(primaryProvider).toLowerCase();
  if (DEFAULT_FALLBACK_CHAINS[normalizedPrimary]) {
    return [...DEFAULT_FALLBACK_CHAINS[normalizedPrimary]];
  }
  return [DEFAULT_FALLBACK_PROVIDER];
}

/**
 * LOGIC CHANGE 2026-09-11: Check whether a provider can be attempted at all.
 * Skipping an unconfigured provider is not a silent failure — the caller logs
 * the skip reason and it lands in the chain-level verdict.
 *
 * @param {string} provider - Provider name
 * @returns {{ available: boolean, reason?: string }}
 */
function providerAvailability(provider) {
  switch (provider) {
    case 'gemini':
      return process.env.GEMINI_API_KEY
        ? { available: true }
        : { available: false, reason: 'GEMINI_API_KEY not set' };
    case 'ollama':
      return process.env.OLLAMA_MODEL
        ? { available: true }
        : { available: false, reason: 'OLLAMA_MODEL not set' };
    case 'claude':
      return { available: true };
    default:
      return { available: false, reason: `provider "${provider}" is not implemented` };
  }
}

async function runWithFallback(prompt, options = {}) {
  const primaryProvider = (options.provider || process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const chain = resolveFallbackChain(primaryProvider, options);
  const enableFallback = options.enableFallback !== undefined ? options.enableFallback : FALLBACK_ENABLED;
  const startedAt = Date.now();

  // Inner attempts suppress their own verdict; this function records exactly one
  // verdict for the whole logical call.
  const attemptOptions = { ...options, __suppressVerdict: true };

  let primaryError;
  try {
    const result = await runLLM(prompt, { ...attemptOptions, provider: primaryProvider });
    recordVerdict({
      provider_requested: primaryProvider,
      provider_used: primaryProvider,
      fallback_reason: null,
      latency_ms: Date.now() - startedAt,
      model: result.model || options.model || null,
      agent_id: options.agentId,
      ok: true,
    });
    return result;
  } catch (err) {
    primaryError = err;
  }

  // LOGIC CHANGE 2026-09-11: Fallback now triggers on timeout, connection
  // refused, non-2xx, empty output and malformed output as well as rate limits.
  // Previously only primaryError.isRateLimit qualified, which meant a local
  // model server that was simply down failed the task outright.
  const reason = fallbackReasonFor(primaryError);

  if (!reason || !enableFallback) {
    recordVerdict({
      provider_requested: primaryProvider,
      provider_used: null,
      fallback_reason: reason,
      latency_ms: Date.now() - startedAt,
      model: options.model || null,
      agent_id: options.agentId,
      ok: false,
    });
    throw primaryError;
  }

  let lastAttempted = null;
  let lastError = primaryError;

  for (const candidate of chain) {
    if (candidate === primaryProvider) continue;

    const availability = providerAvailability(candidate);
    if (!availability.available) {
      console.error(
        `[llm-runner] ${primaryProvider} failed (${reason}) but cannot fall back to ${candidate}: ${availability.reason}`
      );
      continue;
    }

    lastAttempted = candidate;
    console.log(`[llm-runner] ${primaryProvider} failed (${reason}) - falling back to ${candidate}`);

    try {
      const fallbackResult = await runLLM(prompt, { ...attemptOptions, provider: candidate });

      recordVerdict({
        provider_requested: primaryProvider,
        provider_used: candidate,
        fallback_reason: reason,
        latency_ms: Date.now() - startedAt,
        model: fallbackResult.model || options.model || null,
        agent_id: options.agentId,
        ok: true,
      });

      return {
        ...fallbackResult,
        usedFallback: true,
        fallbackProvider: candidate,
        fallbackReason: reason,
        providerRequested: primaryProvider,
        providerUsed: candidate,
      };
    } catch (fallbackError) {
      lastError = fallbackError;
      console.error(`[llm-runner] Fallback to ${candidate} also failed: ${fallbackError.message}`);
    }
  }

  recordVerdict({
    provider_requested: primaryProvider,
    provider_used: null,
    fallback_reason: reason,
    latency_ms: Date.now() - startedAt,
    model: options.model || null,
    agent_id: options.agentId,
    ok: false,
  });

  // Nothing in the chain was attemptable — surface the primary failure as-is so
  // the caller sees the real cause rather than a wrapper about a skipped hop.
  if (!lastAttempted) {
    throw primaryError;
  }

  // Preserved wording for the rate-limit case: callers and existing tests match
  // on "Primary (x) rate limited, fallback (y) failed".
  const primaryPhrase = reason === 'rate_limit'
    ? `Primary (${primaryProvider}) rate limited`
    : `Primary (${primaryProvider}) failed (${reason})`;
  const combinedError = new Error(
    `${primaryPhrase}, fallback (${lastAttempted}) failed: ${lastError.message}`
  );
  combinedError.primaryError = primaryError;
  combinedError.fallbackError = lastError;
  combinedError.fallbackReason = reason;
  throw combinedError;
}

module.exports = {
  resolveFallbackChain,
  providerAvailability,
  runWithFallback,
};
