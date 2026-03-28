/**
 * tests/bulletin-watcher.test.js
 *
 * Tests for lib/bulletin-watcher.js
 */

'use strict';

const {
    processBulletin,
    getWatchingAgents,
    formatBulletinSummary,
    buildNotificationMessage,
    isRateLimited,
    recordTrigger,
    clearRateLimits,
    getRateLimitStatus,
    RATE_LIMIT_MS,
} = require('../lib/bulletin-watcher');

describe('bulletin-watcher', () => {
    let mockSlack;

    beforeEach(() => {
        // Clear rate limits between tests
        clearRateLimits();

        // Mock Slack client
        mockSlack = {
            chat: {
                postMessage: jest.fn().mockResolvedValue({ ok: true }),
            },
        };
    });

    describe('getWatchingAgents', () => {
        it('should return agents that watch task_completed', () => {
            const agents = getWatchingAgents('task_completed');

            expect(Array.isArray(agents)).toBe(true);
            // Secretary and security watch task_completed
            const agentIds = agents.map(a => a.id);
            expect(agentIds).toContain('secretary');
            expect(agentIds).toContain('security');
        });

        it('should return agents that watch vendor_deal', () => {
            const agents = getWatchingAgents('vendor_deal');

            const agentIds = agents.map(a => a.id);
            expect(agentIds).toContain('secretary');
            expect(agentIds).toContain('marketing');
        });

        it('should return agents that watch milestone', () => {
            const agents = getWatchingAgents('milestone');

            const agentIds = agents.map(a => a.id);
            expect(agentIds).toContain('story-bot');
        });

        it('should return empty array for unwatched bulletin type', () => {
            const agents = getWatchingAgents('unknown_type');
            expect(agents).toEqual([]);
        });

        it('should return empty array for null/undefined input', () => {
            expect(getWatchingAgents(null)).toEqual([]);
            expect(getWatchingAgents(undefined)).toEqual([]);
        });
    });

    describe('formatBulletinSummary', () => {
        it('should format bulletin with description', () => {
            const bulletin = {
                type: 'task_completed',
                agentId: 'bridge',
                data: { description: 'Implemented new feature' },
            };

            const summary = formatBulletinSummary(bulletin);

            expect(summary).toContain('task_completed');
            expect(summary).toContain('bridge');
            expect(summary).toContain('Implemented new feature');
        });

        it('should use title if no description', () => {
            const bulletin = {
                type: 'milestone',
                agentId: 'secretary',
                data: { title: 'First 100 customers' },
            };

            const summary = formatBulletinSummary(bulletin);
            expect(summary).toContain('First 100 customers');
        });

        it('should use message if no description or title', () => {
            const bulletin = {
                type: 'alert',
                agentId: 'security',
                data: { message: 'Critical vulnerability found' },
            };

            const summary = formatBulletinSummary(bulletin);
            expect(summary).toContain('Critical vulnerability found');
        });

        it('should truncate long summaries', () => {
            const longText = 'A'.repeat(200);
            const bulletin = {
                type: 'task_completed',
                agentId: 'bridge',
                data: { description: longText },
            };

            const summary = formatBulletinSummary(bulletin);
            expect(summary.length).toBeLessThanOrEqual(200);
            expect(summary).toContain('...');
        });
    });

    describe('buildNotificationMessage', () => {
        it('should build an ASK message', () => {
            const bulletin = {
                type: 'task_completed',
                agentId: 'bridge',
                data: { description: 'Test task completed' },
            };

            const message = buildNotificationMessage(bulletin);

            expect(message).toMatch(/^ASK:/);
            expect(message).toContain('New bulletin posted');
            expect(message).toContain('Test task completed');
        });
    });

    describe('rate limiting', () => {
        it('should not be rate limited initially', () => {
            expect(isRateLimited('test-agent')).toBe(false);
        });

        it('should be rate limited after trigger', () => {
            recordTrigger('test-agent');
            expect(isRateLimited('test-agent')).toBe(true);
        });

        it('should clear rate limits', () => {
            recordTrigger('test-agent');
            expect(isRateLimited('test-agent')).toBe(true);

            clearRateLimits();
            expect(isRateLimited('test-agent')).toBe(false);
        });

        it('should track rate limit status', () => {
            const status = getRateLimitStatus('test-agent');
            expect(status.rateLimited).toBe(false);
            expect(status.remainingMs).toBe(0);

            recordTrigger('test-agent');
            const statusAfter = getRateLimitStatus('test-agent');
            expect(statusAfter.rateLimited).toBe(true);
            expect(statusAfter.remainingMs).toBeGreaterThan(0);
            expect(statusAfter.remainingMs).toBeLessThanOrEqual(RATE_LIMIT_MS);
        });
    });

    describe('processBulletin', () => {
        const testBulletin = {
            id: 'test-123',
            type: 'task_completed',
            agentId: 'bridge',
            timestamp: new Date().toISOString(),
            data: { description: 'Test task completed' },
            read_by: [],
        };

        it('should notify watching agents', async () => {
            const result = await processBulletin(mockSlack, testBulletin, {
                skipRateLimit: true,
            });

            expect(result.notified.length).toBeGreaterThan(0);
            expect(mockSlack.chat.postMessage).toHaveBeenCalled();
        });

        it('should skip the posting agent', async () => {
            // LOGIC CHANGE 2026-03-28: Use a bulletin posted by secretary (who
            // also watches task_completed) to verify self-notification is skipped.
            const secretaryBulletin = {
                ...testBulletin,
                agentId: 'secretary', // Secretary watches task_completed
            };

            const result = await processBulletin(mockSlack, secretaryBulletin, {
                skipRateLimit: true,
            });

            // Secretary posted the bulletin and watches task_completed, should be skipped
            expect(result.notified).not.toContain('secretary');
            expect(result.skipped).toContain('secretary');
        });

        it('should skip agents without channels', async () => {
            // Post a milestone bulletin (watched by story-bot which has a channel)
            const milestoneBulletin = {
                ...testBulletin,
                type: 'milestone',
                agentId: 'other-agent',
            };

            const result = await processBulletin(mockSlack, milestoneBulletin, {
                skipRateLimit: true,
            });

            // Story-bot has a channel and watches milestone
            expect(result.notified).toContain('story-bot');
        });

        it('should respect rate limiting', async () => {
            // First call should succeed
            const result1 = await processBulletin(mockSlack, testBulletin);
            const notifiedCount = result1.notified.length;

            // Clear and re-post - should be rate limited
            const result2 = await processBulletin(mockSlack, testBulletin);

            // Second call should skip all previously notified agents
            expect(result2.skipped.length).toBeGreaterThanOrEqual(notifiedCount);
        });

        it('should skip rate limiting when option set', async () => {
            // First call
            await processBulletin(mockSlack, testBulletin, { skipRateLimit: true });

            // Second call with skipRateLimit should still work
            const result2 = await processBulletin(mockSlack, testBulletin, {
                skipRateLimit: true,
            });

            expect(result2.notified.length).toBeGreaterThan(0);
        });

        it('should call onNotify callback', async () => {
            const onNotify = jest.fn();

            await processBulletin(mockSlack, testBulletin, {
                onNotify,
                skipRateLimit: true,
            });

            expect(onNotify).toHaveBeenCalled();
        });

        it('should handle Slack API errors gracefully', async () => {
            mockSlack.chat.postMessage.mockRejectedValue(new Error('Slack API error'));

            const result = await processBulletin(mockSlack, testBulletin, {
                skipRateLimit: true,
            });

            expect(result.errors.length).toBeGreaterThan(0);
            expect(result.errors[0].error).toContain('Slack API error');
        });

        it('should return empty results for unwatched bulletin type', async () => {
            const unwatchedBulletin = {
                ...testBulletin,
                type: 'unknown_type',
            };

            const result = await processBulletin(mockSlack, unwatchedBulletin);

            expect(result.notified).toEqual([]);
            expect(result.skipped).toEqual([]);
            expect(result.errors).toEqual([]);
        });
    });
});
