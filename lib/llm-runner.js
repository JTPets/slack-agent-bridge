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
const { recordVerdict } = require('./llm-metrics');

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
 * @param {string} stderr - Accumulated stderr
 * @returns {string} A diagnostic message
 */
function describeClaudeExit(code, signal, stderr) {
  const trimmedErr = (stderr || '').trim();
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
  return head + tail;
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
// LOGIC CHANGE 2026-09-13: Default moved off the dead Raspberry Pi home path to the
// container path. Kept in step with lib/config.js - these two must not diverge.
const DEFAULT_CLAUDE_BIN = process.env.CLAUDE_BIN || '/usr/local/bin/claude';
const DEFAULT_MAX_TURNS = parseInt(process.env.MAX_TURNS || '50', 10);
const DEFAULT_TIMEOUT = parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10);

// LOGIC CHANGE 2026-04-01: Added fallback configuration for Claude → Gemini failover.
// When Claude hits rate limits, the system can automatically retry with Gemini.
const DEFAULT_FALLBACK_PROVIDER = 'gemini';
const FALLBACK_ENABLED = process.env.LLM_FALLBACK_ENABLED !== 'false'; // Default: enabled

// LOGIC CHANGE 2026-09-11: Per-primary default fallback chains. An agent whose
// primary is a local Ollama model degrades ollama -> gemini -> claude: local
// first for cost, hosted Gemini next for speed, Claude last as the most capable.
// Every other primary keeps the historical single-hop behaviour (-> gemini).
const DEFAULT_FALLBACK_CHAINS = {
  ollama: ['gemini', 'claude'],
};

// LOGIC CHANGE 2026-09-11: Ollama (local model server) configuration.
// Defaults are deliberately loopback-only: the Pi binds ollama to 127.0.0.1 so
// the model server is never reachable off-box. See CLAUDE.md for the systemd
// drop-in that enforces this along with the memory/parallelism fencing.
const DEFAULT_OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '5m';
const DEFAULT_OLLAMA_NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || '8192', 10);
const DEFAULT_OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);

/**
 * LOGIC CHANGE 2026-09-11: Normalize the OLLAMA_THINK / options.think knob into
 * the value Ollama's native API actually accepts.
 *
 * INVESTIGATED, not assumed: Ollama's `think` field takes a boolean OR one of
 * "low" | "medium" | "high" | "max" (ollama/ollama docs/api.md, /api/chat
 * Parameters). There is no `enable_thinking` field anywhere in the Ollama API —
 * neither native nor OpenAI-compatible. See the adapter JSDoc for why this
 * adapter uses the native endpoint.
 *
 * @param {string|boolean|undefined} raw - Configured think value
 * @returns {boolean|string} A value Ollama's `think` field accepts
 */
function normalizeThink(raw) {
  const value = raw === undefined || raw === null ? process.env.OLLAMA_THINK : raw;
  if (value === undefined || value === null || value === '') return false; // Default: thinking OFF
  if (typeof value === 'boolean') return value;

  const lowered = String(value).toLowerCase();
  if (lowered === 'false' || lowered === 'off' || lowered === 'none' || lowered === '0') return false;
  if (lowered === 'true' || lowered === 'on' || lowered === '1') return true;
  if (['low', 'medium', 'high', 'max'].includes(lowered)) return lowered;

  // Unknown value: fail closed to thinking OFF rather than silently sending
  // something the server will 400 on.
  console.warn(`[llm-runner] Unrecognized OLLAMA_THINK value "${value}" - defaulting to false`);
  return false;
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

    // LOGIC CHANGE 2026-09-20: The prompt is written to the child's STDIN instead
    // of being passed as the `-p` argv entry. Linux caps a SINGLE argv entry at
    // MAX_ARG_STRLEN (32 * PAGE_SIZE = 131072 bytes) independently of the much
    // larger total argv/environ limit, so a long prompt failed at execve with
    // `spawn E2BIG` before any work was attempted. Measured on this platform: the
    // largest prompt that could exec was 131071 bytes. That ceiling was already
    // being reached in normal use - buildPrompt() embeds the cloned repo's
    // CLAUDE.md verbatim, and this repo's CLAUDE.md is ~127 KB on its own, so an
    // ordinary dispatch sat within ~2.5 KB of a hard exec failure.
    //
    // `claude --print` reads its prompt from stdin when no positional prompt is
    // given (`--input-format text` is the default, and is documented as applying
    // to --print). Stdin was previously 'ignore'; it is now 'pipe'. Stdin is used
    // rather than a temp file deliberately: a prompt can carry sensitive context,
    // and a pipe has no on-disk lifetime, no file mode to get wrong, and no
    // cleanup path that can be missed on a failure branch.
    const args = [
      '-p',
      '--output-format', 'text',
      '--max-turns', String(maxTurns),
      '--dangerously-skip-permissions',
    ];

    const promptText = typeof prompt === 'string' ? prompt : String(prompt ?? '');

    console.log(
      `[llm-runner] Spawning Claude in ${cwd} ` +
      `(max-turns=${maxTurns}, prompt=${Buffer.byteLength(promptText)} bytes via stdin)`
    );

    let child;
    try {
      child = spawn(claudeBin, args, {
        cwd,
        env: { ...process.env, HOME: os.homedir() },
        timeout,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      // LOGIC CHANGE 2026-09-20: spawn() can throw SYNCHRONOUSLY (E2BIG did, which
      // is why the observed failure never reached the 'error' handler below).
      // Normalise it to the same rejection shape as the async failure instead of
      // letting a raw throw escape with a different message.
      reject(new Error(`Spawn failed: ${err.message}`));
      return;
    }

    // LOGIC CHANGE 2026-09-20: Deliver the prompt over stdin. A child that exits
    // before draining the pipe makes this write fail with EPIPE/ERR_STREAM_*; that
    // is not itself the task's failure - the close handler below reports the real
    // exit cause - so it is logged and swallowed rather than thrown, which would
    // otherwise surface as an unhandled 'error' on the stream and crash the bridge.
    child.stdin.on('error', (err) => {
      console.error(`[llm-runner] Failed writing prompt to Claude stdin: ${err.message}`);
    });
    child.stdin.end(promptText);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // LOGIC CHANGE 2026-09-13: Take the `signal` arg Node passes to close. A
    // signal kill reports code=null + signal set; without capturing signal that
    // information was lost and the interrupted path threw stderr away entirely.
    child.on('close', (code, signal) => {
      const output = stdout.trim();
      const trimmedErr = stderr.trim();

      // LOGIC CHANGE 2026-03-26: Detect if output indicates max turns was reached.
      // This allows callers to handle partial completions appropriately.
      const hitMaxTurns = output.includes('Reached max turns');

      // LOGIC CHANGE 2026-03-27: Exit code null means the process was killed
      // (e.g., container restart, SIGTERM). Treat as interrupted, not failed.
      // LOGIC CHANGE 2026-09-13: Carry the signal and any stderr through instead
      // of discarding them, and log what stderr the process managed to emit
      // before dying so an interruption with a real cause is not silent.
      if (code === null) {
        if (trimmedErr) {
          console.error(
            `[llm-runner] Claude killed by ${signal || 'unknown signal'}; stderr before exit:\n` +
            trimmedErr.slice(0, 2000)
          );
        } else {
          console.error(`[llm-runner] Claude killed by ${signal || 'unknown signal'} (no stderr output)`);
        }
        resolve({
          output: output || '',
          hitMaxTurns: false,
          interrupted: true,
          signal: signal || null,
          stderr: trimmedErr,
        });
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
        // LOGIC CHANGE 2026-09-13: Surface the real cause. describeClaudeExit keeps
        // the "Exit code N" prefix callers/tests match on, decodes a 128+N code
        // (e.g. 143 -> SIGTERM) and states explicitly when there was no stderr,
        // so a failed task no longer reports a bare, undiagnosable number.
        const err = new Error(describeClaudeExit(code, signal, stderr));
        err.exitCode = code;
        err.signal = signal || signalFromExitCode(code) || null;
        err.stderr = trimmedErr;
        reject(err);
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
 * LOGIC CHANGE 2026-09-11: Ollama adapter - HTTP POST to a local Ollama server.
 * Replaces the 2026-03-26 "not yet implemented" placeholder.
 *
 * WHY THE NATIVE /api/chat ENDPOINT AND NOT /v1/chat/completions:
 * The OpenAI-compatible endpoint's request struct (ollama/ollama openai/openai.go
 * ChatCompletionRequest) carries no `keep_alive` and no `options` field, so model
 * residency and context size — both load-bearing on a memory-fenced Pi — simply
 * cannot be set per request over the compat path. Thinking control IS reachable
 * over compat (`reasoning_effort: "none"` maps to Think=false in
 * thinkFromReasoningEffort), but keep_alive/num_ctx are not, so native it is.
 * There is no `enable_thinking` field on either path; that knob does not exist.
 *
 * PORTABILITY COST of choosing native: this adapter no longer speaks the
 * OpenAI wire format, so pointing it at llama.cpp's server, vLLM or LM Studio
 * would need a second request/response mapping rather than just a base URL
 * change. Accepted deliberately: OLLAMA_NUM_CTX and OLLAMA_KEEP_ALIVE are the
 * controls that keep a local model inside its memory budget, and losing them to
 * gain a URL swap is the worse trade on this box.
 *
 * Single-shot provider: there is no turn loop, so options.maxTurns is ignored and
 * hitMaxTurns is always false (same contract as the Gemini adapter).
 * Non-streaming: `stream: false` so the adapter returns one accumulated string,
 * matching what every caller of runLLM consumes.
 *
 * NO hardcoded model name. The model comes from options.model (per-agent
 * override) or OLLAMA_MODEL. With neither set the adapter throws a precondition
 * error rather than guessing a model that may not be pulled on the box.
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} [options={}] - Options for execution
 * @param {string} [options.model] - Per-agent model override (falls back to OLLAMA_MODEL)
 * @param {string} [options.baseUrl] - Ollama server base URL (falls back to OLLAMA_BASE_URL)
 * @param {number} [options.timeout] - Abort the request after this many ms
 * @param {string} [options.keepAlive] - How long the model stays resident (falls back to OLLAMA_KEEP_ALIVE)
 * @param {number} [options.numCtx] - Context window in tokens (falls back to OLLAMA_NUM_CTX)
 * @param {boolean|string} [options.think] - Thinking mode (falls back to OLLAMA_THINK, default false)
 * @param {number} [options.temperature] - Sampling temperature
 * @returns {Promise<{ output: string, hitMaxTurns: boolean, model: string }>}
 */
async function runOllamaAdapter(prompt, options = {}) {
  const model = options.model || process.env.OLLAMA_MODEL;
  if (!model) {
    throw new Error(
      'OLLAMA_MODEL environment variable (or options.model) is required for Ollama provider'
    );
  }

  const baseUrl = (options.baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL)
    .replace(/\/+$/, '');
  const url = `${baseUrl}/api/chat`;
  const timeout = options.timeout || DEFAULT_OLLAMA_TIMEOUT;
  const keepAlive = options.keepAlive || process.env.OLLAMA_KEEP_ALIVE || DEFAULT_OLLAMA_KEEP_ALIVE;
  const numCtx = options.numCtx || parseInt(process.env.OLLAMA_NUM_CTX || String(DEFAULT_OLLAMA_NUM_CTX), 10);
  const think = normalizeThink(options.think);

  const requestBody = {
    model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    think,
    keep_alive: keepAlive,
    options: {
      num_ctx: numCtx,
      temperature: options.temperature !== undefined ? options.temperature : 0.7,
    },
  };

  console.log(`[llm-runner] Calling Ollama (model=${model}, num_ctx=${numCtx}, think=${think}, timeout=${timeout}ms)`);

  // options.timeout is honored via AbortController — fetch has no timeout option,
  // and an un-aborted request to a wedged local model would hang the poll loop.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw tagFallbackReason(
        new Error(`Ollama request timed out after ${timeout}ms (model=${model})`),
        'timeout'
      );
    }
    // fetch surfaces a refused/unreachable server as a TypeError whose cause
    // carries the syscall code. Both shapes mean "server is not answering".
    const code = err.cause && err.cause.code ? err.cause.code : '';
    throw tagFallbackReason(
      new Error(`Ollama connection failed at ${baseUrl}: ${err.message}${code ? ` (${code})` : ''}`),
      'connection_refused'
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await response.text();
    } catch (readErr) {
      errorText = `<could not read body: ${readErr.message}>`;
    }

    // Ollama returns 429 when a queue/concurrency limit is hit. Treat it like
    // any other rate limit so the existing RateLimitError handling applies.
    if (response.status === 429) {
      const rateErr = new RateLimitError(`Ollama rate limit: ${errorText.slice(0, 500)}`);
      throw tagFallbackReason(rateErr, 'rate_limit');
    }

    throw tagFallbackReason(
      new Error(`Ollama API error (${response.status}): ${errorText.slice(0, 500)}`),
      'http_error'
    );
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw tagFallbackReason(
      new Error(`Ollama returned unparseable JSON: ${err.message}`),
      'malformed_output'
    );
  }

  // Shape check before reading content. A 200 with the wrong shape is a
  // malformed response, not an empty one — the distinction drives the
  // fallback_reason an operator sees.
  if (!data || typeof data !== 'object' || !data.message || typeof data.message.content !== 'string') {
    throw tagFallbackReason(
      new Error(`Ollama response missing message.content (response=${JSON.stringify(data).slice(0, 500)})`),
      'malformed_output'
    );
  }

  const output = data.message.content.trim();

  if (!output) {
    // A thinking model can burn its whole budget on reasoning and return empty
    // content. That is a failed call, not a successful empty answer.
    throw tagFallbackReason(
      new Error(
        `Ollama returned empty output (model=${model}, think=${think}, done_reason=${data.done_reason || 'unknown'})`
      ),
      'empty_output'
    );
  }

  // Single-shot provider: no turn concept, so hitMaxTurns is always false.
  return { output, hitMaxTurns: false, model };
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

/**
 * LOGIC CHANGE 2026-03-30: Validate Gemini API access at startup.
 * Sends a minimal test prompt to confirm the model and API key work before
 * any agent processes a real message. Resolves regardless of outcome — a
 * failure is logged loudly but must NOT block the poll loop from starting.
 *
 * Root cause this prevents: the gemini-2.0-flash → gemini-2.5-flash rename
 * caused all 8 Gemini agents to fail silently for 2 days because errors were
 * swallowed by processConversation's catch block. A startup check makes
 * the failure visible immediately in the container logs.
 * (LOGIC CHANGE 2026-09-14: said "pm2 logs"; there is no pm2 in this deployment.)
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

// LOGIC CHANGE 2026-09-11: Module-level availability flag for the local model
// server, set by validateOllamaOnStartup and refreshed on every Ollama call.
// It is reporting state ONLY — it deliberately does not gate dispatch. A sticky
// "unavailable" flag would route an agent away from its configured provider
// forever after one bad boot, which is a worse failure than one failed call
// that falls back.
let ollamaAvailable = null; // null = never checked, true/false = last known

/**
 * Last known reachability of the Ollama server.
 *
 * @returns {boolean|null} true/false after a check, null if never checked
 */
function isOllamaAvailable() {
  return ollamaAvailable;
}

/**
 * LOGIC CHANGE 2026-09-11: Validate the local Ollama server at startup.
 * Mirrors validateGeminiOnStartup in shape and, critically, in its contract:
 *
 *   IT MUST NOT PREVENT BOOT.
 *
 * Confirmed by reading validateGeminiOnStartup at HEAD — it catches everything
 * and returns, with no process.exit and no rethrow, so bridge-agent.js:1894
 * always proceeds to poll(). This function does the same: an unreachable or
 * down Ollama logs a loud warning, marks the provider unavailable, and the
 * bridge starts normally with every agent on its configured provider.
 *
 * Uses GET /api/tags (the model list) rather than a generation request: it is
 * cheap, needs no model to be pulled, and also lets us say whether the
 * configured OLLAMA_MODEL is actually present on the box.
 *
 * @param {Object} [opts={}] - Options
 * @param {Array<Object>} [opts.agents] - Agent registry entries, used to decide whether ollama is in use at all
 * @param {number} [opts.timeout=5000] - Probe timeout in ms
 * @returns {Promise<void>} Always resolves
 */
async function validateOllamaOnStartup(opts = {}) {
  const timeout = opts.timeout || 5000;
  const configuredModel = process.env.OLLAMA_MODEL;

  // Only probe if something actually routes to ollama. Probing unconditionally
  // would warn on every boot of a box that never intends to run a local model.
  const agents = Array.isArray(opts.agents) ? opts.agents : [];
  const agentUsesOllama = agents.some(a => (a && a.llm_provider || '').toLowerCase() === 'ollama');
  const envUsesOllama =
    (process.env.LLM_PROVIDER || '').toLowerCase() === 'ollama' ||
    (process.env.LLM_FALLBACK_PROVIDER || '').toLowerCase().split(',').map(s => s.trim()).includes('ollama') ||
    Boolean(process.env.OLLAMA_MODEL) ||
    Boolean(process.env.OLLAMA_BASE_URL);

  if (!agentUsesOllama && !envUsesOllama) {
    console.log('[llm-runner] Ollama startup check skipped: no agent or env var routes to ollama');
    return;
  }

  const baseUrl = (process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
  console.log(`[llm-runner] Ollama startup check: probing ${baseUrl}/api/tags...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });

    if (!response.ok) {
      ollamaAvailable = false;
      console.error(`[llm-runner] *** OLLAMA STARTUP CHECK FAILED ***: ${baseUrl} returned HTTP ${response.status}`);
      console.error('[llm-runner] Agents using llm_provider: ollama will fall back (gemini, then claude) until this is resolved.');
      return;
    }

    const data = await response.json();
    const models = Array.isArray(data && data.models) ? data.models.map(m => m.name) : [];
    ollamaAvailable = true;

    if (!configuredModel) {
      console.warn(
        `[llm-runner] Ollama startup check PASSED (${baseUrl}, ${models.length} model(s)) ` +
        'but OLLAMA_MODEL is not set - ollama calls will fail their precondition check.'
      );
      return;
    }

    // Tag list entries carry an explicit tag ("qwen3:8b"); accept a bare name too.
    const present = models.some(name => name === configuredModel || name.split(':')[0] === configuredModel.split(':')[0]);
    if (!present) {
      console.error(
        `[llm-runner] *** OLLAMA STARTUP CHECK WARNING ***: model "${configuredModel}" is not pulled on ${baseUrl}. ` +
        `Available: ${models.join(', ') || '(none)'}`
      );
      return;
    }

    console.log(`[llm-runner] Ollama startup check PASSED (${baseUrl}, model="${configuredModel}" present)`);
  } catch (err) {
    ollamaAvailable = false;
    const detail = err.name === 'AbortError' ? `no response within ${timeout}ms` : err.message;
    console.error(`[llm-runner] *** OLLAMA STARTUP CHECK FAILED ***: ${baseUrl} unreachable (${detail})`);
    console.error('[llm-runner] Agents using llm_provider: ollama will fall back (gemini, then claude) until this is resolved.');
    console.error('[llm-runner] Check: ollama service is running and bound to the OLLAMA_BASE_URL host/port.');
  } finally {
    clearTimeout(timer);
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
};
