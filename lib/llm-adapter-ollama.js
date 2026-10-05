/**
 * lib/llm-adapter-ollama.js
 *
 * The local Ollama adapter (native /api/chat), its startup check, and the reporting-only
 * availability flag that check sets.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const {
  DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_TIMEOUT, DEFAULT_OLLAMA_KEEP_ALIVE, DEFAULT_OLLAMA_NUM_CTX, normalizeThink,
} = require('./llm-defaults');
const { tagFallbackReason, RateLimitError } = require('./llm-errors');

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
  runOllamaAdapter,
  isOllamaAvailable,
  validateOllamaOnStartup,
};
