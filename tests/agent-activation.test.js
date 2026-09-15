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
