/**
 * lib/llm-dispatch.js
 *
 * runLLM: one call on one provider, chosen by name, with exactly one verdict recorded.
 * It is its own module so lib/llm-fallback.js can call it without requiring the
 * facade back (no require cycle).
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const { recordVerdict } = require('./llm-metrics');
const { DEFAULT_PROVIDER } = require('./llm-defaults');
const { fallbackReasonFor } = require('./llm-errors');
const { runClaudeAdapter } = require('./llm-adapter-claude');
const { runOpenAIAdapter, runGeminiAdapter } = require('./llm-adapter-gemini');
const { runOllamaAdapter } = require('./llm-adapter-ollama');

/**
 * Run an LLM with the given prompt and options.
 *
 * @param {string} prompt - The prompt to send to the LLM
 * @param {Object} [options={}] - Options for the LLM execution
 * @param {number} [options.maxTurns] - Maximum turns for the LLM (default: 50)
 * @param {number} [options.timeout] - Timeout in ms (default: 600000)
 * @param {string} [options.cwd] - Working directory for execution
 * @param {string} [options.provider] - LLM provider to use (default: claude)
 * @returns {Promise<{ output: string, hitMaxTurns: boolean, provider: string }>}
 */
// LOGIC CHANGE 2026-04-01: Added provider field to return value so callers can
// see which LLM engine actually handled the request. Used for task notifications.
// LOGIC CHANGE 2026-09-11: Every logical call now records exactly one verdict
// (provider_requested / provider_used / fallback_reason / latency_ms / model).
// runWithFallback sets options.__suppressVerdict on its inner runLLM calls and
// records the single chain-level verdict itself, so a fallback is counted once,
// not once per attempt.
async function runLLM(prompt, options = {}) {
  const provider = options.provider || process.env.LLM_PROVIDER || DEFAULT_PROVIDER;
  const normalizedProvider = provider.toLowerCase();
  const startedAt = Date.now();

  let result;
  try {
    switch (normalizedProvider) {
      case 'claude':
        result = await runClaudeAdapter(prompt, options);
        break;

      case 'openai':
        result = await runOpenAIAdapter(prompt, options);
        break;

      case 'ollama':
        result = await runOllamaAdapter(prompt, options);
        break;

      case 'gemini':
        result = await runGeminiAdapter(prompt, options);
        break;

      default:
        // LOGIC CHANGE 2026-09-11: An unknown provider is a configuration
        // defect, never a fallback trigger — retrying a typo on another engine
        // would hide the typo. Left deliberately untagged so fallbackReasonFor
        // returns null and runWithFallback rethrows it unchanged.
        throw new Error(`Unknown LLM provider: ${provider}. Supported providers: claude, openai, ollama, gemini`);
    }
  } catch (err) {
    if (!options.__suppressVerdict) {
      recordVerdict({
        provider_requested: normalizedProvider,
        provider_used: null,
        fallback_reason: fallbackReasonFor(err),
        latency_ms: Date.now() - startedAt,
        model: options.model || null,
        agent_id: options.agentId,
        ok: false,
      });
    }
    throw err;
  }

  if (!options.__suppressVerdict) {
    recordVerdict({
      provider_requested: normalizedProvider,
      provider_used: normalizedProvider,
      fallback_reason: null,
      latency_ms: Date.now() - startedAt,
      model: result.model || options.model || null,
      agent_id: options.agentId,
      ok: true,
    });
  }

  // Add provider to result so callers can see which engine was used
  return { ...result, provider: normalizedProvider };
}

module.exports = {
  runLLM,
};
