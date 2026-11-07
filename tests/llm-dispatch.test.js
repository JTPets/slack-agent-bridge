/**
 * tests/llm-dispatch.test.js
 *
 * Unit tests for lib/llm-dispatch.js (runLLM: one provider, one call, one recorded verdict).
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

describe('runLLM', () => {
  test('uses claude provider by default when LLM_PROVIDER not set', async () => {
    h.setupMockSpawn({ stdout: 'test output' });

    const { runLLM } = require('../lib/llm-runner');
    const result = await runLLM('test prompt', { cwd: '/tmp/test' });

    expect(h.mockSpawn).toHaveBeenCalled();
    expect(result.output).toBe('test output');
  });

  test('respects LLM_PROVIDER env var', async () => {
    process.env.LLM_PROVIDER = 'openai';

    const { runLLM } = require('../lib/llm-runner');

    await expect(runLLM('test prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
  });

  // LOGIC CHANGE 2026-09-11: Was an "Ollama adapter not yet implemented"
  // assertion. Ollama is implemented, so this now asserts the same thing the
  // test always meant: options.provider wins over the env var.
  test('options.provider overrides LLM_PROVIDER env var', async () => {
    process.env.LLM_PROVIDER = 'claude';
    process.env.OLLAMA_MODEL = 'test-model';
    h.mockOllamaResponse('ollama answer');

    const { runLLM } = require('../lib/llm-runner');
    const result = await runLLM('test prompt', { provider: 'ollama' });

    expect(result.provider).toBe('ollama');
    expect(result.output).toBe('ollama answer');
    expect(h.mockSpawn).not.toHaveBeenCalled();
  });

  test('throws error for unknown provider', async () => {
    const { runLLM } = require('../lib/llm-runner');

    await expect(runLLM('test prompt', { provider: 'unknown' })).rejects.toThrow(
      'Unknown LLM provider: unknown. Supported providers: claude, openai, ollama, gemini'
    );
  });

  test('handles provider name case-insensitively', async () => {
    h.setupMockSpawn({ stdout: 'output' });

    const { runLLM } = require('../lib/llm-runner');
    const result = await runLLM('test', { provider: 'CLAUDE' });

    expect(result.output).toBe('output');
  });

  // LOGIC CHANGE 2026-04-01: Tests for LLM engine visibility in task notifications.
  // runLLM should return the provider name in the result so callers can surface it.
  test('returns provider name in result for claude', async () => {
    h.setupMockSpawn({ stdout: 'output' });

    const { runLLM } = require('../lib/llm-runner');
    const result = await runLLM('test', { provider: 'claude' });

    expect(result.provider).toBe('claude');
  });

  test('returns normalized provider name (lowercase)', async () => {
    h.setupMockSpawn({ stdout: 'output' });

    const { runLLM } = require('../lib/llm-runner');
    const result = await runLLM('test', { provider: 'CLAUDE' });

    expect(result.provider).toBe('claude');
  });

  test('returns default provider when not specified', async () => {
    h.setupMockSpawn({ stdout: 'output' });
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

describe('verdict recording', () => {
  test('a successful call with no fallback records fallback_reason null', async () => {
    h.setupMockSpawn({ stdout: 'ok' });

    const { runLLM } = require('../lib/llm-runner');
    await runLLM('p', { provider: 'claude', agentId: 'bridge' });

    const { getStats } = require('../lib/llm-metrics');
    const stats = getStats({ agentId: 'bridge', days: 1 });
    expect(stats.calls).toBe(1);
    expect(stats.fallbacks).toBe(0);
    expect(stats.fallbackRate).toBe(0);
    expect(stats.used.claude).toBe(1);
  });

  test('runWithFallback records exactly one verdict per logical call', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.OLLAMA_MODEL = 'local-model';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn((url) => {
      if (String(url).includes('/api/chat')) return Promise.reject(connErr);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: 'g' }] } }] }),
      });
    });

    const { runWithFallback } = require('../lib/llm-runner');
    await runWithFallback('p', { provider: 'ollama', agentId: 'solo' });

    const { getStats } = require('../lib/llm-metrics');
    const stats = getStats({ agentId: 'solo', days: 1 });
    // Two provider attempts, ONE verdict.
    expect(stats.calls).toBe(1);

    delete process.env.GEMINI_API_KEY;
    delete process.env.OLLAMA_MODEL;
  });

  test('a failed call records ok=false and the reason', async () => {
    process.env.OLLAMA_MODEL = 'local-model';
    const connErr = new TypeError('fetch failed');
    connErr.cause = { code: 'ECONNREFUSED' };
    global.fetch = jest.fn().mockRejectedValue(connErr);

    const { runLLM } = require('../lib/llm-runner');
    await expect(runLLM('p', { provider: 'ollama', agentId: 'doomed' })).rejects.toThrow();

    const { getStats } = require('../lib/llm-metrics');
    const stats = getStats({ agentId: 'doomed', days: 1 });
    expect(stats.calls).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.reasons.connection_refused).toBe(1);

    delete process.env.OLLAMA_MODEL;
  });
});
