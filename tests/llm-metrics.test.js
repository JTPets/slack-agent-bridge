/**
 * tests/llm-metrics.test.js
 *
 * Unit tests for lib/llm-metrics.js
 *
 * LOGIC CHANGE 2026-09-11: Added alongside the Ollama provider. The counter is
 * the thing that makes a fallback visible to the operator, so it needs the same
 * test rigor as the adapter itself — including the failure paths (unwritable
 * file, corrupt file), because a counter that silently stops counting is worse
 * than no counter at all.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('llm-metrics', () => {
    const originalEnv = process.env;
    let metricsFile;
    let logSpy;
    let errSpy;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
        metricsFile = path.join(
            os.tmpdir(),
            `llm-metrics-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
        );
        process.env.LLM_METRICS_FILE = metricsFile;
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errSpy.mockRestore();
        try { fs.unlinkSync(metricsFile); } catch (err) { /* never created */ }
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    describe('recordVerdict', () => {
        test('emits exactly one structured log line per call', () => {
            const { recordVerdict } = require('../lib/llm-metrics');

            recordVerdict({
                provider_requested: 'ollama',
                provider_used: 'gemini',
                fallback_reason: 'timeout',
                latency_ms: 1234,
                model: 'local-model',
                agent_id: 'secretary',
            });

            const verdictLines = logSpy.mock.calls
                .map(c => c[0])
                .filter(line => typeof line === 'string' && line.startsWith('[llm-verdict] '));

            expect(verdictLines).toHaveLength(1);

            const payload = JSON.parse(verdictLines[0].replace('[llm-verdict] ', ''));
            expect(payload.provider_requested).toBe('ollama');
            expect(payload.provider_used).toBe('gemini');
            expect(payload.fallback_reason).toBe('timeout');
            expect(payload.latency_ms).toBe(1234);
            expect(payload.model).toBe('local-model');
            expect(payload.agent_id).toBe('secretary');
        });

        test('records fallback_reason as null when no fallback happened', () => {
            const { recordVerdict } = require('../lib/llm-metrics');

            const record = recordVerdict({
                provider_requested: 'claude',
                provider_used: 'claude',
                latency_ms: 10,
                agent_id: 'bridge',
            });

            expect(record.fallback_reason).toBeNull();
            expect(record.ok).toBe(true);
        });

        test('defaults unknown fields rather than writing undefined', () => {
            const { recordVerdict } = require('../lib/llm-metrics');

            const record = recordVerdict({});

            expect(record.provider_requested).toBe('unknown');
            expect(record.agent_id).toBe('unknown');
            expect(record.provider_used).toBeNull();
            expect(record.model).toBeNull();
        });

        test('persists the counter to the configured file', () => {
            const { recordVerdict } = require('../lib/llm-metrics');

            recordVerdict({ provider_requested: 'ollama', provider_used: 'ollama', agent_id: 'a1' });

            expect(fs.existsSync(metricsFile)).toBe(true);
            const saved = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
            const day = Object.keys(saved.days)[0];
            expect(saved.days[day].a1.calls).toBe(1);
            expect(saved.days[day].a1.requested.ollama).toBe(1);
        });

        test('accumulates across calls', () => {
            const { recordVerdict, getStats } = require('../lib/llm-metrics');

            recordVerdict({ provider_requested: 'ollama', provider_used: 'ollama', agent_id: 'a1' });
            recordVerdict({ provider_requested: 'ollama', provider_used: 'gemini', fallback_reason: 'timeout', agent_id: 'a1' });
            recordVerdict({ provider_requested: 'ollama', provider_used: 'gemini', fallback_reason: 'empty_output', agent_id: 'a1' });

            const stats = getStats({ agentId: 'a1', days: 1 });
            expect(stats.calls).toBe(3);
            expect(stats.fallbacks).toBe(2);
            expect(stats.reasons.timeout).toBe(1);
            expect(stats.reasons.empty_output).toBe(1);
            expect(stats.used.gemini).toBe(2);
        });

        test('a counter write failure is surfaced, never thrown at the caller', () => {
            // Point the counter at a path that cannot be created.
            process.env.LLM_METRICS_FILE = path.join(metricsFile, 'nested', 'impossible.json');
            fs.writeFileSync(metricsFile, 'not a directory');

            const { recordVerdict } = require('../lib/llm-metrics');

            expect(() => recordVerdict({ provider_requested: 'claude', agent_id: 'a1' })).not.toThrow();
            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[llm-metrics] Could not write'));
        });

        test('a corrupt counter file is surfaced and does not break recording', () => {
            fs.writeFileSync(metricsFile, '{ this is not json');

            const { recordVerdict, getStats } = require('../lib/llm-metrics');
            recordVerdict({ provider_requested: 'claude', provider_used: 'claude', agent_id: 'a1' });

            expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[llm-metrics] Could not read'));
            expect(getStats({ agentId: 'a1', days: 1 }).calls).toBe(1);
        });
    });

    describe('getStats', () => {
        test('returns a zeroed summary when nothing has been recorded', () => {
            const { getStats } = require('../lib/llm-metrics');

            const stats = getStats({ days: 7 });
            expect(stats.calls).toBe(0);
            expect(stats.fallbacks).toBe(0);
            expect(stats.fallbackRate).toBe(0);
            expect(stats.agents).toEqual({});
        });

        test('answers "what fraction of agent X fell back this week"', () => {
            const { recordVerdict, getStats } = require('../lib/llm-metrics');

            for (let i = 0; i < 8; i++) {
                recordVerdict({ provider_requested: 'ollama', provider_used: 'ollama', agent_id: 'secretary' });
            }
            for (let i = 0; i < 2; i++) {
                recordVerdict({
                    provider_requested: 'ollama',
                    provider_used: 'gemini',
                    fallback_reason: 'connection_refused',
                    agent_id: 'secretary',
                });
            }

            const stats = getStats({ agentId: 'secretary', days: 7 });
            expect(stats.calls).toBe(10);
            expect(stats.fallbacks).toBe(2);
            expect(stats.fallbackRate).toBeCloseTo(0.2);
        });

        test('scopes to one agent when agentId is given', () => {
            const { recordVerdict, getStats } = require('../lib/llm-metrics');

            recordVerdict({ provider_requested: 'ollama', provider_used: 'ollama', agent_id: 'a1' });
            recordVerdict({ provider_requested: 'claude', provider_used: 'claude', agent_id: 'a2' });

            expect(getStats({ agentId: 'a1', days: 1 }).calls).toBe(1);
            expect(getStats({ agentId: 'a2', days: 1 }).calls).toBe(1);
            expect(getStats({ days: 1 }).calls).toBe(2);
        });

        test('breaks results down per agent when no agentId is given', () => {
            const { recordVerdict, getStats } = require('../lib/llm-metrics');

            recordVerdict({ provider_requested: 'ollama', provider_used: 'gemini', fallback_reason: 'timeout', agent_id: 'a1' });
            recordVerdict({ provider_requested: 'claude', provider_used: 'claude', agent_id: 'a2' });

            const stats = getStats({ days: 1 });
            expect(stats.agents.a1.fallbackRate).toBe(1);
            expect(stats.agents.a2.fallbackRate).toBe(0);
        });

        test('excludes day buckets outside the window', () => {
            const { getStats, dayKey, writeMetrics } = require('../lib/llm-metrics');

            const oldDay = dayKey(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
            writeMetrics({
                version: 1,
                days: {
                    [oldDay]: { a1: { calls: 5, fallbacks: 5, failures: 0, requested: {}, used: {}, reasons: {} } },
                },
            });

            expect(getStats({ agentId: 'a1', days: 1 }).calls).toBe(0);
            expect(getStats({ agentId: 'a1', days: 7 }).calls).toBe(5);
        });
    });

    describe('writeMetrics retention', () => {
        test('prunes day buckets older than the retention window', () => {
            const { writeMetrics, readMetrics, dayKey } = require('../lib/llm-metrics');

            const ancient = dayKey(new Date(Date.now() - 400 * 24 * 60 * 60 * 1000));
            const today = dayKey();

            writeMetrics({
                version: 1,
                days: {
                    [ancient]: { a1: { calls: 1, fallbacks: 0, failures: 0, requested: {}, used: {}, reasons: {} } },
                    [today]: { a1: { calls: 1, fallbacks: 0, failures: 0, requested: {}, used: {}, reasons: {} } },
                },
            });

            const saved = readMetrics();
            expect(saved.days[ancient]).toBeUndefined();
            expect(saved.days[today]).toBeDefined();
        });
    });

    describe('resetStats', () => {
        test('removes the counter file', () => {
            const { recordVerdict, resetStats, getStats } = require('../lib/llm-metrics');

            recordVerdict({ provider_requested: 'claude', provider_used: 'claude', agent_id: 'a1' });
            expect(fs.existsSync(metricsFile)).toBe(true);

            resetStats();

            expect(fs.existsSync(metricsFile)).toBe(false);
            expect(getStats({ days: 1 }).calls).toBe(0);
        });

        test('is a no-op when no counter file exists', () => {
            const { resetStats } = require('../lib/llm-metrics');
            expect(() => resetStats()).not.toThrow();
        });
    });

    describe('getMetricsFile', () => {
        test('honors LLM_METRICS_FILE', () => {
            const { getMetricsFile } = require('../lib/llm-metrics');
            expect(getMetricsFile()).toBe(metricsFile);
        });

        test('defaults to agents/shared/llm-metrics.json', () => {
            delete process.env.LLM_METRICS_FILE;
            const { getMetricsFile } = require('../lib/llm-metrics');
            expect(getMetricsFile()).toContain(path.join('agents', 'shared', 'llm-metrics.json'));
        });
    });

    describe('dayKey', () => {
        test('formats a date as YYYY-MM-DD', () => {
            const { dayKey } = require('../lib/llm-metrics');
            expect(dayKey(new Date('2026-09-11T23:59:59Z'))).toBe('2026-09-11');
        });
    });
});
