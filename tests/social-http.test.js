'use strict';

const { requestJson, fetchBytes, SocialApiError } = require('../lib/social-http');

const SECRET = 'EAAGsecretpagetoken1234567890';

describe('lib/social-http.js', () => {
    test('the token goes only in the Authorization header, never the URL', async () => {
        let seen;
        const fetchImpl = async (url, init) => { seen = { url, init }; return new Response('{"id":"1"}', { status: 200 }); };
        const out = await requestJson({ platform: 'meta', url: 'https://graph.test/v26.0/me', token: SECRET, fetchImpl });
        expect(out).toEqual({ id: '1' });
        expect(seen.url).not.toContain(SECRET);
        expect(seen.init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    });

    test('a platform error is a SocialApiError naming the status and message, without the token', async () => {
        const fetchImpl = async () => new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${SECRET}` } }), { status: 401 });
        const err = await requestJson({ platform: 'meta', url: 'https://graph.test/x', token: SECRET, fetchImpl }).catch(e => e);
        expect(err).toBeInstanceOf(SocialApiError);
        expect(err.status).toBe(401);
        expect(err.message).toMatch(/meta answered HTTP 401: Invalid OAuth access token/);
        expect(err.message).not.toContain(SECRET);
    });

    test('a JSON body is sent as JSON; a raw body with its content type', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => { calls.push(init); return new Response('{}', { status: 200 }); };
        await requestJson({ platform: 'p', url: 'https://x.test', method: 'POST', json: { a: 1 }, fetchImpl });
        await requestJson({ platform: 'p', url: 'https://x.test', method: 'POST', raw: Buffer.from('ab'), contentType: 'image/png', fetchImpl });
        expect(calls[0].body).toBe('{"a":1}');
        expect(calls[0].headers['Content-Type']).toBe('application/json');
        expect(calls[1].headers['Content-Type']).toBe('image/png');
    });

    test('a 200 whose body is not JSON is an error, an empty body is {}', async () => {
        await expect(requestJson({ platform: 'p', url: 'https://x.test', fetchImpl: async () => new Response('<html>', { status: 200 }) }))
            .rejects.toThrow(/not JSON/);
        await expect(requestJson({ platform: 'p', url: 'https://x.test', fetchImpl: async () => new Response('', { status: 200 }) }))
            .resolves.toEqual({});
    });

    test('a network failure and a timeout are SocialApiErrors', async () => {
        await expect(requestJson({ platform: 'p', url: 'https://x.test', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }))
            .rejects.toThrow(/p request failed: ECONNREFUSED/);
        const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        }));
        await expect(requestJson({ platform: 'p', url: 'https://x.test', timeoutMs: 20, fetchImpl: hang }))
            .rejects.toThrow(/timed out after 20 ms/);
    });

    test('fetchBytes returns the bytes and refuses an image over the limit', async () => {
        const fetchImpl = async () => new Response(Buffer.from('abcdef'), { status: 200, headers: { 'content-type': 'image/jpeg' } });
        const ok = await fetchBytes({ platform: 'b', url: 'https://img.test/a.jpg', fetchImpl });
        expect(ok.bytes.toString()).toBe('abcdef');
        expect(ok.contentType).toBe('image/jpeg');
        await expect(fetchBytes({ platform: 'b', url: 'https://img.test/a.jpg', fetchImpl, maxBytes: 3 })).rejects.toThrow(/over the 3-byte limit/);
        await expect(fetchBytes({ platform: 'b', url: 'https://img.test/a.jpg', fetchImpl: async () => new Response('', { status: 404 }) }))
            .rejects.toThrow(/HTTP 404/);
    });
});
