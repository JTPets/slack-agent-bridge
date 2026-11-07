/**
 * tests/llm-fallback.test.js
 *
 * Unit tests for lib/llm-fallback.js (runWithFallback and the provider chain).
 *
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #10 Wave T, owner decision #44 of 2026-10-10: one
 * suite per module): moved unchanged out of tests/llm-runner.test.js, which covered all
 * seven parts of the lib/llm-runner.js split. Every test still requires the facade
 * (`../lib/llm-runner`), so the facade's surface stays covered. The shared setup is
 * tests/helpers/llm-runner-harness.js.
 */

'use strict';

const { useLlmRunnerHarness } = require('./helpers/llm-runner-harness');

const h = useLlmRunnerHarness();

describe('runWithFallback', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    // Setup successful Gemini response for fallback tests
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ content: { parts: [{ text: 'Gemini fallback response' }] } }],
      }),
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.LLM_FALLBACK_ENABLED;
    delete process.env.LLM_FALLBACK_PROVIDER;
  });

  test('returns result from primary provider when successful', async () => {
    h.setupMockSpawn({ stdout: 'Claude response' });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('test prompt', { cwd: '/tmp/test' });

    expect(result.output).toBe('Claude response');
    expect(result.usedFallback).toBeUndefined();
  });

  test('falls back to Gemini when Claude hits rate limit', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('test prompt', { cwd: '/tmp/test' });

    expect(result.output).toBe('Gemini fallback response');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackProvider).toBe('gemini');
  });

  test('does not fallback when LLM_FALLBACK_ENABLED is false', async () => {
    process.env.LLM_FALLBACK_ENABLED = 'false';
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

    await expect(runWithFallback('test prompt')).rejects.toThrow(RateLimitError);
  });

  test('does not fallback when enableFallback option is false', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

    await expect(runWithFallback('test prompt', { enableFallback: false })).rejects.toThrow(RateLimitError);
  });

  test('throws RateLimitError when GEMINI_API_KEY not set and fallback needed', async () => {
    delete process.env.GEMINI_API_KEY;

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

    await expect(runWithFallback('test prompt')).rejects.toThrow(RateLimitError);
  });

  test('throws original error when primary fails with non-rate-limit error', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with non-rate-limit error
    h.setupMockSpawn({ stderr: 'Some other error', exitCode: 1 });

    const { runWithFallback } = require('../lib/llm-runner');

    await expect(runWithFallback('test prompt')).rejects.toThrow('Exit code 1');
  });

  test('throws combined error when both primary and fallback fail', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    // Setup Gemini to also fail
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Gemini server error'),
    });

    const { runWithFallback } = require('../lib/llm-runner');

    try {
      await runWithFallback('test prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Primary (claude) rate limited');
      expect(err.message).toContain('fallback (gemini) failed');
      expect(err.primaryError).toBeDefined();
      expect(err.fallbackError).toBeDefined();
    }
  });

  test('respects LLM_FALLBACK_PROVIDER env var', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.LLM_FALLBACK_PROVIDER = 'gemini';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('test prompt');

    expect(result.fallbackProvider).toBe('gemini');
  });

  test('respects fallbackProvider option over env var', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.LLM_FALLBACK_PROVIDER = 'ollama';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('test prompt', { fallbackProvider: 'gemini' });

    expect(result.fallbackProvider).toBe('gemini');
  });

  test('passes options to fallback provider', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    // Setup Claude to fail with rate limit
    h.setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

    const { runWithFallback } = require('../lib/llm-runner');
    await runWithFallback('test prompt', { maxOutputTokens: 4096, temperature: 0.5 });

    // Verify Gemini was called with the options
    const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(callBody.generationConfig.maxOutputTokens).toBe(4096);
    expect(callBody.generationConfig.temperature).toBe(0.5);
  });
});

// LOGIC CHANGE 2026-09-11: Tests for the ollama -> gemini -> claude fallback
// chain. These FAIL against the previous runWithFallback, which only fell back
// on primaryError.isRateLimit and only ever tried a single provider.

describe('runWithFallback - ollama chain', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.OLLAMA_MODEL = 'local-model';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_MODEL;
    delete process.env.LLM_FALLBACK_PROVIDER;
    delete process.env.LLM_FALLBACK_ENABLED;
  });

  /**
   * Route /api/chat (ollama) to a failure and Gemini's endpoint to a success.
   */
  function mockOllamaFailureGeminiSuccess(ollamaFailure) {
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/chat')) {
        return ollamaFailure();
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'Gemini fallback response' }] } }],
        }),
      });
    });
  }

  test('connection refused on ollama completes on gemini with a recorded fallback_reason', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    mockOllamaFailureGeminiSuccess(() => Promise.reject(connErr));

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('test prompt', { provider: 'ollama', agentId: 'local-agent' });

    expect(result.output).toBe('Gemini fallback response');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackProvider).toBe('gemini');
    expect(result.fallbackReason).toBe('connection_refused');
    expect(result.providerRequested).toBe('ollama');
    expect(result.providerUsed).toBe('gemini');

    // The reason must also be durably recorded, not only returned.
    const { getStats } = require('../lib/llm-metrics');
    const stats = getStats({ agentId: 'local-agent', days: 1 });
    expect(stats.calls).toBe(1);
    expect(stats.fallbacks).toBe(1);
    expect(stats.fallbackRate).toBe(1);
    expect(stats.reasons.connection_refused).toBe(1);
    expect(stats.used.gemini).toBe(1);
    expect(stats.requested.ollama).toBe(1);
  });

  test('timeout on ollama falls back to gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = jest.fn((url, opts) => {
      if (String(url).includes('/api/chat')) {
        return new Promise((resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            const abortErr = new Error('aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'gemini' }] } }] }),
      });
    });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama', timeout: 50 });

    expect(result.fallbackReason).toBe('timeout');
    expect(result.fallbackProvider).toBe('gemini');
  });

  test('empty ollama output falls back to gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockOllamaFailureGeminiSuccess(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: { role: 'assistant', content: '  ' }, done: true }),
    }));

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama' });

    expect(result.fallbackReason).toBe('empty_output');
    expect(result.output).toBe('Gemini fallback response');
  });

  test('malformed ollama output falls back to gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockOllamaFailureGeminiSuccess(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ done: true }),
    }));

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama' });

    expect(result.fallbackReason).toBe('malformed_output');
    expect(result.output).toBe('Gemini fallback response');
  });

  test('non-2xx ollama response falls back to gemini', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    mockOllamaFailureGeminiSuccess(() => Promise.resolve({
      ok: false,
      status: 500,
      text: () => Promise.resolve('boom'),
    }));

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama' });

    expect(result.fallbackReason).toBe('http_error');
  });

  test('falls through to claude when gemini is unconfigured', async () => {
    delete process.env.GEMINI_API_KEY;
    h.setupMockSpawn({ stdout: 'Claude response' });
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(connErr);

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama' });

    expect(result.output).toBe('Claude response');
    expect(result.fallbackProvider).toBe('claude');
    expect(result.fallbackReason).toBe('connection_refused');
  });

  test('falls through to claude when gemini also fails', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    h.setupMockSpawn({ stdout: 'Claude response' });
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/chat')) return Promise.reject(connErr);
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('gemini down') });
    });

    const { runWithFallback } = require('../lib/llm-runner');
    const result = await runWithFallback('p', { provider: 'ollama' });

    expect(result.output).toBe('Claude response');
    expect(result.fallbackProvider).toBe('claude');
  });

  test('default chain for ollama is gemini then claude', () => {
    const { resolveFallbackChain } = require('../lib/llm-runner');
    expect(resolveFallbackChain('ollama', {})).toEqual(['gemini', 'claude']);
  });

  test('default chain for claude is unchanged (gemini only)', () => {
    const { resolveFallbackChain } = require('../lib/llm-runner');
    expect(resolveFallbackChain('claude', {})).toEqual(['gemini']);
  });

  test('LLM_FALLBACK_PROVIDER accepts a comma-separated chain', () => {
    process.env.LLM_FALLBACK_PROVIDER = 'gemini, claude';
    const { resolveFallbackChain } = require('../lib/llm-runner');
    expect(resolveFallbackChain('ollama', {})).toEqual(['gemini', 'claude']);
  });

  test('an unknown provider is a config defect and never triggers fallback', async () => {
    process.env.GEMINI_API_KEY = 'test-key';

    const { runWithFallback } = require('../lib/llm-runner');

    await expect(runWithFallback('p', { provider: 'not-a-provider' })).rejects.toThrow(
      'Unknown LLM provider: not-a-provider'
    );
  });

  test('does not fall back when fallback is disabled', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(connErr);

    const { runWithFallback } = require('../lib/llm-runner');

    await expect(
      runWithFallback('p', { provider: 'ollama', enableFallback: false })
    ).rejects.toThrow('Ollama connection failed');
  });

  test('reports the whole chain failing with the primary reason named', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    h.setupMockSpawn({ exitCode: 1, stderr: 'claude is broken too' });
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/chat')) return Promise.reject(connErr);
      return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('gemini down') });
    });

    const { runWithFallback } = require('../lib/llm-runner');

    try {
      await runWithFallback('p', { provider: 'ollama' });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Primary (ollama) failed (connection_refused)');
      expect(err.message).toContain('fallback (claude) failed');
      expect(err.fallbackReason).toBe('connection_refused');
      expect(err.primaryError).toBeDefined();
      expect(err.fallbackError).toBeDefined();
    }
  });
});

// LOGIC CHANGE 2026-09-11: Every call must leave a verdict, fallback or not.
