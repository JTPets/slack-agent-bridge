'use strict';

/**
 * tests/agent-surface.test.js
 *
 * THE enumerating guard for the declared-agent surface. It walks the real
 * `agents/agents.json` from disk and fails when an agent's output stops reaching
 * anything — a new schedule on a channel-less agent, a task name with no handler, a
 * scheduled job posting into a channel the poll loop does not read, or a channel the
 * bridge never joins.
 *
 * The live assertion is "this set of orphans and no others", which is a list-equality
 * assertion. Both directions matter, so the negative controls at the bottom prove the
 * guard still detects what it claims to — the pattern from
 * tests/no-shell-execution.test.js.
 */

const path = require('path');
const {
    READER,
    describeSchedule,
    pollableChannels,
    joinableChannels,
    buildSurface,
    findOrphans,
    formatSurface,
} = require('../lib/agent-surface');
const { loadAgents } = require('../lib/agent-registry');

// The bridge channel is an env var the repo cannot see. Pin it to the registry's own
// bridge channel so the table is the live-shaped one rather than a checkout artifact.
const BRIDGE_CHANNEL = 'C0ANZUEJXEJ';

function surface() {
    return buildSurface({ bridgeChannel: BRIDGE_CHANNEL, env: { ...process.env, BRIDGE_CHANNEL_ID: BRIDGE_CHANNEL } });
}

describe('the declared-agent surface', () => {
    test('every agent in the registry gets exactly one row', () => {
        const agents = loadAgents();
        const rows = surface();
        expect(rows.map(r => r.id)).toEqual(agents.map(a => a.id));
    });

    test('every row answers all five questions the surface exists to answer', () => {
        for (const row of surface()) {
            expect(typeof row.channel === 'string' || row.channel === null).toBe(true);
            expect(typeof row.joined).toBe('boolean');
            expect(typeof row.scheduled).toBe('boolean');
            expect(typeof row.provider).toBe('string');
            expect(Object.values(READER)).toContain(row.reader);
        }
    });

    test('no row reports a provider without reporting where it came from', () => {
        for (const row of surface()) {
            expect(row.provider_source).toBeTruthy();
            expect(row.model_source).toBeTruthy();
        }
    });
});

describe('output that reaches nobody', () => {
    // THE live assertion. When this fails, an agent's output stopped reaching
    // something — read the diff, do not update the list to make it pass.
    //
    // Every entry here is a KNOWN, FILED state, not an accepted one:
    //   jester / social-media / marketing — a schedule with no channel. The scheduler
    //     silently skips them (`!agent.schedule || !agent.channel` -> continue), so
    //     unlike an unknown task name it is not even reported at startup. Jester is
    //     `active`, so it is the one that cannot be addressed at all: no channel, no
    //     job, and no agent-channel route to reach it.
    //   story-bot — registered, posts a TASK: message to a channel `getActiveAgents()`
    //     excludes from the poll loop because the agent is `planned`. WORK-TODO #3.
    const EXPECTED_ORPHANS = {
        'jester': 'schedule declared but not registered — schedule declared but agent has no channel',
        'social-media': 'schedule declared but not registered — schedule declared but agent has no channel',
        'marketing': 'schedule declared but not registered — schedule declared but agent has no channel',
        'story-bot': 'scheduled job posts a TASK: message to C0AP8CHCV1U, which the poll loop does not read',
    };

    test('the set of agents whose output reaches nobody is exactly the known set', () => {
        const found = {};
        for (const o of findOrphans(surface())) found[o.id] = o.problem;
        expect(found).toEqual(EXPECTED_ORPHANS);
    });

    test('every scheduled job the scheduler registers posts to a channel the bridge joins', () => {
        const unjoined = surface().filter(r => r.scheduled && !r.joined);
        expect(unjoined.map(r => r.id)).toEqual([]);
    });
});

describe('pollableChannels agrees with buildChannelsToPoll in bridge-agent.js', () => {
    // buildChannelsToPoll lives at module scope in bridge-agent.js and cannot be
    // called without loading the whole bridge, so the rule is re-stated purely in
    // lib/agent-surface.js. This asserts the four conditions are still the same four
    // by reading the live function's SOURCE — a rule restated in two places with
    // nothing comparing them is the drift this repo files as a defect.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    const fn = src.slice(src.indexOf('function buildChannelsToPoll()'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    test('it still skips the bridge agent, channel-less agents and the bridge channel', () => {
        expect(body).toMatch(/agent\.id === 'bridge'/);
        expect(body).toMatch(/!agent\.channel/);
        expect(body).toMatch(/agent\.channel === BRIDGE_CHANNEL/);
    });

    test('it still sources its agents from getActiveAgents, which is the planned filter', () => {
        expect(body).toMatch(/getActiveAgents\(\)/);
    });

    test('it still deduplicates by channel id', () => {
        expect(body).toMatch(/channels\.find\(c => c\.channelId === agent\.channel\)/);
    });

    test('the pure rule produces the five distinct channels the live one does', () => {
        const polled = pollableChannels(loadAgents(), BRIDGE_CHANNEL);
        // code-bridge and code-sqtools share C0AP42BT4MR — one channel, not two.
        expect(polled.size).toBe(5);
        expect(polled.has('C0AP42BT4MR')).toBe(true);
        // story-bot is `planned`, so its channel is joined but never polled.
        expect(polled.has('C0AP8CHCV1U')).toBe(false);
    });
});

describe('joinableChannels is a superset of the polled set, and creates nothing', () => {
    test('every polled channel is also joined', () => {
        const agents = loadAgents();
        const joined = new Set(joinableChannels(agents, BRIDGE_CHANNEL).map(c => c.channelId));
        for (const ch of pollableChannels(agents, BRIDGE_CHANNEL)) {
            expect(joined.has(ch)).toBe(true);
        }
    });

    test('it includes a planned agent\'s existing channel — the story-bot case', () => {
        const joined = joinableChannels(loadAgents(), BRIDGE_CHANNEL).map(c => c.channelId);
        expect(joined).toContain('C0AP8CHCV1U');
    });

    test('it invents no channel id that is not already in the registry or the env', () => {
        const agents = loadAgents();
        const declared = new Set(agents.map(a => a.channel).filter(Boolean));
        declared.add(BRIDGE_CHANNEL);
        for (const c of joinableChannels(agents, BRIDGE_CHANNEL)) {
            expect(declared.has(c.channelId)).toBe(true);
        }
    });

    test('it deduplicates the shared code-agent channel', () => {
        const ids = joinableChannels(loadAgents(), BRIDGE_CHANNEL).map(c => c.channelId);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Negative controls. Both live assertions above are "this list is exactly that
    // list", which passes just as happily against a broken enumerator that returns
    // nothing. These prove it does not.

    test('a new schedule on a channel-less agent is reported', () => {
        const rows = buildSurface({
            agents: [{ id: 'ghost', schedule: { cron: '0 9 * * *', task: 'morning-briefing' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        expect(findOrphans(rows)).toEqual([
            { id: 'ghost', problem: 'schedule declared but not registered — schedule declared but agent has no channel' },
        ]);
    });

    test('a task name with neither a handler nor a template is reported', () => {
        const d = describeSchedule({ id: 'x', channel: 'C1', schedule: { cron: '0 9 * * *', task: 'no-such-task' } });
        expect(d.registered).toBe(false);
        expect(d.reason).toMatch(/no handler and no template/);
    });

    test('a scheduled TASK: job in an unpolled channel is reported', () => {
        const rows = buildSurface({
            agents: [{ id: 'quiet', status: 'planned', channel: 'CZZZ', schedule: { cron: '0 9 * * *', task: 'nightly-audit' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        expect(findOrphans(rows)[0].problem).toMatch(/which the poll loop does not read/);
    });

    test('a deterministic job needs no poll loop and is NOT reported', () => {
        const rows = buildSurface({
            agents: [{ id: 'mail', status: 'planned', channel: 'CZZZ', schedule: { cron: '0 9 * * *', task: 'check-inbox' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        expect(rows[0].reader).toBe(READER.DETERMINISTIC);
        expect(findOrphans(rows)).toEqual([]);
    });

    test('a healthy polled agent produces no orphan', () => {
        const rows = buildSurface({
            agents: [{ id: 'fine', channel: 'CAAA', schedule: { cron: '0 9 * * *', task: 'nightly-audit' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        expect(rows[0].reader).toBe(READER.POLLED);
        expect(findOrphans(rows)).toEqual([]);
    });

    test('formatSurface renders one line per agent plus a header and a rule', () => {
        const lines = formatSurface(surface());
        expect(lines.length).toBe(loadAgents().length + 2);
    });
});
