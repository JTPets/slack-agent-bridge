/**
 * tests/task-lock.test.js
 *
 * Tests for lib/task-lock.js — the task lock's staleness rule.
 *
 * The lock's whole purpose is to make a self-update stand aside for a running
 * task. That is only safe if a lock left behind by a KILLED task expires,
 * because processTask's `finally` cannot run when the process is killed and a
 * self-update restart is exactly that kill. These tests pin both halves:
 * a fresh lock is held, an old one is stale and gets released with a surfaced
 * verdict.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const taskLock = require('../lib/task-lock');

let tmpDir;
let lockFile;
let warnSpy;
let logSpy;
let errorSpy;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-test-'));
    lockFile = path.join(tmpDir, '.task-running');
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TASK_LOCK_STALE_MS;
    delete process.env.TASK_TIMEOUT_MS;
});

describe('acquire / release', () => {
    test('acquire writes a lock that inspect reports as held and not stale', () => {
        const result = taskLock.acquire({ msgTs: '123.456', description: 'long refactor', lockFile });
        expect(result.acquired).toBe(true);
        expect(fs.existsSync(lockFile)).toBe(true);

        const lock = taskLock.inspect({ lockFile });
        expect(lock.held).toBe(true);
        expect(lock.stale).toBe(false);
        expect(lock.format).toBe('json');
        expect(lock.description).toBe('long refactor');
        expect(lock.msgTs).toBe('123.456');
        expect(lock.pid).toBe(process.pid);
    });

    test('release removes the file; inspect then reports not held', () => {
        taskLock.acquire({ msgTs: '1', description: 't', lockFile });
        const released = taskLock.release(lockFile);
        expect(released.released).toBe(true);
        expect(released.existed).toBe(true);
        expect(taskLock.inspect({ lockFile }).held).toBe(false);
    });

    test('releasing an absent lock is a no-op, not an error', () => {
        const released = taskLock.release(lockFile);
        expect(released.released).toBe(false);
        expect(released.existed).toBe(false);
        expect(released.error).toBeUndefined();
    });
});

describe('staleness', () => {
    test('a lock younger than the threshold is held and NOT stale', () => {
        taskLock.acquire({ msgTs: '1', description: 'still running', lockFile });
        const lock = taskLock.inspect({ lockFile, staleAfterMs: 60000, now: Date.now() + 30000 });
        expect(lock.held).toBe(true);
        expect(lock.stale).toBe(false);
    });

    test('a lock older than the threshold is stale', () => {
        taskLock.acquire({ msgTs: '1', description: 'killed mid-run', lockFile });
        const lock = taskLock.inspect({ lockFile, staleAfterMs: 60000, now: Date.now() + 120000 });
        expect(lock.held).toBe(true);
        expect(lock.stale).toBe(true);
    });

    // The deadlock this module exists to prevent: a lock left behind by a killed
    // task must be RELEASED, not waited on forever.
    test('releaseIfStale removes a stale lock and returns a surfaced verdict', () => {
        taskLock.acquire({ msgTs: '99.1', description: 'task killed by a restart', lockFile });

        const result = taskLock.releaseIfStale({
            lockFile,
            staleAfterMs: 60000,
            now: Date.now() + 10 * 60000,
        });

        expect(result.action).toBe('released');
        expect(fs.existsSync(lockFile)).toBe(false);

        // Never silent: a verdict string exists AND it was logged.
        expect(result.verdict).toEqual(expect.stringContaining('task killed by a restart'));
        expect(result.verdict).toEqual(expect.stringContaining('stale task lock'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Released a stale task lock'));
    });

    test('releaseIfStale leaves a FRESH lock alone and returns no verdict', () => {
        taskLock.acquire({ msgTs: '99.2', description: 'genuinely running', lockFile });

        const result = taskLock.releaseIfStale({ lockFile, staleAfterMs: 60000 });

        expect(result.action).toBe('none');
        expect(result.verdict).toBeNull();
        expect(fs.existsSync(lockFile)).toBe(true);
    });
});

describe('threshold derivation', () => {
    test('defaults to 2x TASK_TIMEOUT_MS plus the grace window', () => {
        process.env.TASK_TIMEOUT_MS = '600000';
        expect(taskLock.defaultStaleAfterMs()).toBe(2 * 600000 + taskLock.STALE_GRACE_MS);
    });

    test('TASK_LOCK_STALE_MS overrides the derivation', () => {
        process.env.TASK_TIMEOUT_MS = '600000';
        process.env.TASK_LOCK_STALE_MS = '12345';
        expect(taskLock.defaultStaleAfterMs()).toBe(12345);
    });

    // A task cannot legitimately outlive its own hard-kill timeout, so the
    // default threshold must sit above it or a live task would be released.
    test('the default threshold exceeds a single task timeout', () => {
        process.env.TASK_TIMEOUT_MS = '600000';
        expect(taskLock.defaultStaleAfterMs()).toBeGreaterThan(600000);
    });
});

describe('lock file formats', () => {
    // A deploy briefly has one process on new code and one on old. The legacy
    // 3-line lock must still be readable, and its age must still be computed.
    test('legacy "msgTs\\nepochMs\\ndescription" locks are parsed', () => {
        const started = Date.now();
        fs.writeFileSync(lockFile, `123.456\n${started}\nlegacy task`, 'utf8');

        const lock = taskLock.inspect({ lockFile, staleAfterMs: 60000, now: started + 120000 });
        expect(lock.format).toBe('legacy');
        expect(lock.held).toBe(true);
        expect(lock.stale).toBe(true);
        expect(lock.description).toBe('legacy task');
    });

    // Erring toward "held" keeps an unreadable lock from being read as
    // "no task running", which would restart into a live task.
    test('an unparseable lock is treated as held and ages out by mtime', () => {
        fs.writeFileSync(lockFile, 'garbage that is not json or legacy', 'utf8');

        const fresh = taskLock.inspect({ lockFile, staleAfterMs: 60000 });
        expect(fresh.held).toBe(true);
        expect(fresh.stale).toBe(false);
        expect(fresh.format).toBe('mtime');

        const old = taskLock.inspect({ lockFile, staleAfterMs: 60000, now: Date.now() + 10 * 60000 });
        expect(old.held).toBe(true);
        expect(old.stale).toBe(true);
    });
});
