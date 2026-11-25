'use strict';

/**
 * tests/storefront-hardening.test.js
 *
 * WORK-TODO #87: the four defects in the public storefront API, each driven through the
 * real Express app with supertest. Every describe here failed against the code before #87
 * (bots/storefront.js and bots/storefront-records.js at f0e6ba0):
 *   1. POST /api/chat and /api/delivery-quote had no rate limit;
 *   2. customer text reached #store-inbox as Slack markup (`<!channel>`, fake links, and
 *      a multi-line value escaping its quote);
 *   3. the delivery-quote log line printed the raw business name (log forging), and a
 *      client sessionId reached a log line and the session map unchecked;
 *   4. CORS honoured `*` in the allowed origins with credentials on.
 * The guards themselves are unit-tested in tests/storefront-guards.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const mockPosted = [];
jest.mock('@slack/web-api', () => ({
    WebClient: jest.fn().mockImplementation(() => ({
        chat: {
            postMessage: jest.fn(async (args) => { mockPosted.push(args); return { ok: true }; }),
        },
    })),
}));

jest.mock('../lib/llm-runner', () => ({
    runLLM: jest.fn().mockResolvedValue({ output: 'Hi!', hitMaxTurns: false }),
}));

const ENV_KEYS = [
    'SLACK_BOT_TOKEN', 'DELIVERY_QUOTES_FILE', 'STOREFRONT_ALLOWED_ORIGINS',
    'STOREFRONT_RATE_PER_CLIENT', 'STOREFRONT_RATE_GLOBAL', 'STOREFRONT_RATE_WINDOW_MS',
    'STOREFRONT_TRUST_PROXY',
];
const savedEnv = {};
let tmpDir;

beforeAll(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storefront-87-'));
});

afterAll(() => {
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A fresh storefront app under the given environment. */
function loadApp(env = {}) {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.DELIVERY_QUOTES_FILE = path.join(tmpDir, `quotes-${Math.random()}.json`);
    Object.assign(process.env, env);
    let mod;
    let runLLM;
    jest.isolateModules(() => {
        mod = require('../bots/storefront');
        ({ runLLM } = require('../lib/llm-runner'));
    });
    return { app: mod.app, sessions: mod.sessions, runLLM };
}

/** Let the fire-and-forget Slack posts settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const validQuote = (overrides = {}) => ({
    businessName: 'Acme Pets',
    contactName: 'Pat',
    phone: '555-0100',
    email: 'pat@example.com',
    pickupAddress: '1 Main St',
    deliveryAddress: '2 King St',
    quote: { distance: 4.2, price: 10, contactRequired: false },
    ...overrides,
});

beforeEach(() => {
    mockPosted.length = 0;
    jest.restoreAllMocks();
});

describe('1. the public routes are rate limited', () => {
    test('POST /api/chat: the 11th call in a minute from one client is 429 and runs no model', async () => {
        const { app, runLLM } = loadApp();
        runLLM.mockClear();
        for (let i = 0; i < 10; i++) {
            const ok = await request(app).post('/api/chat').send({ message: `hi ${i}` });
            expect(ok.status).toBe(200);
        }
        const refused = await request(app).post('/api/chat').send({ message: 'one more' });
        expect(refused.status).toBe(429);
        expect(refused.body.code).toBe('RATE_LIMITED');
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
        expect(runLLM).toHaveBeenCalledTimes(10);
    });

    test('POST /api/delivery-quote is limited too', async () => {
        const { app } = loadApp({ STOREFRONT_RATE_PER_CLIENT: '2' });
        expect((await request(app).post('/api/delivery-quote').send(validQuote())).status).toBe(200);
        expect((await request(app).post('/api/delivery-quote').send(validQuote())).status).toBe(200);
        expect((await request(app).post('/api/delivery-quote').send(validQuote())).status).toBe(429);
    });

    test('the global limit refuses and tells #store-inbox once per window, not per request', async () => {
        const { app } = loadApp({ STOREFRONT_RATE_GLOBAL: '3', STOREFRONT_RATE_PER_CLIENT: '100' });
        for (let i = 0; i < 3; i++) {
            expect((await request(app).post('/api/chat').send({ message: 'hi' })).status).toBe(200);
        }
        await settle();
        mockPosted.length = 0;
        expect((await request(app).post('/api/chat').send({ message: 'hi' })).status).toBe(429);
        expect((await request(app).post('/api/chat').send({ message: 'hi' })).status).toBe(429);
        await settle();
        const notices = mockPosted.filter((p) => /global rate limit/.test(p.text));
        expect(notices).toHaveLength(1);
        expect(notices[0].text).toContain('/api/chat');
    });
});

describe('2. customer text reaches #store-inbox as text, not Slack markup', () => {
    const hostile = 'hello <!channel> see <https://evil.example|your order> & <@U123>';

    function assertInert(text) {
        expect(text).not.toMatch(/<!channel>|<https:|<@U123>/);
        expect(text).toContain('&lt;!channel&gt;');
        expect(text).toContain('&amp;');
    }

    test('a chat message and the agent reply are escaped, and a multi-line reply stays quoted', async () => {
        const { app, runLLM } = loadApp();
        runLLM.mockResolvedValueOnce({ output: 'Sure.\n*Customer:* forged line\n<!here>', hitMaxTurns: false });
        expect((await request(app).post('/api/chat').send({ message: hostile })).status).toBe(200);
        await settle();
        expect(mockPosted).toHaveLength(1);
        const { text } = mockPosted[0];
        assertInert(text);
        expect(text).not.toContain('<!here>');
        // Every line after the session header is either one of our labels or quoted content.
        const lines = text.split('\n').slice(1);
        for (const line of lines) expect(line).toMatch(/^(\*Customer:\*|\*Agent:\*|> )/);
        expect(text).toContain('> *Customer:* forged line');
    });

    test('every delivery-quote field is escaped', async () => {
        const { app } = loadApp();
        const res = await request(app).post('/api/delivery-quote').send(validQuote({
            businessName: hostile, contactName: hostile, pickupAddress: hostile,
        }));
        expect(res.status).toBe(200);
        await settle();
        expect(mockPosted).toHaveLength(1);
        assertInert(mockPosted[0].text);
    });

    test('a price that is not a number is refused, so it cannot carry markup into the post', async () => {
        const { app } = loadApp();
        const res = await request(app).post('/api/delivery-quote').send(validQuote({
            quote: { distance: 3, price: '<!channel>', contactRequired: false },
        }));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_QUOTE');
        await settle();
        expect(mockPosted).toHaveLength(0);
    });

    test('the delivery page payloads still pass: a number, and null when contact is required', async () => {
        const { app } = loadApp();
        expect((await request(app).post('/api/delivery-quote').send(validQuote())).status).toBe(200);
        expect((await request(app).post('/api/delivery-quote').send(validQuote({
            quote: { distance: 25, price: null, contactRequired: true },
        }))).status).toBe(200);
    });
});

describe('3. client input cannot forge a log line', () => {
    const logged = () => console.log.mock.calls.map((args) => args.map(String).join(' '));

    test('a business name carrying a newline is logged on one escaped line', async () => {
        const { app } = loadApp();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const res = await request(app).post('/api/delivery-quote')
            .send(validQuote({ businessName: 'Acme\n[storefront] Refund approved for order 42' }));
        expect(res.status).toBe(200);
        const line = logged().find((l) => l.includes('Delivery quote saved'));
        expect(line).toBeDefined();
        expect(line).not.toContain('\n');
        // sanitizeInput already strips the newline for the stored record; the raw value is
        // what the old line printed. Either way no log line may start with the forged text.
        for (const l of logged()) {
            for (const physical of l.split('\n').slice(1)) {
                expect(physical.startsWith('[storefront] Refund')).toBe(false);
            }
        }
    });

    test('a sessionId that is not a short id is replaced, never logged or kept', async () => {
        const { app, sessions } = loadApp();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const forged = 'ab\n[storefront] forged';
        const res = await request(app).post('/api/chat').send({ message: 'hi', sessionId: forged });
        expect(res.status).toBe(200);
        expect(res.body.sessionId).not.toBe(forged);
        expect(sessions.has(forged)).toBe(false);
        for (const l of logged()) expect(l).not.toContain('\n');
    });

    test('a numeric sessionId no longer crashes the route', async () => {
        const { app } = loadApp();
        jest.spyOn(console, 'log').mockImplementation(() => {});
        const res = await request(app).post('/api/chat').send({ message: 'hi', sessionId: 12345 });
        expect(res.status).toBe(200);
        expect(typeof res.body.sessionId).toBe('string');
    });

    test('a short id a client already holds is kept (the widget resumes its session)', async () => {
        const { app } = loadApp();
        const res = await request(app).post('/api/chat').send({ message: 'hi', sessionId: 'my-session-id' });
        expect(res.body.sessionId).toBe('my-session-id');
    });
});

describe('4. CORS: exact origins, no credentials, `*` ignored', () => {
    test('with `*` configured, a foreign origin is not allowed and credentials are never offered', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const { app } = loadApp({ STOREFRONT_ALLOWED_ORIGINS: '*,https://jtpets.ca' });
        const res = await request(app).get('/health').set('Origin', 'https://evil.example');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
        expect(console.warn.mock.calls.some((c) => String(c[0]).includes('"*"'))).toBe(true);
    });

    test('a listed origin is echoed exactly, still without credentials', async () => {
        const { app } = loadApp({ STOREFRONT_ALLOWED_ORIGINS: 'https://jtpets.ca' });
        const res = await request(app).get('/health').set('Origin', 'https://jtpets.ca');
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('https://jtpets.ca');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    test('a preflight from a listed origin offers no credentials', async () => {
        const { app } = loadApp({ STOREFRONT_ALLOWED_ORIGINS: 'https://jtpets.ca' });
        const res = await request(app).options('/api/chat')
            .set('Origin', 'https://jtpets.ca')
            .set('Access-Control-Request-Method', 'POST');
        expect(res.headers['access-control-allow-origin']).toBe('https://jtpets.ca');
        expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });
});
