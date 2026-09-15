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
    // Every entry here is a KNOWN, FILED state, not an accepted one.
    //
    // LOGIC CHANGE 2026-09-15: story-bot's entry CHANGED CLASS, and that change is
    // the defect closing. It used to read "scheduled job posts a TASK: message to
    // C0AP8CHCV1U, which the poll loop does not read" — a job registered and firing
    // into a channel nothing collected. Joining, polling and scheduling now all
    // derive from one rule (`activeChannels`), so a planned agent gets none of the
    // three instead of one of them, and the reason is posted to #sqtools-ops at
    // startup rather than being a silent skip. story-bot is now one activation away
    // from having all three; it is not producing output nobody reads.
    //
    // jester is the one still worth staring at: it is ACTIVE, and its declared
    // channel #jester-agent has never resolved, so it cannot be addressed at all.
    // Creating that channel is an owner action (docs/AGENTS.md), not a dispatch's.
    const EXPECTED_ORPHANS = {
        'jester': 'schedule declared but not registered — schedule declared but #jester-agent has not been resolved to a channel id',
        'social-media': 'schedule declared but not registered — schedule declared but the agent is not activated in this workspace',
        'marketing': 'schedule declared but not registered — schedule declared but the agent is not activated in this workspace',
        'story-bot': 'schedule declared but not registered — schedule declared but the agent is not activated in this workspace',
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

describe('buildChannelsToPoll in bridge-agent.js does not restate the rule', () => {
    // LOGIC CHANGE 2026-09-15: this used to assert that the live function still
    // contained the same four conditions as the pure one — a comparison between two
    // statements of one rule. The two had already drifted once (joining took every
    // declared channel, polling took only active agents'), which is what left
    // story-bot joined to a channel nothing polled.
    //
    // A better comparison was not the fix. There is now ONE statement:
    // buildChannelsToPoll DELEGATES to activeChannels(). This asserts the delegation
    // and the absence of a second copy, which is a property a future edit cannot
    // satisfy by accident.
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    const fn = src.slice(src.indexOf('function buildChannelsToPoll()'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    test('it calls the shared rule', () => {
        expect(body).toMatch(/activeChannels\(loadAgents\(\), BRIDGE_CHANNEL\)/);
    });

    test('it no longer contains a second copy of the membership conditions', () => {
        expect(body).not.toMatch(/getActiveAgents\(\)/);
        expect(body).not.toMatch(/agent\.status === 'planned'/);
        expect(body).not.toMatch(/agent\.channel === BRIDGE_CHANNEL/);
    });

    test('the join set and the poll set are the same set, by construction', () => {
        const agents = loadAgents();
        const joined = joinableChannels(agents, BRIDGE_CHANNEL).map(c => c.channelId).sort();
        const polled = [...pollableChannels(agents, BRIDGE_CHANNEL)].sort();
        expect(joined).toEqual(polled);
    });

    test('a planned agent with a resolved channel gets neither, not one of the two', () => {
        const agents = [
            { id: 'active-one', channel: 'C_ACTIVE', channel_name: 'a' },
            { id: 'planned-one', channel: 'C_PLANNED', channel_name: 'p', status: 'planned' },
        ];
        expect(joinableChannels(agents, 'C_BRIDGE').map(c => c.channelId)).toEqual(['C_BRIDGE', 'C_ACTIVE']);
        expect([...pollableChannels(agents, 'C_BRIDGE')]).toEqual(['C_BRIDGE', 'C_ACTIVE']);
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

describe('joinableChannels is EXACTLY the polled set, and creates nothing', () => {
    test('every polled channel is also joined', () => {
        const agents = loadAgents();
        const joined = new Set(joinableChannels(agents, BRIDGE_CHANNEL).map(c => c.channelId));
        for (const ch of pollableChannels(agents, BRIDGE_CHANNEL)) {
            expect(joined.has(ch)).toBe(true);
        }
    });

    // LOGIC CHANGE 2026-09-15: this test previously asserted the OPPOSITE — that a
    // planned agent's channel IS joined, "the story-bot case". That was the defect
    // with a test sanctioning it: joining without polling is one consequence of a
    // declaration arriving without the other two, which is precisely how a weekly
    // job came to post where nothing read. It is flipped here in the same change as
    // the fix, not weakened.
    test('it does NOT include a planned agent\'s channel — join follows the same rule as poll', () => {
        const joined = joinableChannels(loadAgents(), BRIDGE_CHANNEL).map(c => c.channelId);
        const planned = loadAgents().filter(a => a.status === 'planned' && a.channel);
        expect(planned.length).toBeGreaterThan(0);
        for (const agent of planned) expect(joined).not.toContain(agent.channel);
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
            { id: 'ghost', problem: 'schedule declared but not registered — schedule declared but the agent declares no channel' },
        ]);
    });

    test('a task name with neither a handler nor a template is reported', () => {
        const d = describeSchedule({ id: 'x', channel: 'C1', schedule: { cron: '0 9 * * *', task: 'no-such-task' } });
        expect(d.registered).toBe(false);
        expect(d.reason).toMatch(/no handler and no template/);
    });

    // LOGIC CHANGE 2026-09-15: this control used to build the unpolled case with
    // `status: 'planned'` plus a channel, and assert the "poll loop does not read"
    // orphan. That combination no longer produces a registered job at all — it
    // produces a refusal, which is the fix. The control now asserts the refusal.
    test('a planned agent with a real channel is reported as not activated, not silently skipped', () => {
        const rows = buildSurface({
            agents: [{ id: 'quiet', status: 'planned', channel: 'CZZZ', schedule: { cron: '0 9 * * *', task: 'nightly-audit' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        expect(findOrphans(rows)[0].problem).toMatch(/not activated in this workspace/);
    });

    // The "posts where nothing polls" branch of findOrphans is now UNREACHABLE for a
    // real registry, because joining and polling come from one rule. The branch stays
    // as the assertion that they have not diverged again, so this proves it can still
    // fire — by handing buildSurface a row whose channel the rule excludes.
    test('the unpolled-channel orphan still fires if join and poll ever diverge', () => {
        const rows = buildSurface({
            agents: [{ id: 'drift', channel: 'CZZZ', schedule: { cron: '0 9 * * *', task: 'nightly-audit' } }],
            bridgeChannel: BRIDGE_CHANNEL,
            env: {},
        });
        // Simulate divergence: the row says scheduled + joined, but not polled.
        const diverged = [{ ...rows[0], polled: false, reader: READER.HUMAN_ONLY, joined: true }];
        expect(findOrphans(diverged)[0].problem).toMatch(/which the poll loop does not read/);
    });

    test('a deterministic job needs no poll loop and is NOT reported', () => {
        const rows = buildSurface({
            agents: [{ id: 'mail', channel: 'CZZZ', schedule: { cron: '0 9 * * *', task: 'check-inbox' } }],
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
