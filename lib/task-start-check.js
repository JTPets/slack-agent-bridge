'use strict';

/**
 * lib/task-start-check.js
 *
 * WORK-TODO #72, the owner's answer of 2026-11-08: "if locked - refuse - then a human can
 * over rule or diagnose the gap with AI assistance and fix it moving forward." The task
 * lock ($WORK_DIR/.task-running) and the queue (task-queue.json) both answer "is a task
 * running?", and the self-update gate reads both. Until now a task whose lock could not
 * be written ran anyway, and the divergence was only reported. Now a task does not start
 * unless both agree that nothing else is running and its own lock is written.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * Why a held lock at start is always a divergence. The poll sweep runs one task at a time
 * and awaits it (bridge-agent.js), so when processTask starts, no other task of this
 * process is running. A lock on disk then belongs to nothing alive, or to a second
 * process that should not exist; either way the owner looks before more work runs. The
 * override is `ASK: lock clear` (lib/lock-command.js).
 *
 * Pure: decides and builds text.
 */

/**
 * @param {{ lock: object|null, running: object|null, queueId: string|null }} p
 *   lock - lib/task-lock.js inspect(); running - TaskQueue getRunning()
 * @returns {string|null} why the task may not start, or null
 */
function checkTaskStart({ lock, running, queueId }) {
    if (lock && lock.held) {
        const what = lock.description ? `"${lock.description}"` : 'an unnamed task';
        return `the task lock is already held, by ${what}${lock.stale ? ' (stale)' : ''}, while no task is running here`;
    }
    if (running && running.id !== queueId) {
        return `the queue already shows "${running.description || running.id}" as running, while no task is running here`;
    }
    return null;
}

function describeStartRefusal(reason) {
    return `Task refused before it started: ${reason}. The lock and the queue must agree that nothing is running ` +
        'before new work begins, so a self-update can trust them. Type `ASK: lock` to see both, and ' +
        '`ASK: lock clear` to release them once you are sure no task is running, then resubmit.';
}

module.exports = { checkTaskStart, describeStartRefusal };
