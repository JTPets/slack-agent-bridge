'use strict';

/**
 * tests/task-hub.test.js
 *
 * WORK-TODO #10, B36 (2026-11-25): processTask is a hub over lib/task-*.js spokes. This
 * suite and tests/task-spokes.test.js test each spoke ON ITS OWN, with real files where the spoke writes files (the
 * task lock, the queue, the scratch directory) and doubles only for Slack and the model,
 * and pins the hub's shape: every spoke is required and called, in step order, and the
 * lock is released last.
 *
 * The ordering and identity claims that existed before the split keep their own suites
 * (task-delivery-signal, task-queue-lifecycle, task-lock-refusal, task-agent-identity,
 * task-state-divergence, undelivered-work, llm-scratch-cwd, deadline-warning,
 * task-result-delivery), now reading the spokes through tests/helpers/task-path-sources.js.
 */

const fs = require('fs');
const path = require('path');

const { SPOKES, hubBody, spokeSource } = require('./helpers/task-path-sources');

const fx = require('./helpers/task-spoke-fixtures').useTaskSpokeFixtures();
const { quiet, useTempQueue, enqueue } = fx;

describe('the hub', () => {
    const hub = hubBody();

    test('requires and calls every spoke, and the steps run in order', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
        for (const name of SPOKES) expect(src).toContain(`require('./lib/${name}')`);
        const steps = [
            'await beginTask(', 'taskMemory.startRecord(', 'await prepareWorkspace(', 'await buildTaskPrompt(',
            'await runTaskLlm(', 'await deliverInterrupted(', 'await deliverCompleted(', 'await afterCompletion(',
            'await deliverFailure(', 'await cleanupWorkspace(', 'taskMemory.clearWorkingMemory(', 'releaseTaskLock(',
        ];
        const at = steps.map((s) => hub.indexOf(s));
        expect(at.filter((i) => i < 0)).toEqual([]);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
    });

    test('stays a hub: under 120 lines', () => {
        expect(hub.split('\n').length).toBeLessThan(120);
    });

    test('every lib/task-*.js module that says it was moved out of processTask is a declared spoke', () => {
        const moved = fs.readdirSync(path.join(__dirname, '..', 'lib'))
            .filter((f) => /^task-.*\.js$/.test(f))
            .filter((f) => /moved out of bridge-agent\.js processTask/i
                .test(fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8').replace(/\s*\n \*\s*/g, ' ')))
            .map((f) => f.replace(/\.js$/, ''));
        expect(moved.sort()).toEqual([...SPOKES].sort());
    });
});

describe('lib/task-state-gate.js (the middleware)', () => {
    const gate = require('../lib/task-state-gate');
    const taskLock = require('../lib/task-lock');
    const msg = { ts: '1700000000.000100' };
    const task = { description: 'do a thing' };

    test('a free start takes the lock, marks the row running, and the release removes the lock', async () => {
        quiet();
        const queue = useTempQueue();
        const id = enqueue(queue);
        const lockFile = path.join(fx.tmp(), '.task-running');
        const posts = [];
        const out = await gate.beginTask({ msg, task, queueId: id, lockFile, postToOps: async (t) => posts.push(t) });
        expect(out).toMatchObject({ startRefusal: null, lockOwned: true, lockFile });
        expect(fs.existsSync(lockFile)).toBe(true);
        const row = JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe('running');
        expect(gate.releaseTaskLock(out)).toMatchObject({ existed: true, released: true });
        expect(fs.existsSync(lockFile)).toBe(false);
        expect(posts).toEqual([]);
    });

    test('a held lock refuses before acquire, and a lock it did not write is never released', async () => {
        quiet();
        useTempQueue();
        const lockFile = path.join(fx.tmp(), '.task-running');
        taskLock.acquire({ msgTs: 'other', description: 'other task', lockFile });
        const out = await gate.beginTask({ msg, task, queueId: null, lockFile, postToOps: async () => true });
        expect(out.startRefusal).toBeTruthy();
        expect(out.lockOwned).toBe(false);
        gate.releaseTaskLock(out);
        expect(fs.existsSync(lockFile)).toBe(true);
    });

    test('endTask writes the terminal row with its delivery verdict', async () => {
        quiet();
        const queue = useTempQueue();
        const id = enqueue(queue);
        queue.markRunning(id);
        await gate.endTask('complete', {
            queueId: id, reason: 'Success in 1s', delivery: { delivered: false, detail: 'post failed' },
            description: 't', postToOps: async () => true,
        });
        const row = JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe('completed');
        expect(row.delivery).toMatchObject({ delivered: false, detail: 'post failed' });
    });

    test('a failed terminal write is posted as a divergence, not thrown', async () => {
        quiet();
        const queue = useTempQueue();
        jest.spyOn(queue, 'fail').mockImplementation(() => { throw new Error('EACCES'); });
        const posts = [];
        await gate.endTask('fail', {
            queueId: 'q1', reason: 'boom', delivery: { delivered: true, detail: 'x' },
            description: 'the task', postToOps: async (t) => posts.push(t),
        });
        expect(posts).toHaveLength(1);
        expect(posts[0]).toContain('Failed write: fail');
        expect(posts[0]).toContain('EACCES');
    });

    test('endTask refuses a write that is not terminal, even with no queue id', async () => {
        await expect(gate.endTask('markRunning', { queueId: null })).rejects.toThrow(/not a terminal queue write/);
    });
});

describe('lib/task-llm-run.js', () => {
    // runTaskLlm binds runWithFallback at require time, so the double is installed with
    // doMock in an isolated registry rather than spied on the shared module.
    const llmRunner = { runWithFallback: jest.fn() };
    let runTaskLlm;
    beforeEach(() => {
        llmRunner.runWithFallback = jest.fn();
        jest.isolateModules(() => {
            jest.doMock('../lib/llm-runner', () => ({ runWithFallback: (...a) => llmRunner.runWithFallback(...a) }));
            ({ runTaskLlm } = require('../lib/task-llm-run'));
        });
    });
    afterEach(() => jest.dontMock('../lib/llm-runner'));
    const run = (turns) => ({
        task: { turns, description: 'd', repo: null },
        currentAgent: { id: 'story-bot', llm_model: 'm1' }, currentAgentId: 'story-bot',
        llmProvider: 'claude', sourceLink: '<link|source>',
    });
    const deps = (posts) => ({ postToOps: async (t) => posts.push(t), taskTimeout: 1000, claudeBin: '/bin/claude' });

    test('a max-turns stop retries once at double the turns, as the executing agent', async () => {
        const calls = [];
        llmRunner.runWithFallback.mockImplementation(async (prompt, opts) => {
            calls.push(opts);
            return { output: 'ok', hitMaxTurns: calls.length === 1 };
        });
        const posts = [];
        const out = await runTaskLlm(run(20), 'p', '/tmp/x', deps(posts));
        expect(calls.map((c) => c.maxTurns)).toEqual([20, 40]);
        expect(calls[0]).toMatchObject({ cwd: '/tmp/x', agentId: 'story-bot', model: 'm1', provider: 'claude', timeout: 1000 });
        expect(out).toMatchObject({ didRetry: true, originalTurns: 20, currentTurns: 40 });
        expect(posts[0]).toMatch(/Retrying with 40 turns/);
    });

    test('at the ceiling there is no retry, and the partial result is said', async () => {
        llmRunner.runWithFallback.mockResolvedValue({ output: 'x', hitMaxTurns: true });
        const posts = [];
        const out = await runTaskLlm(run(100), 'p', '/tmp/x', deps(posts));
        expect(llmRunner.runWithFallback).toHaveBeenCalledTimes(1);
        expect(out.didRetry).toBe(false);
        expect(posts[0]).toMatch(/max turns limit\. May be partially complete/);
    });
});

// The memory record, prompt, outcome and follow-up spokes: tests/task-spokes.test.js.
describe('lib/task-workspace.js', () => {
    const { prepareWorkspace, cleanupWorkspace } = require('../lib/task-workspace');

    test('a no-repo task gets an empty directory of its own, and cleanup removes it', async () => {
        const run = { task: { repo: null, description: 'd' }, msg: { ts: '1.2' }, sourceLink: 'l' };
        const cwd = await prepareWorkspace(run, { workDir: fx.tmp(), postToOps: async () => true });
        expect(cwd).toBe(run.scratchCwd);
        expect(fs.readdirSync(cwd)).toEqual([]);
        expect(path.relative(fx.tmp(), cwd).startsWith('..')).toBe(true); // never inside WORK_DIR
        await cleanupWorkspace(run, { workDir: fx.tmp(), postToOps: async () => true });
        expect(fs.existsSync(cwd)).toBe(false);
    });
});

describe('the spoke sources', () => {
    test('no spoke reads the module-scope bridge agentConfig', () => {
        for (const name of SPOKES) expect(spokeSource(name)).not.toMatch(/\bagentConfig\b/);
    });
});
