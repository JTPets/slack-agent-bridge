'use strict';

/**
 * lib/lock-command.js
 *
 * WORK-TODO #72, the override half: `ASK: lock` shows what the task lock and the queue
 * say is running; `ASK: lock clear` releases the lock and marks every queue row still
 * `running` as interrupted. lib/task-start-check.js refuses a task while they disagree,
 * and this is how the owner overrules it after looking.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * Why `clear` is safe whenever it runs. An `ASK:` is answered inside the same poll sweep
 * that runs tasks, one at a time (bridge-agent.js), so while this handler runs no task of
 * this process is running: whatever the lock and the queue hold is left over from a task
 * that is gone. The verdict says what was released, never just "ok".
 *
 * Returns { ok, text } and posts nothing, like every command handler.
 */

const taskLock = require('./task-lock');
const taskQueue = require('./task-queue');

function describeLock(lock) {
    if (!lock.held) return 'Task lock: free.';
    const age = Number.isFinite(lock.ageMs) ? `${Math.round(lock.ageMs / 60000)}m old` : 'age unknown';
    return `Task lock: HELD by ${lock.description ? `"${lock.description}"` : 'an unnamed task'} (${age}` +
        `${lock.stale ? ', stale' : ''}${lock.pid ? `, pid ${lock.pid}` : ''}).`;
}

/** Every row marked running, read through the public getRunning(). Bounded. */
function runningRows(queue) {
    const r = queue.getRunning();
    return r ? [r] : [];
}

/**
 * @param {{ args?: string, lockFile?: string, queue?: object }} ctx - lockFile and queue
 *   are injectable for tests; the defaults are the live ones.
 */
async function handleLock(ctx = {}) {
    const arg = String(ctx.args || '').trim().toLowerCase();
    const queue = ctx.queue || taskQueue.getQueue();
    const lockFile = ctx.lockFile || taskLock.DEFAULT_LOCK_FILE;
    if (arg !== '' && arg !== 'clear') {
        return { ok: false, text: 'Usage: `ASK: lock` to see the task lock and the queue, `ASK: lock clear` to release them.' };
    }
    const lock = taskLock.inspect({ lockFile });
    const rows = runningRows(queue);
    if (arg === '') {
        const queueLine = rows.length
            ? `Queue: ${rows.length} row(s) marked running: ${rows.map((r) => `"${r.description || r.id}"`).join(', ')}.`
            : 'Queue: nothing marked running.';
        const agree = !lock.held && rows.length === 0;
        return {
            ok: true,
            text: `${describeLock(lock)}\n${queueLine}\n` +
                (agree ? 'They agree: nothing is running, and a new task can start.'
                    : 'No task is running in the bridge right now, so these are left over. `ASK: lock clear` releases them.'),
        };
    }
    const done = [];
    if (lock.held) {
        const r = taskLock.release(lockFile);
        if (r.existed && !r.released) return { ok: false, text: `:x: The lock file could not be removed: ${r.error}. Nothing else was changed.` };
        done.push(`released the lock held by ${lock.description ? `"${lock.description}"` : 'an unnamed task'}`);
    }
    for (let row = queue.getRunning(), n = 0; row && n < 50; row = queue.getRunning(), n += 1) {
        queue.interrupt(row.id, 'Cleared by the owner (ASK: lock clear): the task was not running', {
            delivered: false, detail: 'cleared by ASK: lock clear; the task was gone and its result reached nobody',
        });
        done.push(`marked "${row.description || row.id}" interrupted`);
    }
    return {
        ok: true,
        text: done.length ? `:unlock: Cleared: ${done.join('; ')}. New tasks can start; resubmit anything that was lost.`
            : 'Nothing to clear: the lock is free and no queue row is marked running.',
    };
}

module.exports = { handleLock };
