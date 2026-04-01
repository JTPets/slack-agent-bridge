'use strict';

/**
 * tests/task-queue.test.js
 *
 * Unit tests for lib/task-queue.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Save original env
const originalWorkDir = process.env.WORK_DIR;

describe('task-queue', () => {
    let tempDir;
    let queueFile;
    let TaskQueue;
    let getQueue;
    let hasActiveTasks;
    let getQueueStatus;
    let STATUS;

    beforeAll(() => {
        // Create temp directory for tests
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-test-'));
        queueFile = path.join(tempDir, 'task-queue.json');

        // Set WORK_DIR to temp directory before requiring module
        process.env.WORK_DIR = tempDir;

        // Require module after setting env
        const taskQueue = require('../lib/task-queue');
        TaskQueue = taskQueue.TaskQueue;
        getQueue = taskQueue.getQueue;
        hasActiveTasks = taskQueue.hasActiveTasks;
        getQueueStatus = taskQueue.getQueueStatus;
        STATUS = taskQueue.STATUS;
    });

    afterAll(() => {
        // Restore original env
        if (originalWorkDir !== undefined) {
            process.env.WORK_DIR = originalWorkDir;
        } else {
            delete process.env.WORK_DIR;
        }

        // Clean up temp directory
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    beforeEach(() => {
        // Clean queue file before each test
        if (fs.existsSync(queueFile)) {
            fs.unlinkSync(queueFile);
        }
    });

    describe('TaskQueue', () => {
        describe('constructor', () => {
            it('creates queue instance with default file path', () => {
                const queue = new TaskQueue();
                expect(queue).toBeDefined();
                expect(queue.queueFile).toContain('task-queue.json');
            });

            it('creates queue instance with custom file path', () => {
                const customPath = path.join(tempDir, 'custom-queue.json');
                const queue = new TaskQueue(customPath);
                expect(queue.queueFile).toBe(customPath);
            });
        });

        describe('enqueue', () => {
            it('adds task to empty queue', () => {
                const queue = new TaskQueue(queueFile);
                const task = queue.enqueue({
                    msgTs: '1234567890.123456',
                    channelId: 'C123',
                    text: 'TASK: Test task',
                    description: 'Test task',
                });

                expect(task).toBeDefined();
                expect(task.id).toBeDefined();
                expect(task.msgTs).toBe('1234567890.123456');
                expect(task.channelId).toBe('C123');
                expect(task.status).toBe(STATUS.PENDING);
                expect(task.enqueuedAt).toBeDefined();
            });

            it('assigns unique ids to tasks', () => {
                const queue = new TaskQueue(queueFile);
                const task1 = queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Task 1' });
                const task2 = queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Task 2' });

                expect(task1.id).not.toBe(task2.id);
            });

            it('deduplicates by msgTs', () => {
                const queue = new TaskQueue(queueFile);
                const task1 = queue.enqueue({ msgTs: '1234567890.123456', channelId: 'C123', text: 'T1', description: 'First' });
                const task2 = queue.enqueue({ msgTs: '1234567890.123456', channelId: 'C123', text: 'T2', description: 'Duplicate' });

                // Should return the existing task
                expect(task2.id).toBe(task1.id);
                expect(task2.description).toBe('First');

                // Queue should have only one task
                expect(queue.getPending().length).toBe(1);
            });

            it('persists queue to disk', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Persisted task' });

                // Read directly from file
                const data = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
                expect(data.length).toBe(1);
                expect(data[0].description).toBe('Persisted task');
            });
        });

        describe('dequeue', () => {
            it('returns null for empty queue', () => {
                const queue = new TaskQueue(queueFile);
                const task = queue.dequeue();
                expect(task).toBeNull();
            });

            it('returns first pending task and marks as running', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'First' });
                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Second' });

                const task = queue.dequeue();
                expect(task).toBeDefined();
                expect(task.description).toBe('First');
                expect(task.status).toBe(STATUS.RUNNING);
                expect(task.startedAt).toBeDefined();

                // Second task should still be pending
                const pending = queue.getPending();
                expect(pending.length).toBe(1);
                expect(pending[0].description).toBe('Second');
            });

            it('returns null when no pending tasks (all running/completed)', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'First' });
                queue.dequeue(); // Mark as running

                const task = queue.dequeue();
                expect(task).toBeNull();
            });
        });

        describe('complete', () => {
            it('marks task as completed', () => {
                const queue = new TaskQueue(queueFile);
                const queued = queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                const started = queue.dequeue();

                queue.complete(started.id, 'Success');

                const recent = queue.getRecentCompleted(1);
                expect(recent.length).toBe(1);
                expect(recent[0].status).toBe(STATUS.COMPLETED);
                expect(recent[0].completedAt).toBeDefined();
                expect(recent[0].outcome).toBe('Success');
            });

            it('handles non-existent task id gracefully', () => {
                const queue = new TaskQueue(queueFile);
                // Should not throw
                expect(() => queue.complete('nonexistent', 'Done')).not.toThrow();
            });
        });

        describe('fail', () => {
            it('marks task as failed with error message', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                const started = queue.dequeue();

                queue.fail(started.id, 'Task failed: timeout');

                const recent = queue.getRecentCompleted(1);
                expect(recent.length).toBe(1);
                expect(recent[0].status).toBe(STATUS.FAILED);
                expect(recent[0].error).toBe('Task failed: timeout');
            });
        });

        describe('recoverInterrupted', () => {
            it('marks running tasks as interrupted on startup recovery', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                queue.dequeue(); // Mark as running

                const count = queue.recoverInterrupted();
                expect(count).toBe(1);

                const recent = queue.getRecentCompleted(1);
                expect(recent[0].status).toBe(STATUS.INTERRUPTED);
                expect(recent[0].error).toContain('PM2 restart');
            });

            it('returns 0 when no running tasks', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                // Task is still pending, not running

                const count = queue.recoverInterrupted();
                expect(count).toBe(0);
            });
        });

        describe('getRunning', () => {
            it('returns null when no running task', () => {
                const queue = new TaskQueue(queueFile);
                expect(queue.getRunning()).toBeNull();
            });

            it('returns the running task', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Running task' });
                queue.dequeue();

                const running = queue.getRunning();
                expect(running).toBeDefined();
                expect(running.description).toBe('Running task');
            });
        });

        describe('getPending', () => {
            it('returns empty array when no pending tasks', () => {
                const queue = new TaskQueue(queueFile);
                expect(queue.getPending()).toEqual([]);
            });

            it('returns all pending tasks', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'First' });
                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Second' });

                const pending = queue.getPending();
                expect(pending.length).toBe(2);
            });
        });

        describe('getActiveCount', () => {
            it('returns 0 for empty queue', () => {
                const queue = new TaskQueue(queueFile);
                expect(queue.getActiveCount()).toBe(0);
            });

            it('counts pending and running tasks', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'First' });
                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Second' });
                queue.dequeue(); // Mark first as running

                expect(queue.getActiveCount()).toBe(2); // 1 running + 1 pending
            });
        });

        describe('isEmpty', () => {
            it('returns true for empty queue', () => {
                const queue = new TaskQueue(queueFile);
                expect(queue.isEmpty()).toBe(true);
            });

            it('returns false when tasks are active', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                expect(queue.isEmpty()).toBe(false);
            });

            it('returns true when all tasks completed', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test' });
                const task = queue.dequeue();
                queue.complete(task.id, 'Done');

                expect(queue.isEmpty()).toBe(true);
            });
        });

        describe('getStatus', () => {
            it('returns status counts', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Pending' });
                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Running' });
                const running = queue.dequeue();
                queue.enqueue({ msgTs: '3.3', channelId: 'C1', text: 'T3', description: 'Completed' });
                const completed = queue.dequeue();
                queue.complete(completed.id, 'Done');

                const status = queue.getStatus();
                expect(status.pending).toBe(1);
                expect(status.running).toBe(1);
                expect(status.completed).toBe(1);
                expect(status.total).toBe(3);
            });
        });

        describe('getRecentCompleted', () => {
            it('returns empty array when no completed tasks', () => {
                const queue = new TaskQueue(queueFile);
                expect(queue.getRecentCompleted(5)).toEqual([]);
            });

            it('returns completed tasks sorted by completion time (newest first)', () => {
                const queue = new TaskQueue(queueFile);

                // Create and complete tasks
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'First' });
                const t1 = queue.dequeue();
                queue.complete(t1.id, 'Done1');

                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Second' });
                const t2 = queue.dequeue();
                queue.complete(t2.id, 'Done2');

                const recent = queue.getRecentCompleted(5);
                expect(recent.length).toBe(2);
                expect(recent[0].description).toBe('Second'); // Newest first
                expect(recent[1].description).toBe('First');
            });

            it('respects limit parameter', () => {
                const queue = new TaskQueue(queueFile);

                for (let i = 0; i < 10; i++) {
                    queue.enqueue({ msgTs: `${i}.${i}`, channelId: 'C1', text: `T${i}`, description: `Task ${i}` });
                    const task = queue.dequeue();
                    queue.complete(task.id, 'Done');
                }

                const recent = queue.getRecentCompleted(3);
                expect(recent.length).toBe(3);
            });
        });

        describe('cleanup', () => {
            it('removes old completed tasks', () => {
                const queue = new TaskQueue(queueFile);

                // Load queue directly and add an old task
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Old task' });
                const task = queue.dequeue();
                queue.complete(task.id, 'Done');

                // Manually modify completedAt to be old
                const data = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
                data[0].completedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(); // 25 hours ago
                fs.writeFileSync(queueFile, JSON.stringify(data, null, 2), 'utf8');

                const removed = queue.cleanup();
                expect(removed).toBe(1);

                const recent = queue.getRecentCompleted(10);
                expect(recent.length).toBe(0);
            });

            it('keeps recent completed tasks', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Recent task' });
                const task = queue.dequeue();
                queue.complete(task.id, 'Done');

                const removed = queue.cleanup();
                expect(removed).toBe(0);

                const recent = queue.getRecentCompleted(10);
                expect(recent.length).toBe(1);
            });

            it('never removes pending or running tasks', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Pending' });
                queue.enqueue({ msgTs: '2.2', channelId: 'C1', text: 'T2', description: 'Running' });
                queue.dequeue(); // Mark second as running

                const removed = queue.cleanup();
                expect(removed).toBe(0);
                expect(queue.getActiveCount()).toBe(2);
            });
        });

        describe('formatStatus', () => {
            it('returns formatted status string', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Test task' });

                const status = queue.formatStatus();
                expect(status).toContain('Queued tasks');
                expect(status).toContain('Test task');
            });

            it('shows running task when present', () => {
                const queue = new TaskQueue(queueFile);
                queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'T1', description: 'Running task' });
                queue.dequeue();

                const status = queue.formatStatus();
                expect(status).toContain('Currently running');
                expect(status).toContain('Running task');
            });
        });
    });

    describe('module exports', () => {
        describe('getQueue', () => {
            it('returns singleton instance', () => {
                const q1 = getQueue();
                const q2 = getQueue();
                expect(q1).toBe(q2);
            });
        });

        describe('hasActiveTasks', () => {
            it('returns false for empty queue', () => {
                // Create fresh queue for this test
                if (fs.existsSync(queueFile)) {
                    fs.unlinkSync(queueFile);
                }
                expect(hasActiveTasks()).toBe(false);
            });
        });

        describe('getQueueStatus', () => {
            it('returns status object', () => {
                const status = getQueueStatus();
                expect(status).toHaveProperty('pending');
                expect(status).toHaveProperty('running');
                expect(status).toHaveProperty('completed');
            });
        });

        describe('STATUS constants', () => {
            it('exports all status constants', () => {
                expect(STATUS.PENDING).toBe('pending');
                expect(STATUS.RUNNING).toBe('running');
                expect(STATUS.COMPLETED).toBe('completed');
                expect(STATUS.FAILED).toBe('failed');
                expect(STATUS.INTERRUPTED).toBe('interrupted');
            });
        });
    });

    describe('error handling', () => {
        it('handles corrupted queue file', () => {
            const queue = new TaskQueue(queueFile);

            // Write corrupted data
            fs.writeFileSync(queueFile, 'not json', 'utf8');

            // Should not throw, return empty array
            expect(queue.getPending()).toEqual([]);
        });

        it('handles empty queue file', () => {
            const queue = new TaskQueue(queueFile);

            // Write empty file
            fs.writeFileSync(queueFile, '', 'utf8');

            expect(queue.getPending()).toEqual([]);
        });

        it('handles queue file with wrong type (object instead of array)', () => {
            const queue = new TaskQueue(queueFile);

            // Write object instead of array
            fs.writeFileSync(queueFile, '{"foo": "bar"}', 'utf8');

            expect(queue.getPending()).toEqual([]);
        });
    });
});
