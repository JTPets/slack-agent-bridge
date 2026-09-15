'use strict';

/**
 * tests/agent-activation.test.js
 *
 * Tests for lib/agent-activation.js and the workspace-state half of
 * lib/bridge-state.js — the two halves of "a definition is tracked, the decision to
 * run it is local".
 *
 * Against REAL files in a temp directory, not a mocked fs. These functions exist to
 * make a decision durable, and a mocked fs cannot tell a write that landed from one
 * that was merely called.
 *
 * THE assertions this file exists for:
 *   - activation NEVER creates a Slack channel (the replaced implementation did);
 *   - a declared channel that does not exist REFUSES and changes nothing;
 *   - an activation lands in a GITIGNORED file, so it survives a pull.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const bridgeState = require('../lib/bridge-state');

let tempDir;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-activation-'));
    bridgeState.init({
        channelMapFile: path.join(tempDir, 'channel-map.json'),
        activationFile: path.join(tempDir, 'agent-activation.json'),
        stateFile: path.join(tempDir, 'state.json'),
        processedTasksFile: path.join(tempDir, 'processed.json'),
    });
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.restoreAllMocks();
});

describe('the workspace channel map', () => {
    test('a resolved id survives being written and read back', () => {
        expect(bridgeState.getChannelId('jester-agent')).toBeNull();
        expect(bridgeState.setChannelId('jester-agent', 'C_JESTER')).toBe(true);
        expect(bridgeState.getChannelId('jester-agent')).toBe('C_JESTER');
    });

    test('re-recording the same id reports no change, so a caller can tell resolved from already-known', () => {
        bridgeState.setChannelId('jester-agent', 'C_JESTER');
        expect(bridgeState.setChannelId('jester-agent', 'C_JESTER')).toBe(false);
        expect(bridgeState.setChannelId('jester-agent', 'C_OTHER')).toBe(true);
    });

    test('a leading # is not part of the key', () => {
        bridgeState.setChannelId('#jester-agent', 'C_JESTER');
        expect(bridgeState.getChannelId('jester-agent')).toBe('C_JESTER');
    });

    test('a corrupt map reads as empty rather than throwing', () => {
        fs.writeFileSync(path.join(tempDir, 'channel-map.json'), '{not json');
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        expect(bridgeState.loadChannelMap()).toEqual({});
    });
});

describe('the activation store', () => {
    test('no entry is null, not false — a deactivation must be distinguishable from never touched', () => {
        expect(bridgeState.getActivation('storefront')).toBeNull();
        bridgeState.setActivation('storefront', false);
        expect(bridgeState.getActivation('storefront')).toBe(false);
        bridgeState.setActivation('storefront', true);
        expect(bridgeState.getActivation('storefront')).toBe(true);
    });

    test('clearing an entry returns to the "no local decision" state', () => {
        bridgeState.setActivation('storefront', true);
        expect(bridgeState.clearActivation('storefront')).toBe(true);
        expect(bridgeState.getActivation('storefront')).toBeNull();
        expect(bridgeState.clearActivation('storefront')).toBe(false);
    });

    test('a decision carries when it was made and any supplied provenance', () => {
        bridgeState.setActivation('jester', true, { by: 'U123' });
        const entry = bridgeState.loadActivations().jester;
        expect(entry.by).toBe('U123');
        expect(Date.parse(entry.at)).not.toBeNaN();
    });
});

describe('applyWorkspaceState merges the two halves', () => {
    const { applyWorkspaceState } = require('../lib/agent-registry');

    const definition = { id: 'x', channel_name: 'x-agent', default_status: 'planned' };

    test('an unresolved channel name yields a null channel, not a guess', () => {
        const record = applyWorkspaceState(definition, { channels: {}, activations: {} });
        expect(record.channel).toBeNull();
    });

    test('a resolved name yields the id the workspace recorded', () => {
        const record = applyWorkspaceState(definition, { channels: { 'x-agent': 'C_X' }, activations: {} });
        expect(record.channel).toBe('C_X');
    });

    test('with no local decision the declared default_status governs', () => {
        expect(applyWorkspaceState(definition, { channels: {}, activations: {} }).status).toBe('planned');
        expect(applyWorkspaceState({ ...definition, default_status: 'active' }, { channels: {}, activations: {} }).status)
            .toBeUndefined();
    });

    test('a local decision overrides the declared default in both directions', () => {
        const activated = applyWorkspaceState(definition, { channels: {}, activations: { x: { activated: true } } });
        expect(activated.status).toBeUndefined();

        const off = applyWorkspaceState({ ...definition, default_status: 'active' },
            { channels: {}, activations: { x: { activated: false } } });
        expect(off.status).toBe('planned');
    });
});

describe('activateAgent', () => {
    // Loaded after bridgeState.init so it sees the temp paths.
    const activation = require('../lib/agent-activation');
    const registry = require('../lib/agent-registry');

    /** A slack client stub that can FIND channels but has no create method at all. */
    function slackStub(known = {}) {
        return {
            findChannelByName: jest.fn(async (name) => (known[name] ? { channelId: known[name], name } : null)),
            joinAgentChannels: jest.fn(async (channels) => ({ joined: channels.length, failed: 0, total: channels.length })),
        };
    }

    test('an agent whose declared channel does not exist is REFUSED, and nothing is recorded', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        expect(planned).toBeDefined();

        const client = slackStub();
        const result = await activation.activateAgent(planned.id, client);

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/does not exist in this workspace/);
        expect(bridgeState.getActivation(planned.id)).toBeNull();
        expect(client.joinAgentChannels).not.toHaveBeenCalled();
    });

    test('nothing in the module can create a channel', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const client = { ...slackStub(), ensureChannel: jest.fn(), createChannel: jest.fn() };

        await activation.activateAgent(planned.id, client);

        expect(client.ensureChannel).not.toHaveBeenCalled();
        expect(client.createChannel).not.toHaveBeenCalled();
        // The source itself names neither, which is the enumerating half of the claim.
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-activation.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).not.toMatch(/ensureChannel|createChannel|conversations\.create/);
    });

    test('an existing channel resolves, joins, and records the decision', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const client = slackStub({ [planned.channel_name]: 'C_NEW' });

        const result = await activation.activateAgent(planned.id, client);

        expect(result.ok).toBe(true);
        expect(result.channelId).toBe('C_NEW');
        expect(result.joined).toBe(true);
        expect(bridgeState.getActivation(planned.id)).toBe(true);
        // Resolution is cached, so a second activation costs no Slack lookup.
        expect(bridgeState.getChannelId(planned.channel_name)).toBe('C_NEW');
    });

    test('an already-active agent is refused rather than re-activated', async () => {
        const active = registry.loadAgents().find(a => a.status !== 'planned');
        const result = await activation.activateAgent(active.id, slackStub());
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/already active/);
    });

    test('an unknown agent is refused by name', async () => {
        const result = await activation.activateAgent('no-such-agent', slackStub());
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/Agent not found/);
    });

    test('a rejected join refuses the activation instead of leaving an agent active with no reachable channel', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const client = slackStub({ [planned.channel_name]: 'C_NEW' });
        client.joinAgentChannels = jest.fn(async () => ({ joined: 0, failed: 1, total: 1 }));

        const result = await activation.activateAgent(planned.id, client);

        expect(result.ok).toBe(false);
        expect(bridgeState.getActivation(planned.id)).toBeNull();
    });

    test('the cache is consulted before Slack', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        bridgeState.setChannelId(planned.channel_name, 'C_CACHED');
        const client = slackStub();

        const resolution = await activation.resolveAgentChannel(
            { ...planned, channel_name: planned.channel_name }, client);

        expect(resolution).toMatchObject({ resolved: true, channelId: 'C_CACHED', source: 'cache' });
        expect(client.findChannelByName).not.toHaveBeenCalled();
    });

    test('getAgentsNeedingActivation lists planned agents WITH channels too', () => {
        const pending = activation.getAgentsNeedingActivation();
        expect(pending.length).toBeGreaterThan(0);
        for (const row of pending) {
            expect(typeof row.resolvable).toBe('boolean');
            expect(row).toHaveProperty('channel_name');
        }
    });
});

describe('the activation store is gitignored, which is the whole durability claim', () => {
    test('.gitignore names it, so a pull cannot discard a decision', () => {
        const ignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
        expect(ignore).toMatch(/^agents\/shared\/agent-activation\.json$/m);
        expect(ignore).toMatch(/^agents\/shared\/channel-map\.json$/m);
    });
});

describe('the activation command surface', () => {
    const activation = require('../lib/agent-activation');
    const registry = require('../lib/agent-registry');
    const router = require('../lib/command-router');

    function slackStub(known = {}) {
        return {
            findChannelByName: jest.fn(async (name) => (known[name] ? { channelId: known[name], name } : null)),
            joinAgentChannels: jest.fn(async (channels) => ({ joined: channels.length, failed: 0, total: channels.length })),
        };
    }

    test('the verbs are registered in the one command table', () => {
        for (const verb of ['available', 'activate', 'deactivate']) {
            expect(router.listVerbs()).toContain(verb);
            expect(router.isCommand(verb)).toBe(true);
        }
    });

    test('available lists what the markdown defines, separating ready from blocked', async () => {
        const result = await activation.handleAvailable();
        expect(result.ok).toBe(true);
        // Blocked agents are the ones whose declared channel has not resolved.
        const blocked = registry.loadAgents().filter(a => a.status === 'planned' && !a.channel);
        for (const agent of blocked) expect(result.text).toContain(agent.id);
        expect(result.text).toMatch(/Nothing here creates a channel/);
    });

    test('available invents no agent — every agent it lists is one the registry defines', async () => {
        const defined = new Set(registry.loadAgents().map(a => a.id));
        // Each listed agent is a bullet line opening with its id in backticks.
        const listed = [...(await activation.handleAvailable()).text.matchAll(/^• `([^`]+)`/gm)].map(m => m[1]);
        expect(listed.length).toBeGreaterThan(0);
        expect(listed.filter(id => !defined.has(id))).toEqual([]);
    });

    test('activate refuses an agent whose declared channel does not exist, and says why', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const result = await activation.handleActivate({ args: planned.id, slackClient: slackStub() });
        expect(result.ok).toBe(false);
        expect(result.text).toMatch(/does not exist in this workspace/);
        expect(result.text).toMatch(/Nothing was changed/);
        expect(bridgeState.getActivation(planned.id)).toBeNull();
    });

    test('activate with no argument explains itself rather than guessing an agent', async () => {
        const result = await activation.handleActivate({ args: '   ' });
        expect(result.ok).toBe(false);
        expect(result.text).toMatch(/Usage/);
    });

    // THE honesty assertion. An activation that cannot reach the running poll loop
    // must SAY a restart is needed. Claiming live effect it did not have is the
    // failure this whole dispatch exists to stop.
    test('without the re-registration hook it says a restart is needed, and does not imply otherwise', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const result = await activation.handleActivate({
            args: planned.id,
            slackClient: slackStub({ [planned.channel_name]: 'C_NEW' }),
        });
        expect(result.ok).toBe(true);
        expect(result.text).toMatch(/takes effect on the next/);
        expect(result.text).toMatch(/docker compose restart/);
        expect(result.text).not.toMatch(/now polled/);
    });

    test('with the hook it reports live effect, and the hook actually ran', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const onActivationChanged = jest.fn();
        const result = await activation.handleActivate({
            args: planned.id,
            slackClient: slackStub({ [planned.channel_name]: 'C_NEW' }),
            onActivationChanged,
        });
        expect(result.ok).toBe(true);
        expect(onActivationChanged).toHaveBeenCalled();
        expect(result.text).toMatch(/now polled, with its schedule registered/);
    });

    test('a hook that throws downgrades the claim instead of reporting success', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const result = await activation.handleActivate({
            args: planned.id,
            slackClient: slackStub({ [planned.channel_name]: 'C_NEW' }),
            onActivationChanged: jest.fn(() => { throw new Error('registrar exploded'); }),
        });
        expect(result.text).toMatch(/registrar exploded/);
        expect(result.text).toMatch(/takes effect on the next restart/);
    });

    // The durability claim, asserted rather than only written down.
    test('every activation verdict states that the decision survives a restart and a pull', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        const activated = await activation.handleActivate({
            args: planned.id,
            slackClient: slackStub({ [planned.channel_name]: 'C_NEW' }),
            onActivationChanged: jest.fn(),
        });
        const deactivated = await activation.handleDeactivate({ args: planned.id, onActivationChanged: jest.fn() });
        for (const text of [activated.text, deactivated.text]) {
            expect(text).toMatch(/survives a restart and a `git pull`/);
            expect(text).toMatch(/gitignored/);
        }
    });

    test('deactivate keeps the resolved channel so re-activating needs no Slack lookup', async () => {
        const planned = registry.loadAgents().find(a => a.status === 'planned' && !a.channel);
        await activation.handleActivate({
            args: planned.id,
            slackClient: slackStub({ [planned.channel_name]: 'C_NEW' }),
            onActivationChanged: jest.fn(),
        });
        await activation.handleDeactivate({ args: planned.id, onActivationChanged: jest.fn() });
        expect(bridgeState.getActivation(planned.id)).toBe(false);
        expect(bridgeState.getChannelId(planned.channel_name)).toBe('C_NEW');
    });

    test('bridge-agent supplies both seams the verbs need', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
        const call = src.slice(src.indexOf('commandRouter.runCommand('));
        const ctx = call.slice(0, call.indexOf('});'));
        expect(ctx).toMatch(/slackClient/);
        expect(ctx).toMatch(/onActivationChanged: reRegisterAgents/);
        // And the hook re-derives BOTH pieces of startup-only state.
        const fn = src.slice(src.indexOf('function reRegisterAgents()'));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).toMatch(/buildChannelsToPoll\(\)/);
        expect(body).toMatch(/startScheduler\(slack\)/);
    });
});
