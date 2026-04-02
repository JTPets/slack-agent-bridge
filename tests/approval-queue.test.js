/**
 * tests/approval-queue.test.js
 *
 * Unit tests for lib/approval-queue.js
 * Tests manual approval queue for auto-generated tasks.
 *
 * LOGIC CHANGE 2026-04-01: Added tests for approval queue module.
 */

'use strict';

// Set required env vars before loading modules
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.BRIDGE_CHANNEL_ID = 'C_BRIDGE_TEST';
process.env.OPS_CHANNEL_ID = 'C_OPS_TEST';

const fs = require('fs');
const path = require('path');
const approvalQueue = require('../lib/approval-queue');

describe('approval-queue', () => {
    beforeEach(() => {
        // Clear queue before each test
        approvalQueue.clearQueue();
    });

    afterEach(() => {
        // Clean up after tests
        approvalQueue.clearQueue();
    });

    describe('queueTask', () => {
        test('queues a valid task and returns id', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
                targetChannel: 'C123456',
                targetAgent: 'bridge',
                taskMessage: 'TASK: Fix security issue',
                metadata: { repo: 'test/repo', severity: 'HIGH' },
            });

            expect(result.queued).toBe(true);
            expect(result.id).toBeDefined();
            expect(result.id).toMatch(/^sec-[a-f0-9]{6}$/);
        });

        test('returns error for invalid task (missing source)', () => {
            const result = approvalQueue.queueTask({
                taskMessage: 'TASK: Test',
            });

            expect(result.queued).toBe(false);
            expect(result.reason).toContain('missing required fields');
        });

        test('returns error for invalid task (missing taskMessage)', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
            });

            expect(result.queued).toBe(false);
            expect(result.reason).toContain('missing required fields');
        });

        test('returns error for null task', () => {
            const result = approvalQueue.queueTask(null);

            expect(result.queued).toBe(false);
            expect(result.reason).toContain('missing required fields');
        });
    });

    describe('getPendingTasks', () => {
        test('returns empty array when no tasks', () => {
            const pending = approvalQueue.getPendingTasks();
            expect(pending).toEqual([]);
        });

        test('returns queued tasks', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test 1',
            });
            approvalQueue.queueTask({
                source: 'email-monitor',
                taskMessage: 'TASK: Test 2',
            });

            const pending = approvalQueue.getPendingTasks();
            expect(pending).toHaveLength(2);
        });

        test('filters by source', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Security',
            });
            approvalQueue.queueTask({
                source: 'email-monitor',
                taskMessage: 'TASK: Email',
            });

            const securityTasks = approvalQueue.getPendingTasks({ source: 'security-followup' });
            expect(securityTasks).toHaveLength(1);
            expect(securityTasks[0].source).toBe('security-followup');
        });
    });

    describe('getTaskById', () => {
        test('returns null for non-existent task', () => {
            const task = approvalQueue.getTaskById('nonexistent');
            expect(task).toBeNull();
        });

        test('finds pending task by id', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });

            const task = approvalQueue.getTaskById(result.id);
            expect(task).not.toBeNull();
            expect(task.id).toBe(result.id);
            expect(task.status).toBe('pending');
        });

        test('finds approved task by id', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });
            approvalQueue.approveTask(result.id, 'owner');

            const task = approvalQueue.getTaskById(result.id);
            expect(task.status).toBe('approved');
        });

        test('finds task case-insensitively', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });

            const task = approvalQueue.getTaskById(result.id.toUpperCase());
            expect(task).not.toBeNull();
            expect(task.id).toBe(result.id);
        });
    });

    describe('approveTask', () => {
        test('approves pending task', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });

            const result = approvalQueue.approveTask(queueResult.id, 'owner');

            expect(result.success).toBe(true);
            expect(result.task).toBeDefined();
            expect(result.task.status).toBe('approved');
            expect(result.task.approvedBy).toBe('owner');
        });

        test('returns error for non-existent task', () => {
            const result = approvalQueue.approveTask('nonexistent', 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task not found');
        });

        test('returns error for already approved task', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });
            approvalQueue.approveTask(queueResult.id, 'owner');

            const result = approvalQueue.approveTask(queueResult.id, 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task already approved');
        });

        test('returns error for rejected task', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });
            approvalQueue.rejectTask(queueResult.id, 'owner');

            const result = approvalQueue.approveTask(queueResult.id, 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task was rejected');
        });

        test('returns error for null id', () => {
            const result = approvalQueue.approveTask(null, 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task ID is required');
        });
    });

    describe('approveAllTasks', () => {
        test('approves all pending tasks', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test 1',
            });
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test 2',
            });

            const result = approvalQueue.approveAllTasks('owner');

            expect(result.success).toBe(true);
            expect(result.count).toBe(2);
            expect(result.tasks).toHaveLength(2);
            expect(approvalQueue.getPendingTasks()).toHaveLength(0);
        });

        test('filters by source', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Security',
            });
            approvalQueue.queueTask({
                source: 'email-monitor',
                taskMessage: 'TASK: Email',
            });

            const result = approvalQueue.approveAllTasks('owner', { source: 'security-followup' });

            expect(result.count).toBe(1);
            expect(approvalQueue.getPendingTasks()).toHaveLength(1);
            expect(approvalQueue.getPendingTasks()[0].source).toBe('email-monitor');
        });

        test('returns count 0 when no pending tasks', () => {
            const result = approvalQueue.approveAllTasks('owner');

            expect(result.success).toBe(true);
            expect(result.count).toBe(0);
        });
    });

    describe('rejectTask', () => {
        test('rejects pending task', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });

            const result = approvalQueue.rejectTask(queueResult.id, 'owner', 'False positive');

            expect(result.success).toBe(true);
        });

        test('stores rejection reason', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });
            approvalQueue.rejectTask(queueResult.id, 'owner', 'Not a real issue');

            const task = approvalQueue.getTaskById(queueResult.id);
            expect(task.status).toBe('rejected');
            expect(task.rejectionReason).toBe('Not a real issue');
        });

        test('returns error for non-existent task', () => {
            const result = approvalQueue.rejectTask('nonexistent', 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task not found');
        });

        test('returns error for already rejected task', () => {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });
            approvalQueue.rejectTask(queueResult.id, 'owner');

            const result = approvalQueue.rejectTask(queueResult.id, 'owner');

            expect(result.success).toBe(false);
            expect(result.error).toBe('Task already rejected');
        });
    });

    describe('rejectAllTasks', () => {
        test('rejects all pending tasks', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test 1',
            });
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test 2',
            });

            const result = approvalQueue.rejectAllTasks('owner', 'Batch reject');

            expect(result.success).toBe(true);
            expect(result.count).toBe(2);
            expect(approvalQueue.getPendingTasks()).toHaveLength(0);
        });

        test('filters by source', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Security',
            });
            approvalQueue.queueTask({
                source: 'email-monitor',
                taskMessage: 'TASK: Email',
            });

            const result = approvalQueue.rejectAllTasks('owner', 'Reject security', { source: 'security-followup' });

            expect(result.count).toBe(1);
            expect(approvalQueue.getPendingTasks()).toHaveLength(1);
        });
    });

    describe('getStats', () => {
        test('returns correct statistics', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Pending 1',
            });
            const approved = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: To approve',
            });
            approvalQueue.approveTask(approved.id, 'owner');

            const rejected = approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: To reject',
            });
            approvalQueue.rejectTask(rejected.id, 'owner');

            const stats = approvalQueue.getStats();

            expect(stats.pending).toBe(1);
            expect(stats.approved).toBe(1);
            expect(stats.rejected).toBe(1);
            expect(stats.oldestPending).toBeDefined();
        });

        test('returns null oldestPending when no pending tasks', () => {
            const stats = approvalQueue.getStats();
            expect(stats.oldestPending).toBeNull();
        });
    });

    describe('formatPendingTasks', () => {
        test('returns success message when no pending tasks', () => {
            const formatted = approvalQueue.formatPendingTasks();
            expect(formatted).toContain('No tasks awaiting approval');
        });

        test('formats pending tasks for display', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                targetAgent: 'bridge',
                taskMessage: 'TASK: Fix vulnerability',
                metadata: {
                    repo: 'jtpets/test-repo',
                    file: 'auth.js',
                    highestSeverity: 'CRITICAL',
                },
            });

            const formatted = approvalQueue.formatPendingTasks();

            expect(formatted).toContain('1 task(s) awaiting approval');
            expect(formatted).toContain('security-followup');
            expect(formatted).toContain('jtpets/test-repo');
            expect(formatted).toContain('CRITICAL');
            expect(formatted).toContain('approve');
            expect(formatted).toContain('reject');
        });
    });

    describe('formatTaskDetails', () => {
        test('returns not found message for null task', () => {
            const formatted = approvalQueue.formatTaskDetails(null);
            expect(formatted).toContain('Task not found');
        });

        test('formats task details', () => {
            const result = approvalQueue.queueTask({
                source: 'security-followup',
                targetChannel: 'C123456',
                targetAgent: 'bridge',
                taskMessage: 'TASK: Fix XSS\nREPO: test/repo\nINSTRUCTIONS: Fix the issue',
                metadata: {
                    repo: 'test/repo',
                    file: 'user.js',
                    highestSeverity: 'HIGH',
                    findingCount: 2,
                },
            });

            const task = approvalQueue.getTaskById(result.id);
            const formatted = approvalQueue.formatTaskDetails(task);

            expect(formatted).toContain(result.id);
            expect(formatted).toContain('pending');
            expect(formatted).toContain('security-followup');
            expect(formatted).toContain('test/repo');
            expect(formatted).toContain('user.js');
            expect(formatted).toContain('HIGH');
            expect(formatted).toContain('TASK: Fix XSS');
        });
    });

    describe('requiresApproval', () => {
        test('returns true for security-followup', () => {
            expect(approvalQueue.requiresApproval('security-followup')).toBe(true);
        });

        test('returns true for email-monitor', () => {
            expect(approvalQueue.requiresApproval('email-monitor')).toBe(true);
        });

        test('returns true for automated-scan', () => {
            expect(approvalQueue.requiresApproval('automated-scan')).toBe(true);
        });

        test('returns false for unknown source', () => {
            expect(approvalQueue.requiresApproval('manual')).toBe(false);
        });
    });

    describe('cleanup', () => {
        test('does not fail on empty queue', () => {
            const result = approvalQueue.cleanup();
            expect(result.expiredPending).toBe(0);
            expect(result.cleanedApproved).toBe(0);
            expect(result.cleanedRejected).toBe(0);
        });

        test('cleans up queue without removing recent items', () => {
            // Queue a task (will be recent)
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Recent task',
            });

            const result = approvalQueue.cleanup();

            expect(result.expiredPending).toBe(0);
            expect(approvalQueue.getPendingTasks()).toHaveLength(1);
        });
    });

    describe('clearQueue', () => {
        test('clears all entries', () => {
            approvalQueue.queueTask({
                source: 'security-followup',
                taskMessage: 'TASK: Test',
            });

            approvalQueue.clearQueue();

            expect(approvalQueue.getPendingTasks()).toHaveLength(0);
            expect(approvalQueue.getStats().pending).toBe(0);
            expect(approvalQueue.getStats().approved).toBe(0);
            expect(approvalQueue.getStats().rejected).toBe(0);
        });
    });
});

describe('task-parser approval commands', () => {
    const taskParser = require('../lib/task-parser');

    describe('isApprovalQuery', () => {
        test('detects "pending approvals"', () => {
            expect(taskParser.isApprovalQuery('pending approvals')).toBe(true);
            expect(taskParser.isApprovalQuery('Pending Approvals')).toBe(true);
        });

        test('detects "approval queue"', () => {
            expect(taskParser.isApprovalQuery('approval queue')).toBe(true);
        });

        test('detects "awaiting approval"', () => {
            expect(taskParser.isApprovalQuery('awaiting approval')).toBe(true);
        });

        test('detects "what\'s pending"', () => {
            expect(taskParser.isApprovalQuery("what's pending")).toBe(true);
            expect(taskParser.isApprovalQuery('whats pending')).toBe(true);
        });

        test('returns false for unrelated text', () => {
            expect(taskParser.isApprovalQuery('hello')).toBe(false);
            expect(taskParser.isApprovalQuery('approve task123')).toBe(false);
        });
    });

    describe('isApproveCommand', () => {
        test('detects "approve" commands', () => {
            expect(taskParser.isApproveCommand('approve sec-123456')).toBe(true);
            expect(taskParser.isApproveCommand('Approve all')).toBe(true);
        });

        test('returns false for non-approve text', () => {
            expect(taskParser.isApproveCommand('pending approvals')).toBe(false);
            expect(taskParser.isApproveCommand('reject sec-123456')).toBe(false);
        });
    });

    describe('parseApproveCommand', () => {
        test('parses "approve all"', () => {
            const result = taskParser.parseApproveCommand('approve all');
            expect(result).toEqual({ all: true });
        });

        test('parses "approve <id>"', () => {
            const result = taskParser.parseApproveCommand('approve sec-abc123');
            expect(result).toEqual({ all: false, id: 'sec-abc123' });
        });

        test('returns null for invalid command', () => {
            expect(taskParser.parseApproveCommand('approve')).toBeNull();
            expect(taskParser.parseApproveCommand(null)).toBeNull();
        });
    });

    describe('isRejectCommand', () => {
        test('detects "reject" commands', () => {
            expect(taskParser.isRejectCommand('reject sec-123456')).toBe(true);
            expect(taskParser.isRejectCommand('Reject all false positives')).toBe(true);
        });

        test('returns false for non-reject text', () => {
            expect(taskParser.isRejectCommand('approve all')).toBe(false);
        });
    });

    describe('parseRejectCommand', () => {
        test('parses "reject all"', () => {
            const result = taskParser.parseRejectCommand('reject all');
            expect(result).toEqual({ all: true, reason: '' });
        });

        test('parses "reject all [reason]"', () => {
            const result = taskParser.parseRejectCommand('reject all false positives');
            expect(result).toEqual({ all: true, reason: 'false positives' });
        });

        test('parses "reject <id>"', () => {
            const result = taskParser.parseRejectCommand('reject sec-abc123');
            expect(result).toEqual({ all: false, id: 'sec-abc123', reason: '' });
        });

        test('parses "reject <id> [reason]"', () => {
            const result = taskParser.parseRejectCommand('reject sec-abc123 not a real issue');
            expect(result).toEqual({ all: false, id: 'sec-abc123', reason: 'not a real issue' });
        });

        test('returns null for invalid command', () => {
            expect(taskParser.parseRejectCommand('reject')).toBeNull();
            expect(taskParser.parseRejectCommand(null)).toBeNull();
        });
    });

    describe('isShowTaskCommand', () => {
        test('detects "show task" commands', () => {
            expect(taskParser.isShowTaskCommand('show task sec-123456')).toBe(true);
            expect(taskParser.isShowTaskCommand('Show Task ABC-123')).toBe(true);
        });

        test('returns false for non-show-task text', () => {
            expect(taskParser.isShowTaskCommand('approve sec-123456')).toBe(false);
            expect(taskParser.isShowTaskCommand('show pending')).toBe(false);
        });
    });

    describe('parseShowTaskCommand', () => {
        test('parses task ID', () => {
            const result = taskParser.parseShowTaskCommand('show task sec-abc123');
            expect(result).toBe('sec-abc123');
        });

        test('returns null for invalid command', () => {
            expect(taskParser.parseShowTaskCommand('show task')).toBeNull();
            expect(taskParser.parseShowTaskCommand(null)).toBeNull();
        });
    });
});
