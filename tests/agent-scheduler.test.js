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
    TASK_TEMPLATES,
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
                'check-inbox',
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
