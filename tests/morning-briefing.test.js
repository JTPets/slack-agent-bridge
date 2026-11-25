'use strict';

/**
 * tests/morning-briefing.test.js
 *
 * WORK-TODO #85: the secretary's 07:00 briefing. On 2026-11-20 and 11-21 the run (no
 * tools, ~3 KB prompt) went silent for 13-15 minutes, cost about $2.63, and ended in
 * "safeguards flagged this message ... [reasoning_extraction]"; 11-24 went silent for
 * 14 minutes and finished. The template asked for the weather and overnight email, the
 * context carried neither, and the agent had no tools to find them.
 *
 *   1. Every section the template asks for is a fact the secretary's context supplies
 *      (the old template fails this: it asked for weather and holidays).
 *   2. The context carries the weather and today's holidays, and says "unavailable"
 *      when a source fails or hangs, never nothing.
 *   3. A no-tools run's deadline is capped (runDeadline), and the real adapter kills a
 *      no-tools stub at the cap while a run with tools keeps the caller's deadline.
 */

jest.mock('../lib/integrations/google-calendar', () => ({
    getAllTodayEvents: jest.fn(async () => []),
    getAllTomorrowEvents: jest.fn(async () => []),
}));
jest.mock('../lib/owner-tasks', () => ({ getPendingTasks: jest.fn(() => []) }));
jest.mock('../lib/integrations/weather', () => ({ fetchWeather: jest.fn() }));
jest.mock('../lib/integrations/holidays', () => ({ getTodaySpecialDates: jest.fn() }));

const fs = require('fs');
const os = require('os');
const path = require('path');

const weather = require('../lib/integrations/weather');
const holidays = require('../lib/integrations/holidays');
const { buildSecretaryContext, buildDayFactsLines } = require('../lib/agent-context-ops');
const { getTaskTemplate } = require('../lib/agent-task-catalogue');
const { runDeadline, claudeModelArgs, DEFAULT_NO_TOOLS_TIMEOUT_MS } = require('../lib/agent-tools');
const { loadDefinitions } = require('../lib/agent-markdown');
const { runClaudeAdapter } = require('../lib/llm-runner');

const SECRETARY = { id: 'secretary', permissions: ['google-calendar', 'gmail-read'], denied: ['file-system-write'] };
const CODER = { id: 'code-bridge', permissions: ['claude-code'] };
const READER = { id: 'security', permissions: ['github-read'] };

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    weather.fetchWeather.mockResolvedValue({ high: 3, low: -4, precipChance: 40, conditions: 'Light snow' });
    holidays.getTodaySpecialDates.mockResolvedValue({
        holiday: null,
        petAwareness: [{ name: 'Adopt a Senior Pet Month', type: 'pet_awareness_month' }],
    });
});
afterEach(() => jest.restoreAllMocks());

describe('the template asks only for what the context supplies', () => {
    // Each topic the briefing may ask for, and the line in buildSecretaryContext that answers it.
    const SUPPLIED = [
        [/calendar/i, /TODAY'S CALENDAR/],
        [/weather/i, /WEATHER TODAY/],
        [/sqtools/i, /SQTOOLS ALERTS/],
        [/owner tasks/i, /PENDING OWNER TASKS/],
        [/holiday/i, /HOLIDAY TODAY/],
        [/pet awareness/i, /PET AWARENESS/],
    ];
    const ASKS_TO_FETCH = /\b(check|fetch|look up|search|read) (the )?(inbox|email|weather|forecast)|overnight emails?|from overnight|weather forecast/i;

    test('every topic the instructions name has a supplying line, and nothing asks it to go and get data', async () => {
        const text = getTaskTemplate('morning-briefing').instructions;
        const context = await buildSecretaryContext();
        const named = SUPPLIED.filter(([topic]) => topic.test(text));
        expect(named.length).toBeGreaterThanOrEqual(5);
        for (const [, line] of named) expect(context).toMatch(line);
        expect(text).not.toMatch(ASKS_TO_FETCH);
        expect(text).toMatch(/no tools/i);
    });

    test('negative control: the pre-#85 template fails the same check', () => {
        const old = `Prepare the morning briefing for John. Include:
1. Today's calendar events and appointments
2. Weather forecast for Hamilton/Toronto
3. Any urgent emails or messages from overnight`;
        expect(old).toMatch(ASKS_TO_FETCH);
        expect(old).not.toMatch(/no tools/i);
    });
});

describe('the weather and holidays reach the secretary', () => {
    test('a forecast and a pet awareness month are rendered as facts', async () => {
        const context = await buildSecretaryContext();
        expect(context).toContain('WEATHER TODAY (Hamilton): high 3°C, low -4°C, 40% chance of precipitation, Light snow');
        expect(context).toContain('HOLIDAY TODAY: none');
        expect(context).toContain('PET AWARENESS: Adopt a Senior Pet Month (this month)');
    });

    test('a statutory holiday is named', async () => {
        holidays.getTodaySpecialDates.mockResolvedValue({ holiday: { name: 'Christmas Day' }, petAwareness: [] });
        const lines = await buildDayFactsLines();
        expect(lines).toContain('HOLIDAY TODAY: Christmas Day (Ontario statutory holiday)');
        expect(lines).toContain('PET AWARENESS: none today');
    });

    test('a failed, empty or hung source says unavailable, never nothing', async () => {
        weather.fetchWeather.mockResolvedValue(null);
        holidays.getTodaySpecialDates.mockRejectedValue(new Error('Nager down'));
        expect(await buildDayFactsLines()).toEqual([
            'WEATHER TODAY: unavailable (the forecast could not be fetched)',
            'HOLIDAYS AND PET AWARENESS DATES: unavailable',
        ]);

        weather.fetchWeather.mockReturnValue(new Promise(() => {}));
        const started = Date.now();
        const lines = await buildDayFactsLines({ timeoutMs: 50 });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(lines[0]).toBe('WEATHER TODAY: unavailable (the forecast could not be fetched)');
    });
});

describe('a no-tools run has a capped deadline', () => {
    test('the rule', () => {
        expect(runDeadline(900000, SECRETARY, {})).toEqual({ timeout: DEFAULT_NO_TOOLS_TIMEOUT_MS, capped: true });
        expect(runDeadline(900000, null, {})).toEqual({ timeout: DEFAULT_NO_TOOLS_TIMEOUT_MS, capped: true });
        expect(runDeadline(120000, SECRETARY, {})).toEqual({ timeout: 120000, capped: false });
        expect(runDeadline(900000, CODER, {})).toEqual({ timeout: 900000, capped: false });
        expect(runDeadline(900000, READER, {})).toEqual({ timeout: 900000, capped: false });
        expect(runDeadline(900000, SECRETARY, { NO_TOOLS_TIMEOUT_MS: '0' })).toEqual({ timeout: 900000, capped: false });
        expect(runDeadline(900000, SECRETARY, { NO_TOOLS_TIMEOUT_MS: '60000' })).toEqual({ timeout: 60000, capped: true });
        expect(runDeadline(900000, SECRETARY, { NO_TOOLS_TIMEOUT_MS: 'soon' }).timeout).toBe(DEFAULT_NO_TOOLS_TIMEOUT_MS);
    });

    describe('the real adapter against a stub that never answers', () => {
        let dir;
        let hangs;
        const saved = process.env.NO_TOOLS_TIMEOUT_MS;
        beforeAll(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-tools-deadline-'));
            hangs = path.join(dir, 'hangs');
            fs.writeFileSync(hangs, `#!${process.execPath}\nprocess.stdin.resume();\nsetTimeout(() => process.stdout.write('late'), 1500);\n`, { mode: 0o755 });
            process.env.NO_TOOLS_TIMEOUT_MS = '300';
        });
        afterAll(() => {
            if (saved === undefined) delete process.env.NO_TOOLS_TIMEOUT_MS; else process.env.NO_TOOLS_TIMEOUT_MS = saved;
            fs.rmSync(dir, { recursive: true, force: true });
        });

        test('the secretary is killed at the cap although the caller allowed a minute', async () => {
            const started = Date.now();
            const result = await runClaudeAdapter('p', { claudeBin: hangs, cwd: dir, timeout: 60000, agentRecord: SECRETARY });
            expect(result).toMatchObject({ interrupted: true, signal: 'SIGTERM' });
            expect(Date.now() - started).toBeLessThan(1400);
        });

        test('negative control: a run with tools keeps the caller deadline and finishes', async () => {
            const result = await runClaudeAdapter('p', { claudeBin: hangs, cwd: dir, timeout: 60000, agentRecord: READER });
            expect(result.interrupted).toBeFalsy();
            expect(result.output).toBe('late');
        });
    });
});

describe('the agent model reaches the CLI', () => {
    test('claudeModelArgs passes a model id and refuses anything else', () => {
        expect(claudeModelArgs(undefined)).toEqual([]);
        expect(claudeModelArgs('')).toEqual([]);
        expect(claudeModelArgs('claude-sonnet-5-5')).toEqual(['--model', 'claude-sonnet-5-5']);
        expect(claudeModelArgs('claude-opus-5-5[1m]')).toEqual(['--model', 'claude-opus-5-5[1m]']);
        for (const bad of ['--dangerously-skip-permissions', '-p', 'a b', 'x;rm', 42]) {
            expect(() => claudeModelArgs(bad)).toThrow(/Refused Claude model id/);
        }
    });

    test('the secretary is declared on Sonnet, not the CLI default', () => {
        const secretary = loadDefinitions().find(a => a.id === 'secretary');
        expect(secretary.llm_provider).toBe('claude');
        expect(secretary.llm_model).toBe('claude-sonnet-5-5');
    });

    test('the real adapter puts --model in the argv it spawns', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-model-arg-'));
        try {
            const echo = path.join(dir, 'echo-argv');
            fs.writeFileSync(echo, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(process.argv.slice(2))));\n`, { mode: 0o755 });
            const withModel = await runClaudeAdapter('p', { claudeBin: echo, cwd: dir, timeout: 10000, agentRecord: SECRETARY, model: 'claude-sonnet-5-5' });
            const argv = JSON.parse(withModel.output);
            expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
            // Negative control: no model, no flag (the CLI's default, as before).
            const without = await runClaudeAdapter('p', { claudeBin: echo, cwd: dir, timeout: 10000, agentRecord: SECRETARY });
            expect(JSON.parse(without.output)).not.toContain('--model');
            await expect(runClaudeAdapter('p', { claudeBin: echo, cwd: dir, timeout: 10000, model: '-p' })).rejects.toThrow(/Refused/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
