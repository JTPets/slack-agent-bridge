'use strict';

/**
 * tests/task-state-divergence.test.js
 *
 * THE GUARD for the reporting half of WORK-TODO #72: when the bridge's answers to
 * "is a task running?" diverge, the divergence is POSTED, not only logged.
 *
 * The lock and the queue writes are best effort by design, so they can fail while
 * the poll loop's in-memory `isRunning` carries on. Whether a failed lock should
 * refuse the dispatch instead is an owner decision recorded on #72. What this suite
 * pins is that every one of those failure sites in processTask posts to
 * #sqtools-ops, read from bridge-agent.js's own source.
 */

const fs = require('fs');
const path = require('path');

const { describeTaskStateDivergence, KINDS } = require('../lib/task-state-divergence');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

/** Each failure site: the log line that marks it, and the kind it must post. */
const SITES = [
    { marker: 'Running without a task lock', kind: 'lock_not_acquired' },
    { marker: "'[bridge-agent] Queue markRunning failed:'", kind: 'queue_not_marked_running' },
    { marker: "'[bridge-agent] Queue interrupt failed:'", kind: 'queue_terminal_write_failed' },
    { marker: "'[bridge-agent] Queue complete failed:'", kind: 'queue_terminal_write_failed' },
    { marker: "'[bridge-agent] Queue fail failed:'", kind: 'queue_terminal_write_failed' },
];

/** Sites in `src` whose failure is logged but not posted with the right kind. */
function unpostedSites(src) {
    const missing = [];
    for (const { marker, kind } of SITES) {
        const at = src.indexOf(marker);
        if (at < 0) { missing.push(`${marker} (site not found)`); continue; }
        const after = src.slice(at, at + 600);
        const re = new RegExp(`postToOps\\(describeTaskStateDivergence\\(\\{\\s*kind: '${kind}'`);
        if (!re.test(after)) missing.push(marker);
    }
    return missing;
}

describe('describeTaskStateDivergence', () => {
    test('every kind names the consequence and says the task was not stopped', () => {
        for (const kind of Object.keys(KINDS)) {
            const text = describeTaskStateDivergence({ kind, description: 'Fix it', error: 'EACCES', step: 'complete' });
            expect(text).toContain('Task: Fix it');
            expect(text).toContain('Error: EACCES');
            expect(text).toContain('Failed write: complete');
            expect(text).toContain(KINDS[kind].consequence);
            expect(text).toMatch(/not stopped/);
        }
    });

    test('a missing lock says the update gate would not wait', () => {
        expect(describeTaskStateDivergence({ kind: 'lock_not_acquired' }))
            .toMatch(/update during this task\s+would not wait for it/);
    });

    test('a failed terminal write says the gate defers until the entry ages out', () => {
        expect(describeTaskStateDivergence({ kind: 'queue_terminal_write_failed' }))
            .toMatch(/TASK_LOCK_STALE_MS/);
    });

    test('optional fields are omitted, not printed as undefined', () => {
        const text = describeTaskStateDivergence({ kind: 'queue_not_marked_running' });
        expect(text).not.toMatch(/undefined|Task:|Error:|Failed write:/);
    });

    test('an unknown kind throws rather than posting a vague message', () => {
        expect(() => describeTaskStateDivergence({ kind: 'nope' })).toThrow(/unknown kind/);
    });
});

describe('the guard detects what it claims to (negative controls)', () => {
    test('a site that only logs is reported', () => {
        const mutated = SOURCE.replace(
            /(\[bridge-agent\] Queue complete failed:', queueErr\.message\);)[\s\S]*?\}\)\);/,
            '$1'
        );
        expect(mutated).not.toBe(SOURCE);
        expect(unpostedSites(mutated)).toEqual(["'[bridge-agent] Queue complete failed:'"]);
    });

    test('a site posting the wrong kind is reported', () => {
        const mutated = SOURCE.replace(
            "kind: 'lock_not_acquired'", "kind: 'queue_not_marked_running'"
        );
        expect(unpostedSites(mutated)).toContain('Running without a task lock');
    });
});

describe('bridge-agent.js posts every task-state divergence', () => {
    test('all five failure sites post with the right kind', () => {
        expect(unpostedSites(SOURCE)).toEqual([]);
    });
});
