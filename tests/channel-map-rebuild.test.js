'use strict';

/**
 * tests/channel-map-rebuild.test.js
 *
 * Tests for lib/channel-map-rebuild.js — THE reproduction path for the workspace
 * channel mapping (WORK-TODO #55).
 *
 * The assertions this file exists for:
 *   - the mapping is recoverable from the repository ALONE, with no Slack call and no
 *     human reading terminal output;
 *   - recovery keys by the agent's CURRENT declared name, so a name correction does
 *     not orphan a recovered id;
 *   - a value already resolved against the live workspace is NEVER overwritten by a
 *     reconstructed one;
 *   - nothing here creates a Slack channel, and nothing invents an id.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const bridgeState = require('../lib/bridge-state');
const rebuild = require('../lib/channel-map-rebuild');

let workspace;
beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-map-rebuild-'));
    bridgeState.init({
        channelMapFile: path.join(workspace, 'channel-map.json'),
        activationFile: path.join(workspace, 'agent-activation.json'),
        stateFile: path.join(workspace, 'state.json'),
        processedTasksFile: path.join(workspace, 'processed-tasks.json'),
    });
});
afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
});

/** A legacy read as readLegacyRegistry() returns one, without touching git. */
function legacy(agents, ok = true) {
    return { ok, source: 'injected', agents, reason: ok ? undefined : 'injected failure' };
}

describe('the mapping is recoverable from this repository alone', () => {
    test('the legacy registry is readable at HEAD, from git history, after its file was deleted', () => {
        // THE claim the whole reproduction path rests on. agents/agents.json is gone
        // from the working tree — this must still find it.
        expect(fs.existsSync(path.join(__dirname, '..', 'agents', 'agents.json'))).toBe(false);
        const read = rebuild.readLegacyRegistry();
        expect(read.ok).toBe(true);
        expect(read.source).toMatch(/agents\/agents\.json/);
        expect(Array.isArray(read.agents)).toBe(true);
        expect(read.agents.length).toBeGreaterThan(0);
    });

    test('a real reconstruction recovers an id for every active agent the legacy file had one for', () => {
        const result = rebuild.reconstructFromHistory({ dryRun: true });
        expect(result.ok).toBe(true);
        expect(result.conflicts).toEqual([]);
        // Keyed by the CURRENT declared names, not the convention the migration used.
        expect(Object.keys(result.recovered).sort()).toEqual([
            'claude-bridge', 'code-review', 'email-monitor-agent',
            'secretary-inbox', 'social-media', 'sqtools-alerts',
        ]);
    });

    test('a dry run writes nothing', () => {
        rebuild.reconstructFromHistory({ dryRun: true });
        expect(bridgeState.loadChannelMap()).toEqual({});
    });

    test('a real run writes the map, and a second run is a no-op', () => {
        const first = rebuild.reconstructFromHistory();
        expect(Object.keys(first.added).length).toBeGreaterThan(0);
        expect(bridgeState.loadChannelMap()).toEqual(first.recovered);

        const second = rebuild.reconstructFromHistory();
        expect(second.added).toEqual({});
    });
});

describe('recovery joins on the agent id, so a name correction cannot orphan an id', () => {
    test('the id follows the agent to whatever name its definition now declares', () => {
        const result = rebuild.reconstructFromHistory({
            dryRun: true,
            legacy: legacy([{ id: 'secretary', channel: 'C_OLD_SECRETARY' }]),
            agents: [{ id: 'secretary', channel_name: 'a-completely-different-name' }],
        });
        expect(result.recovered).toEqual({ 'a-completely-different-name': 'C_OLD_SECRETARY' });
    });

    test('a legacy record with no current definition is reported, not silently dropped', () => {
        const result = rebuild.reconstructFromHistory({
            dryRun: true,
            legacy: legacy([{ id: 'deleted-agent', channel: 'C_GHOST' }]),
            agents: [],
        });
        expect(result.recovered).toEqual({});
        expect(result.conflicts).toEqual([
            'deleted-agent: held C_GHOST but no current definition declares a channel_name for it',
        ]);
    });

    test('two agents sharing one declared name and one id is normal, not a conflict', () => {
        const result = rebuild.reconstructFromHistory({
            dryRun: true,
            legacy: legacy([{ id: 'a', channel: 'C_SHARED' }, { id: 'b', channel: 'C_SHARED' }]),
            agents: [{ id: 'a', channel_name: 'code-review' }, { id: 'b', channel_name: 'code-review' }],
        });
        expect(result.recovered).toEqual({ 'code-review': 'C_SHARED' });
        expect(result.conflicts).toEqual([]);
    });

    test('two DIFFERENT ids claiming one name recovers NEITHER, and says so', () => {
        const result = rebuild.reconstructFromHistory({
            dryRun: true,
            legacy: legacy([{ id: 'a', channel: 'C_ONE' }, { id: 'b', channel: 'C_TWO' }]),
            agents: [{ id: 'a', channel_name: 'shared' }, { id: 'b', channel_name: 'shared' }],
        });
        expect(result.recovered).toEqual({});
        expect(result.conflicts[0]).toMatch(/both claim it/);
    });
});

describe('a live value always beats a reconstructed one', () => {
    test('an existing mapping is kept and the history value is reported as ignored', () => {
        bridgeState.setChannelId('secretary-inbox', 'C_LIVE');
        const result = rebuild.reconstructFromHistory({
            legacy: legacy([{ id: 'secretary', channel: 'C_FROM_HISTORY' }]),
            agents: [{ id: 'secretary', channel_name: 'secretary-inbox' }],
        });
        expect(bridgeState.getChannelId('secretary-inbox')).toBe('C_LIVE');
        expect(result.added).toEqual({});
        expect(result.kept['secretary-inbox']).toEqual({ keeping: 'C_LIVE', ignored: 'C_FROM_HISTORY' });
    });

    test('an unreadable legacy source fails with a reason and changes nothing', () => {
        const result = rebuild.reconstructFromHistory({ legacy: legacy(null, false) });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('injected failure');
        expect(bridgeState.loadChannelMap()).toEqual({});
    });
});

describe('live resolution creates nothing and invents nothing', () => {
    /** A client that can FIND channels and has no create method at all. */
    function slackStub(known = {}) {
        return {
            findChannelByName: jest.fn(async (name) => (known[name] ? { channelId: known[name], name } : null)),
        };
    }

    test('a declared name that does not exist is UNRESOLVED with a reason, never invented', async () => {
        const client = slackStub({});
        const outcome = await rebuild.resolveDeclaredChannels({
            slackClient: client,
            agents: [{ id: 'jester', channel_name: 'jester-agent' }],
        });
        expect(outcome.resolved).toEqual([]);
        expect(outcome.unresolved[0].reason).toMatch(/does not exist in this workspace/);
        expect(bridgeState.loadChannelMap()).toEqual({});
    });

    test('a name that exists is resolved once and then cached', async () => {
        const client = slackStub({ 'secretary-inbox': 'C_FOUND' });
        const agents = [{ id: 'secretary', channel_name: 'secretary-inbox' }];
        const first = await rebuild.resolveDeclaredChannels({ slackClient: client, agents });
        expect(first.resolved[0]).toMatchObject({ channelId: 'C_FOUND', source: 'slack' });

        const second = await rebuild.resolveDeclaredChannels({ slackClient: client, agents });
        expect(second.resolved[0].source).toBe('cache');
        expect(client.findChannelByName).toHaveBeenCalledTimes(1);
    });

    test('a planned agent is skipped unless asked for, so recovery does not activate anything', async () => {
        const client = slackStub({ marketing: 'C_MARKETING' });
        const agents = [{ id: 'marketing', channel_name: 'marketing', status: 'planned' }];
        expect((await rebuild.resolveDeclaredChannels({ slackClient: client, agents })).resolved).toEqual([]);
        const opened = await rebuild.resolveDeclaredChannels({ slackClient: client, agents, includePlanned: true });
        expect(opened.resolved[0].channelId).toBe('C_MARKETING');
    });

    test('the module names no channel-creating API at all', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channel-map-rebuild.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).not.toMatch(/ensureChannel|createChannel|conversations\.create/);
    });

    test('every git call is an argv array — no shell string is ever built', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'channel-map-rebuild.js'), 'utf8');
        expect(src).not.toMatch(/execSync|shell\s*:\s*true/);
        expect(src).toMatch(/execFileSync\('git', args/);
    });
});

describe('the read-only report answers the question without touching anything', () => {
    test('every declared agent gets one row saying resolved or not', () => {
        const rows = rebuild.report([
            { id: 'a', channel_name: 'x', channel: 'C_X' },
            { id: 'b', channel_name: 'y', channel: null, status: 'planned' },
        ]);
        expect(rows).toEqual([
            { id: 'a', status: 'active', channel_name: 'x', channel: 'C_X', resolved: true },
            { id: 'b', status: 'planned', channel_name: 'y', channel: null, resolved: false },
        ]);
        expect(rebuild.formatReport(rows).join('\n')).toMatch(/UNRESOLVED/);
    });
});
