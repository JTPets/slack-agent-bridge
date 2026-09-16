/**
 * tests/backlog-report.test.js
 *
 * Tests for lib/backlog-report.js.
 *
 * The live assertion worth having is the AGREEMENT one: the parser's counts must equal
 * what WORK-TODO.md's own documented regeneration commands produce, computed here from
 * the same file. That never goes stale when the backlog changes, unlike a hardcoded
 * count — and a hardcoded count is exactly what WORK-TODO.md tells readers not to trust.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const backlog = require('../lib/backlog-report');

const NOW = new Date('2026-09-16T12:00:00Z');

describe('parseBacklog', () => {
    const SAMPLE = [
        '## P1 — tier one',
        '',
        '### 7. An item that is open',
        '**Filed 2026-09-01.** Some prose.',
        '**Priority:** P1 | **Effort:** Low',
        '**Status:** open — still open',
        '',
        '## P2 — tier two',
        '',
        '### 4b. A suffixed id',
        '**Filed 2026-09-14,** more prose.',
        '**Priority:** P2',
        '**Status:** open',
        '',
        '### 9. An item with no filed date',
        'Body with no filed marker.',
        '**Priority:** P3',
        '',
    ].join('\n');

    test('reads id, title, tier, filed date, priority and status', () => {
        const { items } = backlog.parseBacklog(SAMPLE, NOW);
        expect(items.map(i => i.id)).toEqual(['7', '4b', '9']);
        expect(items[0]).toMatchObject({ tier: 'P1', priority: 'P1', filed: '2026-09-01', ageDays: 15, open: true });
        expect(items[1]).toMatchObject({ id: '4b', tier: 'P2', filed: '2026-09-14', ageDays: 2 });
    });

    test('an item with no Filed date is REPORTED as unparsed, never silently dropped', () => {
        const { items, unparsed } = backlog.parseBacklog(SAMPLE, NOW);
        // Still present as an item...
        expect(items.find(i => i.id === '9')).toBeTruthy();
        expect(items.find(i => i.id === '9').ageDays).toBeNull();
        // ...and named, so the gap is visible rather than reducing the population.
        expect(unparsed.map(u => u.id)).toEqual(['9']);
        expect(unparsed[0].reason).toMatch(/Filed/);
    });

    test('a tier heading assigns every following item until the next one', () => {
        const { tiers } = backlog.parseBacklog(SAMPLE, NOW);
        expect(tiers).toEqual({ P1: 1, P2: 2, P3: 0, untiered: 0 });
    });

    test('the LEADING priority is taken, so a conditional priority counts once', () => {
        const text = ['## P2 — t', '', '### 1. x', '**Filed 2026-09-10.**', '**Priority:** P2, or P1 once the deploy lands', ''].join('\n');
        expect(backlog.parseBacklog(text, NOW).items[0].priority).toBe('P2');
    });
});

describe('ageDays and readsAsOpen', () => {
    test('ages in whole days from midnight UTC', () => {
        expect(backlog.ageDays('2026-09-16', NOW)).toBe(0);
        expect(backlog.ageDays('2026-09-15', NOW)).toBe(1);
        expect(backlog.ageDays('not-a-date', NOW)).toBeNull();
    });

    test('a missing status reads as open, because closed items are purged', () => {
        expect(backlog.readsAsOpen(null)).toBe(true);
        expect(backlog.readsAsOpen('open — waiting on the owner')).toBe(true);
        expect(backlog.readsAsOpen('closed 2026-09-15')).toBe(false);
    });
});

describe('loadBacklog against the repository\'s own WORK-TODO.md', () => {
    const loaded = backlog.loadBacklog({ now: NOW });
    const text = fs.readFileSync(backlog.BACKLOG_FILE, 'utf8');

    test('it is readable and parses to a non-empty set', () => {
        expect(loaded.available).toBe(true);
        expect(loaded.items.length).toBeGreaterThan(0);
    });

    test('the item count AGREES with WORK-TODO.md\'s own documented count command', () => {
        // `grep -cE '^### [0-9]+[a-z]?\. ' WORK-TODO.md`
        const byGrep = text.split('\n').filter(l => /^### [0-9]+[a-z]?\. /.test(l)).length;
        expect(loaded.items.length).toBe(byGrep);
    });

    test('the per-tier tally AGREES with the file\'s own awk command', () => {
        // awk '/^## P1/{t="P1"} … /^### [0-9]/{print t}' | sort | uniq -c
        const byAwk = { P1: 0, P2: 0, P3: 0 };
        let tier = null;
        for (const line of text.split('\n')) {
            if (/^## P1/.test(line)) tier = 'P1';
            else if (/^## P2/.test(line)) tier = 'P2';
            else if (/^## P3/.test(line)) tier = 'P3';
            else if (/^### [0-9]/.test(line) && tier) byAwk[tier] += 1;
        }
        expect({ P1: loaded.tiers.P1, P2: loaded.tiers.P2, P3: loaded.tiers.P3 }).toEqual(byAwk);
    });

    test('no duplicate ids — the same check the file asks to be run before filing', () => {
        const ids = loaded.items.map(i => i.id);
        expect(ids.length).toBe(new Set(ids).size);
    });
});

describe('a missing file is UNAVAILABLE, never an empty backlog', () => {
    test('an unreadable file reports a reason and available:false', () => {
        const missing = path.join(os.tmpdir(), `no-such-backlog-${Date.now()}.md`);
        const r = backlog.loadBacklog({ file: missing, now: NOW });
        expect(r.available).toBe(false);
        expect(r.reason).toMatch(/could not read/);
        expect(r.items).toEqual([]);
    });

    test('a file that parses to zero items is UNAVAILABLE, not a clean backlog', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-'));
        const file = path.join(dir, 'WORK-TODO.md');
        try {
            fs.writeFileSync(file, '# nothing that looks like an item heading\n');
            const r = backlog.loadBacklog({ file, now: NOW });
            expect(r.available).toBe(false);
            expect(r.reason).toMatch(/zero items/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('stalest', () => {
    const items = [
        { id: 'a', open: true, ageDays: 1 },
        { id: 'b', open: true, ageDays: 9 },
        { id: 'c', open: true, ageDays: 4 },
        { id: 'd', open: false, ageDays: 40 },
        { id: 'e', open: true, ageDays: null },
    ];

    test('oldest first, closed items and unaged items excluded', () => {
        expect(backlog.stalest(items, { limit: 10 }).map(i => i.id)).toEqual(['b', 'c', 'a']);
    });

    test('minAgeDays filters, and limit truncates', () => {
        expect(backlog.stalest(items, { limit: 10, minAgeDays: 4 }).map(i => i.id)).toEqual(['b', 'c']);
        expect(backlog.stalest(items, { limit: 1 }).map(i => i.id)).toEqual(['b']);
    });
});
