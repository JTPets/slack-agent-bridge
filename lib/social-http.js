/**
 * lib/social-http.js
 *
 * The one HTTP helper the social platform clients share (Meta, Bluesky, Google
 * Business Profile). JSON in, JSON out, a timeout, and an error that never carries
 * a credential.
 *
 * LOGIC CHANGE 2026-11-09: created for the social media integration.
 *
 * Credentials travel ONLY in the Authorization header, never in a URL, so a URL
 * that ends up in an error message, a log line or a Slack post carries no token.
 * Every error message is passed through lib/redact-secrets.js as well, because a
 * platform's error body can echo what it was sent.
 */

'use strict';

const { redact } = require('./redact-secrets');

const DEFAULT_TIMEOUT_MS = 30000;

class SocialApiError extends Error {
    constructor(message, { status = null, platform = null, body = null } = {}) {
        super(redact(message));
        this.name = 'SocialApiError';
        this.status = status;
        this.platform = platform;
        this.body = body;
    }
}

/** The most useful message a platform's error body carries, or null. */
function bodyMessage(body) {
    if (!body || typeof body !== 'object') return null;
    if (body.error && typeof body.error === 'object') {
        return body.error.message || body.error.status || null;
    }
    if (typeof body.error === 'string') return body.message ? `${body.error}: ${body.message}` : body.error;
    return body.message || null;
}

/**
 * Request JSON. Resolves the parsed body; rejects SocialApiError.
 *
 * @param {object} opts
 * @param {string} opts.platform - for the error message ('meta', 'bluesky', 'gbp')
 * @param {string} opts.url
 * @param {string} [opts.method='GET']
 * @param {string} [opts.token] - sent as `Authorization: Bearer`
 * @param {object} [opts.json] - request body, sent as JSON
 * @param {Buffer} [opts.raw] - raw request body (an image upload)
 * @param {string} [opts.contentType] - for `raw`
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.fetchImpl] - injectable for tests; defaults to global fetch
 */
async function requestJson({
    platform, url, method = 'GET', token, json, raw, contentType,
    timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch,
}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
    } else if (raw !== undefined) {
        headers['Content-Type'] = contentType || 'application/octet-stream';
        body = raw;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    let res;
    try {
        res = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
        const why = err && err.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : (err && err.message) || String(err);
        throw new SocialApiError(`${platform} request failed: ${why}`, { platform });
    } finally {
        clearTimeout(timer);
    }

    const text = await res.text();
    let parsed = null;
    if (text) {
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
    }
    if (!res.ok) {
        // The credential this request carried is scrubbed by value as well: a token
        // read from somewhere other than process.env would escape redact()'s env pass.
        let detail = bodyMessage(parsed) || text.slice(0, 200) || 'no body';
        if (token) detail = String(detail).split(token).join('[REDACTED]');
        throw new SocialApiError(`${platform} answered HTTP ${res.status}: ${detail}`,
            { status: res.status, platform, body: parsed });
    }
    if (text && parsed === null) {
        throw new SocialApiError(`${platform} answered HTTP ${res.status} with a body that is not JSON`,
            { status: res.status, platform });
    }
    return parsed || {};
}

/** Download bytes (an image to re-upload). Rejects SocialApiError. */
async function fetchBytes({ platform, url, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch, maxBytes = 1000000 }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (!res.ok) throw new SocialApiError(`${platform}: image download answered HTTP ${res.status}`, { status: res.status, platform });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) {
            throw new SocialApiError(`${platform}: image is ${buf.length} bytes, over the ${maxBytes}-byte limit`, { platform });
        }
        return { bytes: buf, contentType: (res.headers && res.headers.get && res.headers.get('content-type')) || 'image/jpeg' };
    } catch (err) {
        if (err instanceof SocialApiError) throw err;
        throw new SocialApiError(`${platform}: image download failed: ${err.message}`, { platform });
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { SocialApiError, requestJson, fetchBytes, bodyMessage, DEFAULT_TIMEOUT_MS };
