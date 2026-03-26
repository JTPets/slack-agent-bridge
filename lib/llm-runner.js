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
 */

'use strict';

const { spawn } = require('child_process');
const os = require('os');

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

    default:
      throw new Error(`Unknown LLM provider: ${provider}. Supported providers: claude, openai, ollama`);
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

module.exports = {
  runLLM,
  // Export adapters for testing purposes
  runClaudeAdapter,
  runOpenAIAdapter,
  runOllamaAdapter,
  // Export defaults for testing
  DEFAULT_PROVIDER,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT,
};
