/**
 * tests/llm-defaults.test.js
 *
 * Unit tests for lib/llm-defaults.js (the configuration constants the facade exports).
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
