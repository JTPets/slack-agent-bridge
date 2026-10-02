'use strict';

/**
 * lib/task-state-divergence.js
 *
 * The text posted to #sqtools-ops when the bridge's answers to "is a task
 * running?" stop agreeing.
 *
 * LOGIC CHANGE 2026-10-02 (WORK-TODO #72). Three things answer that question:
 * the poll loop's in-memory `isRunning`, the task lock on disk
 * ($WORK_DIR/.task-running, lib/task-lock.js) and the queue entry's status
 * (task-queue.json, lib/task-queue.js). The self-update gate reads the last two
 * from another process. Writes to both are best effort by design - a task that
 * cannot write its lock or its queue row still runs - and every failure used to
 * be a console.error only. So the answers could diverge and nobody was told:
 *
 *   - lock not acquired: the poll loop refuses new work, but the update gate sees
 *     an idle bridge and would restart into the running task.
 *   - queue not marked running: a kill mid-task is never recorded as interrupted,
 *     and `ASK: what's queued` shows the task as still pending.
 *   - queue terminal write failed: the poll loop accepts new work, but the entry
 *     stays `running` on disk, so the update gate defers for a task that is over
 *     until the entry ages out.
 *
 * This module does not make them agree - whether a failed lock should refuse the
 * dispatch instead is an owner decision recorded on #72. It makes a divergence a
 * posted fact instead of a log line. Pure: builds a string, posts nothing.
 */

const KINDS = {
    lock_not_acquired: {
        title: 'A task is running WITHOUT a task lock.',
        consequence:
            'The poll loop knows a task is running and will not start another. Anything that reads ' +
            'the lock - the self-update gate - sees an idle bridge, so an update during this task ' +
            'would not wait for it.',
    },
    queue_not_marked_running: {
        title: 'A task is running but its queue entry was not marked running.',
        consequence:
            'If the bridge is killed during this task, the next startup will not record it as ' +
            'interrupted or post it, and `ASK: what\'s queued` will show it as still pending.',
    },
    queue_terminal_write_failed: {
        title: 'A task has ended but its queue entry was not updated.',
        consequence:
            'The poll loop will accept new work, but the entry stays `running` on disk, so the ' +
            'self-update gate will treat this task as live until it ages out at the lock ' +
            'staleness threshold (TASK_LOCK_STALE_MS).',
    },
};

/**
 * @param {object} p
 * @param {keyof KINDS} p.kind
 * @param {string} [p.description] - the task's description
 * @param {string} [p.error] - the error message from the failed write
 * @param {string} [p.step] - which write failed, e.g. 'complete', 'fail', 'interrupt'
 * @returns {string}
 */
function describeTaskStateDivergence({ kind, description, error, step }) {
    const k = KINDS[kind];
    if (!k) throw new Error(`describeTaskStateDivergence: unknown kind "${kind}"`);
    const lines = [`:warning: *${k.title}*`];
    if (description) lines.push(`Task: ${description}`);
    if (step) lines.push(`Failed write: ${step}`);
    if (error) lines.push(`Error: ${error}`);
    lines.push(k.consequence);
    lines.push('The task itself was not stopped. WORK-TODO #72.');
    return lines.join('\n');
}

module.exports = { describeTaskStateDivergence, KINDS };
