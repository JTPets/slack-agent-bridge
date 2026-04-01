/**
 * tests/llm-runner.test.js
 *
 * Unit tests for lib/llm-runner.js
 */

const EventEmitter = require('events');

describe('llm-runner module', () => {
  const originalEnv = process.env;
  let mockSpawn;
  let childProcess;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear LLM_PROVIDER to ensure default behavior
    delete process.env.LLM_PROVIDER;

    // Create fresh mock for each test
    mockSpawn = jest.fn();
    jest.doMock('child_process', () => ({
      spawn: mockSpawn,
    }));
  });

  afterEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /**
   * Helper to setup spawn mock that auto-resolves
   */
  function setupMockSpawn({ exitCode = 0, stdout = '', stderr = '' } = {}) {
    mockSpawn.mockImplementation(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      setImmediate(() => {
        if (stdout) mockChild.stdout.emit('data', stdout);
        if (stderr) mockChild.stderr.emit('data', stderr);
        mockChild.emit('close', exitCode);
      });

      return mockChild;
    });
  }

  /**
   * Helper to setup spawn mock that emits error
   */
  function setupMockSpawnError(errorMessage) {
    mockSpawn.mockImplementation(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      setImmediate(() => {
        mockChild.emit('error', new Error(errorMessage));
      });

      return mockChild;
    });
  }

  describe('runLLM', () => {
    test('uses claude provider by default when LLM_PROVIDER not set', async () => {
      setupMockSpawn({ stdout: 'test output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test prompt', { cwd: '/tmp/test' });

      expect(mockSpawn).toHaveBeenCalled();
      expect(result.output).toBe('test output');
    });

    test('respects LLM_PROVIDER env var', async () => {
      process.env.LLM_PROVIDER = 'openai';

      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
    });

    test('options.provider overrides LLM_PROVIDER env var', async () => {
      process.env.LLM_PROVIDER = 'claude';

      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt', { provider: 'ollama' })).rejects.toThrow('Ollama adapter not yet implemented');
    });

    test('throws error for unknown provider', async () => {
      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt', { provider: 'unknown' })).rejects.toThrow(
        'Unknown LLM provider: unknown. Supported providers: claude, openai, ollama, gemini'
      );
    });

    test('handles provider name case-insensitively', async () => {
      setupMockSpawn({ stdout: 'output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test', { provider: 'CLAUDE' });

      expect(result.output).toBe('output');
    });

    // LOGIC CHANGE 2026-04-01: Tests for LLM engine visibility in task notifications.
    // runLLM should return the provider name in the result so callers can surface it.
    test('returns provider name in result for claude', async () => {
      setupMockSpawn({ stdout: 'output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test', { provider: 'claude' });

      expect(result.provider).toBe('claude');
    });

    test('returns normalized provider name (lowercase)', async () => {
      setupMockSpawn({ stdout: 'output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test', { provider: 'CLAUDE' });

      expect(result.provider).toBe('claude');
    });

    test('returns default provider when not specified', async () => {
      setupMockSpawn({ stdout: 'output' });
      delete process.env.LLM_PROVIDER;

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test');

      expect(result.provider).toBe('claude');
    });

    test('returns provider from LLM_PROVIDER env var', async () => {
      process.env.GEMINI_API_KEY = 'test-key';
      process.env.LLM_PROVIDER = 'gemini';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'response' }] } }],
        }),
      });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test');

      expect(result.provider).toBe('gemini');

      delete process.env.GEMINI_API_KEY;
      delete process.env.LLM_PROVIDER;
    });
  });

  describe('runClaudeAdapter', () => {
    test('spawns claude with correct args', async () => {
      setupMockSpawn({ stdout: 'success' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      await runClaudeAdapter('my prompt', {
        cwd: '/test/dir',
        maxTurns: 20,
        timeout: 120000,
        claudeBin: '/custom/claude',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/claude',
        ['-p', 'my prompt', '--output-format', 'text', '--max-turns', '20', '--dangerously-skip-permissions'],
        expect.objectContaining({
          cwd: '/test/dir',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    test('uses default values when options not provided', async () => {
      setupMockSpawn({ stdout: 'output' });

      // Ensure defaults are used
      delete process.env.CLAUDE_BIN;
      delete process.env.MAX_TURNS;
      delete process.env.TASK_TIMEOUT_MS;

      const { runClaudeAdapter, DEFAULT_MAX_TURNS } = require('../lib/llm-runner');
      await runClaudeAdapter('prompt');

      // Should use default max turns (50)
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--max-turns', '50']),
        expect.any(Object)
      );
    });

    test('detects max turns reached in output', async () => {
      setupMockSpawn({ stdout: 'Partial output\nReached max turns\nMore text' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.hitMaxTurns).toBe(true);
      expect(result.output).toContain('Reached max turns');
    });

    test('hitMaxTurns is false when not in output', async () => {
      setupMockSpawn({ stdout: 'Normal completion output' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.hitMaxTurns).toBe(false);
    });

    test('rejects on non-zero exit code', async () => {
      setupMockSpawn({ exitCode: 1, stderr: 'Error occurred' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Exit code 1');
    });

    test('includes stderr in error message on failure', async () => {
      setupMockSpawn({ exitCode: 2, stderr: 'Some error details' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Some error details');
    });

    test('rejects on spawn error', async () => {
      setupMockSpawnError('ENOENT');

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Spawn failed: ENOENT');
    });

    test('trims output', async () => {
      setupMockSpawn({ stdout: '  trimmed output  \n' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.output).toBe('trimmed output');
    });

    test('accumulates multiple stdout chunks', async () => {
      mockSpawn.mockImplementation(() => {
        const mockChild = new EventEmitter();
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();

        setImmediate(() => {
          mockChild.stdout.emit('data', 'chunk1 ');
          mockChild.stdout.emit('data', 'chunk2 ');
          mockChild.stdout.emit('data', 'chunk3');
          mockChild.emit('close', 0);
        });

        return mockChild;
      });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.output).toBe('chunk1 chunk2 chunk3');
    });
  });

  describe('runOpenAIAdapter', () => {
    test('throws not implemented error', async () => {
      const { runOpenAIAdapter } = require('../lib/llm-runner');

      await expect(runOpenAIAdapter('prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
    });
  });

  describe('runOllamaAdapter', () => {
    test('throws not implemented error', async () => {
      const { runOllamaAdapter } = require('../lib/llm-runner');

      await expect(runOllamaAdapter('prompt')).rejects.toThrow('Ollama adapter not yet implemented');
    });
  });

  // LOGIC CHANGE 2026-03-27: Tests for Gemini adapter.
  // Gemini adapter uses HTTP POST to Google's Generative Language API.
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
      setupMockSpawn({ stdout: 'Claude response' });

      const { runWithFallback } = require('../lib/llm-runner');
      const result = await runWithFallback('test prompt', { cwd: '/tmp/test' });

      expect(result.output).toBe('Claude response');
      expect(result.usedFallback).toBeUndefined();
    });

    test('falls back to Gemini when Claude hits rate limit', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

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
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

      await expect(runWithFallback('test prompt')).rejects.toThrow(RateLimitError);
    });

    test('does not fallback when enableFallback option is false', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

      await expect(runWithFallback('test prompt', { enableFallback: false })).rejects.toThrow(RateLimitError);
    });

    test('throws RateLimitError when GEMINI_API_KEY not set and fallback needed', async () => {
      delete process.env.GEMINI_API_KEY;

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback, RateLimitError } = require('../lib/llm-runner');

      await expect(runWithFallback('test prompt')).rejects.toThrow(RateLimitError);
    });

    test('throws original error when primary fails with non-rate-limit error', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      // Setup Claude to fail with non-rate-limit error
      setupMockSpawn({ stderr: 'Some other error', exitCode: 1 });

      const { runWithFallback } = require('../lib/llm-runner');

      await expect(runWithFallback('test prompt')).rejects.toThrow('Exit code 1');
    });

    test('throws combined error when both primary and fallback fail', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

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
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback } = require('../lib/llm-runner');
      const result = await runWithFallback('test prompt');

      expect(result.fallbackProvider).toBe('gemini');
    });

    test('respects fallbackProvider option over env var', async () => {
      process.env.GEMINI_API_KEY = 'test-key';
      process.env.LLM_FALLBACK_PROVIDER = 'ollama';

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback } = require('../lib/llm-runner');
      const result = await runWithFallback('test prompt', { fallbackProvider: 'gemini' });

      expect(result.fallbackProvider).toBe('gemini');
    });

    test('passes options to fallback provider', async () => {
      process.env.GEMINI_API_KEY = 'test-key';

      // Setup Claude to fail with rate limit
      setupMockSpawn({ stderr: 'rate limit exceeded', exitCode: 1 });

      const { runWithFallback } = require('../lib/llm-runner');
      await runWithFallback('test prompt', { maxOutputTokens: 4096, temperature: 0.5 });

      // Verify Gemini was called with the options
      const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(callBody.generationConfig.maxOutputTokens).toBe(4096);
      expect(callBody.generationConfig.temperature).toBe(0.5);
    });
  });

  describe('exported constants', () => {
    test('exports DEFAULT_PROVIDER as claude', () => {
      const { DEFAULT_PROVIDER } = require('../lib/llm-runner');
      expect(DEFAULT_PROVIDER).toBe('claude');
    });

    test('exports DEFAULT_MAX_TURNS as 50', () => {
      delete process.env.MAX_TURNS;
      const { DEFAULT_MAX_TURNS } = require('../lib/llm-runner');
      expect(DEFAULT_MAX_TURNS).toBe(50);
    });

    test('exports DEFAULT_TIMEOUT as 600000', () => {
      delete process.env.TASK_TIMEOUT_MS;
      const { DEFAULT_TIMEOUT } = require('../lib/llm-runner');
      expect(DEFAULT_TIMEOUT).toBe(600000);
    });

    // LOGIC CHANGE 2026-04-01: Tests for fallback configuration exports
    test('exports DEFAULT_FALLBACK_PROVIDER as gemini', () => {
      const { DEFAULT_FALLBACK_PROVIDER } = require('../lib/llm-runner');
      expect(DEFAULT_FALLBACK_PROVIDER).toBe('gemini');
    });

    test('exports FALLBACK_ENABLED as true by default', () => {
      delete process.env.LLM_FALLBACK_ENABLED;
      jest.resetModules();
      const { FALLBACK_ENABLED } = require('../lib/llm-runner');
      expect(FALLBACK_ENABLED).toBe(true);
    });

    test('FALLBACK_ENABLED is false when env var set to false', () => {
      process.env.LLM_FALLBACK_ENABLED = 'false';
      jest.resetModules();
      const { FALLBACK_ENABLED } = require('../lib/llm-runner');
      expect(FALLBACK_ENABLED).toBe(false);
    });
  });

  // LOGIC CHANGE 2026-04-01: isRateLimitError re-enabled for fallback purposes.
  // Detection now used to trigger Claude → Gemini fallback, NOT to pause the bot.
  describe('isRateLimitError (RE-ENABLED for fallback)', () => {
    test('returns true for rate limit error patterns', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('Error: rate limit exceeded')).toBe(true);
      expect(isRateLimitError('429 Too Many Requests')).toBe(true);
      expect(isRateLimitError('quota exceeded')).toBe(true);
      expect(isRateLimitError('rate_limit_error')).toBe(true);
      expect(isRateLimitError('Usage limit reached')).toBe(true);
      expect(isRateLimitError('HTTP 429')).toBe(true);
    });

    test('returns false for null or empty text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError('')).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
    });

    test('returns false for normal text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('Task completed successfully')).toBe(false);
      expect(isRateLimitError('Normal error message')).toBe(false);
    });
  });

  describe('RateLimitError', () => {
    test('has isRateLimit property set to true', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('Rate limit hit');
      expect(error.isRateLimit).toBe(true);
    });

    test('has name set to RateLimitError', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('test');
      expect(error.name).toBe('RateLimitError');
    });

    test('is an instance of Error', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('test');
      expect(error instanceof Error).toBe(true);
    });

    test('preserves error message', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('custom message');
      expect(error.message).toBe('custom message');
    });
  });

  // LOGIC CHANGE 2026-04-01: Rate limit detection RE-ENABLED for fallback.
  // Tests updated to verify RateLimitError IS thrown for rate limit text in stderr.
  describe('runClaudeAdapter rate limit detection (RE-ENABLED for fallback)', () => {
    test('rate limit text in stdout with exit code 0 resolves normally', async () => {
      setupMockSpawn({ stdout: 'Error: rate limit exceeded', exitCode: 0 });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      // Should resolve normally - only check stderr on non-zero exit
      const result = await runClaudeAdapter('prompt');
      expect(result.output).toContain('rate limit exceeded');
    });

    test('exit code 1 with rate limit text in stderr throws RateLimitError', async () => {
      setupMockSpawn({ stderr: 'Too many requests', exitCode: 1 });

      const { runClaudeAdapter, RateLimitError } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(RateLimitError);
        expect(err.isRateLimit).toBe(true);
        expect(err.message).toContain('Claude rate limit detected');
      }
    });

    test('exit code 1 with non-rate-limit stderr throws regular Error', async () => {
      setupMockSpawn({ stderr: 'Some other error', exitCode: 1 });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err.isRateLimit).toBeUndefined();
        expect(err.message).toContain('Exit code 1');
      }
    });

    test('exit code null resolves with interrupted flag instead of error', async () => {
      setupMockSpawn({ exitCode: null, stdout: 'partial', stderr: '' });

      // Need to override setupMockSpawn to emit null exit code
      mockSpawn.mockImplementation(() => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stdout.emit('data', 'partial output');
          child.emit('close', null);
        });
        return child;
      });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');
      expect(result.interrupted).toBe(true);
      expect(result.output).toBe('partial output');
    });
  });

  // LOGIC CHANGE 2026-03-27: isBandwidthExhausted DISABLED (always returns false).
  // Tests updated accordingly.
  describe('isBandwidthExhausted (DISABLED)', () => {
    test('always returns false - bandwidth detection disabled to fix false positives', () => {
      const { isBandwidthExhausted } = require('../lib/llm-runner');
      expect(isBandwidthExhausted(1, '', 'usage limit reached')).toBe(false);
      expect(isBandwidthExhausted(1, '', 'rate limit exceeded')).toBe(false);
      expect(isBandwidthExhausted(1, '', 'bandwidth quota exceeded')).toBe(false);
      expect(isBandwidthExhausted(1, 'Error', 'quota exceeded')).toBe(false);
      expect(isBandwidthExhausted(0, '', 'usage limit reached')).toBe(false);
    });
  });

  describe('BandwidthExhaustedError', () => {
    test('has isBandwidthExhausted property set to true', () => {
      const { BandwidthExhaustedError } = require('../lib/llm-runner');
      const error = new BandwidthExhaustedError('Bandwidth exhausted');
      expect(error.isBandwidthExhausted).toBe(true);
    });

    test('has isRateLimit property set to true for backward compatibility', () => {
      const { BandwidthExhaustedError } = require('../lib/llm-runner');
      const error = new BandwidthExhaustedError('Bandwidth exhausted');
      expect(error.isRateLimit).toBe(true);
    });

    test('has name set to BandwidthExhaustedError', () => {
      const { BandwidthExhaustedError } = require('../lib/llm-runner');
      const error = new BandwidthExhaustedError('test');
      expect(error.name).toBe('BandwidthExhaustedError');
    });

    test('is an instance of Error', () => {
      const { BandwidthExhaustedError } = require('../lib/llm-runner');
      const error = new BandwidthExhaustedError('test');
      expect(error instanceof Error).toBe(true);
    });

    test('preserves error message', () => {
      const { BandwidthExhaustedError } = require('../lib/llm-runner');
      const error = new BandwidthExhaustedError('custom message');
      expect(error.message).toBe('custom message');
    });
  });

  // LOGIC CHANGE 2026-03-27: Bandwidth detection DISABLED in runClaudeAdapter.
  // Tests updated to verify no BandwidthExhaustedError is thrown.
  describe('runClaudeAdapter bandwidth exhaustion detection (DISABLED)', () => {
    test('exit code 1 + bandwidth keyword in stderr throws regular Error, not BandwidthExhaustedError', async () => {
      setupMockSpawn({ exitCode: 1, stdout: '', stderr: 'Error: usage limit exceeded' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err.isBandwidthExhausted).toBeUndefined();
        expect(err.message).toContain('Exit code 1');
      }
    });

    test('exit code 1 with any stderr throws regular Error', async () => {
      setupMockSpawn({ exitCode: 1, stdout: '', stderr: 'command not found' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err.isBandwidthExhausted).toBeUndefined();
        expect(err.message).toContain('Exit code 1');
      }
    });

    test('rate limit text in stdout with exit code 0 resolves normally (detection disabled)', async () => {
      setupMockSpawn({ exitCode: 0, stdout: 'rate limit exceeded', stderr: '' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');
      expect(result.output).toContain('rate limit exceeded');
    });
  });
});
