/**
 * tests/agent-scheduler.test.js
 *
 * Tests for lib/agent-scheduler.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Store original agents.json path
const AGENTS_FILE = path.join(__dirname, '..', 'agents', 'agents.json');
let originalAgentsContent;

// Mock node-cron
jest.mock('node-cron', () => {
    const mockJobs = [];
    return {
        schedule: jest.fn((cronExpr, callback, options) => {
            const job = {
                cronExpr,
                callback,
                options,
                stop: jest.fn(),
                start: jest.fn(),
            };
            mockJobs.push(job);
            return job;
        }),
        validate: jest.fn((cronExpr) => {
            // Basic validation - check for 5-6 space-separated parts
            const parts = cronExpr.trim().split(/\s+/);
            return parts.length >= 5 && parts.length <= 6;
        }),
        _getMockJobs: () => mockJobs,
        _clearMockJobs: () => { mockJobs.length = 0; },
    };
});

const cron = require('node-cron');
const {
    startScheduler,
    stopScheduler,
    getActiveJobs,
    triggerTask,
    buildTaskMessage,
    getTaskTemplate,
    getDeterministicTask,
    runScheduledTask,
    TASK_TEMPLATES,
    DETERMINISTIC_TASKS,
} = require('../lib/agent-scheduler');

describe('agent-scheduler', () => {
    let mockSlack;

    beforeEach(() => {
        // Clear cron mock state
        cron._clearMockJobs();
        cron.schedule.mockClear();
        cron.validate.mockClear();

        // Stop any existing jobs from previous tests
        stopScheduler();

        // Mock Slack client
        mockSlack = {
            chat: {
                postMessage: jest.fn().mockResolvedValue({ ok: true }),
            },
        };
    });

    afterEach(() => {
        stopScheduler();
    });

    describe('TASK_TEMPLATES', () => {
        it('should have templates for all scheduled task types', () => {
            const expectedTasks = [
                'morning-briefing',
                'nightly-audit',
                'weekly-critique',
                'draft-weekly-posts',
                'content-calendar',
                'weekly-analytics',
            ];

            for (const task of expectedTasks) {
                expect(TASK_TEMPLATES[task]).toBeDefined();
                expect(TASK_TEMPLATES[task].description).toBeTruthy();
                expect(TASK_TEMPLATES[task].instructions).toBeTruthy();
            }
        });
    });

    describe('getTaskTemplate', () => {
        it('should return template for valid task name', () => {
            const template = getTaskTemplate('morning-briefing');
            expect(template).toBeDefined();
            expect(template.description).toBe('Morning briefing');
            expect(template.instructions).toContain('calendar');
        });

        it('should return null for unknown task name', () => {
            const template = getTaskTemplate('unknown-task');
            expect(template).toBeNull();
        });
    });

    describe('buildTaskMessage', () => {
        it('should build a valid TASK message', () => {
            const message = buildTaskMessage('secretary', 'morning-briefing');

            expect(message).toContain('TASK:');
            expect(message).toContain('INSTRUCTIONS:');
            expect(message).toContain('Morning briefing');
            expect(message).toContain('secretary');
        });

        it('should return null for unknown task', () => {
            const message = buildTaskMessage('test', 'unknown-task');
            expect(message).toBeNull();
        });

        // LOGIC CHANGE 2026-09-13: Regression tests for the duplicated
        // "(scheduled by <agent>)" suffix. The check-inbox template hardcoded the
        // suffix in its own description while buildTaskMessage appends it to every
        // template, so production Slack showed it twice, every 30 minutes.
        it('should append the scheduled-by suffix exactly once for every template', () => {
            for (const taskName of Object.keys(TASK_TEMPLATES)) {
                const firstLine = buildTaskMessage('some-agent', taskName).split('\n')[0];
                expect(firstLine.match(/\(scheduled by /g)).toHaveLength(1);
                expect(firstLine.endsWith('(scheduled by some-agent)')).toBe(true);
            }
        });

        it('should keep the scheduled-by suffix out of every template description', () => {
            // The suffix belongs to buildTaskMessage, which is generic. A description
            // that carries it is the defect, whichever template reintroduces it.
            for (const [taskName, template] of Object.entries(TASK_TEMPLATES)) {
                expect(`${taskName}: ${template.description}`).not.toContain('scheduled by');
            }
        });
    });

    // LOGIC CHANGE 2026-09-14: `check-inbox` moved out of TASK_TEMPLATES into
    // DETERMINISTIC_TASKS. These guard the move and the class it belongs to.
    describe('DETERMINISTIC_TASKS', () => {
        it('routes check-inbox to a deterministic handler, not an LLM template', () => {
            expect(getDeterministicTask('check-inbox')).toBeTruthy();
            expect(typeof getDeterministicTask('check-inbox').run).toBe('function');
            // The prose template is gone: nothing can dispatch "check the inbox"
            // to a model that has no mailbox access.
            expect(TASK_TEMPLATES['check-inbox']).toBeUndefined();
            expect(buildTaskMessage('email-monitor', 'check-inbox')).toBeNull();
        });

        it('keeps the two registries disjoint', () => {
            const overlap = Object.keys(DETERMINISTIC_TASKS)
                .filter(name => Object.prototype.hasOwnProperty.call(TASK_TEMPLATES, name));
            expect(overlap).toEqual([]);
        });

        // THE enumerating guard: every task name any agent schedules must resolve
        // to a handler or a template. Before this, a scheduled task name that
        // resolved to neither registered a cron job that logged "No template
        // found" on every tick, forever, and did nothing else.
        // LOGIC CHANGE 2026-09-15: reads through loadAgents() rather than parsing
        // agents/agents.json, which no longer exists — definitions are
        // agents/<id>/agent.md. Reading the loader's OUTPUT is also the better
        // assertion: it is what the scheduler itself sees, so a task name lost in
        // the markdown migration would fail here, which a file-format read could not.
        it('resolves every task name scheduled by any agent', () => {
            const { loadAgents } = require('../lib/agent-registry');
            const scheduled = loadAgents()
                .filter(a => a.schedule && a.schedule.task)
                .map(a => ({ id: a.id, task: a.schedule.task }));

            expect(scheduled.length).toBeGreaterThan(0);

            const unresolved = scheduled.filter(
                ({ task }) => !getDeterministicTask(task) && !getTaskTemplate(task)
            );
            expect(unresolved).toEqual([]);
        });

    });

    describe('runScheduledTask', () => {
        it('runs the deterministic handler and reports its verdict', async () => {
            const agent = { id: 'email-monitor', channel: 'C_EMAIL' };
            const handler = getDeterministicTask('check-inbox');
            const spy = jest.spyOn(handler, 'run').mockResolvedValue({ ok: true, status: 'ok', fetched: 0 });

            const outcome = await runScheduledTask(mockSlack, agent, 'check-inbox');

            expect(spy).toHaveBeenCalled();
            expect(outcome).toMatchObject({ success: true, deterministic: true });
            expect(outcome.verdict.status).toBe('ok');
            // A deterministic task must NOT post a TASK: message for an LLM.
            const posted = mockSlack.chat.postMessage.mock.calls
                .filter(([arg]) => typeof arg.text === 'string' && arg.text.startsWith('TASK:'));
            expect(posted).toEqual([]);

            spy.mockRestore();
        });

        it('reports failure when the handler verdict is not ok', async () => {
            const agent = { id: 'email-monitor', channel: 'C_EMAIL' };
            const handler = getDeterministicTask('check-inbox');
            const spy = jest.spyOn(handler, 'run')
                .mockResolvedValue({ ok: false, status: 'not_configured', error: 'no creds' });

            const outcome = await runScheduledTask(mockSlack, agent, 'check-inbox');
            expect(outcome.success).toBe(false);

            spy.mockRestore();
        });

        it('still posts a TASK: message for template-backed tasks', async () => {
            const agent = { id: 'secretary', channel: 'C_SEC' };
            const outcome = await runScheduledTask(mockSlack, agent, 'morning-briefing');

            expect(outcome).toMatchObject({ success: true, deterministic: false });
            expect(mockSlack.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({ channel: 'C_SEC', text: expect.stringContaining('TASK:') })
            );
        });
    });

    describe('startScheduler', () => {
        it('should schedule jobs for agents with valid schedules', () => {
            const result = startScheduler(mockSlack);

            // Should have scheduled some jobs
            expect(result.jobCount).toBeGreaterThan(0);
            expect(result.agents.length).toBeGreaterThan(0);

            // Cron.schedule should have been called
            expect(cron.schedule).toHaveBeenCalled();
        });

        it('should skip agents without schedules', () => {
            const result = startScheduler(mockSlack);

            // Bridge agent has schedule: null, should not be in list
            expect(result.agents).not.toContain('bridge');
        });

        it('should skip agents without channels', () => {
            const result = startScheduler(mockSlack);

            // Storefront has status: planned and channel: null
            expect(result.agents).not.toContain('storefront');
        });

        it('should validate cron expressions', () => {
            startScheduler(mockSlack);

            // Validate should have been called for each agent with a schedule
            expect(cron.validate).toHaveBeenCalled();
        });

        it('should pass timezone option to cron.schedule', () => {
            startScheduler(mockSlack);

            // Check that timezone was set to America/Toronto
            const calls = cron.schedule.mock.calls;
            if (calls.length > 0) {
                const options = calls[0][2];
                expect(options.timezone).toBe('America/Toronto');
            }
        });

        it('should call onTrigger callback when job fires', async () => {
            const onTrigger = jest.fn();
            startScheduler(mockSlack, { onTrigger });

            // Get a scheduled job and fire its callback
            const jobs = cron._getMockJobs();
            if (jobs.length > 0) {
                await jobs[0].callback();
                expect(onTrigger).toHaveBeenCalled();
            }
        });

        it('should post task message to Slack when job fires', async () => {
            startScheduler(mockSlack);

            const jobs = cron._getMockJobs();
            if (jobs.length > 0) {
                await jobs[0].callback();
                expect(mockSlack.chat.postMessage).toHaveBeenCalled();
            }
        });
    });

    describe('stopScheduler', () => {
        it('should stop all active jobs', () => {
            startScheduler(mockSlack);

            const activeCount = getActiveJobs().length;
            expect(activeCount).toBeGreaterThan(0);

            const stopped = stopScheduler();
            expect(stopped).toBe(activeCount);
            expect(getActiveJobs().length).toBe(0);
        });

        it('should return 0 when no jobs are active', () => {
            const stopped = stopScheduler();
            expect(stopped).toBe(0);
        });
    });

    describe('getActiveJobs', () => {
        it('should return list of active job keys', () => {
            startScheduler(mockSlack);

            const jobs = getActiveJobs();
            expect(Array.isArray(jobs)).toBe(true);

            // Each key should be in format agentId:taskName
            for (const key of jobs) {
                expect(key).toMatch(/^[\w-]+:[\w-]+$/);
            }
        });

        it('should return empty array when no jobs scheduled', () => {
            const jobs = getActiveJobs();
            expect(jobs).toEqual([]);
        });
    });

    describe('triggerTask', () => {
        it('should post task message to agent channel', async () => {
            const result = await triggerTask(mockSlack, 'secretary', 'morning-briefing');

            expect(result.success).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    text: expect.stringContaining('TASK:'),
                })
            );
        });

        it('should fail for unknown agent', async () => {
            const result = await triggerTask(mockSlack, 'unknown-agent', 'morning-briefing');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Agent not found');
        });

        it('should fail for agent without channel', async () => {
            // Storefront has no channel assigned
            const result = await triggerTask(mockSlack, 'storefront', 'morning-briefing');

            expect(result.success).toBe(false);
            expect(result.error).toContain('no channel');
        });

        it('should fail for unknown task', async () => {
            const result = await triggerTask(mockSlack, 'secretary', 'unknown-task');

            expect(result.success).toBe(false);
            expect(result.error).toContain('No template');
        });

        it('should handle Slack API errors', async () => {
            mockSlack.chat.postMessage.mockRejectedValueOnce(new Error('Slack API error'));

            const result = await triggerTask(mockSlack, 'secretary', 'morning-briefing');

            expect(result.success).toBe(false);
            expect(result.error).toContain('Slack API error');
        });
    });
});
