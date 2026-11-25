'use strict';

/**
 * tests/task-spokes.test.js
 *
 * WORK-TODO #10, B36 (2026-11-25): the second half of processTask's spokes, each tested
 * on its own (the hub, the state gate, the model run and the workspace are in
 * tests/task-hub.test.js): the history record, the prompt, the three endings and the
 * follow-ups. Real queue files; doubles only for Slack, memory and the model.
 */

const fs = require('fs');

const fx = require('./helpers/task-spoke-fixtures').useTaskSpokeFixtures();
const { quiet, useTempQueue, enqueue } = fx;

describe('lib/task-memory-record.js', () => {
    test('a memory failure is logged, never thrown', () => {
        quiet();
        const memory = require('../memory/memory-manager');
        jest.spyOn(memory, 'addTask').mockImplementation(() => { throw new Error('disk'); });
        jest.spyOn(memory, 'failTask').mockImplementation(() => { throw new Error('disk'); });
        jest.spyOn(memory, 'clearAgentWorkingMemory').mockImplementation(() => { throw new Error('disk'); });
        const rec = require('../lib/task-memory-record');
        expect(rec.startRecord({ description: 'd' })).toBeNull();
        expect(() => rec.recordFailed('id', 'e')).not.toThrow();
        expect(() => rec.clearWorkingMemory('story-bot')).not.toThrow();
    });

    test('a completed retry records its turns, a max-turns stop records partial', () => {
        const memory = require('../memory/memory-manager');
        const seen = [];
        jest.spyOn(memory, 'completeTask').mockImplementation((id, o) => seen.push(o));
        require('../lib/task-memory-record').recordCompleted('id', {
            output: 'out', elapsed: '12', hitMaxTurns: true, didRetry: true, originalTurns: 20, currentTurns: 40,
        });
        expect(seen[0]).toEqual({
            output: 'max turns reached', elapsed: 12, retried: true, originalTurns: 20, retryTurns: 40, partial: true,
        });
    });
});

describe('lib/task-prompt.js', () => {
    test("a no-repo prompt is the executing agent's, and a failing data context does not stop it", async () => {
        quiet();
        const agentContext = require('../lib/agent-context');
        const memory = require('../memory/memory-manager');
        jest.spyOn(agentContext, 'buildAgentDataContext').mockRejectedValue(new Error('calendar down'));
        jest.spyOn(memory, 'buildTaskContext').mockReturnValue('RECENT');
        const { buildTaskPrompt } = require('../lib/task-prompt');
        const out = await buildTaskPrompt({
            task: { repo: null, instructions: 'do it', description: 'd' },
            currentAgent: { system_prompt: 'I am story-bot' }, currentAgentId: 'story-bot',
        });
        expect(out.prompt).toBe('RECENT\n\nI am story-bot\n\ndo it');
    });
});

describe('lib/task-outcome.js', () => {
    const notifyOwner = require('../lib/notify-owner');
    const { deliverCompleted, deliverFailure } = require('../lib/task-outcome');
    const baseRun = (queueId) => ({
        msg: { ts: '1.2' }, sourceChannel: 'C', queueId, task: { description: 'd', repo: null },
        startTime: Date.now(), sourceLink: 'l', taskDir: null, taskBaseSha: null, llmProvider: 'claude',
        memoryTaskId: null, taskSuccess: false,
    });
    const deps = (posts) => ({ postToOps: async (t) => { posts.push(t); return true; }, truncate: (t) => t });

    test('a result Slack refused is announced AND recorded delivered: false, after the post', async () => {
        quiet();
        const queue = useTempQueue();
        const id = enqueue(queue);
        queue.markRunning(id);
        const order = [];
        jest.spyOn(notifyOwner, 'taskCompleted').mockImplementation(async () => {
            order.push(JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id).status);
            return false;
        });
        const posts = [];
        const run = baseRun(id);
        await deliverCompleted(run, { result: { output: 'out', hitMaxTurns: false, provider: 'claude' } }, deps(posts));
        expect(order).toEqual(['running']); // still running while the post was made
        expect(posts.join('\n')).toMatch(/result was not delivered/);
        const row = JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe('completed');
        expect(row.delivery.delivered).toBe(false);
        expect(run.taskSuccess).toBe(true);
    });

    test('a failure is reported, its message redacted, and the row failed with the verdict', async () => {
        quiet();
        const queue = useTempQueue();
        const id = enqueue(queue);
        queue.markRunning(id);
        jest.spyOn(notifyOwner, 'taskFailed').mockResolvedValue({ opsPosted: false, ownerNotified: true });
        await deliverFailure(baseRun(id), new Error('boom xoxb-123456789012-abcdefghijkl'), deps([]));
        const row = JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id);
        expect(row.status).toBe('failed');
        expect(row.delivery.delivered).toBe(true);
        expect(row.error).not.toContain('xoxb-123456789012');
    });
});

describe('lib/task-followups.js', () => {
    test("ACTION REQUIRED goes to the owner's inbox, and the bulletin is posted as the executing agent", async () => {
        quiet();
        const notifyOwner = require('../lib/notify-owner');
        const bulletinBoard = require('../lib/bulletin-board');
        const actions = [];
        jest.spyOn(notifyOwner, 'processActionRequired').mockImplementation(async (o, opts) => actions.push(opts));
        const posted = [];
        jest.spyOn(bulletinBoard, 'postBulletin').mockImplementation((who, type) => { posted.push([who, type]); return { success: false }; });
        const { afterCompletion } = require('../lib/task-followups');
        await afterCompletion(
            { task: { description: 'd', repo: null }, currentAgentId: 'story-bot', memoryTaskId: null, sourceLink: 'l' },
            { didRetry: false, originalTurns: 10, currentTurns: 10 },
            { output: 'commit abcdef1 done', elapsed: '3', hitMaxTurns: false, validation: null, validationError: null },
            { slack: {}, postToOps: async () => true, truncate: (t) => t, clearRateLimitState: async () => {} },
        );
        expect(actions).toEqual([{ agentId: 'bridge' }]);
        expect(posted).toEqual([['story-bot', 'task_completed']]);
    });

    test('a Phase-3 gate that did not run is posted, never silent', async () => {
        const posts = [];
        const { postPhase3Detail } = require('../lib/task-followups');
        await postPhase3Detail({ task: { description: 'd' }, sourceLink: 'l' }, {
            validation: { passed: false, testRun: { ran: false, outcome: 'runner_absent', reason: 'jest: not found' },
                testCommand: 'npm test', testOutput: 'sh: jest: not found', warnings: [] },
            validationError: null,
        }, async (t) => posts.push(t));
        expect(posts[0]).toMatch(/the test gate DID NOT RUN/);
    });
});

