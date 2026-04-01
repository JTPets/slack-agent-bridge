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
 */

'use strict';

const { spawn } = require('child_process');
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

// Default configuration
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/jtpets/.local/bin/claude';
const DEFAULT_MAX_TURNS = parseInt(process.env.MAX_TURNS || '50', 10);
const DEFAULT_TIMEOUT = parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10);

// LOGIC CHANGE 2026-04-01: Added fallback configuration for Claude → Gemini failover.
// When Claude hits rate limits, the system can automatically retry with Gemini.
const DEFAULT_FALLBACK_PROVIDER = 'gemini';
const FALLBACK_ENABLED = process.env.LLM_FALLBACK_ENABLED !== 'false'; // Default: enabled

/**
 * Run an LLM with the given prompt and options.
 *
 * @param {string} prompt - The prompt to send to the LLM
 * @param {Object} [options={}] - Options for the LLM execution
 * @param {number} [options.maxTurns] - Maximum turns for the LLM (default: 50)
 * @param {number} [options.timeout] - Timeout in ms (default: 600000)
 * @param {string} [options.cwd] - Working directory for execution
 * @param {string} [options.provider] - LLM provider to use (default: claude)
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
async function runLLM(prompt, options = {}) {
  const provider = options.provider || process.env.LLM_PROVIDER || DEFAULT_PROVIDER;

  switch (provider.toLowerCase()) {
    case 'claude':
      return runClaudeAdapter(prompt, options);

    case 'openai':
      return runOpenAIAdapter(prompt, options);

    case 'ollama':
      return runOllamaAdapter(prompt, options);

    case 'gemini':
      return runGeminiAdapter(prompt, options);

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Supported providers: claude, openai, ollama, gemini`);
  }
}

/**
 * Claude adapter - spawns Claude Code CLI with -p flag.
 * Contains all spawn logic previously in bridge-agent.js runClaudeCode function.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options for execution
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
function runClaudeAdapter(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const cwd = options.cwd || process.cwd();
    const claudeBin = options.claudeBin || DEFAULT_CLAUDE_BIN;

    const args = [
      '-p', prompt,
      '--output-format', 'text',
      '--max-turns', String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    console.log(`[llm-runner] Spawning Claude in ${cwd} (max-turns=${maxTurns})`);

    const child = spawn(claudeBin, args, {
      cwd,
      env: { ...process.env, HOME: os.homedir() },
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const output = stdout.trim();

      // LOGIC CHANGE 2026-03-26: Detect if output indicates max turns was reached.
      // This allows callers to handle partial completions appropriately.
      const hitMaxTurns = output.includes('Reached max turns');

      // LOGIC CHANGE 2026-03-27: Exit code null means the process was killed
      // (e.g., PM2 restart, SIGTERM). Treat as interrupted, not failed.
      if (code === null) {
        resolve({ output: output || '', hitMaxTurns: false, interrupted: true });
        return;
      }

      // LOGIC CHANGE 2026-04-01: Check for rate limit errors in stderr to enable
      // Claude → Gemini fallback. This detection only throws RateLimitError,
      // it does NOT pause the entire bot (that behavior was disabled in 2026-03-27).
      if (code !== 0 && isRateLimitError(stderr)) {
        reject(new RateLimitError(`Claude rate limit detected: ${stderr.slice(0, 500)}`));
        return;
      }

      if (code === 0) {
        resolve({ output, hitMaxTurns });
      } else {
        reject(new Error(
          `Exit code ${code}${stderr ? '\n' + stderr.slice(0, 2000) : ''}`
        ));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}

/**
 * OpenAI adapter - placeholder for future implementation.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options for execution
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
async function runOpenAIAdapter(prompt, options = {}) {
  // LOGIC CHANGE 2026-03-26: Placeholder for OpenAI adapter.
  // Will be implemented when OpenAI integration is needed.
  throw new Error('OpenAI adapter not yet implemented');
}

/**
 * Ollama adapter - placeholder for future implementation.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options for execution
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
async function runOllamaAdapter(prompt, options = {}) {
  // LOGIC CHANGE 2026-03-26: Placeholder for Ollama adapter.
  // Will be implemented when local Ollama integration is needed.
  throw new Error('Ollama adapter not yet implemented');
}

/**
 * LOGIC CHANGE 2026-03-27: Gemini adapter - HTTP POST to Google's Generative Language API.
 * Uses gemini-2.5-flash model for fast inference. Requires GEMINI_API_KEY env var.
 * LOGIC CHANGE 2026-03-28: gemini-2.0-flash retired by Google for new API keys as of March 2026. Updated to gemini-2.5-flash.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Options for execution
 * @returns {Promise<{ output: string, hitMaxTurns: boolean }>}
 */
async function runGeminiAdapter(prompt, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required for Gemini provider');
  }

  const model = options.model || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      maxOutputTokens: options.maxOutputTokens || 8192,
      temperature: options.temperature || 0.7,
    }
  };

  console.log(`[llm-runner] Calling Gemini API (model=${model})`);
  // LOGIC CHANGE 2026-04-01: Added debug logging to diagnose empty response reports.
  // Logs the exact URL (key redacted), request body, HTTP status, and raw response
  // so we can compare against the working curl command.
  console.log('[llm-runner] DEBUG: URL:', url.replace(apiKey, '<REDACTED>'));
  console.log('[llm-runner] DEBUG: Body:', JSON.stringify(requestBody));

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    console.log('[llm-runner] DEBUG: Status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();

      // Check for rate limit errors
      if (response.status === 429 || errorText.includes('RESOURCE_EXHAUSTED') || errorText.includes('quota')) {
        throw new RateLimitError(`Gemini rate limit: ${errorText.slice(0, 500)}`);
      }

      throw new Error(`Gemini API error (${response.status}): ${errorText.slice(0, 500)}`);
    }

    const data = await response.json();
    console.log('[llm-runner] DEBUG: Response:', JSON.stringify(data));

    // Extract text from response
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      throw new Error('Gemini returned no candidates');
    }

    // LOGIC CHANGE 2026-04-01: Check finishReason before accessing content.parts.
    // When finishReason === 'MAX_TOKENS', Gemini 2.5 Flash omits content.parts entirely
    // (reasoning tokens consume the budget before output tokens are produced).
    // Replaced generic "empty response" with specific diagnostics so callers know
    // whether to increase maxOutputTokens or investigate an unexpected format.
    const finishReason = candidates[0].finishReason;
    const parts = candidates[0].content?.parts || [];
    const output = parts.map(p => p.text || '').join('').trim();

    if (!output) {
      if (finishReason === 'MAX_TOKENS') {
        const thoughts = data.usageMetadata?.thoughtsTokenCount || 0;
        throw new Error(
          `Gemini hit MAX_TOKENS limit (thoughtsTokenCount=${thoughts} - increase maxOutputTokens)`
        );
      }
      throw new Error(
        `Gemini returned no text in response (finishReason=${finishReason}, response=${JSON.stringify(data).slice(0, 500)})`
      );
    }

    // Gemini doesn't have a turn concept like Claude CLI, so hitMaxTurns is always false
    return { output, hitMaxTurns: false };

  } catch (err) {
    // Re-throw RateLimitError as-is
    if (err.isRateLimit) {
      throw err;
    }

    // Wrap other fetch errors
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      throw new Error(`Gemini network error: ${err.message}`);
    }

    throw err;
  }
}

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
async function runWithFallback(prompt, options = {}) {
  const primaryProvider = options.provider || process.env.LLM_PROVIDER || DEFAULT_PROVIDER;
  const fallbackProvider = options.fallbackProvider || process.env.LLM_FALLBACK_PROVIDER || DEFAULT_FALLBACK_PROVIDER;
  const enableFallback = options.enableFallback !== undefined ? options.enableFallback : FALLBACK_ENABLED;

  // Try primary provider first
  try {
    const result = await runLLM(prompt, { ...options, provider: primaryProvider });
    return result;
  } catch (primaryError) {
    // Check if this is a rate limit error and fallback is enabled
    if (primaryError.isRateLimit && enableFallback) {
      // Check if fallback provider is available
      if (fallbackProvider === 'gemini' && !process.env.GEMINI_API_KEY) {
        console.error(`[llm-runner] ${primaryProvider} rate limit hit but GEMINI_API_KEY not set - cannot fallback`);
        throw primaryError;
      }

      console.log(`[llm-runner] ${primaryProvider} rate limit hit - falling back to ${fallbackProvider}`);

      try {
        const fallbackResult = await runLLM(prompt, { ...options, provider: fallbackProvider });
        return {
          ...fallbackResult,
          usedFallback: true,
          fallbackProvider: fallbackProvider,
        };
      } catch (fallbackError) {
        // If fallback also fails, throw the original error with fallback info
        console.error(`[llm-runner] Fallback to ${fallbackProvider} also failed: ${fallbackError.message}`);
        const combinedError = new Error(
          `Primary (${primaryProvider}) rate limited, fallback (${fallbackProvider}) failed: ${fallbackError.message}`
        );
        combinedError.primaryError = primaryError;
        combinedError.fallbackError = fallbackError;
        throw combinedError;
      }
    }

    // Not a rate limit error or fallback disabled - throw original error
    throw primaryError;
  }
}

/**
 * LOGIC CHANGE 2026-03-30: Validate Gemini API access at startup.
 * Sends a minimal test prompt to confirm the model and API key work before
 * any agent processes a real message. Resolves regardless of outcome — a
 * failure is logged loudly but must NOT block the poll loop from starting.
 *
 * Root cause this prevents: the gemini-2.0-flash → gemini-2.5-flash rename
 * caused all 8 Gemini agents to fail silently for 2 days because errors were
 * swallowed by processConversation's catch block. A startup check makes
 * the failure visible immediately in pm2 logs.
 *
 * @returns {Promise<void>}
 */
async function validateGeminiOnStartup() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[llm-runner] Gemini startup check skipped: GEMINI_API_KEY not set');
    return;
  }

  const model = 'gemini-2.5-flash';
  console.log(`[llm-runner] Gemini startup check: testing ${model}...`);
  try {
    // LOGIC CHANGE 2026-04-01: Increased maxOutputTokens from 10 to 100.
    // Gemini 2.5 Flash uses ~7 tokens for internal reasoning (thoughtsTokenCount)
    // before producing output, so a limit of 10 left only 3 output tokens —
    // enough to trigger MAX_TOKENS and return an empty response.
    const result = await runGeminiAdapter('Reply with the single word: ok', {
      maxOutputTokens: 100,
      temperature: 0,
    });
    console.log(`[llm-runner] Gemini startup check PASSED (model=${model}, output="${result.output.slice(0, 50)}")`);
  } catch (err) {
    console.error(`[llm-runner] *** GEMINI STARTUP CHECK FAILED ***: ${err.message}`);
    console.error(`[llm-runner] All agents using llm_provider: gemini will fail until this is resolved.`);
    console.error(`[llm-runner] Check: GEMINI_API_KEY is valid, model "${model}" is accessible on this key tier.`);
  }
}

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
  // Export defaults for testing
  DEFAULT_PROVIDER,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT,
  // LOGIC CHANGE 2026-04-01: Export fallback configuration
  DEFAULT_FALLBACK_PROVIDER,
  FALLBACK_ENABLED,
  // Export rate limit utilities for testing and bridge-agent usage
  isRateLimitError,
  RateLimitError,
  RATE_LIMIT_PATTERNS,
  // LOGIC CHANGE 2026-03-27: Export bandwidth exhaustion utilities
  isBandwidthExhausted,
  BandwidthExhaustedError,
  BANDWIDTH_EXHAUSTION_PATTERNS,
  MIN_REAL_OUTPUT_LENGTH,
};
