'use strict';

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

/** Local midnight `offset` days from today, as the module computes it. */
function midnight(offset) {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset);
}

describe('the three day windows', () => {
    test.each([
        ['getYesterdayRange', -1],
        ['getTodayRange', 0],
        ['getTomorrowRange', 1],
    ])('%s spans local midnight to the next local midnight', (name, offset) => {
        const { start, end } = cal[name]();
        expect(start).toBe(midnight(offset).toISOString());
        const next = midnight(offset);
        next.setDate(next.getDate() + 1);
        expect(end).toBe(next.toISOString());
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

test('the export surface is unchanged by the collapse', () => {
    expect(Object.keys(cal).sort()).toEqual([
        'getAllTodayEvents', 'getAllTomorrowEvents', 'getAllYesterdayEvents', 'getCalendarIds',
        'getTodayEvents', 'getTodayRange', 'getTomorrowEvents', 'getTomorrowRange',
        'getYesterdayEvents', 'getYesterdayRange', 'listCalendars', 'transformEvent',
    ]);
});
