'use strict';

/**
 * tests/digest-sections.test.js
 *
 * CHARACTERISATION of the morning digest text, and the tests for the two modules
 * split out of morning-digest.js on 2026-10-05 (WORK-TODO #10, wave 2):
 * lib/digest-sections.js (buildDigest and its helpers) and lib/integrations/weather.js
 * (fetchWeather, decodeWeatherCode).
 *
 * morning-digest.js had no exports and no test, so its output was pinned nowhere. The
 * expected texts below were run against the PRE-split buildDigest (a copy of
 * morning-digest.js at 2f9357b with main() removed and its memory dir pointed at the
 * fixture dir) before the split, and produced the same strings, so a split that changed
 * a word of the digest turns this red.
 *
 * Every external source is a double: holidays, calendar, staff tasks, Gmail and the
 * categorizer are mocked by module, and the weather API by mocking https.get, which is
 * the same seam before and after the move. Task memory is a temp dir.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const mockHolidays = { getTodaySpecialDates: jest.fn() };
const mockCalendar = { getAllTodayEvents: jest.fn(), getAllYesterdayEvents: jest.fn() };
const mockStaff = { formatDigestSummary: jest.fn() };
const mockGmail = { hasCredentials: jest.fn(), getRecentEmails: jest.fn() };
const mockCategorizer = { categorizeEmails: jest.fn(), formatSummary: jest.fn() };
const mockHttps = { get: jest.fn() };

jest.mock('../lib/integrations/holidays', () => mockHolidays);
jest.mock('../lib/integrations/google-calendar', () => mockCalendar);
jest.mock('../lib/staff-tasks', () => mockStaff);
jest.mock('../lib/integrations/gmail', () => mockGmail);
jest.mock('../lib/integrations/email-categorizer', () => mockCategorizer);
jest.mock('https', () => mockHttps);

const { buildDigest, loadJsonFile, isWithinLast24Hours, formatEvent, formatEventTime } =
    require('../lib/digest-sections');
const weather = require('../lib/integrations/weather');

/** Make https.get answer with `body` (a string), or emit an error when body is an Error. */
function answerWeather(body) {
    mockHttps.get.mockImplementation((url, cb) => {
        const req = new EventEmitter();
        process.nextTick(() => {
            if (body instanceof Error) { req.emit('error', body); return; }
            const res = new EventEmitter();
            cb(res);
            res.emit('data', body);
            res.emit('end');
        });
        return req;
    });
}

const WEATHER_JSON = JSON.stringify({
    daily: {
        temperature_2m_max: [21.6], temperature_2m_min: [9.4],
        precipitation_probability_max: [40], weathercode: [61],
    },
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

let memoryDir;
const quiet = [];

beforeEach(() => {
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
    quiet.push(jest.spyOn(console, 'error').mockImplementation(() => {}));
    mockHolidays.getTodaySpecialDates.mockResolvedValue({ holiday: null, petAwareness: [] });
    mockCalendar.getAllTodayEvents.mockResolvedValue([]);
    mockCalendar.getAllYesterdayEvents.mockResolvedValue([]);
    mockStaff.formatDigestSummary.mockReturnValue('');
    mockGmail.hasCredentials.mockReturnValue(false);
    answerWeather(new Error('offline'));
});

afterEach(() => {
    fs.rmSync(memoryDir, { recursive: true, force: true });
    while (quiet.length) quiet.pop().mockRestore();
    jest.clearAllMocks();
});

function writeMemory({ history = [], tasks = [], context = {} }) {
    fs.writeFileSync(path.join(memoryDir, 'history.json'), JSON.stringify(history));
    fs.writeFileSync(path.join(memoryDir, 'tasks.json'), JSON.stringify(tasks));
    fs.writeFileSync(path.join(memoryDir, 'context.json'), JSON.stringify(context));
}

describe('buildDigest — the digest text, pinned', () => {
    test('an empty day: every optional section absent, all clear', async () => {
        const text = await buildDigest({ memoryDir });
        expect(text).toBe([
            'Good morning John. Here is your daily digest:',
            '',
            '*Agent task summary:*',
            '• 0 tasks completed yesterday',
            '• 0 tasks failed',
            '• 0 tasks still active',
            '',
            '---',
            '*All clear!* No failures requiring attention.',
        ].join('\n'));
    });

    test('a full day: every section, in order', async () => {
        writeMemory({
            context: { owner_name: 'Sam' },
            history: [
                { status: 'completed', completedAt: hoursAgo(2) },
                { status: 'completed', completedAt: hoursAgo(30) },
                { status: 'failed', failedAt: hoursAgo(3), description: 'Fix the parser', error: 'tests failed' },
            ],
            tasks: [
                { status: 'active', description: 'Split files', repo: 'jtpets/slack-agent-bridge' },
                { status: 'done', description: 'ignored' },
            ],
        });
        mockHolidays.getTodaySpecialDates.mockResolvedValue({
            holiday: { name: 'Thanksgiving' },
            petAwareness: [
                { type: 'pet_awareness', name: 'National Pet Day', socialTip: 'Post a photo' },
                { type: 'pet_awareness_month', name: 'Senior Pet Month', socialTip: 'Feature senior care' },
            ],
        });
        answerWeather(WEATHER_JSON);
        mockCalendar.getAllTodayEvents.mockResolvedValue([
            { start: '2026-10-05', title: 'Inventory day' },
            { start: '2026-10-05T13:30:00Z', title: 'Supplier call' },
        ]);
        mockCalendar.getAllYesterdayEvents.mockResolvedValue([{ start: null, title: 'Untimed thing' }]);
        mockStaff.formatDigestSummary.mockReturnValue('*Staff tasks:* 2 open');
        mockGmail.hasCredentials.mockReturnValue(true);
        mockGmail.getRecentEmails.mockResolvedValue([{ id: 'synthetic-1' }]);
        mockCategorizer.categorizeEmails.mockReturnValue({ total: 1 });
        mockCategorizer.formatSummary.mockReturnValue('1 email, 0 flagged');

        const text = await buildDigest({ memoryDir });
        const lines = text.split('\n');

        expect(lines.slice(0, 26)).toEqual([
            'Good morning Sam. Here is your daily digest:',
            '',
            '*Today:* Thanksgiving (Ontario statutory holiday)',
            '',
            '*Today:* National Pet Day - Post a photo',
            '*This month:* Senior Pet Month - Feature senior care',
            '',
            '*Weather today in Hamilton:*',
            'High: 22°C / Low: 9°C',
            'Precipitation chance: 40%',
            'Conditions: Rain',
            '',
            "*Today's calendar:*",
            '  - All day: Inventory day',
            '  - 9:30 AM: Supplier call',
            '',
            "*Yesterday's events:*",
            '  - Untimed thing',
            '',
            '*Staff tasks:* 2 open',
            '',
            '*1 email, 0 flagged*',
            '',
            '*Agent task summary:*',
            '• 1 task completed yesterday',
            '• 1 task failed',
        ]);
        expect(lines[26]).toBe('• 1 task still active');
        // The failure block is lib/digest-failures.js's, tested there; here it is
        // enough that it sits between the summary and the active list.
        expect(text).toContain('Fix the parser');
        expect(text).toContain('*Active tasks:*\n  - Split files (jtpets/slack-agent-bridge)');
        expect(lines[lines.length - 2]).toBe('---');
        expect(lines[lines.length - 1]).toMatch(/^\*Action needed from you:\* 1 item$/);
        expect(mockGmail.getRecentEmails).toHaveBeenCalledWith(expect.any(Date), 100);
    });

    test('a section that throws is skipped, never fatal', async () => {
        mockHolidays.getTodaySpecialDates.mockRejectedValue(new Error('api down'));
        mockCalendar.getAllTodayEvents.mockRejectedValue(new Error('no creds'));
        mockStaff.formatDigestSummary.mockImplementation(() => { throw new Error('bad state'); });
        const text = await buildDigest({ memoryDir });
        expect(text.startsWith('Good morning John.')).toBe(true);
        expect(text).toContain('*All clear!*');
        expect(text).not.toContain('calendar');
    });
});

describe('the helpers that moved with it', () => {
    test('loadJsonFile returns the default for a missing file and for bad JSON', () => {
        expect(loadJsonFile(path.join(memoryDir, 'nope.json'), [])).toEqual([]);
        const bad = path.join(memoryDir, 'bad.json');
        fs.writeFileSync(bad, '{not json');
        expect(loadJsonFile(bad, { d: 1 })).toEqual({ d: 1 });
    });

    test('isWithinLast24Hours', () => {
        expect(isWithinLast24Hours(hoursAgo(23))).toBe(true);
        expect(isWithinLast24Hours(hoursAgo(25))).toBe(false);
        expect(isWithinLast24Hours(null)).toBe(false);
    });

    test('formatEvent / formatEventTime render Toronto time and all-day events', () => {
        expect(formatEventTime('2026-10-05')).toBe('All day');
        expect(formatEventTime('')).toBe('');
        expect(formatEvent({ start: '2026-01-15T14:00:00Z', title: 'Call' })).toBe('9:00 AM: Call');
    });
});

describe('lib/integrations/weather.js', () => {
    test('decodeWeatherCode maps the WMO ranges', () => {
        expect(weather.decodeWeatherCode(0)).toBe('Clear');
        expect(weather.decodeWeatherCode(2)).toBe('Partly cloudy');
        expect(weather.decodeWeatherCode(73)).toBe('Snow');
        expect(weather.decodeWeatherCode(95)).toBe('Thunderstorm');
        expect(weather.decodeWeatherCode(99)).toBe('Unknown');
    });

    test('fetchWeather resolves the rounded daily figures', async () => {
        answerWeather(WEATHER_JSON);
        await expect(weather.fetchWeather()).resolves.toEqual(
            { high: 22, low: 9, precipChance: 40, conditions: 'Rain' });
        expect(mockHttps.get.mock.calls[0][0]).toBe(weather.WEATHER_API_URL);
    });

    test('fetchWeather resolves null, never rejects, on every failure', async () => {
        answerWeather('{}');
        await expect(weather.fetchWeather()).resolves.toBeNull();
        answerWeather('not json');
        await expect(weather.fetchWeather()).resolves.toBeNull();
        answerWeather(new Error('ENOTFOUND'));
        await expect(weather.fetchWeather()).resolves.toBeNull();
    });
});
