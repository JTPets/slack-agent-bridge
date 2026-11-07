'use strict';

const path = require('path');

/**
 * tests/google-calendar.test.js
 *
 * lib/integrations/google-calendar.js had three copies each of a day-range builder, a
 * per-calendar fetcher and an all-calendars merge until 2026-10-05 (WORK-TODO #10,
 * wave 3), when they were collapsed into one of each. Before that, its fetchers were
 * reached only through mocks of the whole module. This suite drives the REAL module
 * over a mocked googleapis client, and was run against the pre-collapse code first, so
 * it pins the behaviour the collapse had to keep: which window each name asks for, the
 * request shape, the event shape, the merge order across GOOGLE_CALENDAR_IDS, and that
 * every failure is an empty list rather than a throw.
 *
 * Also the regression test for the refresh-token name: until 2026-10-05 this module read
 * only GOOGLE_CALENDAR_REFRESH_TOKEN, so a .env holding the documented GOOGLE_REFRESH_TOKEN
 * left the calendar unconfigured while Gmail, on the same token, worked.
 */

const mockList = jest.fn();
const mockCalendarList = jest.fn();
jest.mock('googleapis', () => ({
    google: {
        auth: {
            OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn() })),
            GoogleAuth: jest.fn(),
        },
        calendar: jest.fn(() => ({
            events: { list: mockList },
            calendarList: { list: mockCalendarList },
        })),
    },
}));

const cal = require('../lib/integrations/google-calendar');

const ENV_KEYS = ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_CALENDAR_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET', 'GOOGLE_CALENDAR_IDS'];
let saved;
const quiet = [];

beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = 'synthetic-refresh';
    process.env.GOOGLE_CLIENT_ID = 'synthetic-id';
    process.env.GOOGLE_CLIENT_SECRET = 'synthetic-secret';
    quiet.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
    mockList.mockReset();
    mockCalendarList.mockReset();
});

afterEach(() => {
    for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    while (quiet.length) quiet.pop().mockRestore();
});

// LOGIC CHANGE 2026-11-07 (WORK-TODO #76): the windows are Toronto days, not process-local
// days. This block used to rebuild the expectation from local fields, which pinned the
// defect: it passed in any process zone because it made the same mistake as the module.
const { execFileSync } = require('child_process');
const { dayKey } = require('../lib/time-format');
const torontoClock = (iso) => new Date(iso).toLocaleString('en-CA', {
    timeZone: 'America/Toronto', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
});

describe('the three day windows', () => {
    test.each([
        ['getYesterdayRange', -1],
        ['getTodayRange', 0],
        ['getTomorrowRange', 1],
    ])('%s spans Toronto midnight to the next Toronto midnight', (name, offset) => {
        const { start, end } = cal[name]();
        expect(torontoClock(start)).toMatch(/, 00:00$/);
        expect(torontoClock(end)).toMatch(/, 00:00$/);
        const today = dayKey(new Date(), 'America/Toronto');
        const shifted = dayKey(new Date(Date.parse(start) + 12 * 3600 * 1000), 'America/Toronto');
        const dayMs = 24 * 3600 * 1000;
        expect(Math.round((Date.parse(shifted) - Date.parse(today)) / dayMs)).toBe(offset);
        expect([23, 24, 25]).toContain((Date.parse(end) - Date.parse(start)) / 3600000);
    });

    test.each([
        // 22:30 Toronto on Nov 6 is 03:30 UTC on Nov 7: "today" is still Nov 6 in Toronto.
        ['2026-11-07T03:30:00Z', 0, '2026-11-06T05:00:00.000Z', '2026-11-07T05:00:00.000Z'],
        // The fall-back day (2026-11-01) is 25 hours long.
        ['2026-11-01T15:00:00Z', 0, '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'],
        // The spring-forward day (2026-03-08) is 23 hours long.
        ['2026-03-08T15:00:00Z', 0, '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
        ['2026-11-07T15:00:00Z', 1, '2026-11-08T05:00:00.000Z', '2026-11-09T05:00:00.000Z'],
        ['2026-01-01T15:00:00Z', -1, '2025-12-31T05:00:00.000Z', '2026-01-01T05:00:00.000Z'],
    ])('dayRange at %s offset %i', (now, offset, start, end) => {
        expect(cal.dayRange(offset, new Date(now))).toEqual({ start, end });
    });

    test('the window does not depend on the process timezone (real child processes)', () => {
        const script = "const c=require('./lib/integrations/google-calendar');" +
            "process.stdout.write(JSON.stringify(c.dayRange(0,new Date('2026-11-07T03:30:00Z'))))";
        const run = (tz) => execFileSync(process.execPath, ['-e', script], {
            cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8',
        });
        const expected = JSON.stringify({ start: '2026-11-06T05:00:00.000Z', end: '2026-11-07T05:00:00.000Z' });
        for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'America/New_York']) {
            expect([tz, run(tz)]).toEqual([tz, expected]);
        }
    });

    test('negative control: the pre-#76 local-field window moves with TZ', () => {
        const preFix = "const now=new Date('2026-11-07T03:30:00Z');" +
            'const s=new Date(now.getFullYear(),now.getMonth(),now.getDate());process.stdout.write(s.toISOString())';
        const run = (tz) => execFileSync(process.execPath, ['-e', preFix], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
        expect(run('UTC')).not.toBe(run('America/Toronto'));
    });
});

describe('the per-calendar fetchers', () => {
    test.each([
        ['getYesterdayEvents', 'getYesterdayRange'],
        ['getTodayEvents', 'getTodayRange'],
        ['getTomorrowEvents', 'getTomorrowRange'],
    ])('%s lists that window, single events, in start order, and transforms each', async (fn, range) => {
        mockList.mockResolvedValue({ data: { items: [
            { summary: 'Call', start: { dateTime: '2026-10-05T13:00:00Z' }, end: { dateTime: '2026-10-05T14:00:00Z' }, recurringEventId: 'r1' },
            { start: { date: '2026-10-05' }, end: { date: '2026-10-06' }, status: 'tentative' },
        ] } });
        const events = await cal[fn]('cal-a');
        const { start, end } = cal[range]();
        expect(mockList).toHaveBeenCalledWith({
            calendarId: 'cal-a', timeMin: start, timeMax: end, singleEvents: true, orderBy: 'startTime',
        });
        expect(events).toEqual([
            { title: 'Call', start: '2026-10-05T13:00:00Z', end: '2026-10-05T14:00:00Z', status: 'confirmed', recurring: true },
            { title: 'Untitled Event', start: '2026-10-05', end: '2026-10-06', status: 'tentative', recurring: false },
        ]);
    });

    test.each(['getYesterdayEvents', 'getTodayEvents', 'getTomorrowEvents'])(
        '%s defaults to the primary calendar and returns [] when the API throws', async (fn) => {
            mockList.mockRejectedValue(new Error('quota'));
            expect(await cal[fn]()).toEqual([]);
            expect(mockList.mock.calls[0][0].calendarId).toBe('primary');
            expect(console.error.mock.calls[0].join(' ')).toContain('quota');
        });

    test('no credentials configured: [] and no API call', async () => {
        delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
        expect(await cal.getTodayEvents()).toEqual([]);
        expect(mockList).not.toHaveBeenCalled();
    });

    test('GOOGLE_REFRESH_TOKEN alone is enough (it was ignored before 2026-10-05)', async () => {
        const { google } = require('googleapis');
        delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
        process.env.GOOGLE_REFRESH_TOKEN = 'synthetic-primary-refresh';
        mockList.mockResolvedValue({ data: { items: [] } });
        await cal.getTodayEvents();
        expect(mockList).toHaveBeenCalledTimes(1);
        const client = google.auth.OAuth2.mock.results.at(-1).value;
        expect(client.setCredentials).toHaveBeenCalledWith({ refresh_token: 'synthetic-primary-refresh' });
    });

    test('a response with no items is an empty list', async () => {
        mockList.mockResolvedValue({ data: {} });
        expect(await cal.getTomorrowEvents('x')).toEqual([]);
    });
});

describe('the all-calendars merges', () => {
    test.each([
        ['getAllYesterdayEvents', 'getYesterdayRange'],
        ['getAllTodayEvents', 'getTodayRange'],
        ['getAllTomorrowEvents', 'getTomorrowRange'],
    ])('%s merges every configured calendar, tagged and sorted by start', async (fn, range) => {
        process.env.GOOGLE_CALENDAR_IDS = 'cal-a, cal-b';
        mockList.mockImplementation(async ({ calendarId }) => ({ data: { items: calendarId === 'cal-a'
            ? [{ summary: 'Late', start: { dateTime: '2026-10-05T18:00:00Z' } }]
            : [{ summary: 'Early', start: { dateTime: '2026-10-05T09:00:00Z' } }] } }));
        const events = await cal[fn]();
        expect(events.map((e) => [e.title, e.calendarId])).toEqual([['Early', 'cal-b'], ['Late', 'cal-a']]);
        const { start } = cal[range]();
        expect(mockList.mock.calls.every(([args]) => args.timeMin === start)).toBe(true);
    });

    test('one failing calendar does not lose the others', async () => {
        process.env.GOOGLE_CALENDAR_IDS = 'bad,good';
        mockList.mockImplementation(async ({ calendarId }) => {
            if (calendarId === 'bad') throw new Error('forbidden');
            return { data: { items: [{ summary: 'Kept' }] } };
        });
        expect((await cal.getAllTodayEvents()).map((e) => e.title)).toEqual(['Kept']);
    });
});

describe('listCalendars and getCalendarIds', () => {
    test('listCalendars maps each calendar and returns [] on failure', async () => {
        mockCalendarList.mockResolvedValue({ data: { items: [{ id: 'a', summary: 'A', primary: true }, {}] } });
        expect(await cal.listCalendars()).toEqual([
            { id: 'a', summary: 'A', primary: true },
            { id: '', summary: 'Unnamed Calendar', primary: false },
        ]);
        mockCalendarList.mockRejectedValue(new Error('down'));
        expect(await cal.listCalendars()).toEqual([]);
    });

    test('getCalendarIds trims, drops blanks, defaults to primary', () => {
        expect(cal.getCalendarIds()).toEqual(['primary']);
        process.env.GOOGLE_CALENDAR_IDS = ' a , ,b ';
        expect(cal.getCalendarIds()).toEqual(['a', 'b']);
    });
});

// LOGIC CHANGE 2026-11-07 (WORK-TODO #76): dayRange is exported so its fixed-instant
// and DST cases can be tested; nothing else was added.
test('the export surface is unchanged by the collapse', () => {
    expect(Object.keys(cal).sort()).toEqual([
        'dayRange', 'getAllTodayEvents', 'getAllTomorrowEvents', 'getAllYesterdayEvents', 'getCalendarIds',
        'getTodayEvents', 'getTodayRange', 'getTomorrowEvents', 'getTomorrowRange',
        'getYesterdayEvents', 'getYesterdayRange', 'listCalendars', 'transformEvent',
    ]);
});
