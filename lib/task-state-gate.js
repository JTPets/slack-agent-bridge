'use strict';

/**
 * lib/task-state-gate.js
 *
 * WORK-TODO #10, B36 (2026-11-25): the MIDDLEWARE every task passes through on its
 * way in and out. Three answers to "is a task running?" live here and nowhere else in
 * the task path: the task lock (lib/task-lock.js), the queue row (lib/task-queue.js)
 * and the #sqtools-ops notice when the two diverge (lib/task-state-divergence.js).
 *
 *   beginTask       start check, lock, `running` transition (before any work)
 *   endTask         the ONE terminal queue write (complete / fail / interrupt)
 *   releaseTaskLock the lock release, only for a lock this task wrote
 *
 * Moved out of bridge-agent.js processTask, whose three terminal writes were three
 * copies of the same try / log / post block. Behaviour is unchanged; the history of
 * each rule is in the comments below and in git (`git log -S checkTaskStart`).
 */

const taskQueue = require('./task-queue');
const taskLock = require('./task-lock');
const { checkTaskStart } = require('./task-start-check');
const { describeTaskStateDivergence } = require('./task-state-divergence');

/** The only queue writes a task may end with. */
const TERMINAL_WRITES = ['complete', 'fail', 'interrupt'];

/**
 * Before any work: may this task start, and if so take the lock and mark its queue row
 * running.
 *
 * LOGIC CHANGE 2026-11-08 (WORK-TODO #72, owner: "if locked - refuse - then a human can
 * over rule"): a task starts only when the lock and the queue agree nothing else is
 * running AND its own lock is written; otherwise `startRefusal` says why, the caller
 * throws it inside its try (so the failure path posts it and fails the row), and the
 * owner overrules with `ASK: lock clear`.
 *
 * LOGIC CHANGE 2026-09-14: markRunning(queueId), not dequeue(): the id is known here,
 * and dequeue()'s "first pending entry" search would start the wrong row whenever a
 * second one is pending. Before this, nothing wrote `running`, so recoverInterrupted()
 * could never fire (WORK-TODO P1 #18).
 *
 * LOGIC CHANGE 2026-10-02 (WORK-TODO #72): every failed write is POSTED, not only
 * logged, because the poll loop and the update gate then disagree.
 *
 * @param {object} p
 * @param {object} p.msg - the Slack message ({ ts })
 * @param {object} p.task - the parsed task ({ description })
 * @param {string|null} p.queueId
 * @param {string} p.lockFile
 * @param {Function} p.postToOps - never throws
 * @returns {Promise<{ startRefusal: string|null, lockOwned: boolean, lockFile: string }>}
 */
async function beginTask({ msg, task, queueId, lockFile, postToOps }) {
  let startRefusal = null;
  try {
    startRefusal = checkTaskStart({
      lock: taskLock.inspect({ lockFile }),
      running: taskQueue.getQueue().getRunning(),
      queueId,
    });
  } catch (checkErr) {
    startRefusal = `the lock and the queue could not be read (${checkErr.message})`;
  }
  const lockResult = startRefusal
    ? { acquired: false, refused: true }
    : taskLock.acquire({ msgTs: msg.ts, description: task.description, lockFile });
  const lockOwned = lockResult.acquired === true;
  if (!lockResult.acquired && !lockResult.refused) {
    startRefusal = `the task lock could not be written (${lockResult.error})`;
    console.error(
      `[bridge-agent] Running without a task lock (${lockResult.error}) - ` +
      `a self-update during this task will not defer for it`
    );
    await postToOps(describeTaskStateDivergence({
      kind: 'lock_not_acquired', description: task.description, error: lockResult.error,
    }));
  }

  if (queueId && !startRefusal) {
    try {
      taskQueue.getQueue().markRunning(queueId);
    } catch (queueErr) {
      console.error('[bridge-agent] Queue markRunning failed:', queueErr.message);
      startRefusal = `the queue could not record this task as running (${queueErr.message})`;
      await postToOps(describeTaskStateDivergence({
        kind: 'queue_not_marked_running', description: task.description, error: queueErr.message,
      }));
    }
  }
  return { startRefusal, lockOwned, lockFile };
}

/**
 * The terminal queue write, with the delivery verdict stamped in the same write.
 *
 * LOGIC CHANGE 2026-09-20: every caller passes the delivery verdict of the post it made
 * FIRST. The post -> terminal write ordering is what makes "this row is terminal" mean
 * "the result was delivered, or its loss was recorded" (tests/task-delivery-signal.test.js).
 * A failed write is posted (WORK-TODO #72): the row stays `running` and the update gate
 * defers for it until it ages out.
 *
 * @param {'complete'|'fail'|'interrupt'} write
 * @param {object} p
 * @param {string|null} p.queueId - no id, no write
 * @param {string} p.reason - the row's result or error text
 * @param {{ delivered: boolean, detail: string }} p.delivery
 * @param {string} p.description - for the divergence notice
 * @param {Function} p.postToOps
 */
async function endTask(write, { queueId, reason, delivery, description, postToOps }) {
  if (!TERMINAL_WRITES.includes(write)) {
    throw new Error(`endTask: "${write}" is not a terminal queue write (${TERMINAL_WRITES.join(', ')})`);
  }
  if (!queueId) return;
  try {
    taskQueue.getQueue()[write](queueId, reason, delivery);
  } catch (queueErr) {
    console.error(`[bridge-agent] Queue ${write} failed:`, queueErr.message);
    await postToOps(describeTaskStateDivergence({
      kind: 'queue_terminal_write_failed', description, error: queueErr.message, step: write,
    }));
  }
}

/**
 * Release the lock, only when this task wrote it (WORK-TODO #72: a lock this task did not
 * write is never released by this task). A lock that survives is aged out by the staleness
 * rule (lib/task-lock.js), so a failed unlink is logged, not fatal.
 *
 * @param {{ lockOwned: boolean, lockFile: string }} gate - what beginTask returned
 */
function releaseTaskLock({ lockOwned, lockFile }) {
  const releaseResult = lockOwned ? taskLock.release(lockFile) : { existed: false };
  if (releaseResult.existed && !releaseResult.released) {
    console.error(
      `[bridge-agent] Task lock ${lockFile} could not be removed ` +
      `(${releaseResult.error}); it will be aged out by the staleness rule`
    );
  }
  return releaseResult;
}

module.exports = { beginTask, endTask, releaseTaskLock, TERMINAL_WRITES };
