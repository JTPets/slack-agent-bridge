'use strict';

/**
 * tests/storefront-guards.test.js — bots/storefront-guards.js on its own (WORK-TODO #87),
 * plus THE enumerating guard for log forging in the storefront: every `${...}` inside a
 * console call in bots/storefront*.js must be logSafe(...) or a value the server made.
 * The route-level proofs are tests/storefront-hardening.test.js.
 */

const fs = require('fs');
const path = require('path');
const {
    rateLimitConfig,
    createRateLimiter,
    rateLimitMiddleware,
    buildCorsOptions,
    acceptSessionId,
    DEFAULT_WINDOW_MS,
    DEFAULT_PER_CLIENT,
    DEFAULT_GLOBAL,
} = require('../bots/storefront-guards');

function clock(start = 1000) {
    let t = start;
    const now = () => t;
    now.advance = (ms) => { t += ms; };
    return now;
}

describe('createRateLimiter', () => {
    test('a client gets perClient calls per window, then a refusal with the wait', () => {
        const now = clock();
        const l = createRateLimiter({ windowMs: 1000, perClient: 2, global: 100, now });
        expect(l.check('a').allowed).toBe(true);
        now.advance(100);
        expect(l.check('a').allowed).toBe(true);
        const refused = l.check('a');
        expect(refused).toEqual({ allowed: false, scope: 'client', retryAfterMs: 900 });
        expect(l.check('b').allowed).toBe(true);
    });

    test('the window slides: the oldest call ageing out frees one slot', () => {
        const now = clock();
        const l = createRateLimiter({ windowMs: 1000, perClient: 1, global: 100, now });
        expect(l.check('a').allowed).toBe(true);
        now.advance(999);
        expect(l.check('a').allowed).toBe(false);
        now.advance(1);
        expect(l.check('a').allowed).toBe(true);
    });

    test('a refused call is not counted, so hammering does not keep the window shut', () => {
        const now = clock();
        const l = createRateLimiter({ windowMs: 1000, perClient: 1, global: 100, now });
        l.check('a');
        for (let i = 0; i < 50; i++) { now.advance(10); l.check('a'); }
        now.advance(500);
        expect(l.check('a').allowed).toBe(true);
    });

    test('the global limit holds across many clients', () => {
        const now = clock();
        const l = createRateLimiter({ windowMs: 1000, perClient: 5, global: 3, now });
        expect(['a', 'b', 'c'].map((k) => l.check(k).allowed)).toEqual([true, true, true]);
        expect(l.check('d')).toMatchObject({ allowed: false, scope: 'global' });
    });

    test('idle clients are forgotten, so the key map cannot grow without bound', () => {
        const now = clock();
        const l = createRateLimiter({ windowMs: 1000, perClient: 5, global: 1000, now });
        for (let i = 0; i < 100; i++) l.check(`ip-${i}`);
        expect(l.trackedClients()).toBe(100);
        now.advance(1000);
        l.check('late');
        expect(l.trackedClients()).toBe(1);
    });

    test('reset clears everything', () => {
        const l = createRateLimiter({ windowMs: 1000, perClient: 1, global: 1 });
        l.check('a');
        l.reset();
        expect(l.check('a').allowed).toBe(true);
    });
});

describe('rateLimitMiddleware', () => {
    function fakeRes() {
        const res = { headers: {}, statusCode: 200, body: null };
        res.set = (k, v) => { res.headers[k] = v; return res; };
        res.status = (c) => { res.statusCode = c; return res; };
        res.json = (b) => { res.body = b; return res; };
        return res;
    }

    test('passes, then answers 429 with Retry-After, and reports a global refusal once per window', () => {
        const now = clock();
        const limiter = createRateLimiter({ windowMs: 1000, perClient: 10, global: 1, now });
        const onGlobalLimit = jest.fn();
        const mw = rateLimitMiddleware(limiter, { windowMs: 1000, onGlobalLimit, now });
        const next = jest.fn();
        mw({ ip: '1.1.1.1', path: '/api/chat' }, fakeRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
        const res = fakeRes();
        mw({ ip: '2.2.2.2', path: '/api/chat' }, res, next);
        mw({ ip: '3.3.3.3', path: '/api/chat' }, fakeRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(429);
        expect(res.body.code).toBe('RATE_LIMITED');
        expect(res.headers['Retry-After']).toBe('1');
        expect(onGlobalLimit).toHaveBeenCalledTimes(1);
        expect(onGlobalLimit).toHaveBeenCalledWith('/api/chat');
    });

    test('a per-client refusal is not reported, and a throwing reporter never fails the request', () => {
        const limiter = createRateLimiter({ windowMs: 1000, perClient: 1, global: 1 });
        const mw = rateLimitMiddleware(limiter, { windowMs: 1000, onGlobalLimit: () => { throw new Error('x'); } });
        mw({ ip: 'a' }, fakeRes(), () => {});
        const res = fakeRes();
        expect(() => mw({ ip: 'b' }, res, () => {})).not.toThrow();
        expect(res.statusCode).toBe(429);
    });
});

describe('rateLimitConfig', () => {
    test('defaults, overrides, and a bad value falls back', () => {
        expect(rateLimitConfig({})).toEqual({
            windowMs: DEFAULT_WINDOW_MS, perClient: DEFAULT_PER_CLIENT, global: DEFAULT_GLOBAL,
        });
        expect(rateLimitConfig({
            STOREFRONT_RATE_WINDOW_MS: '5000', STOREFRONT_RATE_PER_CLIENT: '3', STOREFRONT_RATE_GLOBAL: 'lots',
        })).toEqual({ windowMs: 5000, perClient: 3, global: DEFAULT_GLOBAL });
        expect(rateLimitConfig({ STOREFRONT_RATE_PER_CLIENT: '0' }).perClient).toBe(DEFAULT_PER_CLIENT);
    });
});

describe('buildCorsOptions', () => {
    const decide = (options, origin) => new Promise((resolve) => {
        options.origin(origin, (err, ok) => resolve(err ? 'refused' : ok));
    });

    test('exact match only, credentials off, `*` dropped and reported', async () => {
        const { options, ignored } = buildCorsOptions(['*', ' https://jtpets.ca ', '']);
        expect(ignored).toEqual(['*']);
        expect(options.credentials).toBe(false);
        expect(await decide(options, 'https://jtpets.ca')).toBe(true);
        expect(await decide(options, 'https://evil.example')).toBe('refused');
        expect(await decide(options, 'https://jtpets.ca.evil.example')).toBe('refused');
        expect(await decide(options, undefined)).toBe(true);
    });
});

describe('acceptSessionId', () => {
    test('keeps a short id, replaces anything else', () => {
        expect(acceptSessionId('3f2b6c1e-1111-4222-8333-444455556666')).toBe('3f2b6c1e-1111-4222-8333-444455556666');
        expect(acceptSessionId('my-session-id')).toBe('my-session-id');
        for (const bad of [undefined, null, 42, {}, '', 'a\nb', 'a b', 'x'.repeat(65), '../etc']) {
            expect(acceptSessionId(bad)).toBeNull();
        }
    });
});

// THE enumerating guard. A console call in the storefront that interpolates a value must
// interpolate logSafe(...) or one of the server-made values listed here. A new console line
// carrying client input fails this test until it is wrapped.
const SERVER_VALUES = new Set([
    'stats.itemCount', 'stats.categories', 'productMatches.length', 'quoteRecord.id', 'PORT',
    // validated by acceptSessionId before this line runs (bots/storefront.js)
    'sessionId.substring(0, 8)',
]);

function unsafeLogInterpolations(source) {
    const found = [];
    const callRe = /console\.(?:log|warn|error|info)\(\s*`((?:[^`\\]|\\.)*)`/g;
    let call;
    while ((call = callRe.exec(source)) !== null) {
        const exprRe = /\$\{([^}]*)\}/g;
        let m;
        while ((m = exprRe.exec(call[1])) !== null) {
            const expr = m[1].trim();
            if (!expr.startsWith('logSafe(') && !SERVER_VALUES.has(expr)) found.push(expr);
        }
    }
    return found;
}

describe('no storefront log line interpolates client input unescaped', () => {
    const botsDir = path.join(__dirname, '..', 'bots');
    const files = fs.readdirSync(botsDir).filter((f) => /^storefront.*\.js$/.test(f));

    test('the walk finds the storefront files', () => {
        expect(files).toEqual(expect.arrayContaining(['storefront.js', 'storefront-delivery.js', 'storefront-records.js']));
    });

    test.each(files)('%s', (file) => {
        const source = fs.readFileSync(path.join(botsDir, file), 'utf8');
        expect(unsafeLogInterpolations(source)).toEqual([]);
    });

    test('negative control: the pre-#87 delivery log line is caught', () => {
        const before = 'console.log(`[storefront] Delivery quote saved: ${quoteRecord.id} - ${businessName}`);';
        expect(unsafeLogInterpolations(before)).toEqual(['businessName']);
        const after = 'console.log(`[storefront] saved: ${quoteRecord.id} - ${logSafe(quoteRecord.businessName)}`);';
        expect(unsafeLogInterpolations(after)).toEqual([]);
    });
});
