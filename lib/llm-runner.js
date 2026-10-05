/**
 * lib/llm-runner.js
 *
 * Unified LLM execution interface supporting multiple providers.
 * Provides a single runLLM function that delegates to provider-specific adapters.
 *
 * LOGIC CHANGE 2026-03-26: Created llm-runner.js to abstract LLM execution
 * away from bridge-agent.js. This allows switching between providers via
 * LLM_PROVIDER env var (default: claude). Supports future addition of
 * openai, ollama, and other providers.
 *
 * LOGIC CHANGE 2026-03-26: Added rate limit detection for Claude adapter.
 * Detects rate limit errors in stdout/stderr and throws RateLimitError
 * with isRateLimit flag for callers to handle appropriately.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): this file is now a facade with every name it
 * exported before, each the same function or value as in the module it moved to:
 *   lib/llm-errors.js         rate-limit and bandwidth detection, exit diagnostics, error
 *                             classes, fallback-reason tags
 *   lib/llm-defaults.js       configuration read from the environment, normalizeThink
 *   lib/llm-dispatch.js       runLLM (one provider, one verdict)
 *   lib/llm-adapter-claude.js the Claude CLI adapter
 *   lib/llm-adapter-gemini.js the Gemini adapter, its startup check, the OpenAI placeholder
 *   lib/llm-adapter-ollama.js the Ollama adapter, its startup check and availability flag
 *   lib/llm-fallback.js       resolveFallbackChain, providerAvailability, runWithFallback
 * runLLM is in its own module rather than here so lib/llm-fallback.js can call it without
 * a require cycle back through this facade.
 */

'use strict';

const {
  RATE_LIMIT_PATTERNS, BANDWIDTH_EXHAUSTION_PATTERNS, MIN_REAL_OUTPUT_LENGTH, isRateLimitError,
  signalFromExitCode, describeClaudeExit, isBandwidthExhausted, RateLimitError, BandwidthExhaustedError,
  fallbackReasonFor,
} = require('./llm-errors');
const {
  DEFAULT_PROVIDER, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT, DEFAULT_FALLBACK_PROVIDER, FALLBACK_ENABLED,
  DEFAULT_FALLBACK_CHAINS, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_KEEP_ALIVE, DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_OLLAMA_TIMEOUT, normalizeThink,
} = require('./llm-defaults');
const { runLLM } = require('./llm-dispatch');
const { runClaudeAdapter, WARN_AT_FRACTION } = require('./llm-adapter-claude');
const { runOpenAIAdapter, runGeminiAdapter, validateGeminiOnStartup } = require('./llm-adapter-gemini');
const { runOllamaAdapter, isOllamaAvailable, validateOllamaOnStartup } = require('./llm-adapter-ollama');
const { resolveFallbackChain, providerAvailability, runWithFallback } = require('./llm-fallback');

module.exports = {
  runLLM,
  // LOGIC CHANGE 2026-04-01: Export runWithFallback for automatic Claude → Gemini failover
  runWithFallback,
  // Export adapters for testing purposes
  runClaudeAdapter,
  runOpenAIAdapter,
  runOllamaAdapter,
  runGeminiAdapter,
  // LOGIC CHANGE 2026-03-30: Export startup validation for bridge-agent.js
  validateGeminiOnStartup,
  // LOGIC CHANGE 2026-09-11: Export Ollama startup validation and availability
  validateOllamaOnStartup,
  isOllamaAvailable,
  // Export defaults for testing
  DEFAULT_PROVIDER,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT,
  // LOGIC CHANGE 2026-04-01: Export fallback configuration
  DEFAULT_FALLBACK_PROVIDER,
  FALLBACK_ENABLED,
  // LOGIC CHANGE 2026-09-11: Export fallback chain + ollama configuration
  DEFAULT_FALLBACK_CHAINS,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_KEEP_ALIVE,
  DEFAULT_OLLAMA_NUM_CTX,
  DEFAULT_OLLAMA_TIMEOUT,
  resolveFallbackChain,
  providerAvailability,
  fallbackReasonFor,
  normalizeThink,
  // LOGIC CHANGE 2026-09-13: Export exit diagnostics for testing.
  describeClaudeExit,
  signalFromExitCode,
  // Export rate limit utilities for testing and bridge-agent usage
  isRateLimitError,
  RateLimitError,
  RATE_LIMIT_PATTERNS,
  // LOGIC CHANGE 2026-03-27: Export bandwidth exhaustion utilities
  isBandwidthExhausted,
  BandwidthExhaustedError,
  BANDWIDTH_EXHAUSTION_PATTERNS,
  MIN_REAL_OUTPUT_LENGTH,
  WARN_AT_FRACTION,
};
