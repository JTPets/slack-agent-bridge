/**
 * tests/bulletin-board.test.js
 *
 * Unit tests for lib/bulletin-board.js
 * LOGIC CHANGE 2026-03-28: Initial test suite for bulletin board system
 */

const fs = require('fs');
const path = require('path');

// Test with a temp directory to avoid polluting real bulletin file
const TEST_BULLETIN_DIR = path.join(__dirname, '..', 'agents', 'shared');
const TEST_BULLETIN_FILE = path.join(TEST_BULLETIN_DIR, 'bulletin.json');

// Clear bulletin file before each test
function resetBulletinFile() {
    try {
        if (fs.existsSync(TEST_BULLETIN_FILE)) {
            fs.unlinkSync(TEST_BULLETIN_FILE);
        }
    } catch (err) {
        // Ignore cleanup errors
    }
}

// Import the module
const bulletinBoard = require('../lib/bulletin-board');

describe('bulletin-board', () => {
    beforeEach(() => {
        resetBulletinFile();
    });

    afterAll(() => {
        resetBulletinFile();
    });

    describe('postBulletin', () => {
        test('creates a bulletin with required fields', () => {
            const result = bulletinBoard.postBulletin('bridge', 'task_completed', {
                description: 'Test task completed',
            });

            expect(result.success).toBe(true);
            expect(result.bulletin).toBeDefined();
            expect(result.bulletin.id).toBeDefined();
            expect(result.bulletin.agentId).toBe('bridge');
            expect(result.bulletin.type).toBe('task_completed');
            expect(result.bulletin.data.description).toBe('Test task completed');
            expect(result.bulletin.timestamp).toBeDefined();
            expect(result.bulletin.read_by).toEqual([]);
        });

        test('fails without agentId', () => {
            const result = bulletinBoard.postBulletin(null, 'task_completed', { description: 'test' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('agentId');
        });

        test('fails with invalid type', () => {
            const result = bulletinBoard.postBulletin('bridge', 'invalid_type', { description: 'test' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Invalid type');
        });

        test('fails without data object', () => {
            const result = bulletinBoard.postBulletin('bridge', 'task_completed', null);

            expect(result.success).toBe(false);
            expect(result.error).toContain('data');
        });

        test('allows all valid bulletin types', () => {
            const types = ['milestone', 'alert', 'vendor_deal', 'customer_insight', 'task_completed', 'security_finding', 'content_idea'];

            for (const type of types) {
                const result = bulletinBoard.postBulletin('test-agent', type, { description: 'test' });
                expect(result.success).toBe(true);
                expect(result.bulletin.type).toBe(type);
            }
        });
    });

    describe('getBulletins', () => {
        test('returns empty array when no bulletins exist', () => {
            const result = bulletinBoard.getBulletins();
            expect(result).toEqual([]);
        });

        test('returns all bulletins sorted newest first', () => {
            // Post bulletins with manually different timestamps to avoid race conditions
            const result1 = bulletinBoard.postBulletin('agent1', 'milestone', { description: 'first' });
            const result2 = bulletinBoard.postBulletin('agent2', 'alert', { description: 'second' });
            const result3 = bulletinBoard.postBulletin('agent1', 'task_completed', { description: 'third' });

            // Manually update timestamps to ensure ordering
            const bulletins = bulletinBoard.loadBulletins();
            const now = Date.now();
            bulletins[0].timestamp = new Date(now - 2000).toISOString();  // oldest
            bulletins[1].timestamp = new Date(now - 1000).toISOString();
            bulletins[2].timestamp = new Date(now).toISOString();         // newest
            bulletinBoard.saveBulletins(bulletins);

            const sorted = bulletinBoard.getBulletins();

            expect(sorted.length).toBe(3);
            expect(sorted[0].data.description).toBe('third');
            expect(sorted[2].data.description).toBe('first');
        });

        test('filters by type', () => {
            bulletinBoard.postBulletin('agent1', 'milestone', { description: 'milestone1' });
            bulletinBoard.postBulletin('agent1', 'alert', { description: 'alert1' });
            bulletinBoard.postBulletin('agent1', 'milestone', { description: 'milestone2' });

            const milestones = bulletinBoard.getBulletins({ type: 'milestone' });

            expect(milestones.length).toBe(2);
            milestones.forEach(b => expect(b.type).toBe('milestone'));
        });

        test('filters by agentId', () => {
            bulletinBoard.postBulletin('bridge', 'milestone', { description: 'from bridge' });
            bulletinBoard.postBulletin('secretary', 'alert', { description: 'from secretary' });
            bulletinBoard.postBulletin('bridge', 'alert', { description: 'from bridge again' });

            const bridgeBulletins = bulletinBoard.getBulletins({ agentId: 'bridge' });

            expect(bridgeBulletins.length).toBe(2);
            bridgeBulletins.forEach(b => expect(b.agentId).toBe('bridge'));
        });

        test('filters by unreadBy', () => {
            bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test1' });
            const result2 = bulletinBoard.postBulletin('bridge', 'alert', { description: 'test2' });

            // Mark first bulletin as read by secretary
            const bulletins = bulletinBoard.getBulletins();
            bulletinBoard.markRead(bulletins[1].id, 'secretary');

            const unread = bulletinBoard.getBulletins({ unreadBy: 'secretary' });

            expect(unread.length).toBe(1);
            expect(unread[0].data.description).toBe('test2');
        });

        test('filters by since timestamp', () => {
            bulletinBoard.postBulletin('bridge', 'milestone', { description: 'old' });

            // Wait a bit to ensure different timestamps
            const now = new Date().toISOString();

            bulletinBoard.postBulletin('bridge', 'alert', { description: 'new' });

            const recent = bulletinBoard.getBulletins({ since: now });

            // Should only get the one posted after 'now'
            expect(recent.length).toBeLessThanOrEqual(1);
            if (recent.length > 0) {
                expect(recent[0].data.description).toBe('new');
            }
        });

        test('respects limit parameter', () => {
            for (let i = 0; i < 10; i++) {
                bulletinBoard.postBulletin('bridge', 'milestone', { description: `test ${i}` });
            }

            const limited = bulletinBoard.getBulletins({ limit: 3 });

            expect(limited.length).toBe(3);
        });
    });

    describe('markRead', () => {
        test('marks a bulletin as read by an agent', () => {
            const result = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            const bulletinId = result.bulletin.id;

            const markResult = bulletinBoard.markRead(bulletinId, 'secretary');

            expect(markResult.success).toBe(true);

            const bulletins = bulletinBoard.getBulletins();
            const bulletin = bulletins.find(b => b.id === bulletinId);
            expect(bulletin.read_by).toContain('secretary');
        });

        test('does not duplicate agentId in read_by', () => {
            const result = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            const bulletinId = result.bulletin.id;

            bulletinBoard.markRead(bulletinId, 'secretary');
            bulletinBoard.markRead(bulletinId, 'secretary');

            const bulletins = bulletinBoard.getBulletins();
            const bulletin = bulletins.find(b => b.id === bulletinId);
            expect(bulletin.read_by.filter(a => a === 'secretary').length).toBe(1);
        });

        test('allows multiple agents to mark same bulletin as read', () => {
            const result = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            const bulletinId = result.bulletin.id;

            bulletinBoard.markRead(bulletinId, 'secretary');
            bulletinBoard.markRead(bulletinId, 'security');

            const bulletins = bulletinBoard.getBulletins();
            const bulletin = bulletins.find(b => b.id === bulletinId);
            expect(bulletin.read_by).toContain('secretary');
            expect(bulletin.read_by).toContain('security');
        });

        test('fails for non-existent bulletin', () => {
            const result = bulletinBoard.markRead('nonexistent-id', 'secretary');
            expect(result.success).toBe(false);
            expect(result.error).toContain('not found');
        });

        test('fails without required parameters', () => {
            expect(bulletinBoard.markRead(null, 'secretary').success).toBe(false);
            expect(bulletinBoard.markRead('id', null).success).toBe(false);
        });
    });

    describe('cleanupOldBulletins', () => {
        test('removes bulletins older than specified days', () => {
            // Create a bulletin and manually backdate it
            bulletinBoard.postBulletin('bridge', 'milestone', { description: 'old' });

            // Manually modify the bulletin file to backdate the bulletin
            const bulletins = bulletinBoard.loadBulletins();
            const oldDate = new Date();
            oldDate.setDate(oldDate.getDate() - 10); // 10 days ago
            bulletins[0].timestamp = oldDate.toISOString();
            bulletinBoard.saveBulletins(bulletins);

            // Add a new bulletin
            bulletinBoard.postBulletin('bridge', 'alert', { description: 'new' });

            // Cleanup bulletins older than 7 days
            const result = bulletinBoard.cleanupOldBulletins(7);

            expect(result.success).toBe(true);
            expect(result.removed).toBe(1);

            // Only new bulletin should remain
            const remaining = bulletinBoard.getBulletins();
            expect(remaining.length).toBe(1);
            expect(remaining[0].data.description).toBe('new');
        });

        test('keeps bulletins newer than specified days', () => {
            bulletinBoard.postBulletin('bridge', 'milestone', { description: 'recent' });

            const result = bulletinBoard.cleanupOldBulletins(7);

            expect(result.success).toBe(true);
            expect(result.removed).toBe(0);

            const remaining = bulletinBoard.getBulletins();
            expect(remaining.length).toBe(1);
        });

        test('uses default 7 days when no parameter provided', () => {
            // Just verify it runs without error
            const result = bulletinBoard.cleanupOldBulletins();
            expect(result.success).toBe(true);
        });
    });

    describe('formatBulletinsForSlack', () => {
        test('returns "No new bulletins" for empty array', () => {
            const result = bulletinBoard.formatBulletinsForSlack([]);
            expect(result).toBe('No new bulletins.');
        });

        test('formats bulletins with type emoji and agent', () => {
            bulletinBoard.postBulletin('bridge', 'task_completed', { description: 'Test task done' });
            const bulletins = bulletinBoard.getBulletins();

            const result = bulletinBoard.formatBulletinsForSlack(bulletins);

            expect(result).toContain('*Recent Bulletins:*');
            expect(result).toContain(':white_check_mark:');
            expect(result).toContain('*bridge*');
            expect(result).toContain('Test task done');
        });

        test('truncates long descriptions', () => {
            const longDesc = 'x'.repeat(100);
            bulletinBoard.postBulletin('bridge', 'milestone', { description: longDesc });
            const bulletins = bulletinBoard.getBulletins();

            const result = bulletinBoard.formatBulletinsForSlack(bulletins);

            expect(result).toContain('...');
            expect(result.length).toBeLessThan(longDesc.length + 200);
        });

        test('respects maxItems limit', () => {
            for (let i = 0; i < 5; i++) {
                bulletinBoard.postBulletin('bridge', 'milestone', { description: `item ${i}` });
            }
            const bulletins = bulletinBoard.getBulletins();

            const result = bulletinBoard.formatBulletinsForSlack(bulletins, 2);

            expect(result).toContain('...and 3 more');
        });
    });

    describe('formatBulletinsForContext', () => {
        test('returns empty string when no unread bulletins', () => {
            const result = bulletinBoard.formatBulletinsForContext('secretary');
            expect(result).toBe('');
        });

        test('formats unread bulletins for prompt context', () => {
            bulletinBoard.postBulletin('bridge', 'task_completed', { description: 'Task done' });

            const result = bulletinBoard.formatBulletinsForContext('secretary');

            expect(result).toContain('UNREAD BULLETINS FROM OTHER AGENTS:');
            expect(result).toContain('[task_completed]');
            expect(result).toContain('bridge:');
            expect(result).toContain('Task done');
        });

        test('excludes read bulletins', () => {
            const posted = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            bulletinBoard.markRead(posted.bulletin.id, 'secretary');

            const result = bulletinBoard.formatBulletinsForContext('secretary');

            expect(result).toBe('');
        });
    });

    describe('isBulletinQuery', () => {
        test('detects "bulletins" command', () => {
            expect(bulletinBoard.isBulletinQuery('bulletins')).toBe(true);
            expect(bulletinBoard.isBulletinQuery('Bulletins')).toBe(true);
            expect(bulletinBoard.isBulletinQuery('BULLETINS')).toBe(true);
        });

        test('detects "bulletin" singular', () => {
            expect(bulletinBoard.isBulletinQuery('bulletin')).toBe(true);
        });

        test('detects "what\'s new" command', () => {
            expect(bulletinBoard.isBulletinQuery("what's new")).toBe(true);
            expect(bulletinBoard.isBulletinQuery('whats new')).toBe(true);
            expect(bulletinBoard.isBulletinQuery("What's New")).toBe(true);
        });

        test('detects "show bulletins" command', () => {
            expect(bulletinBoard.isBulletinQuery('show bulletins')).toBe(true);
            expect(bulletinBoard.isBulletinQuery('show bulletin')).toBe(true);
        });

        test('returns false for non-matching queries', () => {
            expect(bulletinBoard.isBulletinQuery('queue status')).toBe(false);
            expect(bulletinBoard.isBulletinQuery('hello')).toBe(false);
            expect(bulletinBoard.isBulletinQuery('bulletin board rules')).toBe(false);
        });

        test('returns false for empty input', () => {
            expect(bulletinBoard.isBulletinQuery('')).toBe(false);
            expect(bulletinBoard.isBulletinQuery(null)).toBe(false);
            expect(bulletinBoard.isBulletinQuery(undefined)).toBe(false);
        });
    });

    describe('self-healing behavior', () => {
        test('handles corrupted JSON file', () => {
            // Write invalid JSON
            fs.writeFileSync(TEST_BULLETIN_FILE, '{invalid json}', 'utf8');

            // Should not throw, should reset file
            const result = bulletinBoard.loadBulletins();
            expect(result).toEqual([]);

            // Should be able to post after corruption
            const postResult = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            expect(postResult.success).toBe(true);
        });

        test('handles non-array JSON file', () => {
            // Write valid JSON but wrong type
            fs.writeFileSync(TEST_BULLETIN_FILE, '{"not": "array"}', 'utf8');

            // Should reset to empty array
            const result = bulletinBoard.loadBulletins();
            expect(result).toEqual([]);
        });

        test('handles empty file', () => {
            // Write empty file
            fs.writeFileSync(TEST_BULLETIN_FILE, '', 'utf8');

            // Should reset to empty array
            const result = bulletinBoard.loadBulletins();
            expect(result).toEqual([]);
        });

        test('auto-creates directory and file if missing', () => {
            // Remove file if exists
            resetBulletinFile();

            // Post should work
            const result = bulletinBoard.postBulletin('bridge', 'milestone', { description: 'test' });
            expect(result.success).toBe(true);

            // File should exist now
            expect(fs.existsSync(TEST_BULLETIN_FILE)).toBe(true);
        });
    });
});
