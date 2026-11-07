/**
 * tests/llm-errors.test.js
 *
 * Unit tests for lib/llm-errors.js (rate-limit and bandwidth detection, the error classes, exit diagnostics).
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

describe('describeClaudeExit / signalFromExitCode', () => {
  test('signalFromExitCode decodes 128+N and rejects ordinary codes', () => {
    const { signalFromExitCode } = require('../lib/llm-runner');
    expect(signalFromExitCode(143)).toBe('SIGTERM');
    expect(signalFromExitCode(137)).toBe('SIGKILL');
    expect(signalFromExitCode(130)).toBe('SIGINT');
    expect(signalFromExitCode(1)).toBeNull();
    expect(signalFromExitCode(0)).toBeNull();
    expect(signalFromExitCode(null)).toBeNull();
  });

  test('describeClaudeExit keeps the "Exit code N" prefix callers match on', () => {
    const { describeClaudeExit } = require('../lib/llm-runner');
    expect(describeClaudeExit(1, null, 'boom')).toContain('Exit code 1');
    expect(describeClaudeExit(1, null, 'boom')).toContain('boom');
  });

  test('describeClaudeExit reports a direct signal kill when code is null', () => {
    const { describeClaudeExit } = require('../lib/llm-runner');
    const msg = describeClaudeExit(null, 'SIGTERM', '');
    expect(msg).toContain('SIGTERM');
    expect(msg).toContain('(no stderr output)');
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
