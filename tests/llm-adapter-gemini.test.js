/**
 * tests/llm-adapter-gemini.test.js
 *
 * Unit tests for lib/llm-adapter-gemini.js (the Gemini adapter, its startup check, and the OpenAI placeholder).
 *
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #10 Wave T, owner decision #44 of 2026-10-10: one
 * suite per module): moved unchanged out of tests/llm-runner.test.js, which covered all
 * seven parts of the lib/llm-runner.js split. Every test still requires the facade
 * (`../lib/llm-runner`), so the facade's surface stays covered. The shared setup is
 * tests/helpers/llm-runner-harness.js.
 */

'use strict';

const { useLlmRunnerHarness } = require('./helpers/llm-runner-harness');

useLlmRunnerHarness();

describe('runOpenAIAdapter', () => {
  test('throws not implemented error', async () => {
    const { runOpenAIAdapter } = require('../lib/llm-runner');

    await expect(runOpenAIAdapter('prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
  });
});

// LOGIC CHANGE 2026-09-11: Replaced the "not yet implemented" placeholder test
// with real coverage of the implemented adapter. The timeout,
// connection-refused and malformed-output cases below all FAIL against the
// old stub (which rejected every call with the same message regardless of
// what the server did).

describe('runGeminiAdapter', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  });

  test('throws error when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow(
      'GEMINI_API_KEY environment variable is required for Gemini provider'
    );
  });

  test('calls Gemini API with correct URL and body', async () => {
    process.env.GEMINI_API_KEY = 'test-api-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Generated response' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    await runGeminiAdapter('test prompt');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: expect.stringContaining('test prompt'),
      })
    );
  });

  test('includes API key in URL query parameter', async () => {
    process.env.GEMINI_API_KEY = 'my-secret-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'response' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    await runGeminiAdapter('prompt');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('key=my-secret-key'),
      expect.any(Object)
    );
  });

  test('returns output from Gemini response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Hello from Gemini!' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    const result = await runGeminiAdapter('prompt');

    expect(result.output).toBe('Hello from Gemini!');
    expect(result.hitMaxTurns).toBe(false);
  });

  test('concatenates multiple parts in response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Part 1. ' }, { text: 'Part 2.' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    const result = await runGeminiAdapter('prompt');

    expect(result.output).toBe('Part 1. Part 2.');
  });

  test('uses custom model when provided in options', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'response' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    await runGeminiAdapter('prompt', { model: 'gemini-1.5-pro' });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('models/gemini-1.5-pro:generateContent'),
      expect.any(Object)
    );
  });

  test('passes maxOutputTokens and temperature to request', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'response' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    await runGeminiAdapter('prompt', { maxOutputTokens: 4096, temperature: 0.5 });

    const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(callBody.generationConfig.maxOutputTokens).toBe(4096);
    expect(callBody.generationConfig.temperature).toBe(0.5);
  });

  test('throws RateLimitError on 429 response', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limit exceeded'),
    });

    const { runGeminiAdapter, RateLimitError } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow(RateLimitError);
  });

  test('throws RateLimitError when response contains RESOURCE_EXHAUSTED', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('{"error": {"code": "RESOURCE_EXHAUSTED"}}'),
    });

    const { runGeminiAdapter, RateLimitError } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow(RateLimitError);
  });

  test('throws RateLimitError when response contains quota', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('API quota exceeded for today'),
    });

    const { runGeminiAdapter, RateLimitError } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow(RateLimitError);
  });

  test('throws error on non-rate-limit API error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal server error'),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow('Gemini API error (500)');
  });

  test('throws error when response has no candidates', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ candidates: [] }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow('Gemini returned no candidates');
  });

  // LOGIC CHANGE 2026-04-01: Updated to reflect new specific error messages.
  // Generic "empty response" replaced with finishReason-aware diagnostics.
  test('throws error with finishReason when response text is empty', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow('Gemini returned no text in response');
  });

  test('throws MAX_TOKENS error with thoughtsTokenCount when response is empty due to token limit', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ finishReason: 'MAX_TOKENS' }], // no content.parts when budget exhausted
        usageMetadata: { thoughtsTokenCount: 42 },
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow(
      'Gemini hit MAX_TOKENS limit (thoughtsTokenCount=42 - increase maxOutputTokens)'
    );
  });

  test('handles network error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const fetchError = new TypeError('fetch failed: network error');
    global.fetch = jest.fn().mockRejectedValue(fetchError);

    const { runGeminiAdapter } = require('../lib/llm-runner');

    await expect(runGeminiAdapter('prompt')).rejects.toThrow('Gemini network error');
  });

  test('hitMaxTurns is always false (Gemini has no turn concept)', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'response' }] } }],
      }),
    });

    const { runGeminiAdapter } = require('../lib/llm-runner');
    const result = await runGeminiAdapter('prompt');

    expect(result.hitMaxTurns).toBe(false);
  });
});

// LOGIC CHANGE 2026-03-30: Regression tests for validateGeminiOnStartup.
// Added after gemini-2.5-flash rename silenced all Gemini agents for 2 days.

describe('validateGeminiOnStartup', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
  });

  test('skips validation and logs when GEMINI_API_KEY is not set', async () => {
    delete process.env.GEMINI_API_KEY;
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const { validateGeminiOnStartup } = require('../lib/llm-runner');
    await expect(validateGeminiOnStartup()).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Gemini startup check skipped')
    );

    consoleSpy.mockRestore();
  });

  test('logs PASSED when Gemini API responds successfully', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const { validateGeminiOnStartup } = require('../lib/llm-runner');
    await expect(validateGeminiOnStartup()).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Gemini startup check PASSED')
    );

    consoleSpy.mockRestore();
  });

  test('logs FAILED but does not throw when Gemini API fails', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('models/gemini-2.5-flash is not found'),
    });
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateGeminiOnStartup } = require('../lib/llm-runner');
    await expect(validateGeminiOnStartup()).resolves.toBeUndefined();
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('GEMINI STARTUP CHECK FAILED')
    );

    consoleErrSpy.mockRestore();
  });

  test('logs FAILED but does not throw on network error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed: network error'));
    const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateGeminiOnStartup } = require('../lib/llm-runner');
    await expect(validateGeminiOnStartup()).resolves.toBeUndefined();
    expect(consoleErrSpy).toHaveBeenCalledWith(
      expect.stringContaining('GEMINI STARTUP CHECK FAILED')
    );

    consoleErrSpy.mockRestore();
  });

  // LOGIC CHANGE 2026-04-01: Regression test — startup check must use
  // maxOutputTokens=100 so Gemini 2.5 Flash has budget beyond reasoning tokens.
  test('uses maxOutputTokens=100 to avoid MAX_TOKENS from reasoning token overhead', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      }),
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const { validateGeminiOnStartup } = require('../lib/llm-runner');
    await validateGeminiOnStartup();

    const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(callBody.generationConfig.maxOutputTokens).toBe(100);

    consoleSpy.mockRestore();
  });
});

// LOGIC CHANGE 2026-04-01: Tests for runWithFallback function.
// Implements Claude → Gemini automatic fallback on rate limits.
