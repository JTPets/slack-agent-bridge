'use strict';

/**
 * tests/zoned-calendar.test.js
 *
 * WORK-TODO #76: calendar arithmetic in the store's zone. The calendar's day range, the
 * holiday and pet-awareness dates, the standup weekday, the secretary's "tomorrow" and the
 * staff-task clock were built from a Date's LOCAL fields, so they followed the process
 * timezone. The container runs with TZ America/New_York, which shares Toronto's offset,
 * so nothing was wrong on the box; in a UTC container "today" would have started at
 * 19:00 or 20:00 Toronto the day before. These tests run the real modules in child
 * processes under several TZ values and require the same answer from each.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { zonedParts, addDays, zonedMidnight, dayKey } = require('../lib/time-format');

const ROOT = path.join(__dirname, '..');
const ZONES = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York', 'America/Toronto'];
const runIn = (tz, script) => execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8',
});
const sameEverywhere = (script) => {
    const out = ZONES.map((tz) => [tz, runIn(tz, script)]);
    for (const [, value] of out) expect(value).toBe(out[0][1]);
    return out[0][1];
};

describe('lib/time-format.js zoned helpers', () => {
    test('zonedParts reads Toronto wall-clock fields, weekday as Date#getDay', () => {
        // 03:30 UTC on Sat 2026-11-07 is 22:30 on Fri 2026-11-06 in Toronto.
        expect(zonedParts('2026-11-07T03:30:00Z', 'America/Toronto')).toEqual({
            year: 2026, month: 11, day: 6, hour: 22, minute: 30, second: 0, weekday: 5,
        });
        // Midnight is hour 0, never 24.
        expect(zonedParts('2026-11-07T05:00:00Z', 'America/Toronto').hour).toBe(0);
    });

    test('addDays is calendar arithmetic, across months, years and DST', () => {
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
        expect(addDays('2026-03-08', 0)).toBe('2026-03-08');
    });

    test('zonedMidnight in both DST phases and on both transition days', () => {
        expect(zonedMidnight('2026-07-01', 'America/Toronto').toISOString()).toBe('2026-07-01T04:00:00.000Z');
        expect(zonedMidnight('2026-01-15', 'America/Toronto').toISOString()).toBe('2026-01-15T05:00:00.000Z');
        expect(zonedMidnight('2026-03-08', 'America/Toronto').toISOString()).toBe('2026-03-08T05:00:00.000Z');
        expect(zonedMidnight('2026-11-01', 'America/Toronto').toISOString()).toBe('2026-11-01T04:00:00.000Z');
        expect(zonedMidnight('2026-11-07', 'UTC').toISOString()).toBe('2026-11-07T00:00:00.000Z');
    });

    test('zonedMidnight round-trips through dayKey for every day of 2026', () => {
        let key = '2026-01-01';
        for (let i = 0; i < 365; i += 1) {
            expect(dayKey(zonedMidnight(key, 'America/Toronto'), 'America/Toronto')).toBe(key);
            key = addDays(key, 1);
        }
    });

    test('every helper refuses a missing zone', () => {
        expect(() => zonedParts(new Date())).toThrow(/timeZone is required/);
        expect(() => zonedMidnight('2026-01-01')).toThrow(/timeZone is required/);
    });
});

describe('the store-day readers give one answer in every process zone (real child processes)', () => {
    test('local-date parseDate/formatDate and a bare YYYY-MM-DD string', () => {
        const out = sameEverywhere(
            "const d=require('./lib/integrations/local-date');" +
            "const t=new Date('2026-11-07T03:30:00Z');" +
            "process.stdout.write(JSON.stringify([d.parseDate(t),d.formatDate(t),d.parseDate('2026-12-25')]))");
        expect(JSON.parse(out)).toEqual([{ year: 2026, month: 11, day: 6 }, '2026-11-06', { year: 2026, month: 12, day: 25 }]);
    });

    test('pet-awareness upcoming dates', () => {
        sameEverywhere(
            "const p=require('./lib/integrations/pet-awareness');" +
            "process.stdout.write(JSON.stringify(p.getUpcomingPetAwareness(60,new Date('2026-03-31T03:30:00Z'))))");
    });

    test('the standup type auto-detected late on a Monday in Toronto', () => {
        // 23:30 Monday Toronto = Tuesday in UTC and Tokyo; kickoff only if read in Toronto
        // (the default type is retro, so a Friday case would pass either way).
        const out = sameEverywhere(
            "const RealDate=Date;const fixed=new RealDate('2026-11-10T04:30:00Z').getTime();" +
            'global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]));}static now(){return fixed;}};' +
            "const w=require('./lib/watercooler-catalogue');process.stdout.write(w.parseStandupType('standup'))");
        expect(out).toBe('kickoff');
    });

    test('the staff-task clock reads Toronto minutes', () => {
        const out = sameEverywhere(
            "const RealDate=Date;const fixed=new RealDate('2026-11-07T04:30:00Z').getTime();" +
            'global.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[fixed]));}static now(){return fixed;}};' +
            "const s=require('./lib/staff-tasks-time');process.stdout.write(String(s.getCurrentTimeMinutes()))");
        expect(out).toBe(String(23 * 60 + 30));
    });

    test('negative control: the pre-#76 parseDate (local fields) differs between zones', () => {
        const preFix = "const d=new Date('2026-11-07T03:30:00Z');process.stdout.write(String(d.getDate()))";
        expect(runIn('UTC', preFix)).not.toBe(runIn('America/Toronto', preFix));
    });
});
