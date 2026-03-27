'use strict';

/**
 * Tests for lib/notify-owner.js
 *
 * LOGIC CHANGE 2026-03-26: Initial test suite for centralized notification layer.
 */

const notifyOwner = require('../lib/notify-owner');

// Mock agent-registry
jest.mock('../lib/agent-registry', () => ({
    getAgent: jest.fn(),
}));

// Mock owner-tasks
// LOGIC CHANGE 2026-03-27: Changed mock from addTask to addOwnerTask to match
// the updated implementation that saves to owner-tasks.json instead of
// activation-checklists.json.
jest.mock('../lib/owner-tasks', () => ({
    addOwnerTask: jest.fn(),
    extractActionRequired: jest.fn(),
}));

const { getAgent } = require('../lib/agent-registry');
const { addOwnerTask, extractActionRequired } = require('../lib/owner-tasks');

describe('notify-owner', () => {
    let mockSlack;
    const testOwnerId = 'U12345OWNER';
    const testOpsChannel = 'C12345OPS';

    beforeEach(() => {
        jest.clearAllMocks();

        // Create mock Slack client
        mockSlack = {
            chat: {
                postMessage: jest.fn().mockResolvedValue({}),
            },
        };

        // Re-initialize module with fresh mocks
        notifyOwner.init({
            slack: mockSlack,
            ownerId: testOwnerId,
            opsChannelId: testOpsChannel,
        });

        // Default: secretary is not active
        getAgent.mockReturnValue(null);
    });

    describe('init', () => {
        it('should initialize with required dependencies', () => {
            // Module already initialized in beforeEach
            // Verify by calling a function that requires init
            expect(async () => {
                await notifyOwner.notifyChannel(testOpsChannel, 'test');
            }).not.toThrow();
        });
    });

    describe('PRIORITY', () => {
        it('should export priority constants', () => {
            expect(notifyOwner.PRIORITY.CRITICAL).toBe('critical');
            expect(notifyOwner.PRIORITY.HIGH).toBe('high');
            expect(notifyOwner.PRIORITY.LOW).toBe('low');
        });
    });

    describe('getSecretaryStatus', () => {
        it('should return inactive when secretary not in registry', () => {
            getAgent.mockReturnValue(null);
            const result = notifyOwner.getSecretaryStatus();
            expect(result).toEqual({ active: false, channelId: null });
        });

        it('should return inactive when secretary has planned status', () => {
            getAgent.mockReturnValue({
                id: 'secretary',
                status: 'planned',
                channel: null,
            });
            const result = notifyOwner.getSecretaryStatus();
            expect(result).toEqual({ active: false, channelId: null });
        });

        it('should return inactive when secretary has no channel', () => {
            getAgent.mockReturnValue({
                id: 'secretary',
                channel: null,
            });
            const result = notifyOwner.getSecretaryStatus();
            expect(result).toEqual({ active: false, channelId: null });
        });

        it('should return active when secretary has channel and no planned status', () => {
            getAgent.mockReturnValue({
                id: 'secretary',
                channel: 'C_SECRETARY',
            });
            const result = notifyOwner.getSecretaryStatus();
            expect(result).toEqual({ active: true, channelId: 'C_SECRETARY' });
        });
    });

    describe('notifyChannel', () => {
        it('should post message to channel', async () => {
            const result = await notifyOwner.notifyChannel(testOpsChannel, 'Test message');

            expect(result).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledWith({
                channel: testOpsChannel,
                text: 'Test message',
                unfurl_links: false,
            });
        });

        it('should return false on API error', async () => {
            mockSlack.chat.postMessage.mockRejectedValue(new Error('API error'));

            const result = await notifyOwner.notifyChannel(testOpsChannel, 'Test message');

            expect(result).toBe(false);
        });

        it('should return false without channelId', async () => {
            const result = await notifyOwner.notifyChannel(null, 'Test message');
            expect(result).toBe(false);
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });

        it('should return false without message', async () => {
            const result = await notifyOwner.notifyChannel(testOpsChannel, '');
            expect(result).toBe(false);
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });
    });

    describe('notifyOwner', () => {
        describe('low priority', () => {
            it('should log only without sending message', async () => {
                const result = await notifyOwner.notifyOwner('Test message', notifyOwner.PRIORITY.LOW);

                expect(result).toBe(true);
                expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
            });
        });

        describe('high priority', () => {
            it('should log for digest without immediate notification', async () => {
                const result = await notifyOwner.notifyOwner('Test message', notifyOwner.PRIORITY.HIGH);

                expect(result).toBe(true);
                // Currently just logs, no Slack message
                expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
            });
        });

        describe('critical priority', () => {
            it('should DM owner when secretary is not active', async () => {
                getAgent.mockReturnValue(null);

                const result = await notifyOwner.notifyOwner('Critical message', notifyOwner.PRIORITY.CRITICAL);

                expect(result).toBe(true);
                expect(mockSlack.chat.postMessage).toHaveBeenCalledWith({
                    channel: testOwnerId,
                    text: 'Critical message',
                    unfurl_links: false,
                });
            });

            it('should route through secretary channel when active', async () => {
                getAgent.mockReturnValue({
                    id: 'secretary',
                    channel: 'C_SECRETARY',
                });

                const result = await notifyOwner.notifyOwner('Critical message', notifyOwner.PRIORITY.CRITICAL);

                expect(result).toBe(true);
                expect(mockSlack.chat.postMessage).toHaveBeenCalledWith({
                    channel: 'C_SECRETARY',
                    text: ':rotating_light: *Owner Notification*\nCritical message',
                    unfurl_links: false,
                });
            });

            it('should return false on API error', async () => {
                mockSlack.chat.postMessage.mockRejectedValue(new Error('API error'));

                const result = await notifyOwner.notifyOwner('Critical message', notifyOwner.PRIORITY.CRITICAL);

                expect(result).toBe(false);
            });
        });

        it('should return false for unknown priority', async () => {
            const result = await notifyOwner.notifyOwner('Test message', 'unknown');
            expect(result).toBe(false);
        });

        it('should return false for empty message', async () => {
            const result = await notifyOwner.notifyOwner('', notifyOwner.PRIORITY.CRITICAL);
            expect(result).toBe(false);
        });

        it('should default to HIGH priority', async () => {
            const result = await notifyOwner.notifyOwner('Test message');

            expect(result).toBe(true);
            // HIGH priority doesn't send immediate message
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });
    });

    describe('taskFailed', () => {
        const task = { description: 'Test task', repo: 'org/repo' };

        it('should post to ops channel and notify owner', async () => {
            const result = await notifyOwner.taskFailed(task, new Error('Test error'), {
                elapsed: '30',
                sourceLink: '<link|source>',
            });

            expect(result.opsPosted).toBe(true);
            expect(result.ownerNotified).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledTimes(2);
        });

        it('should handle string error', async () => {
            const result = await notifyOwner.taskFailed(task, 'String error');

            expect(result.opsPosted).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalled();
        });

        it('should truncate long error messages', async () => {
            const longError = 'x'.repeat(4000);

            await notifyOwner.taskFailed(task, longError);

            const opsCall = mockSlack.chat.postMessage.mock.calls.find(
                call => call[0].channel === testOpsChannel
            );
            expect(opsCall[0].text).toContain('truncated');
        });

        it('should format error summary for owner DM', async () => {
            const longError = 'y'.repeat(300);

            await notifyOwner.taskFailed(task, longError);

            const ownerCall = mockSlack.chat.postMessage.mock.calls.find(
                call => call[0].channel === testOwnerId
            );
            expect(ownerCall[0].text).toContain('...');
            expect(ownerCall[0].text.length).toBeLessThan(300);
        });

        it('should work without options', async () => {
            const result = await notifyOwner.taskFailed(task, 'Error');

            expect(result.opsPosted).toBe(true);
        });
    });

    describe('taskCompleted', () => {
        const task = { description: 'Test task', repo: 'org/repo', branch: 'main' };

        it('should post to ops channel only', async () => {
            const result = await notifyOwner.taskCompleted(task, 'Output summary', {
                elapsed: '60',
                sourceLink: '<link|source>',
            });

            expect(result).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledTimes(1);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    channel: testOpsChannel,
                })
            );
        });

        it('should include repo label in message', async () => {
            await notifyOwner.taskCompleted(task, 'Output');

            const call = mockSlack.chat.postMessage.mock.calls[0];
            expect(call[0].text).toContain('org/repo');
            expect(call[0].text).toContain('main');
        });

        it('should truncate long summaries', async () => {
            const longSummary = 'z'.repeat(4000);

            await notifyOwner.taskCompleted(task, longSummary);

            const call = mockSlack.chat.postMessage.mock.calls[0];
            expect(call[0].text).toContain('truncated');
        });

        it('should work without repo', async () => {
            const taskNoRepo = { description: 'No repo task' };

            await notifyOwner.taskCompleted(taskNoRepo, 'Output');

            const call = mockSlack.chat.postMessage.mock.calls[0];
            expect(call[0].text).not.toContain('Repo:');
        });
    });

    describe('actionRequired', () => {
        // LOGIC CHANGE 2026-03-27: Updated tests to use addOwnerTask instead of addTask.
        // addOwnerTask takes (description, category, priority) where category is derived
        // from agentId ('bridge' -> 'general', other agents -> agent name).
        it('should add task to owner-tasks.json', async () => {
            addOwnerTask.mockReturnValue({ id: 'task-123', description: 'Add env var' });

            const result = await notifyOwner.actionRequired({}, 'Add env var', {
                agentId: 'bridge',
                priority: 'high',
            });

            expect(result.added).toBe(true);
            // agentId 'bridge' maps to category 'general'
            expect(addOwnerTask).toHaveBeenCalledWith('Add env var', 'general', 'high');
        });

        it('should use default agentId and priority', async () => {
            addOwnerTask.mockReturnValue({ id: 'task-123', description: 'Add env var' });

            await notifyOwner.actionRequired({}, 'Add env var');

            // Default agentId is 'bridge' which maps to 'general'
            expect(addOwnerTask).toHaveBeenCalledWith('Add env var', 'general', 'high');
        });

        it('should return added=false when addOwnerTask returns null (duplicate)', async () => {
            addOwnerTask.mockReturnValue(null);

            const result = await notifyOwner.actionRequired({}, 'Duplicate task');

            expect(result.added).toBe(false);
        });

        it('should handle addOwnerTask throwing error', async () => {
            addOwnerTask.mockImplementation(() => {
                throw new Error('Write error');
            });

            const result = await notifyOwner.actionRequired({}, 'Some task');

            expect(result.added).toBe(false);
        });

        it('should use agentId as category for non-bridge agents', async () => {
            addOwnerTask.mockReturnValue({ id: 'task-456', description: 'Task' });

            await notifyOwner.actionRequired({}, 'Task', {
                agentId: 'secretary',
                priority: 'medium',
            });

            // agentId 'secretary' maps to category 'secretary'
            expect(addOwnerTask).toHaveBeenCalledWith('Task', 'secretary', 'medium');
        });
    });

    describe('processActionRequired', () => {
        // LOGIC CHANGE 2026-03-27: Updated tests to use addOwnerTask instead of addTask.
        it('should extract and add action from output', async () => {
            extractActionRequired.mockReturnValue('Add NEW_VAR to .env');
            addOwnerTask.mockReturnValue({ id: 'task-789', description: 'Add NEW_VAR to .env' });

            const result = await notifyOwner.processActionRequired(
                'Task done.\nACTION REQUIRED: Add NEW_VAR to .env\nEnd.',
                { agentId: 'bridge' }
            );

            expect(result.found).toBe(true);
            expect(result.action).toBe('Add NEW_VAR to .env');
            expect(result.added).toBe(true);
        });

        it('should return found=false when no action in output', async () => {
            extractActionRequired.mockReturnValue(null);

            const result = await notifyOwner.processActionRequired('No action here');

            expect(result.found).toBe(false);
            expect(result.action).toBeNull();
            expect(result.added).toBe(false);
        });

        it('should use default agentId mapped to category general', async () => {
            extractActionRequired.mockReturnValue('Some action');
            addOwnerTask.mockReturnValue({ id: 'task-abc', description: 'Some action' });

            await notifyOwner.processActionRequired('ACTION REQUIRED: Some action');

            // Default agentId 'bridge' maps to category 'general'
            expect(addOwnerTask).toHaveBeenCalledWith('Some action', 'general', 'high');
        });
    });

    describe('rateLimitHit', () => {
        it('should post to ops and notify owner', async () => {
            const result = await notifyOwner.rateLimitHit({
                pauseMinutes: 30,
                resumeTime: '3:30 PM',
                retryCount: 1,
            });

            expect(result.opsPosted).toBe(true);
            expect(result.ownerNotified).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledTimes(2);
        });

        it('should include rate limit details in ops message', async () => {
            await notifyOwner.rateLimitHit({
                pauseMinutes: 60,
                resumeTime: '4:00 PM',
                retryCount: 2,
            });

            const opsCall = mockSlack.chat.postMessage.mock.calls.find(
                call => call[0].channel === testOpsChannel
            );
            expect(opsCall[0].text).toContain('60 minutes');
            expect(opsCall[0].text).toContain('4:00 PM');
            expect(opsCall[0].text).toContain('Attempt 2');
        });

        it('should include resume time in owner notification', async () => {
            await notifyOwner.rateLimitHit({
                pauseMinutes: 30,
                resumeTime: '5:00 PM',
                retryCount: 1,
            });

            const ownerCall = mockSlack.chat.postMessage.mock.calls.find(
                call => call[0].channel === testOwnerId
            );
            expect(ownerCall[0].text).toContain('5:00 PM');
        });
    });

    describe('rateLimitCleared', () => {
        it('should post resolved message to ops channel', async () => {
            const result = await notifyOwner.rateLimitCleared();

            expect(result).toBe(true);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledWith({
                channel: testOpsChannel,
                text: ':white_check_mark: Rate limit resolved. Queue processing resumed.',
                unfurl_links: false,
            });
        });
    });

    describe('module not initialized', () => {
        beforeEach(() => {
            // Re-require module to reset state
            jest.resetModules();
        });

        it('notifyChannel should return false without init', async () => {
            const freshModule = require('../lib/notify-owner');
            // Don't call init

            const result = await freshModule.notifyChannel('C123', 'test');
            expect(result).toBe(false);
        });

        it('notifyOwner should return false without init', async () => {
            const freshModule = require('../lib/notify-owner');
            // Don't call init

            const result = await freshModule.notifyOwner('test', freshModule.PRIORITY.CRITICAL);
            expect(result).toBe(false);
        });
    });
});
