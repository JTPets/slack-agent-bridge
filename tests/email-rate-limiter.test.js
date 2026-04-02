/**
 * tests/email-rate-limiter.test.js
 *
 * Tests for lib/email-rate-limiter.js
 * Rate-limiting for email-to-Slack pipeline to prevent flood attacks.
 */

'use strict';

const rateLimiter = require('../lib/email-rate-limiter');

describe('email-rate-limiter', () => {
    // Reset state before each test
    beforeEach(() => {
        rateLimiter.reset();
        // Reset config to defaults
        rateLimiter.configure({
            maxEmailsPerWindow: 50,
            maxBulletinsPerWindow: 10,
            maxSlackMessagesPerWindow: 20,
            windowSizeMs: 5 * 60 * 1000,
            cooldownMs: 60 * 1000,
        });
    });

    describe('configure', () => {
        it('should return current config', () => {
            const config = rateLimiter.getConfig();
            expect(config).toHaveProperty('maxEmailsPerWindow');
            expect(config).toHaveProperty('maxBulletinsPerWindow');
            expect(config).toHaveProperty('maxSlackMessagesPerWindow');
            expect(config).toHaveProperty('windowSizeMs');
            expect(config).toHaveProperty('cooldownMs');
        });

        it('should allow configuring custom limits', () => {
            const newConfig = rateLimiter.configure({
                maxEmailsPerWindow: 100,
                maxBulletinsPerWindow: 25,
            });

            expect(newConfig.maxEmailsPerWindow).toBe(100);
            expect(newConfig.maxBulletinsPerWindow).toBe(25);
            // Other values should use defaults
            expect(newConfig.maxSlackMessagesPerWindow).toBe(20);
        });
    });

    describe('email rate limiting', () => {
        it('should allow processing emails within limit', () => {
            const result = rateLimiter.canProcessEmail();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(50);
        });

        it('should track processed emails', () => {
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordEmailProcessed();

            const result = rateLimiter.canProcessEmail();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(47);
        });

        it('should block when limit exceeded', () => {
            // Configure low limit for testing
            rateLimiter.configure({ maxEmailsPerWindow: 3 });

            // Process 3 emails
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordEmailProcessed();

            // Fourth should be blocked
            const result = rateLimiter.canProcessEmail();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Email rate limit exceeded');
            expect(result.remaining).toBe(0);
        });

        it('should track suppressed emails', () => {
            rateLimiter.recordEmailSuppressed();
            rateLimiter.recordEmailSuppressed();

            const status = rateLimiter.getStatus();
            expect(status.suppressed.emails).toBe(2);
        });
    });

    describe('bulletin rate limiting', () => {
        it('should allow posting bulletins within limit', () => {
            const result = rateLimiter.canPostBulletin();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(10);
        });

        it('should track posted bulletins', () => {
            rateLimiter.recordBulletinPosted();
            rateLimiter.recordBulletinPosted();

            const result = rateLimiter.canPostBulletin();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(8);
        });

        it('should block when bulletin limit exceeded', () => {
            rateLimiter.configure({ maxBulletinsPerWindow: 2 });

            rateLimiter.recordBulletinPosted();
            rateLimiter.recordBulletinPosted();

            const result = rateLimiter.canPostBulletin();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Bulletin rate limit exceeded');
        });

        it('should track suppressed bulletins with data', () => {
            const bulletinData = { type: 'vendor_deal', from: 'test@example.com' };
            rateLimiter.recordBulletinSuppressed(bulletinData);

            const status = rateLimiter.getStatus();
            expect(status.suppressed.bulletins).toBe(1);

            // Get suppressed and reset
            const suppressed = rateLimiter.getSuppressedAndReset();
            expect(suppressed.bulletins).toHaveLength(1);
            expect(suppressed.bulletins[0].data).toEqual(bulletinData);
        });
    });

    describe('Slack message rate limiting', () => {
        it('should allow posting Slack messages within limit', () => {
            const result = rateLimiter.canPostSlackMessage();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(20);
        });

        it('should track posted Slack messages', () => {
            rateLimiter.recordSlackMessagePosted();

            const result = rateLimiter.canPostSlackMessage();
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(19);
        });

        it('should block when Slack message limit exceeded', () => {
            rateLimiter.configure({ maxSlackMessagesPerWindow: 2 });

            rateLimiter.recordSlackMessagePosted();
            rateLimiter.recordSlackMessagePosted();

            const result = rateLimiter.canPostSlackMessage();
            expect(result.allowed).toBe(false);
            expect(result.reason).toContain('Slack message rate limit exceeded');
        });

        it('should track suppressed Slack messages', () => {
            rateLimiter.recordSlackMessageSuppressed();
            rateLimiter.recordSlackMessageSuppressed();

            const status = rateLimiter.getStatus();
            expect(status.suppressed.slackMessages).toBe(2);
        });
    });

    describe('cooldown behavior', () => {
        it('should not be in cooldown initially', () => {
            expect(rateLimiter.isInCooldown()).toBe(false);
        });

        it('should enter cooldown when email limit exceeded', () => {
            rateLimiter.configure({ maxEmailsPerWindow: 1 });
            rateLimiter.recordEmailProcessed();

            const result = rateLimiter.canProcessEmail();
            expect(result.allowed).toBe(false);
            expect(rateLimiter.isInCooldown()).toBe(true);
        });

        it('should block all operations during cooldown', () => {
            // Trigger cooldown via email limit
            rateLimiter.configure({ maxEmailsPerWindow: 1 });
            rateLimiter.recordEmailProcessed();
            rateLimiter.canProcessEmail(); // Triggers cooldown

            // All operations should be blocked
            expect(rateLimiter.canProcessEmail().allowed).toBe(false);
            expect(rateLimiter.canProcessEmail().reason).toBe('Rate limit cooldown active');
            expect(rateLimiter.canPostBulletin().allowed).toBe(false);
            expect(rateLimiter.canPostSlackMessage().allowed).toBe(false);
        });

        it('should exit cooldown after cooldownMs expires', () => {
            rateLimiter.configure({
                maxEmailsPerWindow: 1,
                cooldownMs: 10, // Very short for testing
            });
            rateLimiter.recordEmailProcessed();
            rateLimiter.canProcessEmail(); // Triggers cooldown

            expect(rateLimiter.isInCooldown()).toBe(true);

            // Wait for cooldown to expire
            return new Promise((resolve) => {
                setTimeout(() => {
                    expect(rateLimiter.isInCooldown()).toBe(false);
                    resolve();
                }, 15);
            });
        });
    });

    describe('getStatus', () => {
        it('should return comprehensive status', () => {
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordBulletinPosted();
            rateLimiter.recordSlackMessagePosted();
            rateLimiter.recordEmailSuppressed();

            const status = rateLimiter.getStatus();

            expect(status.inCooldown).toBe(false);
            expect(status.cooldownExpiresAt).toBeNull();

            expect(status.emails.count).toBe(1);
            expect(status.emails.max).toBe(50);
            expect(status.emails.remaining).toBe(49);

            expect(status.bulletins.count).toBe(1);
            expect(status.bulletins.max).toBe(10);
            expect(status.bulletins.remaining).toBe(9);

            expect(status.slackMessages.count).toBe(1);
            expect(status.slackMessages.max).toBe(20);
            expect(status.slackMessages.remaining).toBe(19);

            expect(status.suppressed.emails).toBe(1);
            expect(status.suppressed.bulletins).toBe(0);
            expect(status.suppressed.slackMessages).toBe(0);
        });
    });

    describe('getSuppressedAndReset', () => {
        it('should return suppressed items and reset counters', () => {
            rateLimiter.recordEmailSuppressed();
            rateLimiter.recordEmailSuppressed();
            rateLimiter.recordBulletinSuppressed({ type: 'vendor_deal' });
            rateLimiter.recordSlackMessageSuppressed();

            const suppressed = rateLimiter.getSuppressedAndReset();

            expect(suppressed.emails).toBe(2);
            expect(suppressed.bulletins).toHaveLength(1);
            expect(suppressed.slackMessages).toBe(1);

            // Counters should be reset
            const statusAfter = rateLimiter.getStatus();
            expect(statusAfter.suppressed.emails).toBe(0);
            expect(statusAfter.suppressed.bulletins).toBe(0);
            expect(statusAfter.suppressed.slackMessages).toBe(0);
        });
    });

    describe('formatSuppressedSummary', () => {
        it('should return null when nothing suppressed', () => {
            const suppressed = { emails: 0, bulletins: [], slackMessages: 0 };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toBeNull();
        });

        it('should format email-only summary', () => {
            const suppressed = { emails: 5, bulletins: [], slackMessages: 0 };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toContain('5 emails skipped');
        });

        it('should format singular email correctly', () => {
            const suppressed = { emails: 1, bulletins: [], slackMessages: 0 };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toContain('1 email skipped');
            expect(summary).not.toContain('emails');
        });

        it('should format bulletin summary with type grouping', () => {
            const suppressed = {
                emails: 0,
                bulletins: [
                    { data: { type: 'vendor_deal' } },
                    { data: { type: 'vendor_deal' } },
                    { data: { type: 'alert' } },
                ],
                slackMessages: 0,
            };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toContain('3 bulletins suppressed');
            expect(summary).toContain('2 vendor_deal');
            expect(summary).toContain('1 alert');
        });

        it('should format combined summary', () => {
            const suppressed = {
                emails: 3,
                bulletins: [{ data: { type: 'vendor_deal' } }],
                slackMessages: 2,
            };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toContain('3 emails skipped');
            expect(summary).toContain('1 bulletin suppressed');
            expect(summary).toContain('2 notifications batched');
        });

        it('should include warning emoji and protection message', () => {
            const suppressed = { emails: 1, bulletins: [], slackMessages: 0 };
            const summary = rateLimiter.formatSuppressedSummary(suppressed);
            expect(summary).toContain(':warning:');
            expect(summary).toContain('Rate limit summary');
            expect(summary).toContain('flood attacks');
        });
    });

    describe('reset', () => {
        it('should clear all state', () => {
            // Add some state
            rateLimiter.recordEmailProcessed();
            rateLimiter.recordBulletinPosted();
            rateLimiter.recordSlackMessagePosted();
            rateLimiter.recordEmailSuppressed();

            // Trigger cooldown
            rateLimiter.configure({ maxEmailsPerWindow: 1 });
            rateLimiter.canProcessEmail();

            // Reset
            rateLimiter.reset();

            const status = rateLimiter.getStatus();
            expect(status.inCooldown).toBe(false);
            expect(status.emails.count).toBe(0);
            expect(status.bulletins.count).toBe(0);
            expect(status.slackMessages.count).toBe(0);
            expect(status.suppressed.emails).toBe(0);
        });
    });

    describe('sliding window cleanup', () => {
        it('should clean up timestamps older than window', async () => {
            // Configure very short window
            rateLimiter.configure({
                windowSizeMs: 50, // 50ms window
            });

            rateLimiter.recordEmailProcessed();
            rateLimiter.recordEmailProcessed();

            expect(rateLimiter.getStatus().emails.count).toBe(2);

            // Wait for window to expire
            await new Promise((resolve) => setTimeout(resolve, 60));

            // Getting status triggers cleanup
            const status = rateLimiter.getStatus();
            expect(status.emails.count).toBe(0);
        });
    });

    describe('DEFAULT_CONFIG export', () => {
        it('should export DEFAULT_CONFIG for reference', () => {
            expect(rateLimiter.DEFAULT_CONFIG).toBeDefined();
            expect(rateLimiter.DEFAULT_CONFIG.maxEmailsPerWindow).toBe(50);
            expect(rateLimiter.DEFAULT_CONFIG.maxBulletinsPerWindow).toBe(10);
            expect(rateLimiter.DEFAULT_CONFIG.maxSlackMessagesPerWindow).toBe(20);
        });
    });

    describe('flood attack scenario', () => {
        it('should protect against rapid email flood', () => {
            // Simulate flood attack: many emails in rapid succession
            rateLimiter.configure({ maxEmailsPerWindow: 10 });

            const results = [];
            for (let i = 0; i < 20; i++) {
                const canProcess = rateLimiter.canProcessEmail();
                if (canProcess.allowed) {
                    rateLimiter.recordEmailProcessed();
                    results.push('processed');
                } else {
                    rateLimiter.recordEmailSuppressed();
                    results.push('blocked');
                }
            }

            // First 10 should be processed
            expect(results.filter((r) => r === 'processed').length).toBe(10);
            // Remaining should be blocked
            expect(results.filter((r) => r === 'blocked').length).toBe(10);

            // System should be in cooldown
            expect(rateLimiter.isInCooldown()).toBe(true);

            // Status should show suppressed count
            const status = rateLimiter.getStatus();
            expect(status.suppressed.emails).toBe(10);
        });

        it('should protect bulletins during vendor deal spam', () => {
            // Simulate many vendor deals at once
            rateLimiter.configure({ maxBulletinsPerWindow: 3 });

            const posted = [];
            const suppressed = [];

            for (let i = 0; i < 10; i++) {
                const canPost = rateLimiter.canPostBulletin();
                if (canPost.allowed) {
                    rateLimiter.recordBulletinPosted();
                    posted.push(i);
                } else {
                    rateLimiter.recordBulletinSuppressed({
                        type: 'vendor_deal',
                        from: `vendor${i}@example.com`,
                    });
                    suppressed.push(i);
                }
            }

            expect(posted.length).toBe(3);
            expect(suppressed.length).toBe(7);

            // Get suppressed summary
            const suppressedData = rateLimiter.getSuppressedAndReset();
            expect(suppressedData.bulletins.length).toBe(7);

            // Format should show grouped types
            const summary = rateLimiter.formatSuppressedSummary({
                emails: 0,
                bulletins: suppressedData.bulletins,
                slackMessages: 0,
            });
            expect(summary).toContain('7 bulletins suppressed');
            expect(summary).toContain('7 vendor_deal');
        });
    });
});
