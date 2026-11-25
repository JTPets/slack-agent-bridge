'use strict';

/**
 * WORK-TODO #86 and #59: lib/run-stats-store.js keeps each Claude run's stats, and
 * `ASK: runs [days]` (lib/run-stats-report.js) reports them per agent. The adapter wiring is
 * proven against a REAL stub binary through the real adapter, because the property is that
 * the one write site actually writes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../lib/run-stats-store');
const report = require('../lib/run-stats-report');
const router = require('../lib/command-router');

let dir;
let file;
let logSpy;
let errSpy;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stats-'));
    file = path.join(dir, 'run-stats.json');
    store.init({ file });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    store.init();
    logSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-11-25T17:00:00Z'); // 12:00 Toronto
const run = (over = {}) => ({
    agent_id: 'secretary', exit: 0, signal: null, durationMs: 20000, numTurns: 3,
    costUsd: 0.06, toolCalls: 2, maxQuietMs: 5000, maxRepeat: 1, alerts: [], ...over,
});

describe('the store', () => {
    test('records a run, logs the unchanged [run-stats] line, and reads it back', () => {
        expect(store.recordRunStats(run(), NOW)).toEqual({ recorded: true });
        const line = logSpy.mock.calls.map((c) => c[0]).find((s) => s.startsWith('[run-stats] '));
        expect(JSON.parse(line.slice(12))).toMatchObject({ agent_id: 'secretary', costUsd: 0.06 });
        const [rec] = store.readRuns();
        expect(rec).toMatchObject({ at: NOW.toISOString(), agent_id: 'secretary', durationMs: 20000, costUsd: 0.06, numTurns: 3 });
    });

    test('keeps only the declared fields; no output or prompt reaches the file', () => {
        store.recordRunStats(run({ output: 'SECRET-OUTPUT', prompt: 'SECRET-PROMPT', costUsd: 'x' }), NOW);
        const text = fs.readFileSync(file, 'utf8');
        expect(text).not.toMatch(/SECRET/);
        expect(store.readRuns()[0].costUsd).toBeNull();
    });

    test('a run with no agent id is recorded as unknown', () => {
        store.recordRunStats(run({ agent_id: null }), NOW);
        expect(store.readRuns()[0].agent_id).toBe('unknown');
    });

    test('drops runs past the retention window and past MAX_RUNS', () => {
        const old = new Date(NOW.getTime() - (store.RETAIN_DAYS + 1) * 86400000);
        store.recordRunStats(run({ agent_id: 'old' }), old);
        store.recordRunStats(run({ agent_id: 'new' }), NOW);
        expect(store.readRuns().map((r) => r.agent_id)).toEqual(['new']);

        const many = Array.from({ length: store.MAX_RUNS }, () => store.toRecord(run(), NOW));
        fs.writeFileSync(file, JSON.stringify({ version: 1, runs: many }));
        store.recordRunStats(run({ agent_id: 'last' }), NOW);
        const runs = store.readRuns();
        expect(runs).toHaveLength(store.MAX_RUNS);
        expect(runs[runs.length - 1].agent_id).toBe('last');
    });

    test('a corrupt file is set aside, not overwritten, and the run is still recorded', () => {
        fs.writeFileSync(file, '{not json');
        expect(store.recordRunStats(run(), NOW).recorded).toBe(true);
        const aside = fs.readdirSync(dir).find((f) => f.includes('.corrupt-'));
        expect(fs.readFileSync(path.join(dir, aside), 'utf8')).toBe('{not json');
        expect(store.readRuns()).toHaveLength(1);
    });

    test('a failed write never throws; it returns the error', () => {
        store.init({ file: path.join(dir, 'blocker', 'run-stats.json') });
        fs.writeFileSync(path.join(dir, 'blocker'), 'a file where a directory should be');
        const verdict = store.recordRunStats(run(), NOW);
        expect(verdict.recorded).toBe(false);
        expect(verdict.error).toBeTruthy();
    });

    test('under jest with no init({ file }) the default file is never written', () => {
        store.init();
        const verdict = store.recordRunStats(run(), NOW);
        expect(verdict).toMatchObject({ recorded: false });
        expect(verdict.skipped).toMatch(/jest/);
    });

    test('an unreadable record throws on read (a report must not show it as empty)', () => {
        fs.writeFileSync(file, '{"runs": 3}');
        expect(() => store.readRuns()).toThrow(/no runs array/);
    });
});

describe('the report', () => {
    test('percentile is nearest-rank over finite numbers', () => {
        expect(report.percentile([], 50)).toBeNull();
        expect(report.percentile([5], 95)).toBe(5);
        expect(report.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
        expect(report.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
        expect(report.percentile([3, null, 1, NaN, 2], 50)).toBe(2);
    });

    test('summarizes per agent and per Toronto day inside the window only', () => {
        const at = (iso) => store.toRecord(run(), new Date(iso));
        const runs = [
            { ...at('2026-11-25T12:00:00Z'), agent_id: 'secretary', costUsd: 2.63, durationMs: 917000, maxQuietMs: 810000, alerts: ['stall'], exit: 1 },
            { ...at('2026-11-25T13:00:00Z'), agent_id: 'secretary', costUsd: 0.06, durationMs: 20000 },
            { ...at('2026-11-24T06:00:00Z'), agent_id: 'security', costUsd: null, durationMs: 60000, maxRepeat: 7, alerts: ['loop'] },
            // 2026-11-25T03:00Z is still 2026-11-24 in Toronto.
            { ...at('2026-11-25T03:00:00Z'), agent_id: 'security', costUsd: 0.10 },
            // Outside a 2-day window.
            { ...at('2026-11-22T12:00:00Z'), agent_id: 'jester' },
        ];
        const s = report.summarizeRuns(runs, { days: 2, now: NOW });
        expect(s).toMatchObject({ from: '2026-11-24', to: '2026-11-25', total: 4 });
        expect(s.agents.map((a) => a.agentId)).toEqual(['secretary', 'security']);
        const sec = s.agents[0];
        expect(sec).toMatchObject({ runs: 2, failed: 1, costKnown: 2, turns: 6, p50DurationMs: 20000, p95DurationMs: 917000, maxQuietMs: 810000, stallAlerts: 1 });
        expect(sec.costUsd).toBeCloseTo(2.69);
        expect(s.agents[1]).toMatchObject({ runs: 2, costKnown: 1, maxRepeat: 7, loopAlerts: 1 });
        expect(s.perDay.map((d) => [d.day, d.runs])).toEqual([['2026-11-24', 2], ['2026-11-25', 2]]);
    });

    test('a killed run (signal) counts as failed', () => {
        const s = report.summarizeRuns([store.toRecord(run({ exit: null, signal: 'SIGTERM' }), NOW)], { days: 1, now: NOW });
        expect(s.agents[0].failed).toBe(1);
    });

    test('the text names cost as an estimate and says when some runs reported no cost', async () => {
        store.recordRunStats(run({ costUsd: 0.5 }), NOW);
        store.recordRunStats(run({ costUsd: null }), NOW);
        const { ok, text } = await report.handleRuns({ args: '' }, { now: NOW });
        expect(ok).toBe(true);
        expect(text).toMatch(/\*secretary\*: 2 run\(s\), est\. \$0\.50 \(1 of 2 reported a cost\)/);
        expect(text).toMatch(/duration p50 20\.0s \/ p95 20\.0s/);
        expect(text).toMatch(/not an invoice/);
        expect(text).toMatch(/the last 7 days/);
    });

    test('an empty window says so; an unreadable record is a failure, not an empty week', async () => {
        expect((await report.handleRuns({ args: '1' }, { now: NOW, readRuns: () => [] })).text).toMatch(/No Claude runs are recorded for today/);
        const bad = await report.handleRuns({ args: '' }, { now: NOW, readRuns: () => { throw new Error('EACCES'); } });
        expect(bad.ok).toBe(false);
        expect(bad.text).toMatch(/failure, not an empty week/);
    });

    test('days: a non-number or 0 is refused, above the max is clamped', async () => {
        expect((await report.handleRuns({ args: 'lots' }, { readRuns: () => [] })).ok).toBe(false);
        expect((await report.handleRuns({ args: '0' }, { readRuns: () => [] })).ok).toBe(false);
        const text = (await report.handleRuns({ args: '99' }, { now: NOW, readRuns: () => [store.toRecord(run(), NOW)] })).text;
        expect(text).toMatch(new RegExp(`the last ${report.MAX_DAYS} days`));
    });
});

describe('the verb', () => {
    test('`runs` is a read-only verb in the command table and reaches the report', async () => {
        expect(router.COMMANDS.runs.kind).toBe('report');
        expect(router.isBareCommand('runs 14')).toBe(true);
        store.recordRunStats(run(), new Date());
        const result = await router.runCommand('runs 1');
        expect(result).toMatchObject({ handled: true, verb: 'runs', ok: true });
        expect(result.text).toMatch(/\*secretary\*: 1 run/);
    });
});

describe('the one write site: the real Claude adapter', () => {
    test('a finished run is recorded with its agent, turns and cost', async () => {
        const { runClaudeAdapter } = require('../lib/llm-runner');
        const bin = path.join(dir, 'claude-stub');
        const ev = (o) => `${JSON.stringify(o)}\n`;
        const out = ev({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'x' } }] } }) +
            ev({ type: 'result', subtype: 'success', result: 'done', num_turns: 4, total_cost_usd: 0.31 });
        fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(out)});process.exit(0);});\n`, { mode: 0o755 });
        const res = await runClaudeAdapter('p', { claudeBin: bin, cwd: dir, timeout: 20000, stallMs: 0, loopRepeat: 0, agentId: 'security' });
        expect(res.output).toBe('done');
        const [rec] = store.readRuns();
        expect(rec).toMatchObject({ agent_id: 'security', exit: 0, numTurns: 4, costUsd: 0.31, toolCalls: 1 });
        expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    });
});
