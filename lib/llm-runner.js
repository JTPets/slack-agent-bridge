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
// LOGIC CHANGE 2026-03-27: DISABLED: Rate limit detection causes false positives.
// Will re-enable when properly calibrated.
function isRateLimitError(text) {
  return false;
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
// LOGIC CHANGE 2026-03-27: DISABLED: Bandwidth exhaustion detection causes false positives
// alongside rate limit detection. Will re-enable when properly calibrated.
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
 * Uses gemini-2.0-flash model for fast inference. Requires GEMINI_API_KEY env var.
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

  const model = options.model || 'gemini-2.0-flash';
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

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();

      // Check for rate limit errors
      if (response.status === 429 || errorText.includes('RESOURCE_EXHAUSTED') || errorText.includes('quota')) {
        throw new RateLimitError(`Gemini rate limit: ${errorText.slice(0, 500)}`);
      }

      throw new Error(`Gemini API error (${response.status}): ${errorText.slice(0, 500)}`);
    }

    const data = await response.json();

    // Extract text from response
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      throw new Error('Gemini returned no candidates');
    }

    const parts = candidates[0].content?.parts || [];
    const output = parts.map(p => p.text || '').join('').trim();

    if (!output) {
      throw new Error('Gemini returned empty response');
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

module.exports = {
  runLLM,
  // Export adapters for testing purposes
  runClaudeAdapter,
  runOpenAIAdapter,
  runOllamaAdapter,
  runGeminiAdapter,
  // Export defaults for testing
  DEFAULT_PROVIDER,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT,
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
