/**
 * tests/llm-adapter-ollama.test.js
 *
 * Unit tests for lib/llm-adapter-ollama.js (the Ollama adapter and its startup check).
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

describe('runOllamaAdapter', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('throws precondition error when no model is configured', async () => {
    delete process.env.OLLAMA_MODEL;

    const { runOllamaAdapter } = require('../lib/llm-runner');

    await expect(runOllamaAdapter('prompt')).rejects.toThrow(
      'OLLAMA_MODEL environment variable (or options.model) is required for Ollama provider'
    );
  });

  test('posts to the native /api/chat endpoint with stream disabled', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    h.mockOllamaResponse('hello');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    await runOllamaAdapter('my prompt');

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'my prompt' }]);
  });

  test('sends think=false by default (thinking mode off)', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    h.mockOllamaResponse('hello');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    await runOllamaAdapter('prompt');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.think).toBe(false);
    // The knob is Ollama's native `think`, NOT `enable_thinking` (which does
    // not exist in the Ollama API on any endpoint).
    expect(body).not.toHaveProperty('enable_thinking');
  });

  test('accepts a thinking level from OLLAMA_THINK', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    process.env.OLLAMA_THINK = 'medium';
    h.mockOllamaResponse('hello');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    await runOllamaAdapter('prompt');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.think).toBe('medium');
  });

  test('takes base url, keep-alive and context size from env with defaults', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9999/';
    process.env.OLLAMA_KEEP_ALIVE = '30m';
    process.env.OLLAMA_NUM_CTX = '4096';
    h.mockOllamaResponse('hello');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    await runOllamaAdapter('prompt');

    expect(global.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9999/api/chat');
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.keep_alive).toBe('30m');
    expect(body.options.num_ctx).toBe(4096);

    delete process.env.OLLAMA_KEEP_ALIVE;
    delete process.env.OLLAMA_NUM_CTX;
  });

  test('per-agent options.model overrides OLLAMA_MODEL', async () => {
    process.env.OLLAMA_MODEL = 'workhorse-model';
    h.mockOllamaResponse('routed');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    const result = await runOllamaAdapter('prompt', { model: 'router-model' });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.model).toBe('router-model');
    expect(result.model).toBe('router-model');
  });

  test('returns output with hitMaxTurns false (single-shot provider)', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    h.mockOllamaResponse('  the answer  ');

    const { runOllamaAdapter } = require('../lib/llm-runner');
    const result = await runOllamaAdapter('prompt', { maxTurns: 50 });

    expect(result.output).toBe('the answer');
    expect(result.hitMaxTurns).toBe(false);
  });

  // FAILS against the old stub: the stub rejected with "not yet implemented"
  // regardless of the timeout, so no timeout path existed to assert on.
  test('aborts and tags fallbackReason=timeout when options.timeout elapses', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      });
    }));

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt', { timeout: 50 });
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama request timed out after 50ms');
      expect(err.fallbackReason).toBe('timeout');
      expect(err.isProviderUnavailable).toBe(true);
    }
  });

  // FAILS against the old stub for the same reason as the timeout test.
  test('tags fallbackReason=connection_refused when the server is down', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(connErr);

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama connection failed');
      expect(err.message).toContain('ECONNREFUSED');
      expect(err.fallbackReason).toBe('connection_refused');
    }
  });

  test('tags fallbackReason=http_error on a non-2xx response', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('internal error'),
    });

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama API error (500)');
      expect(err.fallbackReason).toBe('http_error');
    }
  });

  test('throws RateLimitError tagged rate_limit on 429', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('too many requests'),
    });

    const { runOllamaAdapter, RateLimitError } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.isRateLimit).toBe(true);
      expect(err.fallbackReason).toBe('rate_limit');
    }
  });

  // FAILS against the old stub: a 200 with the wrong body shape had no
  // distinct behaviour before this adapter existed.
  test('tags fallbackReason=malformed_output when message.content is missing', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ model: 'test-model', done: true }),
    });

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama response missing message.content');
      expect(err.fallbackReason).toBe('malformed_output');
    }
  });

  test('tags fallbackReason=malformed_output when the body is not JSON', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    });

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama returned unparseable JSON');
      expect(err.fallbackReason).toBe('malformed_output');
    }
  });

  test('tags fallbackReason=empty_output when content is blank', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    h.mockOllamaResponse('   ', { done_reason: 'length' });

    const { runOllamaAdapter } = require('../lib/llm-runner');

    try {
      await runOllamaAdapter('prompt');
      throw new Error('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Ollama returned empty output');
      expect(err.fallbackReason).toBe('empty_output');
    }
  });
});

// LOGIC CHANGE 2026-09-11: Tests for validateOllamaOnStartup. The hard
// requirement is that it NEVER prevents boot - validateGeminiOnStartup at HEAD
// catches and logs without exiting, and this mirrors that exactly.

describe('validateOllamaOnStartup', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('skips the probe when nothing routes to ollama', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    global.fetch = jest.fn();

    const { validateOllamaOnStartup } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup({ agents: [{ id: 'a', llm_provider: 'claude' }] })).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Ollama startup check skipped'));
    consoleSpy.mockRestore();
  });

  test('probes when an agent is configured for ollama', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [{ name: 'test-model:8b' }] }),
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const { validateOllamaOnStartup } = require('../lib/llm-runner');
    await validateOllamaOnStartup({ agents: [{ id: 'local', llm_provider: 'ollama' }] });

    expect(global.fetch).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.any(Object));
    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test('logs PASSED when the server answers and the model is pulled', async () => {
    process.env.OLLAMA_MODEL = 'test-model:8b';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [{ name: 'test-model:8b' }] }),
    });
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const { validateOllamaOnStartup, isOllamaAvailable } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Ollama startup check PASSED'));
    expect(isOllamaAvailable()).toBe(true);
    consoleSpy.mockRestore();
  });

  test('warns without throwing when the configured model is not pulled', async () => {
    process.env.OLLAMA_MODEL = 'missing-model';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: [{ name: 'some-other-model:8b' }] }),
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateOllamaOnStartup } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('is not pulled'));
    errSpy.mockRestore();
  });

  test('does NOT throw when the server is unreachable - boot must continue', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(connErr);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateOllamaOnStartup, isOllamaAvailable } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('OLLAMA STARTUP CHECK FAILED'));
    expect(isOllamaAvailable()).toBe(false);
    errSpy.mockRestore();
  });

  test('does NOT throw on a non-2xx probe response', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve({}) });
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateOllamaOnStartup } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup()).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    errSpy.mockRestore();
  });

  test('does NOT throw when the probe times out', async () => {
    process.env.OLLAMA_MODEL = 'test-model';
    global.fetch = jest.fn((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        reject(abortErr);
      });
    }));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { validateOllamaOnStartup } = require('../lib/llm-runner');
    await expect(validateOllamaOnStartup({ timeout: 50 })).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('no response within 50ms'));
    errSpy.mockRestore();
  });
});

// LOGIC CHANGE 2026-03-27: Tests for Gemini adapter.
// Gemini adapter uses HTTP POST to Google's Generative Language API.
