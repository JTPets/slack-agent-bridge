'use strict';

/**
 * tests/llm-http-failure.test.js
 *
 * WORK-TODO #79. On 2026-11-07 the bridge's boot log reported the Gemini startup check as
 * "Gemini rate limit: ..." for an HTTP 402 whose body said "Your prepayment credits are
 * depleted" with status RESOURCE_EXHAUSTED. The adapter tested the body for
 * RESOURCE_EXHAUSTED / "quota" before it looked at the status, so a billing failure was
 * labelled as something that clears by waiting. The class, not the one site:
 *
 *   - 402 / billing body under any status    -> was rate_limit           -> now billing
 *   - Gemini 5xx / other non-2xx             -> was UNTAGGED (no fallback,
 *                                               although CLAUDE.md lists
 *                                               "Non-2xx -> http_error")  -> now http_error
 *   - Gemini 401/403/invalid key             -> was untagged             -> now auth
 *   - Gemini network failure                 -> was untagged             -> now connection_refused
 *   - Gemini no candidates / empty text      -> was untagged             -> malformed_output / empty_output
 *   - Ollama 402/401/403                     -> was http_error           -> billing / auth
 *   - Claude CLI "Credit balance is too low" -> was untagged             -> billing
 *   - the morning digest's failure groups    -> billing had no group     -> its own group
 *
 * The 402 body below is a SYNTHETIC reconstruction of the 2026-11-07 boot-log text (the
 * message, the status and the code it quoted); no real response is stored in the repo.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    classifyHttpFailure, describeHttpFailure, isBillingError, BillingError, RateLimitError,
    fallbackReasonFor, isRateLimitError,
} = require('../lib/llm-errors');
const { runGeminiAdapter } = require('../lib/llm-adapter-gemini');
const { runOllamaAdapter } = require('../lib/llm-adapter-ollama');
const { runClaudeAdapter } = require('../lib/llm-adapter-claude');
const { categorizeFailures, formatFailureSections } = require('../lib/digest-failures');

const BOOT_LOG_402_BODY = JSON.stringify({
    error: {
        code: 402,
        message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.',
        status: 'RESOURCE_EXHAUSTED',
    },
});

const realFetch = global.fetch;
const savedKey = process.env.GEMINI_API_KEY;
const savedModel = process.env.OLLAMA_MODEL;

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    process.env.OLLAMA_MODEL = 'test-model';
});
afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = realFetch;
});
afterAll(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    if (savedModel === undefined) delete process.env.OLLAMA_MODEL; else process.env.OLLAMA_MODEL = savedModel;
});

const respond = (status, body) => jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
});
const rejection = (p) => p.then(() => { throw new Error('expected a rejection'); }, (e) => e);

describe('classifyHttpFailure', () => {
    test.each([
        [402, BOOT_LOG_402_BODY, 'billing'],
        [402, '', 'billing'],
        [400, 'Your prepayment credits are depleted', 'billing'],
        [429, 'Too Many Requests', 'rate_limit'],
        [400, '{"error":{"status":"RESOURCE_EXHAUSTED"}}', 'rate_limit'],
        [400, 'API quota exceeded for today', 'rate_limit'],
        [401, 'unauthorised', 'auth'],
        [403, 'forbidden', 'auth'],
        [400, '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}', 'auth'],
        [500, 'Internal server error', 'http_error'],
        [503, '', 'http_error'],
        [404, 'model not found', 'http_error'],
    ])('HTTP %i %j -> %s', (status, body, expected) => {
        expect(classifyHttpFailure(status, body)).toBe(expected);
    });

    test('billing wins over RESOURCE_EXHAUSTED: the order is the fix', () => {
        expect(BOOT_LOG_402_BODY).toContain('RESOURCE_EXHAUSTED');
        expect(classifyHttpFailure(402, BOOT_LOG_402_BODY)).toBe('billing');
    });

    test('negative control: the pre-#79 test labels the boot-log 402 a rate limit', () => {
        // The condition lib/llm-adapter-gemini.js used before 2026-11-07, verbatim.
        const preFix = (status, errorText) =>
            status === 429 || errorText.includes('RESOURCE_EXHAUSTED') || errorText.includes('quota');
        expect(preFix(402, BOOT_LOG_402_BODY)).toBe(true);
    });
});

describe('isBillingError', () => {
    test('matches the Gemini and Anthropic credit messages', () => {
        expect(isBillingError('Your prepayment credits are depleted')).toBe(true);
        expect(isBillingError('Credit balance is too low')).toBe(true);
        expect(isBillingError('402 Payment Required')).toBe(true);
    });
    test('does not match a rate limit or ordinary output', () => {
        expect(isBillingError('rate limit exceeded')).toBe(false);
        expect(isBillingError('Too many requests')).toBe(false);
        expect(isBillingError('Added a credit card field to the checkout form')).toBe(false);
        expect(isBillingError('')).toBe(false);
        expect(isBillingError(undefined)).toBe(false);
    });
    test('and a billing message is not a rate limit by the rate-limit predicate either', () => {
        expect(isRateLimitError('Your prepayment credits are depleted')).toBe(false);
    });
});

describe('describeHttpFailure names the fix', () => {
    test('billing says it is not a rate limit and how to fix it', () => {
        const msg = describeHttpFailure('Gemini', 'billing', 402, BOOT_LOG_402_BODY);
        expect(msg).toMatch(/^Gemini billing failure \(HTTP 402\)/);
        expect(msg).toContain('NOT a rate limit');
        expect(msg).toContain('top up');
        expect(msg).not.toMatch(/rate limit:/);
    });
    test('the rate-limit wording is unchanged, because callers match on it', () => {
        expect(describeHttpFailure('Gemini', 'rate_limit', 429, 'slow down')).toBe('Gemini rate limit: slow down');
    });
    test('auth names the key variable', () => {
        expect(describeHttpFailure('Gemini', 'auth', 401, 'x', { keyVar: 'GEMINI_API_KEY' })).toContain('GEMINI_API_KEY');
    });
});

describe('the Gemini adapter, at the HTTP boundary', () => {
    test('THE REGRESSION: the 2026-11-07 boot-log 402 is a billing failure, not a rate limit', async () => {
        global.fetch = respond(402, BOOT_LOG_402_BODY);
        const err = await rejection(runGeminiAdapter('prompt'));
        expect(err).toBeInstanceOf(BillingError);
        expect(err).not.toBeInstanceOf(RateLimitError);
        expect(err.isRateLimit).toBeFalsy();
        expect(err.fallbackReason).toBe('billing');
        expect(fallbackReasonFor(err)).toBe('billing');
        expect(err.httpStatus).toBe(402);
        expect(err.message).toContain('prepayment credits are depleted');
        expect(err.message).not.toContain('Gemini rate limit');
    });

    test('a 429 is still a RateLimitError tagged rate_limit', async () => {
        global.fetch = respond(429, 'Rate limit exceeded');
        const err = await rejection(runGeminiAdapter('prompt'));
        expect(err).toBeInstanceOf(RateLimitError);
        expect(err.fallbackReason).toBe('rate_limit');
        expect(err.message).toMatch(/^Gemini rate limit:/);
    });

    test('a 500 is tagged http_error, so it is a fallback trigger (it was untagged)', async () => {
        global.fetch = respond(500, 'Internal server error');
        const err = await rejection(runGeminiAdapter('prompt'));
        expect(err.message).toContain('Gemini API error (500)');
        expect(err.fallbackReason).toBe('http_error');
    });

    test('an invalid key is tagged auth and names GEMINI_API_KEY', async () => {
        global.fetch = respond(400, '{"error":{"status":"INVALID_ARGUMENT","message":"API key not valid."}}');
        const err = await rejection(runGeminiAdapter('prompt'));
        expect(err.fallbackReason).toBe('auth');
        expect(err.message).toContain('GEMINI_API_KEY');
    });

    test('a network failure is tagged connection_refused', async () => {
        global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
        const err = await rejection(runGeminiAdapter('prompt'));
        expect(err.message).toContain('Gemini network error');
        expect(err.fallbackReason).toBe('connection_refused');
    });

    test('no candidates is malformed_output; empty text is empty_output', async () => {
        global.fetch = respond(200, JSON.stringify({ candidates: [] }));
        expect((await rejection(runGeminiAdapter('p'))).fallbackReason).toBe('malformed_output');
        global.fetch = respond(200, JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: {} }] }));
        expect((await rejection(runGeminiAdapter('p'))).fallbackReason).toBe('empty_output');
    });

    test('the startup check prints the billing hint, not "check the key"', async () => {
        global.fetch = respond(402, BOOT_LOG_402_BODY);
        const { validateGeminiOnStartup } = require('../lib/llm-adapter-gemini');
        await validateGeminiOnStartup();
        const printed = console.error.mock.calls.map((c) => c.join(' ')).join('\n');
        expect(printed).toContain('billing failure');
        expect(printed).toContain('NOT a rate limit');
        expect(printed).not.toContain('GEMINI_API_KEY is valid');
    });
});

describe('the Ollama adapter uses the same classifier', () => {
    test('402 -> billing, 403 -> auth, 429 -> rate_limit, 500 -> http_error', async () => {
        const cases = [[402, 'billing'], [403, 'auth'], [429, 'rate_limit'], [500, 'http_error']];
        for (const [status, expected] of cases) {
            global.fetch = respond(status, 'x');
            const err = await rejection(runOllamaAdapter('p', {}));
            expect([status, err.fallbackReason]).toEqual([status, expected]);
        }
    });
    test('the 500 wording is unchanged', async () => {
        global.fetch = respond(500, 'boom');
        expect((await rejection(runOllamaAdapter('p', {}))).message).toBe('Ollama API error (500): boom');
    });
});

describe('the Claude adapter (real spawn, stub binary)', () => {
    let dir;
    const stub = (name, text) => {
        const file = path.join(dir, name);
        fs.writeFileSync(file,
            `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(${JSON.stringify(text + '\n')}); process.exit(1); });\n`,
            { mode: 0o755 });
        return file;
    };
    beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-billing-')); });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('"Credit balance is too low" on stdout is a billing failure, tagged billing', async () => {
        const bin = stub('credit-low', 'Credit balance is too low');
        const err = await rejection(runClaudeAdapter('prompt', { claudeBin: bin, cwd: dir }));
        expect(err).toBeInstanceOf(BillingError);
        expect(err.fallbackReason).toBe('billing');
        expect(err.message).toContain('NOT a rate limit');
    }, 15000);

    test('negative control: a usage-limit message is still a rate limit', async () => {
        const bin = stub('usage-limit', 'Claude usage limit reached');
        const err = await rejection(runClaudeAdapter('prompt', { claudeBin: bin, cwd: dir }));
        expect(err).toBeInstanceOf(RateLimitError);
    }, 15000);
});

describe('the morning digest gives billing its own group', () => {
    const task = (description, error) => ({ description, error });
    test('a billing failure is not filed under "Rate limited"', () => {
        const c = categorizeFailures([
            task('a', 'Gemini billing failure (HTTP 402): ... prepayment credits are depleted'),
            task('b', 'Claude API: rate limit exceeded (429)'),
        ]);
        expect(c.billing.map((t) => t.description)).toEqual(['a']);
        expect(c.rateLimit.map((t) => t.description)).toEqual(['b']);
        const text = formatFailureSections(c).lines.join('\n');
        expect(text).toContain('*Billing / credits exhausted:* 1 task');
        expect(text).toContain('Waiting will not fix it');
        expect(formatFailureSections(c).actionNeededCount).toBe(2);
    });
});
