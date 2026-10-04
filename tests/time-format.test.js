'use strict';

/**
 * tests/time-format.test.js
 *
 * Tests for lib/time-format.js and THE enumerating guards for WORK-TODO #33 and #32:
 *   - a UTC day key (`toISOString().split('T')[0]` / `.slice(0, 10)`) may not reappear in
 *     production code; a day key goes through dayKey(date, zone), which names its zone;
 *   - a bulletin timestamp is rendered by formatTimestamp, not by an inline option set.
 * Plus the boundary-hour fixture in both DST phases, and the staff-task regression: a
 * task state written at 21:30 Toronto is still "today" at 21:30 Toronto.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { dayKey, formatTimestamp, STORE_TIME_ZONE } = require('../lib/time-format');
const { listSourceFiles, stripComments, REPO_ROOT } = require('./helpers/source-scan');

const UTC_DAY_KEY = /\.toISOString\(\)\s*\.\s*(?:split\(\s*['"]T['"]\s*\)|slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\))/;
const INLINE_BULLETIN_TIME = /\.timestamp\)\s*\.\s*toLocale\w*String\s*\(/;

describe('dayKey', () => {
    test.each([
        ['EDT, after the UTC rollover', '2026-09-15T01:30:00Z', '2026-09-14', '2026-09-15'],
        ['EDT, before the UTC rollover', '2026-09-14T23:30:00Z', '2026-09-14', '2026-09-14'],
        ['EST, after the UTC rollover', '2026-01-15T00:30:00Z', '2026-01-14', '2026-01-15'],
        ['EST, Toronto midnight', '2026-01-15T05:00:00Z', '2026-01-15', '2026-01-15'],
    ])('%s', (_label, instant, toronto, utc) => {
        expect(dayKey(instant, STORE_TIME_ZONE)).toBe(toronto);
        expect(dayKey(instant, 'UTC')).toBe(utc);
    });

    test('UTC matches the idiom it replaced in lib/llm-metrics.js', () => {
        const d = new Date('2026-03-08T07:15:00Z');
        expect(dayKey(d, 'UTC')).toBe(d.toISOString().slice(0, 10));
    });

    test('a zone is required: forgetting one cannot silently give a UTC day', () => {
        expect(() => dayKey(new Date())).toThrow(/timeZone is required/);
    });
});

describe('formatTimestamp', () => {
    const t = '2026-09-14T18:05:00Z'; // 2:05 PM EDT

    test('datetime and date precision, in the store zone by default', () => {
        expect(formatTimestamp(t)).toBe('Sep 14, 2:05 PM');
        expect(formatTimestamp(t, { precision: 'date' })).toBe('Sep 14');
        expect(formatTimestamp(t, { timeZone: 'UTC' })).toBe('Sep 14, 6:05 PM');
    });

    test('an unknown precision throws', () => {
        expect(() => formatTimestamp(t, { precision: 'week' })).toThrow(/unknown precision/);
    });
});

describe('the enumerating guards', () => {
    const files = listSourceFiles().map((abs) => ({
        rel: path.relative(REPO_ROOT, abs),
        code: stripComments(fs.readFileSync(abs, 'utf8')),
    }));

    test('the patterns match what they forbid (negative controls)', () => {
        expect(UTC_DAY_KEY.test("const today = new Date().toISOString().split('T')[0];")).toBe(true);
        expect(UTC_DAY_KEY.test('return date.toISOString().slice(0, 10);')).toBe(true);
        expect(UTC_DAY_KEY.test('createdAt: new Date().toISOString(),')).toBe(false);
        expect(INLINE_BULLETIN_TIME.test("new Date(b.timestamp).toLocaleDateString('en-US', {")).toBe(true);
        expect(INLINE_BULLETIN_TIME.test('formatTimestamp(b.timestamp)')).toBe(false);
    });

    test('the walk covers the modules that held the defect', () => {
        const rels = files.map((f) => f.rel);
        for (const f of ['lib/staff-tasks.js', 'morning-digest.js', 'lib/llm-metrics.js', 'lib/agent-create.js', 'lib/agent-context.js']) {
            expect(rels).toContain(f);
        }
    });

    test('no production file builds a UTC day key from toISOString (WORK-TODO #33)', () => {
        expect(files.filter((f) => UTC_DAY_KEY.test(f.code)).map((f) => f.rel)).toEqual([]);
    });

    test('no production file renders a bulletin timestamp inline (WORK-TODO #32)', () => {
        expect(files.filter((f) => INLINE_BULLETIN_TIME.test(f.code)).map((f) => f.rel)).toEqual([]);
    });
});

describe('staff tasks use the store day (regression, WORK-TODO #33)', () => {
    const staffTasks = require('../lib/staff-tasks');
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-day-'));
        staffTasks.init({ stateFile: path.join(dir, 'state.json') });
        jest.useFakeTimers({ now: new Date('2026-09-15T01:30:00Z') }); // 21:30 EDT, Sep 14
    });

    afterEach(() => {
        jest.useRealTimers();
        staffTasks.init();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('init points the module at the given file and back', () => {
        expect(staffTasks.TASKS_STATE_FILE).toBe(path.join(dir, 'state.json'));
        staffTasks.init();
        expect(staffTasks.TASKS_STATE_FILE).toBe(staffTasks.DEFAULT_TASKS_STATE_FILE);
    });

    test("an evening task filed today is still today's at 21:30 (UTC would say tomorrow)", () => {
        staffTasks.saveTasksState({ date: '2026-09-14', tasks: [{ description: 'close till', completed: false }] });
        expect(staffTasks.getDailyTasks()).toHaveLength(1);
    });
});
