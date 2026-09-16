/**
 * tests/critique-digest.test.js
 *
 * Tests for lib/critique-digest.js and lib/critique-signals.js.
 *
 * THE PROPERTY UNDER TEST, above all others: an UNAVAILABLE signal is never rendered
 * as an empty one. "Nothing failed this week" and "I could not read the queue" are
 * opposite findings, and a critique that confuses them is the false-green class this
 * repository treats as its worst defect. Every signal is exercised in both states.
 */

'use strict';

const digest = require('../lib/critique-digest');
const signals = require('../lib/critique-signals');

const NOW = new Date('2026-09-16T12:00:00Z');

/** A deps bag where every source succeeds and reports something. */
function healthyDeps(overrides = {}) {
    return {
        backlog: {
            loadBacklog: () => ({
                available: true, reason: null,
                items: [
                    { id: '17', title: 'nothing starts auto-update', tier: 'P1', ageDays: 11, filed: '2026-09-05', open: true },
                    { id: '3', title: 'scheduler', tier: 'P1', ageDays: 2, filed: '2026-09-14', open: true },
                ],
                tiers: { P1: 2, P2: 0, P3: 0, untiered: 0 },
                unparsed: [{ id: '9', title: 'undated', reason: 'no **Filed** date' }],
            }),
            stalest: (items, o) => items.filter(i => i.ageDays >= (o.minAgeDays || 0)).sort((a, b) => b.ageDays - a.ageDays).slice(0, o.limit),
        },
        history: {
            revisionsSince: () => ({ available: true, reason: null, count: 30 }),
            commitsSince: () => ({
                available: true, reason: null,
                commits: [{ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', date: '2026-09-15T00:00:00Z', subject: 'did a thing', body: 'Addresses #3' }],
            }),
            claimsFrom: () => ({ closes: [], addresses: [{ id: '3', sha: 'aaaaaaa' }], repeatedlyAddressed: [{ id: '3', count: 4, shas: ['a', 'b', 'c', 'd'] }] }),
        },
        queue: {
            getRecentCompleted: () => [
                { description: 'quick one', status: 'completed', startedAt: '2026-09-16T10:00:00Z', completedAt: '2026-09-16T10:02:00Z' },
                { description: 'another quick one', status: 'completed', startedAt: '2026-09-16T10:00:00Z', completedAt: '2026-09-16T10:02:00Z' },
                { description: 'the long one', status: 'completed', startedAt: '2026-09-16T09:00:00Z', completedAt: '2026-09-16T09:40:00Z' },
                { description: 'the broken one', status: 'failed', error: 'boom', attempts: 2, previousStatus: 'interrupted', startedAt: '2026-09-16T08:00:00Z', completedAt: '2026-09-16T08:01:00Z' },
            ],
        },
        bulletins: {
            getBulletins: () => [{ type: 'milestone', agentId: 'story-bot', timestamp: '2026-09-15T00:00:00Z', data: { description: 'x' } }],
            formatBulletinData: () => 'description: x',
        },
        surface: {
            buildSurface: () => [],
            findOrphans: () => [{ id: 'jester', problem: 'no channel' }],
        },
        ...overrides,
    };
}

describe('buildDigest assembles every signal', () => {
    const d = digest.buildDigest({ now: NOW, deps: healthyDeps() });

    test('it carries the window it measured', () => {
        expect(d.windowDays).toBe(7);
        expect(d.generatedAt).toBe(NOW.toISOString());
        expect(Date.parse(d.windowSince)).toBe(NOW.getTime() - 7 * 86400000);
    });

    test('backlog: open count, tiers, undated count and revision count', () => {
        expect(d.backlog).toMatchObject({ available: true, open: 2, undated: 1, revisions: 30, overThreshold: 1 });
        expect(d.backlog.stale.map(i => i.id)).toEqual(['17', '3']);
    });

    test('the oldest items are listed even when NONE crosses the stale threshold', () => {
        // The first implementation filtered on STALE_DAYS and returned []. With every
        // item under three days old that emptied the sharpest signal in the digest.
        const deps = healthyDeps();
        const base = deps.backlog.loadBacklog();
        deps.backlog.loadBacklog = () => ({ ...base, items: base.items.map(i => ({ ...i, ageDays: 1 })) });
        const young = digest.buildDigest({ now: NOW, deps });
        expect(young.backlog.overThreshold).toBe(0);
        expect(young.backlog.stale).toHaveLength(2);
    });

    test('claims: repeatedly-addressed items come through', () => {
        expect(d.history.repeatedlyAddressed).toEqual([{ id: '3', count: 4, shas: ['a', 'b', 'c', 'd'] }]);
    });

    test('tasks: counts, failures, re-attempts and duration outliers', () => {
        expect(d.tasks.counts).toEqual({ completed: 3, failed: 1, interrupted: 0 });
        expect(d.tasks.medianMinutes).toBe(2);
        expect(d.tasks.failures[0]).toMatchObject({ description: 'the broken one', attempts: 2, error: 'boom' });
        expect(d.tasks.reattempted[0]).toMatchObject({ description: 'the broken one', attempts: 2, previousStatus: 'interrupted' });
        // 40 min against a 2 min median: over 3x and over the 5 min floor.
        expect(d.tasks.slow.map(s => s.description)).toEqual(['the long one']);
    });

    test('tasks: the 24-hour retention window is carried beside the counts', () => {
        expect(d.tasks.retentionHours).toBe(24);
    });

    test('orphans are reused from the agent surface, not re-derived', () => {
        expect(d.orphans.items).toEqual([{ id: 'jester', problem: 'no channel' }]);
    });

    test('the running commit is reported as UNKNOWN with the reason, never omitted', () => {
        expect(d.deploy.runningCommit).toBeNull();
        expect(d.deploy.reason).toMatch(/#17/);
    });
});

describe('an unavailable signal is never an empty one', () => {
    test('a backlog that cannot be read reports available:false and a reason', () => {
        const deps = healthyDeps({ backlog: { loadBacklog: () => ({ available: false, reason: 'could not read WORK-TODO.md: ENOENT', items: [], tiers: null, unparsed: [] }), stalest: () => [] } });
        const d = digest.buildDigest({ now: NOW, deps });
        expect(d.backlog).toMatchObject({ available: false, open: 0 });
        expect(d.backlog.reason).toMatch(/could not read/);
    });

    test('a shallow or absent git checkout reports available:false, not zero commits', () => {
        const deps = healthyDeps();
        deps.history.commitsSince = () => ({ available: false, reason: 'the checkout is a shallow clone', commits: [] });
        const d = digest.buildDigest({ now: NOW, deps });
        expect(d.history).toMatchObject({ available: false, commits: 0 });
        expect(digest.formatDigestForPrompt(d)).toContain('CLAIMS: UNAVAILABLE');
    });

    test('a queue that throws reports available:false, not "nothing failed"', () => {
        const deps = healthyDeps({ queue: { getRecentCompleted: () => { throw new Error('EACCES'); } } });
        const d = digest.buildDigest({ now: NOW, deps });
        expect(d.tasks).toMatchObject({ available: false, counts: null });
        expect(d.tasks.reason).toMatch(/EACCES/);
        expect(digest.formatDigestForPrompt(d)).toContain('TASKS: UNAVAILABLE');
    });

    test('a bulletin board that throws is unavailable, and a surface that throws too', () => {
        const d = digest.buildDigest({
            now: NOW,
            deps: healthyDeps({
                bulletins: { getBulletins: () => { throw new Error('corrupt'); } },
                surface: { buildSurface: () => { throw new Error('registry gone'); }, findOrphans: () => [] },
            }),
        });
        expect(d.bulletins).toMatchObject({ available: false, items: [] });
        expect(d.orphans).toMatchObject({ available: false, items: [] });
    });

    test('every UNAVAILABLE line tells the reader not to call it "nothing to report"', () => {
        const deps = healthyDeps();
        deps.history.commitsSince = () => ({ available: false, reason: 'no git', commits: [] });
        const text = digest.formatDigestForPrompt(digest.buildDigest({ now: NOW, deps }));
        expect(text).toMatch(/Do not report this as "nothing to report"/);
    });
});

describe('thinness', () => {
    /** Every windowed source available and empty. */
    function quietDeps() {
        const deps = healthyDeps();
        deps.history.commitsSince = () => ({ available: true, reason: null, commits: [] });
        deps.history.claimsFrom = () => ({ closes: [], addresses: [], repeatedlyAddressed: [] });
        deps.queue = { getRecentCompleted: () => [] };
        deps.bulletins = { getBulletins: () => [], formatBulletinData: () => '' };
        return deps;
    }

    test('a week with no commits, no terminal tasks and no bulletins is THIN', () => {
        expect(digest.buildDigest({ now: NOW, deps: quietDeps() }).thin).toBe(true);
    });

    test('a standing backlog does NOT make a quiet week eventful', () => {
        // Deliberate: an item open for eleven days is not news on the twelfth. Counting
        // it would make every week look eventful and guarantee a padded post.
        const d = digest.buildDigest({ now: NOW, deps: quietDeps() });
        expect(d.backlog.open).toBe(2);
        expect(d.thin).toBe(true);
    });

    test('one commit is enough to make a week not thin', () => {
        const deps = quietDeps();
        deps.history.commitsSince = () => ({ available: true, reason: null, commits: [{ sha: 'a', shortSha: 'a', subject: 's', body: '' }] });
        expect(digest.buildDigest({ now: NOW, deps }).thin).toBe(false);
    });

    test('one terminal task is enough, and one bulletin is enough', () => {
        const withTask = quietDeps();
        withTask.queue = { getRecentCompleted: () => [{ description: 'x', status: 'completed' }] };
        expect(digest.buildDigest({ now: NOW, deps: withTask }).thin).toBe(false);

        const withBulletin = quietDeps();
        withBulletin.bulletins = { getBulletins: () => [{ type: 'alert', agentId: 'a', timestamp: NOW.toISOString(), data: {} }], formatBulletinData: () => '' };
        expect(digest.buildDigest({ now: NOW, deps: withBulletin }).thin).toBe(false);
    });

    test('UNAVAILABLE is not thin — a missing sensor is unknown, not quiet', () => {
        const deps = quietDeps();
        deps.history.commitsSince = () => ({ available: false, reason: 'no git', commits: [] });
        expect(digest.buildDigest({ now: NOW, deps }).thin).toBe(false);
    });
});

describe('formatDigestForPrompt', () => {
    const text = digest.formatDigestForPrompt(digest.buildDigest({ now: NOW, deps: healthyDeps() }));

    test('it states that every figure was computed, not judged', () => {
        expect(text).toMatch(/computed from a file or from `git log`/);
        expect(text).toMatch(/None of it is an opinion/);
    });

    test('it names the queue retention beside the task counts', () => {
        expect(text).toMatch(/retains 24 hours/);
        expect(text).toMatch(/AT MOST the last day/);
    });

    test('it says the running commit is unknown', () => {
        expect(text).toMatch(/Running commit: UNKNOWN/);
    });

    test('bulletins are present but are the shortest section', () => {
        const section = text.slice(text.indexOf('BULLETINS'));
        expect(section.split('\n').length).toBeLessThan(10);
    });
});

describe('formatCoverage', () => {
    test('a quiet week still names what was checked, so silence is evidence', () => {
        const line = digest.formatCoverage(digest.buildDigest({ now: NOW, deps: healthyDeps() }));
        expect(line).toMatch(/commits/);
        expect(line).toMatch(/task outcomes/);
        expect(line).toMatch(/backlog ages/);
    });

    test('an unavailable source is named as unavailable in the coverage line', () => {
        const deps = healthyDeps();
        deps.history.commitsSince = () => ({ available: false, reason: 'no git', commits: [] });
        expect(digest.formatCoverage(digest.buildDigest({ now: NOW, deps }))).toMatch(/commits \(UNAVAILABLE: no git\)/);
    });
});

describe('helpers', () => {
    test('durationMinutes rejects missing, unparseable and reversed stamps', () => {
        expect(signals.durationMinutes('2026-09-16T10:00:00Z', '2026-09-16T10:30:00Z')).toBe(30);
        expect(signals.durationMinutes(null, '2026-09-16T10:30:00Z')).toBeNull();
        expect(signals.durationMinutes('2026-09-16T10:30:00Z', '2026-09-16T10:00:00Z')).toBeNull();
        expect(signals.durationMinutes('nope', 'nope')).toBeNull();
    });

    test('median handles odd, even and empty', () => {
        expect(signals.median([3, 1, 2])).toBe(2);
        expect(signals.median([1, 2, 3, 4])).toBe(2.5);
        expect(signals.median([])).toBeNull();
    });
});
