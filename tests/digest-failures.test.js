'use strict';

/**
 * tests/digest-failures.test.js
 *
 * Regression tests for WORK-TODO #31: the morning digest told the owner that failed tasks
 * "will auto-retry" and were "Auto-requeued" when nothing does either, and classified a
 * rate limit with its own permissive patterns rather than lib/llm-runner.js's.
 */

const { categorizeFailures, formatFailureSections } = require('../lib/digest-failures');
const { isRateLimitError } = require('../lib/llm-runner');

const task = (description, error, outcome) => ({ description, error, outcome });

describe('categorizeFailures uses llm-runner\'s rate-limit predicate', () => {
    test('a real rate-limit error is a rate limit', () => {
        const c = categorizeFailures([task('a', 'Claude API: rate limit exceeded (429)')]);
        expect(c.rateLimit).toHaveLength(1);
    });

    test('an error that merely MENTIONS a rate limit is not filed as one (failed before the fix)', () => {
        const err = 'git clone failed; note: the readme discusses rate limit handling and bandwidth';
        expect(isRateLimitError(err)).toBe(false);
        const c = categorizeFailures([task('b', err)]);
        expect(c.rateLimit).toHaveLength(0);
        expect(c.infrastructure).toHaveLength(1);
    });

    test('max turns and code failures are grouped as before', () => {
        const c = categorizeFailures([task('c', 'hit max turns'), task('d', 'TypeError: x is undefined')]);
        expect(c.maxTurns).toHaveLength(1);
        expect(c.codeFailures).toHaveLength(1);
    });
});

describe('formatFailureSections says what is true', () => {
    const all = categorizeFailures([
        task('rl', 'rate limit reached'),
        task('tmp', 'mkdir EACCES'),
        task('mt', 'max turns', { partial: true, retried: true }),
        task('code', 'SyntaxError'),
    ]);

    test('no line promises an automatic retry or re-queue that does not happen', () => {
        const text = formatFailureSections(all).lines.join('\n');
        expect(text).not.toMatch(/will auto-retry|auto-requeued|no action needed/i);
        expect(text).toMatch(/Nothing retries them/);
        expect(text).toMatch(/Nothing re-queues them/);
    });

    test('every failed task counts as action needed', () => {
        expect(formatFailureSections(all).actionNeededCount).toBe(4);
    });

    test('the max-turns retry is reported only where the recorded outcome says it ran', () => {
        const retried = formatFailureSections(categorizeFailures([task('m', 'max turns', { partial: true, retried: true })]));
        const notRetried = formatFailureSections(categorizeFailures([task('m', 'max turns', { partial: true })]));
        expect(retried.lines.join('\n')).toMatch(/1 of them after the automatic retry/);
        expect(notRetried.lines.join('\n')).not.toMatch(/automatic retry/);
    });

    test('each group lists its tasks so they can be re-submitted', () => {
        const text = formatFailureSections(all).lines.join('\n');
        for (const d of ['rl', 'tmp', 'mt', 'code']) expect(text).toContain(`  - ${d} - `);
    });

    test('no failures, no lines', () => {
        expect(formatFailureSections(categorizeFailures([]))).toEqual({ lines: [], actionNeededCount: 0 });
    });
});
