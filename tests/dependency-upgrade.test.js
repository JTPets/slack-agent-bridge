'use strict';

/**
 * tests/dependency-upgrade.test.js
 *
 * LOGIC CHANGE 2026-10-05: written with the move to @slack/web-api 8 (from 7),
 * @slack/socket-mode 3.1, and googleapis 178 (from 171). Dependabot proposed the first
 * and an older googleapis (PRs #13, #14). This suite pins what that upgrade had to keep
 * true.
 *
 * 1. web-api 8 replaced axios with fetch and replaced plain-object errors with Error
 *    classes. This repository reads `err.data?.error` at a dozen sites
 *    (lib/slack-client.js, lib/heartbeat.js, bridge-agent.js) to tell `already_in_channel`
 *    and `missing_scope` apart. If v8 had dropped `.data`, every one of those checks
 *    would quietly fall through to the generic path, and no other suite would notice,
 *    because they all use client doubles. These tests drive the REAL WebClient over an
 *    injected fetch, so the error shape and the redaction are proven on the wire.
 *
 * 2. googleapis 180 and later require Node 22, and the jt-agent image is Node 20. Tests
 *    run on whatever Node the developer has, so a Node-22-only dependency would pass
 *    here and fail only in production. The engines guard reads the Node version from the
 *    repository's own image definitions (Dockerfile, docker-compose.example.yml), not
 *    from a number typed into this file.
 */

const fs = require('fs');
const path = require('path');
const semver = require('semver');
const { createWebClient } = require('../lib/slack-web');

const ROOT = path.join(__dirname, '..');

/** A fetch double that records what was sent and answers with `body`. */
function fakeFetch(body) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url: String(url), body: String(init && init.body) });
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    fn.calls = calls;
    return fn;
}

describe('@slack/web-api 8: the error shape this repository reads', () => {
    test('the sites that depend on it exist (so this test guards something)', () => {
        const src = ['lib/slack-client.js', 'lib/heartbeat.js', 'bridge-agent.js']
            .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
        expect((src.match(/\.data\?\.error/g) || []).length).toBeGreaterThanOrEqual(10);
    });

    test('a platform error still carries .data.error and the platform code', async () => {
        const fetch = fakeFetch({ ok: false, error: 'already_in_channel' });
        const client = createWebClient('xoxb-test-not-real', { fetch, retryConfig: { retries: 0 } });
        const err = await client.conversations.join({ channel: 'C0FIX1' }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.data?.error).toBe('already_in_channel');
        expect(err.code).toBe('slack_webapi_platform_error');
        expect(fetch.calls[0].url).toContain('conversations.join');
    });

    test('a successful call resolves with the response body', async () => {
        const fetch = fakeFetch({ ok: true, channel: { id: 'C0FIX1' } });
        const client = createWebClient('xoxb-test-not-real', { fetch, retryConfig: { retries: 0 } });
        const res = await client.conversations.join({ channel: 'C0FIX1' });
        expect(res.ok).toBe(true);
        expect(res.channel.id).toBe('C0FIX1');
    });
});

describe('@slack/web-api 8: redaction reaches the wire over the fetch transport', () => {
    // Assembled at runtime so the source never holds a token-shaped literal (GitHub push
    // protection blocks one, rightly, whether or not it is real).
    const SECRET = ['xoxb', '1111111111', '2222222222', 'abcdefghijklmnopqrstuvwx'].join('-');

    test('a token in a posted message never appears in the request body', async () => {
        const fetch = fakeFetch({ ok: true, ts: '1.0' });
        const client = createWebClient('xoxb-test-not-real', { fetch, retryConfig: { retries: 0 } });
        await client.chat.postMessage({ channel: 'C0FIX1', text: `leaked ${SECRET} here` });
        const sent = decodeURIComponent(fetch.calls[0].body);
        expect(sent).toContain('leaked');
        expect(sent).not.toContain(SECRET);
    });

    test('negative control: the same post through an unguarded client DOES carry it', async () => {
        const { WebClient } = require('@slack/web-api');
        const fetch = fakeFetch({ ok: true, ts: '1.0' });
        const raw = new WebClient('xoxb-test-not-real', { fetch, retryConfig: { retries: 0 } });
        await raw.chat.postMessage({ channel: 'C0FIX1', text: `leaked ${SECRET} here` });
        expect(decodeURIComponent(fetch.calls[0].body)).toContain(SECRET);
    });
});

describe('every production dependency runs on the Node the image ships', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.example.yml'), 'utf8');
    const pinned = (dockerfile.match(/^FROM node:(\d+\.\d+\.\d+)/m) || [])[1];
    const liveMajor = (compose.match(/^\s*image:\s*node:(\d+)\s*$/m) || [])[1];
    const lock = require('../package-lock.json');

    function offenders(packages) {
        const out = [];
        for (const [p, v] of Object.entries(packages)) {
            if (!p || v.dev || !v.engines || typeof v.engines.node !== 'string') continue;
            const range = v.engines.node;
            if (!semver.satisfies(pinned, range) || !semver.intersects(range, `^${liveMajor}`)) {
                out.push(`${p.replace(/^node_modules\//, '')}@${v.version} needs node ${range}`);
            }
        }
        return out;
    }

    test('the image definitions name a Node version at all', () => {
        expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
        expect(liveMajor).toMatch(/^\d+$/);
        expect(semver.major(pinned)).toBe(Number(liveMajor));
    });

    test('no production package in the lockfile excludes that Node', () => {
        expect(offenders(lock.packages)).toEqual([]);
    });

    test('negative control: a Node-22-only package WOULD be caught', () => {
        const fake = { ...lock.packages, 'node_modules/googleapis-future': { version: '999.0.0', engines: { node: '>=22.0.0' } } };
        expect(offenders(fake)).toEqual(['googleapis-future@999.0.0 needs node >=22.0.0']);
    });

    test('negative control: a dev-only package is not held to it', () => {
        const fake = { ...lock.packages, 'node_modules/dev-tool': { version: '1.0.0', dev: true, engines: { node: '>=22' } } };
        expect(offenders(fake)).toEqual([]);
    });
});
