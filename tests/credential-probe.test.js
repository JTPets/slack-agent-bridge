'use strict';

/**
 * tests/credential-probe.test.js
 *
 * WORK-TODO #80 (B30): a SET credential is probed with one live read-only call when
 * `activate` is asked, and the step passes only when the probe says it works or when no
 * probe exists (stated). Every probe here is injected or runs over an injected fetch:
 * no test makes a network call. The values below are synthetic.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const probe = require('../lib/credential-probe');
const bridgeState = require('../lib/bridge-state');
const checklist = require('../lib/activation-checklist');
const activation = require('../lib/agent-activation');
const registry = require('../lib/agent-registry');

const SQUARE = 'EAAAsquare-synthetic-value-0123456789';
const REFRESH = 'gbp-refresh-synthetic-value-0123456789';

const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

describe('probeCredential', () => {
    test('a variable with no probe is not_probed, says so, and calls nothing', async () => {
        const r = await probe.probeCredential('YELP_API_KEY', { env: { YELP_API_KEY: 'x' } });
        expect(r).toEqual({ status: 'not_probed', probe: null, reason: 'no live check exists for it' });
    });

    test('every probed variable belongs to a probe that lists it', () => {
        for (const [name, id] of Object.entries(probe.PROBE_FOR)) expect(probe.PROBES[id].vars).toContain(name);
    });

    test('works when the read-only call answers', async () => {
        const squareApiRequest = jest.fn(async () => ({ objects: [] }));
        const r = await probe.probeCredential('SQUARE_ACCESS_TOKEN', { env: { SQUARE_ACCESS_TOKEN: SQUARE }, deps: { squareApiRequest } });
        expect(r.status).toBe('works');
        expect(squareApiRequest).toHaveBeenCalledWith('/catalog/list?types=CATEGORY', SQUARE);
    });

    test('a failing call is fails, and an echoed value never reaches the reason', async () => {
        const squareApiRequest = async (_, token) => { throw new Error(`Square API error: 401 (token ${token} revoked)`); };
        const r = await probe.probeCredential('SQUARE_ACCESS_TOKEN', { env: { SQUARE_ACCESS_TOKEN: SQUARE }, deps: { squareApiRequest } });
        expect(r.status).toBe('fails');
        expect(r.reason).toMatch(/401/);
        expect(r.reason).not.toContain(SQUARE);
    });

    test('the real Google Business read over a fetch that echoes the refresh token: no value in the reason', async () => {
        const env = { GBP_REFRESH_TOKEN: REFRESH, GBP_ACCOUNT_ID: '111', GBP_LOCATION_ID: '222', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret-synthetic-0123' };
        const fetchImpl = jest.fn(async () => res(400, { error: { message: `invalid_grant: ${REFRESH} expired` } }));
        const r = await probe.probeCredential('GBP_REFRESH_TOKEN', { env, fetchImpl });
        expect(fetchImpl).toHaveBeenCalled();
        expect(r.status).toBe('fails');
        expect(r.reason).toMatch(/invalid_grant/);
        expect(r.reason).not.toContain(REFRESH);
    });

    test('the real Facebook read over an injected fetch: 200 works, 401 fails', async () => {
        const env = { META_PAGE_ACCESS_TOKEN: 'meta-synthetic-token-0123456789', META_PAGE_ID: '42' };
        const ok = await probe.probeCredential('META_PAGE_ID', { env, fetchImpl: async () => res(200, { name: 'Shop', followers_count: 3, data: [] }) });
        expect(ok.status).toBe('works');
        const bad = await probe.probeCredential('META_PAGE_ID', { env, fetchImpl: async () => res(401, { error: { message: 'Session has expired' } }) });
        expect(bad).toMatchObject({ status: 'fails', reason: expect.stringMatching(/Session has expired/) });
    });

    test('a sibling variable that is EMPTY fails the probe without calling anything', async () => {
        const readFacebook = jest.fn();
        const r = await probe.probeCredential('META_PAGE_ID', { env: { META_PAGE_ID: '42' }, deps: { readFacebook } });
        expect(r.status).toBe('fails');
        expect(r.reason).toMatch(/META_PAGE_ACCESS_TOKEN` is EMPTY/);
        expect(readFacebook).not.toHaveBeenCalled();
    });

    test('a hung call is a failure after the timeout, and a throwing client never rejects', async () => {
        const hung = await probe.probeCredential('BLUESKY_HANDLE', { env: { BLUESKY_HANDLE: 'a.b' }, timeoutMs: 20, deps: { readBluesky: () => new Promise(() => {}) } });
        expect(hung).toMatchObject({ status: 'fails', reason: expect.stringMatching(/no answer within 20 ms/) });
        const thrown = await probe.probeCredential('BLUESKY_HANDLE', { env: { BLUESKY_HANDLE: 'a.b' }, deps: { readBluesky: () => { throw new Error('boom'); } } });
        expect(thrown).toMatchObject({ status: 'fails', reason: 'boom' });
    });

    test('Gmail: the read-only profile call decides it', async () => {
        const env = { GOOGLE_REFRESH_TOKEN: 'r', GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's' };
        const client = (fn) => async () => ({ client: { users: { getProfile: fn } } });
        expect((await probe.probeCredential('GOOGLE_REFRESH_TOKEN', { env, deps: { createGmailClient: client(async () => ({})) } })).status).toBe('works');
        const bad = await probe.probeCredential('GOOGLE_REFRESH_TOKEN', { env, deps: { createGmailClient: client(async () => { throw new Error('invalid_grant'); }) } });
        expect(bad).toMatchObject({ status: 'fails', reason: 'invalid_grant' });
    });

    test('variables sharing one probe share one call', async () => {
        const readFacebook = jest.fn(async () => ({ account: { available: true } }));
        const env = { META_PAGE_ACCESS_TOKEN: 't', META_PAGE_ID: '42' };
        const cache = new Map();
        await probe.probeCredential('META_PAGE_ACCESS_TOKEN', { env, deps: { readFacebook }, cache });
        await probe.probeCredential('META_PAGE_ID', { env, deps: { readFacebook }, cache });
        expect(readFacebook).toHaveBeenCalledTimes(1);
    });
});

describe('the activation session probes a SET credential', () => {
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-probe-'));
        bridgeState.init({
            channelMapFile: path.join(dir, 'channel-map.json'),
            activationFile: path.join(dir, 'agent-activation.json'),
            answersFile: path.join(dir, 'activation-answers.json'),
            stateFile: path.join(dir, 'state.json'),
            processedTasksFile: path.join(dir, 'processed.json'),
        });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const planned = () => registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
    const slackStub = (known) => ({
        findChannelByName: jest.fn(async (name) => (known[name] ? { channelId: known[name], name } : null)),
        joinAgentChannels: jest.fn(async (c) => ({ joined: c.length, failed: 0, total: c.length })),
    });
    const lists = (id) => ({ [id]: { name: id, tasks: [
        { description: 'Add SQUARE_ACCESS_TOKEN to .env', completed: false },
        { description: 'Add FAKE_UNPROBED_VAR to .env', completed: false },
    ] } });
    const env = { SQUARE_ACCESS_TOKEN: SQUARE, FAKE_UNPROBED_VAR: 'x' };

    test('a SET credential whose probe fails blocks activation, with the reason and no value', async () => {
        const a = planned();
        const client = slackStub({ [a.channel_name]: 'C_NEW' });
        const echo = async (_, token) => { throw new Error(`Square API error: 401 for ${token}`); };
        const probeFn = (name, o) => probe.probeCredential(name, { ...o, deps: { squareApiRequest: echo } });
        const r = await activation.handleActivate({ args: a.id, slackClient: client, checklists: lists(a.id), env, probe: probeFn });
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/SQUARE_ACCESS_TOKEN` is SET but does not work: Square API error: 401/);
        expect(r.text).toMatch(/failed a live read-only check/);
        expect(r.text).toMatch(/FAKE_UNPROBED_VAR` is SET \(not probed: no live check exists for it\)/);
        expect(r.text).not.toContain(SQUARE);
        expect(bridgeState.getActivation(a.id)).toBeNull();
        expect(client.joinAgentChannels).not.toHaveBeenCalled();
    });

    test('a probe that works (and an unprobed SET step) lets it activate', async () => {
        const a = planned();
        const probeFn = (name, o) => probe.probeCredential(name, { ...o, deps: { squareApiRequest: async () => ({}) } });
        const r = await activation.handleActivate({ args: a.id, slackClient: slackStub({ [a.channel_name]: 'C_NEW' }), checklists: lists(a.id), env, probe: probeFn, onActivationChanged: jest.fn() });
        expect(r.ok).toBe(true);
        expect(bridgeState.getActivation(a.id)).toBe(true);
    });

    test('an EMPTY step is never probed, and a probe that throws is a failure, not a crash', async () => {
        const calls = [];
        const v = checklist.evaluateChecklist('x', { checklists: lists('x'), answers: {}, env: { FAKE_UNPROBED_VAR: 'x' } });
        const out = await checklist.probeSteps(v, { env: {}, probe: async (n) => { calls.push(n); throw new Error('x'); } });
        expect(calls).toEqual(['FAKE_UNPROBED_VAR']);
        expect(out.ready).toBe(false);
        expect(out.steps[1]).toMatchObject({ pass: false, probe: 'fails' });
    });
});
