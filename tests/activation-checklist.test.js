'use strict';

/**
 * tests/activation-checklist.test.js
 *
 * WORK-TODO #80: `ASK: activate <id>` is a question-and-answer session over the agent's
 * checklist. "Add X to .env" steps are checked by the bridge (SET/EMPTY, never the
 * value) and cannot be ticked by hand; every other step is answered with
 * `activate <id> done <n>`, stored in a gitignored workspace file (a real temp file
 * here); the agent is activated only when every step passes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const bridgeState = require('../lib/bridge-state');
const checklist = require('../lib/activation-checklist');
const activation = require('../lib/agent-activation');
const registry = require('../lib/agent-registry');

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-checklist-'));
    bridgeState.init({
        channelMapFile: path.join(dir, 'channel-map.json'),
        activationFile: path.join(dir, 'agent-activation.json'),
        answersFile: path.join(dir, 'activation-answers.json'),
        stateFile: path.join(dir, 'state.json'),
        processedTasksFile: path.join(dir, 'processed.json'),
    });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const slackStub = (known = {}) => ({
    findChannelByName: jest.fn(async (name) => (known[name] ? { channelId: known[name], name } : null)),
    joinAgentChannels: jest.fn(async (channels) => ({ joined: channels.length, failed: 0, total: channels.length })),
});
const planned = () => registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
const listFor = (id) => ({
    [id]: { name: id, tasks: [
        { description: 'Create the vendor app', completed: false },
        { description: 'Add FAKE_CHECKLIST_TOKEN to .env', completed: false },
        { description: 'Already done long ago', completed: true },
    ] },
});
const answersOnDisk = () => {
    const f = path.join(dir, 'activation-answers.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
};

describe('the step kinds', () => {
    test('every "Add X to .env" step in the live checklist file is an env step the bridge checks', () => {
        const live = require('../lib/owner-tasks-store').loadChecklists();
        const envSteps = Object.values(live).flatMap(a => (a.tasks || [])).filter(t => /to \.env/.test(t.description) && /^Add /.test(t.description));
        expect(envSteps.length).toBeGreaterThan(0);
        for (const t of envSteps) expect(checklist.stepKind(t.description)).toMatchObject({ kind: 'env' });
        expect(checklist.stepKind('Create Square API credentials (read-only app)')).toEqual({ kind: 'ask' });
    });

    test('an env step reports SET or EMPTY and never the value', () => {
        const v = checklist.evaluateChecklist('a', { checklists: listFor('a'), answers: {}, env: { FAKE_CHECKLIST_TOKEN: 'sk-very-secret' } });
        expect(v.steps[1]).toMatchObject({ kind: 'env', pass: true });
        const text = checklist.formatChecklist('a', v);
        expect(text).not.toMatch(/sk-very-secret/);
        expect(text).toMatch(/FAKE_CHECKLIST_TOKEN` is SET/);
        expect(checklist.evaluateChecklist('a', { checklists: listFor('a'), answers: {}, env: { FAKE_CHECKLIST_TOKEN: '  ' } }).steps[1].pass).toBe(false);
    });

    test('a step ticked in the tracked file counts; an agent with no checklist is not gated', () => {
        const v = checklist.evaluateChecklist('a', { checklists: listFor('a'), answers: {}, env: {} });
        expect(v.steps[2]).toMatchObject({ pass: true, why: 'ticked in the checklist file' });
        expect(checklist.evaluateChecklist('b', { checklists: listFor('a'), answers: {}, env: {} })).toEqual({ known: false, ready: true, steps: [] });
    });
});

describe('the session', () => {
    test('activate with open steps refuses, lists each step with how to answer, and activates nothing', async () => {
        const a = planned();
        const client = slackStub({ [a.channel_name]: 'C_NEW' });
        const r = await activation.handleActivate({ args: a.id, slackClient: client, checklists: listFor(a.id), env: {} });
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/1 of 3 pass/);
        expect(r.text).toMatch(new RegExp(`activate ${a.id} done 1`));
        expect(r.text).toMatch(/force-recreate bridge/);
        expect(r.text).toMatch(/Not activated yet/);
        expect(bridgeState.getActivation(a.id)).toBeNull();
        expect(client.joinAgentChannels).not.toHaveBeenCalled();
    });

    test('done records the answer in the workspace file; once every step passes it activates', async () => {
        const a = planned();
        const client = slackStub({ [a.channel_name]: 'C_NEW' });
        const env = { FAKE_CHECKLIST_TOKEN: 'x' };
        const r = await activation.handleActivate({ args: `${a.id} done 1`, slackClient: client, checklists: listFor(a.id), env, userId: 'U1', onActivationChanged: jest.fn() });
        expect(answersOnDisk()[a.id]['Create the vendor app']).toMatchObject({ by: 'U1' });
        expect(r.ok).toBe(true);
        expect(r.text).toMatch(/Checklist: all 3 steps pass\.\n:white_check_mark: Activated/);
        expect(bridgeState.getActivation(a.id)).toBe(true);
    });

    test('an answer alone, with a step still open, records it and does not activate', async () => {
        const a = planned();
        const r = await activation.handleActivate({ args: `${a.id} done 1`, slackClient: slackStub({ [a.channel_name]: 'C_NEW' }), checklists: listFor(a.id), env: {} });
        expect(r.ok).toBe(true);
        expect(r.text).toMatch(/2 of 3 pass/);
        expect(bridgeState.getActivation(a.id)).toBeNull();
    });

    test('undo takes an answer back', async () => {
        const a = planned();
        const ctx = { slackClient: slackStub(), checklists: listFor(a.id), env: {} };
        await activation.handleActivate({ ...ctx, args: `${a.id} done 1` });
        await activation.handleActivate({ ...ctx, args: `${a.id} undo 1` });
        expect(answersOnDisk()[a.id]).toEqual({});
    });

    test('an env step, an unknown number or a bad word is refused and NOTHING is written (all or nothing)', async () => {
        const a = planned();
        const ctx = { slackClient: slackStub(), checklists: listFor(a.id), env: {} };
        const envStep = await activation.handleActivate({ ...ctx, args: `${a.id} done 1 2` });
        expect(envStep.text).toMatch(/checked by the bridge itself/);
        const missing = await activation.handleActivate({ ...ctx, args: `${a.id} done 1 9` });
        expect(missing.text).toMatch(/step 9 does not exist/);
        expect((await activation.handleActivate({ ...ctx, args: `${a.id} done x` })).text).toMatch(/needs one or more step numbers/);
        expect((await activation.handleActivate({ ...ctx, args: `${a.id} please` })).text).toMatch(/unknown word/);
        expect(answersOnDisk()).toEqual({});
    });
});

describe('the pending list ("what do I need to do") agrees', () => {
    test('a live "Add X to .env" step leaves the list when the variable is SET', () => {
        const store = require('../lib/owner-tasks-store');
        const live = store.loadChecklists();
        const [agentId, step] = Object.entries(live).flatMap(([id, a]) => (a.tasks || []).filter(t => !t.completed && checklist.stepKind(t.description).kind === 'env').map(t => [id, t]))[0];
        const name = checklist.stepKind(step.description).name;
        const saved = process.env[name];
        try {
            delete process.env[name];
            expect(store.getPendingTasks().some(p => p.agentId === agentId && p.description === step.description)).toBe(true);
            process.env[name] = 'set-for-test';
            expect(store.getPendingTasks().some(p => p.agentId === agentId && p.description === step.description)).toBe(false);
        } finally {
            if (saved === undefined) delete process.env[name]; else process.env[name] = saved;
        }
    });

    test('a step answered in Slack leaves the list', () => {
        const store = require('../lib/owner-tasks-store');
        const [agentId, step] = Object.entries(store.loadChecklists()).flatMap(([id, a]) => (a.tasks || []).filter(t => !t.completed && checklist.stepKind(t.description).kind === 'ask').map(t => [id, t]))[0];
        bridgeState.setActivationAnswer(agentId, step.description, true);
        expect(store.getPendingTasks().some(p => p.agentId === agentId && p.description === step.description)).toBe(false);
    });
});
