'use strict';

/**
 * tests/helpers/llm-runner-harness.js
 *
 * The shared setup of the llm-* suites, moved unchanged out of tests/llm-runner.test.js
 * when that suite was split one-per-module (WORK-TODO #10 Wave T, 2026-11-07): a fresh
 * module registry and a copy of process.env per test, a throwaway LLM_METRICS_FILE so no
 * test touches agents/shared/llm-metrics.json, a mocked child_process.spawn, and the
 * three helpers the tests drive it with.
 *
 * Call useLlmRunnerHarness() once at the top of a suite file. It registers the hooks and
 * returns an object whose `mockSpawn` is the current test's spawn mock.
 */

const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // The prompt goes over stdin (2026-09-20), so a fake child needs a writable stdin
    // or runClaudeAdapter throws on child.stdin.end().
    child.stdin = Object.assign(new EventEmitter(), { end: jest.fn(), write: jest.fn() });
    return child;
}

function useLlmRunnerHarness() {
    const originalEnv = process.env;
    const metricsFiles = [];
    const h = {
        mockSpawn: null,

        /** Mock a successful Ollama /api/chat reply. */
        mockOllamaResponse(content, extra = {}) {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ model: 'test-model', message: { role: 'assistant', content }, done: true, ...extra }),
            });
        },

        /** Spawn mock that emits the given output and exits. */
        setupMockSpawn({ exitCode = 0, stdout = '', stderr = '' } = {}) {
            h.mockSpawn.mockImplementation(() => {
                const child = fakeChild();
                setImmediate(() => {
                    if (stdout) child.stdout.emit('data', stdout);
                    if (stderr) child.stderr.emit('data', stderr);
                    child.emit('close', exitCode);
                });
                return child;
            });
        },

        /** Spawn mock that emits an error. */
        setupMockSpawnError(errorMessage) {
            h.mockSpawn.mockImplementation(() => {
                const child = fakeChild();
                setImmediate(() => child.emit('error', new Error(errorMessage)));
                return child;
            });
        },
    };

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
        // Clear LLM_PROVIDER to ensure default behavior
        delete process.env.LLM_PROVIDER;
        process.env.LLM_METRICS_FILE = path.join(os.tmpdir(), `llm-metrics-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
        metricsFiles.push(process.env.LLM_METRICS_FILE);
        delete process.env.OLLAMA_MODEL;
        delete process.env.OLLAMA_BASE_URL;
        delete process.env.OLLAMA_THINK;

        h.mockSpawn = jest.fn();
        jest.doMock('child_process', () => ({ spawn: h.mockSpawn }));
    });

    afterEach(() => {
        jest.resetModules();
    });

    afterAll(() => {
        process.env = originalEnv;
        for (const f of metricsFiles) {
            try { fs.unlinkSync(f); } catch (err) { /* never existed */ }
        }
    });

    return h;
}

module.exports = { useLlmRunnerHarness };
