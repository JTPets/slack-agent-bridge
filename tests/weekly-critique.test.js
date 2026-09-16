/**
 * tests/weekly-critique.test.js
 *
 * BEHAVIOUR tests for lib/weekly-critique.js. Two properties carry the design here:
 *
 *   1. IT RESOLVES TO THE JESTER, never to the caller's agent — from the same
 *      declaration the cron registrar reads, so the verb and the schedule cannot name
 *      different agents.
 *   2. A THIN WEEK CALLS NO MODEL AT ALL. A model handed an empty digest and a
 *      contrarian persona will produce a complaint, because that is what it was asked
 *      to be. The only reliable way to get an honest "nothing to report" is not to ask.
 *
 * The third property — that NOTHING HE PRODUCES CAN GATE ANYTHING — is a source-and
 * call-site guard rather than a behaviour test, and lives in
 * `tests/weekly-critique-gating.test.js`. Split out 2026-09-16 because this file
 * reached 440 lines against the repository's 300-line rule; the seam was already there.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const critique = require('../lib/weekly-critique');

const {
    NOW, JESTER, BRIDGE, digestFixture, slackDouble, llmDouble, notifierDouble,
} = require('./helpers/critique-fixtures');

describe('it resolves to the jester, not to the caller\'s agent', () => {
    test('resolveCritic finds the agent whose schedule declares this task', () => {
        const found = critique.resolveCritic(BRIDGE, () => [BRIDGE, JESTER]);
        expect(found.id).toBe('jester');
    });

    test('an agent already declaring the task is used as-is (the cron path)', () => {
        const load = jest.fn(() => { throw new Error('the registry must not be consulted here'); });
        expect(critique.resolveCritic(JESTER, load).id).toBe('jester');
        expect(load).not.toHaveBeenCalled();
    });

    test('a registry that cannot be loaded falls back to the passed agent, never crashes', () => {
        const found = critique.resolveCritic(BRIDGE, () => { throw new Error('registry gone'); });
        expect(found.id).toBe('bridge');
    });

    test('the post lands in the JESTER\'s channel even when the bridge invoked it', async () => {
        const slack = slackDouble();
        const llm = llmDouble();
        const r = await critique.runWeeklyCritique({
            slack, agent: BRIDGE, now: NOW, llm, notifier: notifierDouble(),
            loadAgentsFn: () => [BRIDGE, JESTER], digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: true, status: 'ok', agentId: 'jester', channel: 'C0JESTER', posted: true });
        expect(slack.posts).toHaveLength(1);
        expect(slack.posts[0].channel).toBe('C0JESTER');
    });

    test('it runs on the JESTER\'s provider and bills metrics to him, not to the bridge', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: BRIDGE, now: NOW, llm, notifier: notifierDouble(),
            loadAgentsFn: () => [BRIDGE, JESTER], digest: digestFixture(),
        });
        expect(llm.calls[0].options).toMatchObject({ provider: 'gemini', agentId: 'jester' });
    });

    test('the prompt carries HIS system prompt and the computed digest', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: BRIDGE, now: NOW, llm, notifier: notifierDouble(),
            loadAgentsFn: () => [BRIDGE, JESTER], digest: digestFixture(),
        });
        const { prompt } = llm.calls[0];
        expect(prompt).toContain('sharp-tongued contrarian');
        expect(prompt).toContain('DIGEST —');
        expect(prompt).toContain('48 open items');
    });
});

describe('the call is one shot, on his provider, with no fallback and no working tree', () => {
    test('maxTurns is 1 — he is given everything; there is nothing to fetch', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        expect(llm.calls[0].options.maxTurns).toBe(1);
    });

    test('cwd is a FRESH temp dir, not WORK_DIR and not the repository', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        const { cwd } = llm.calls[0].options;
        expect(cwd.startsWith(fs.realpathSync(os.tmpdir())) || cwd.startsWith(os.tmpdir())).toBe(true);
        expect(cwd).toContain('critique-');
        expect(cwd).not.toContain(path.join(__dirname, '..'));
    });

    test('the temp dir is removed even when the model throws (the finally-block rule)', async () => {
        let seen;
        const llm = { runLLM: async (_p, o) => { seen = o.cwd; throw new Error('provider down'); } };
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        expect(seen).toBeTruthy();
        expect(fs.existsSync(seen)).toBe(false);
    });

    test('it calls runLLM and NEVER runWithFallback', async () => {
        // The chain can land on `claude`, whose adapter spawns a CLI with
        // --dangerously-skip-permissions in cwd. Jester's definition denies
        // file-system and github; routing him onto a tool-capable engine to save a
        // weekly joke is not a trade worth making.
        const llm = {
            runLLM: async () => ({ output: 'roast' }),
            runWithFallback: async () => { throw new Error('runWithFallback must not be called'); },
        };
        const r = await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        expect(r.ok).toBe(true);

        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'weekly-critique.js'), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(code).toMatch(/\brunLLM\(/);
        expect(code).not.toMatch(/\brunWithFallback\b/);
    });
});

describe('a thin week produces a short honest post and calls no model', () => {
    const thin = () => digestFixture({
        thin: true,
        history: { available: true, reason: null, commits: 0, closes: [], addresses: [], repeatedlyAddressed: [], merged: [] },
    });

    test('no model is called at all', async () => {
        const llm = llmDouble();
        const r = await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: thin(),
        });
        expect(llm.calls).toHaveLength(0);
        expect(r).toMatchObject({ ok: true, status: 'thin', posted: true, provider: null });
    });

    test('the post says so plainly and refuses to invent a complaint', async () => {
        const slack = slackDouble();
        await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble(), notifier: notifierDouble(), digest: thin(),
        });
        const text = slack.posts[0].text;
        expect(text).toMatch(/nothing worth the breath/i);
        expect(text).toMatch(/not going to invent one/i);
        expect(text.length).toBeLessThan(700);
    });

    test('it names what was checked, so a short post is evidence and not an absence of it', async () => {
        const slack = slackDouble();
        await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble(), notifier: notifierDouble(), digest: thin(),
        });
        expect(slack.posts[0].text).toMatch(/Checked:/);
        expect(slack.posts[0].text).toMatch(/commits/);
    });

    test('a thin week with an unreadable backlog says the backlog could not be read', async () => {
        const slack = slackDouble();
        const d = thin();
        d.backlog = { available: false, reason: 'could not read WORK-TODO.md: ENOENT', open: 0 };
        await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble(), notifier: notifierDouble(), digest: d,
        });
        expect(slack.posts[0].text).toMatch(/could not be read/);
    });
});

describe('a normal week posts the model\'s output with the coverage line', () => {
    test('the output is posted verbatim and the coverage line is appended', async () => {
        const slack = slackDouble();
        await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble({ output: 'Thirty backlog edits. Zero closures.' }),
            notifier: notifierDouble(), digest: digestFixture(),
        });
        expect(slack.posts[0].text).toContain('Thirty backlog edits. Zero closures.');
        expect(slack.posts[0].text).toMatch(/Checked:/);
    });

    test('the prompt forbids inventing, and says UNAVAILABLE is not good news', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        const { prompt } = llm.calls[0];
        expect(prompt).toMatch(/Do not manufacture a/);
        expect(prompt).toMatch(/a sensor failed, NOT that there was nothing/);
        expect(prompt).toMatch(/Never treat it as good news/);
    });

    test('the prompt tells him he decides and blocks nothing', async () => {
        const llm = llmDouble();
        await critique.runWeeklyCritique({
            slack: slackDouble(), agent: JESTER, now: NOW, llm, notifier: notifierDouble(), digest: digestFixture(),
        });
        expect(llm.calls[0].prompt).toMatch(/You decide nothing and block nothing/);
    });
});

describe('every failure is reported and nothing is posted', () => {
    test('no resolved channel: refuses, escalates, posts nothing', async () => {
        const slack = slackDouble();
        const notifier = notifierDouble();
        const r = await critique.runWeeklyCritique({
            slack, agent: null, now: NOW, llm: llmDouble(), notifier,
            loadAgentsFn: () => [{ ...JESTER, channel: null }], digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: false, status: 'no_channel', posted: false, escalated: true });
        expect(r.error).toMatch(/#jester-agent/);
        expect(r.error).toMatch(/owner action/);
        expect(slack.posts).toHaveLength(0);
        expect(notifier.ops).toHaveLength(1);
    });

    test('the model throwing is reported, not swallowed, and nothing is posted', async () => {
        const slack = slackDouble();
        const notifier = notifierDouble();
        const r = await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble({ throw: 'gemini 429' }), notifier, digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: false, status: 'llm_failed', posted: false, escalated: true });
        expect(slack.posts).toHaveLength(0);
        expect(notifier.ops[0]).toContain('gemini 429');
    });

    test('an EMPTY model response is a failure, never an empty post', async () => {
        const notifier = notifierDouble();
        const slack = slackDouble();
        const r = await critique.runWeeklyCritique({
            slack, agent: JESTER, now: NOW, llm: llmDouble({ output: '   ' }), notifier, digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: false, status: 'llm_failed', posted: false });
        expect(slack.posts).toHaveLength(0);
        expect(notifier.ops[0]).toMatch(/empty critique/);
    });

    test('a Slack post that fails is reported', async () => {
        const notifier = notifierDouble();
        const r = await critique.runWeeklyCritique({
            slack: slackDouble({ fail: 'not_in_channel' }), agent: JESTER, now: NOW,
            llm: llmDouble(), notifier, digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: false, status: 'post_failed', posted: false, escalated: true });
        expect(notifier.ops[0]).toContain('not_in_channel');
    });

    test('a thin post that fails to send is reported too', async () => {
        const notifier = notifierDouble();
        const r = await critique.runWeeklyCritique({
            slack: slackDouble({ fail: 'channel_not_found' }), agent: JESTER, now: NOW,
            llm: llmDouble(), notifier, digest: digestFixture({ thin: true }),
        });
        expect(r).toMatchObject({ ok: false, status: 'post_failed', escalated: true });
    });

    test('a notifier that itself throws does not take the task down', async () => {
        const r = await critique.runWeeklyCritique({
            slack: slackDouble({ fail: 'boom' }), agent: JESTER, now: NOW, llm: llmDouble(),
            notifier: { notifyOps: async () => { throw new Error('ops is down too'); } },
            digest: digestFixture(),
        });
        expect(r).toMatchObject({ ok: false, status: 'post_failed', escalated: false });
    });
});
