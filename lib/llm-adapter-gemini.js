/**
 * lib/llm-adapter-gemini.js
 *
 * The hosted single-shot adapters: Gemini over its HTTP API, its startup check, and the
 * OpenAI placeholder.
 *
 * Moved unchanged out of lib/llm-runner.js on 2026-10-05 (WORK-TODO #10). lib/llm-runner.js
 * re-exports every name here, so callers are unchanged.
 */

'use strict';

const {
  RateLimitError, BillingError, tagFallbackReason, classifyHttpFailure, describeHttpFailure,
} = require('./llm-errors');

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

      // LOGIC CHANGE 2026-11-07 (WORK-TODO #79): classify by lib/llm-http-failure.js.
      // This used to test RESOURCE_EXHAUSTED/"quota" before the status, so an HTTP 402
      // "Your prepayment credits are depleted" (status RESOURCE_EXHAUSTED) was reported
      // as "Gemini rate limit" — a fix that waiting cannot bring. Every non-2xx is also
      // tagged now: an untagged 5xx was not a fallback trigger at all, although
      // CLAUDE.md's trigger table lists "Non-2xx response -> http_error".
      const reason = classifyHttpFailure(response.status, errorText);
      const message = describeHttpFailure('Gemini', reason, response.status, errorText, { keyVar: 'GEMINI_API_KEY' });
      let err;
      if (reason === 'rate_limit') err = new RateLimitError(message);
      else if (reason === 'billing') err = new BillingError(message);
      else err = new Error(message);
      err.httpStatus = response.status;
      throw tagFallbackReason(err, reason);
    }

    const data = await response.json();

    // Extract text from response
    const candidates = data.candidates || [];
    if (candidates.length === 0) {
      // LOGIC CHANGE 2026-11-07 (WORK-TODO #79): tagged, so it is a fallback trigger.
      throw tagFallbackReason(new Error('Gemini returned no candidates'), 'malformed_output');
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
        throw tagFallbackReason(new Error(
          `Gemini hit MAX_TOKENS limit (thoughtsTokenCount=${thoughts} - increase maxOutputTokens)`
        ), 'empty_output');
      }
      throw tagFallbackReason(new Error(
        `Gemini returned no text in response (finishReason=${finishReason}, response=${JSON.stringify(data).slice(0, 500)})`
      ), 'empty_output');
    }

    // Gemini doesn't have a turn concept like Claude CLI, so hitMaxTurns is always false
    return { output, hitMaxTurns: false };

  } catch (err) {
    // Re-throw an already-classified error as-is (rate limit, billing, tagged).
    if (err.isRateLimit || err.fallbackReason) {
      throw err;
    }

    // Wrap other fetch errors
    // LOGIC CHANGE 2026-11-07 (WORK-TODO #79): tagged connection_refused, as the Ollama
    // adapter's network failure already is.
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      throw tagFallbackReason(new Error(`Gemini network error: ${err.message}`), 'connection_refused');
    }

    throw err;
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
    // LOGIC CHANGE 2026-11-07 (WORK-TODO #79): the hint follows the classified reason,
    // so a depleted account is not sent to check its key.
    if (err.fallbackReason === 'billing') {
      console.error('[llm-runner] Check: the Gemini account\'s prepaid credits or billing (NOT a rate limit; waiting will not fix it).');
    } else if (err.fallbackReason === 'rate_limit') {
      console.error('[llm-runner] Check: the key\'s quota; a rate limit clears on its own.');
    } else {
      console.error(`[llm-runner] Check: GEMINI_API_KEY is valid, model "${model}" is accessible on this key tier.`);
    }
  }
}

module.exports = {
  runOpenAIAdapter,
  runGeminiAdapter,
  validateGeminiOnStartup,
};
