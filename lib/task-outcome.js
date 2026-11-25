'use strict';

/**
 * lib/task-outcome.js
 *
 * WORK-TODO #10, B36 (2026-11-25): how a TASK: ends, moved out of bridge-agent.js
 * processTask. Each ending delivers its result FIRST and only then writes the terminal
 * queue row with the delivery verdict of that post (lib/task-state-gate.js endTask).
 * That ordering is what makes "this row is terminal" mean "the result was delivered, or
 * its loss was recorded" (LOGIC CHANGE 2026-09-20; tests/task-delivery-signal.test.js).
 *
 *   deliverInterrupted  the child was killed but this process lives (e.g. the timeout)
 *   deliverCompleted    Phase 3, then ONE result card carrying its verdict
 *   deliverFailure      the failure card, after any throw in the task
 *   reportAlreadyDone   the pipeline found the work already done
 */

const fs = require('fs');

const notifyOwner = require('./notify-owner');
const { redact } = require('./redact-secrets');
const { validateOutput } = require('./code-review-pipeline');
const {
  OUTCOME: RESULT_OUTCOME, buildTaskResult, withDelivery, renderText, formatResultLogLine,
} = require('./task-result');
const { endTask } = require('./task-state-gate');
const { readTaskWork } = require('./task-workspace');
const taskMemory = require('./task-memory-record');

/** Seconds since the task started, as the string every report uses. */
function elapsedSince(startTime) {
  return ((Date.now() - startTime) / 1000).toFixed(0);
}

/**
 * LOGIC CHANGE 2026-03-27: an interrupted run (exit code null: a container restart or the
 * TASK_TIMEOUT_MS kill) is not a failure. LOGIC CHANGE 2026-09-14: its queue row is
 * written HERE, because this process may never restart, and a row left `running` would be
 * a phantom the update gate defers for. LOGIC CHANGE 2026-09-20: the notice IS the
 * task's result, so its delivery is the verdict. LOGIC CHANGE 2026-11-12 (WORK-TODO #6):
 * the same result shape as every other ending, as text.
 */
async function deliverInterrupted(run, llm, deps) {
  const { postToOps } = deps;
  const { task } = run;
  const { signal, stderr: llmStderr, provider: usedProvider } = llm.result;
  const elapsed = elapsedSince(run.startTime);
  const signalNote = signal ? ` (${signal})` : '';
  // LOGIC CHANGE 2026-09-13: redacted before the log, which is shipped off-box.
  const safeStderr = llmStderr ? redact(llmStderr) : '';
  console.log(`[bridge-agent] Task interrupted${signalNote} - likely container restart${safeStderr ? `; stderr: ${safeStderr.slice(-500)}` : ''}`);
  const interruptDelivered = await postToOps(renderText(buildTaskResult({
    task,
    outcome: RESULT_OUTCOME.INTERRUPTED,
    elapsed,
    provider: usedProvider,
    error: `Interrupted${signalNote} (likely container restart).${safeStderr ? `\n${safeStderr.slice(-1000)}` : ''}`,
    sourceLink: run.sourceLink,
  })));
  run.taskSuccess = true; // Don't mark as failure
  taskMemory.recordInterrupted(run.memoryTaskId, elapsed);
  await endTask('interrupt', {
    queueId: run.queueId,
    reason: `Task interrupted${signalNote} after ${elapsed}s (likely container restart)`,
    delivery: {
      delivered: interruptDelivered === true,
      detail: interruptDelivered === true
        ? 'interruption notice posted to the ops channel'
        : 'the interruption notice post to the ops channel failed',
    },
    description: task.description,
    postToOps,
  });
}

/**
 * Phase 3, the result card, the terminal row.
 *
 * LOGIC CHANGE 2026-09-20: the post's return value is the DELIVERY of the result and the
 * only copy of it (`output` is gone when the task returns; memory keeps 500 characters),
 * so it is recorded, and a failed delivery is announced and written as `delivered: false`.
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #6): Phase 3 runs BEFORE the post, so one card
 * carries the test verdict beside the branch, commits, files and output. The row stays
 * `running` while the gate runs, which is truthful.
 *
 * @returns {Promise<{ output: string, elapsed: string, hitMaxTurns: boolean,
 *   validation: object|null, validationError: Error|null }>} what the follow-ups need
 */
async function deliverCompleted(run, llm, deps) {
  const { postToOps } = deps;
  const { task, taskDir } = run;
  const { output, hitMaxTurns, provider: usedProvider } = llm.result;
  const elapsed = elapsedSince(run.startTime);

  let validation = null;
  let validationError = null;
  if (task.repo && taskDir && fs.existsSync(taskDir)) {
    try {
      validation = validateOutput(taskDir, { testScript: run.taskTestScript });
    } catch (validErr) {
      validationError = validErr;
    }
  }
  const taskResult = buildTaskResult({
    task,
    outcome: hitMaxTurns ? RESULT_OUTCOME.MAX_TURNS : RESULT_OUTCOME.COMPLETED,
    elapsed,
    provider: usedProvider,
    work: readTaskWork(taskDir, run.taskBaseSha),
    validation,
    validationError,
    summary: deps.truncate(output),
    sourceLink: run.sourceLink,
  });
  const resultDelivered = await notifyOwner.taskCompleted(task, deps.truncate(output), {
    elapsed,
    sourceLink: run.sourceLink,
    llmProvider: usedProvider,
    result: taskResult,
  });
  console.log(formatResultLogLine(withDelivery(taskResult, resultDelivered === true,
    resultDelivered === true ? 'result card posted to the ops channel' : 'the result card post failed')));

  // Never a silent null: announced (best effort — the ops channel is where the result
  // just failed to land) AND recorded durably on the queue row below.
  if (!resultDelivered) {
    console.error(
      `[bridge-agent] Task ${run.msg.ts} finished but its RESULT WAS NOT DELIVERED to Slack. ` +
      `The output is not recoverable from this process.`
    );
    await postToOps(
      `:rotating_light: *Task finished but its result was not delivered.*\n` +
      `Task: ${task.description}\n` +
      `The completion post to this channel failed, so the task output reached nobody and is gone. ` +
      `Recorded as \`delivered: false\` on the queue entry.\n` +
      `Source: ${run.sourceLink}`
    );
  }

  run.taskSuccess = true;
  console.log(`[bridge-agent] Task ${run.msg.ts} done (${elapsed}s)`);

  await endTask('complete', {
    queueId: run.queueId,
    reason: `Success in ${elapsed}s`,
    delivery: {
      delivered: resultDelivered === true,
      detail: resultDelivered === true
        ? 'task result posted to the ops channel'
        : 'the task result post to the ops channel failed',
    },
    description: task.description,
    postToOps,
  });
  return { output, elapsed, hitMaxTurns, validation, validationError };
}

/**
 * Any throw in the task. LOGIC CHANGE 2026-09-13: the message is redacted before the log,
 * the queue file and memory (each its own sink). LOGIC CHANGE 2026-09-20: `taskFailed`
 * returns `{ opsPosted, ownerNotified }`; either counts as delivered, and the verdict goes
 * on the row. LOGIC CHANGE 2026-03-27: no rate-limit pause here (false positives killed
 * tasks). LOGIC CHANGE 2026-11-12 (WORK-TODO #6): the ops post is the result card, with
 * the work the clone holds (a failed task may still have pushed a branch).
 */
async function deliverFailure(run, err, deps) {
  const { postToOps } = deps;
  const { task } = run;
  const elapsed = elapsedSince(run.startTime);
  const safeErrMsg = redact(err.message);
  const failureResult = buildTaskResult({
    task,
    outcome: RESULT_OUTCOME.FAILED,
    elapsed,
    provider: run.llmProvider || 'claude',
    work: readTaskWork(run.taskDir, run.taskBaseSha),
    error: safeErrMsg,
    sourceLink: run.sourceLink,
  });
  const failureReport = await notifyOwner.taskFailed(task, err, {
    elapsed,
    sourceLink: run.sourceLink,
    llmProvider: run.llmProvider || 'claude',
    result: failureResult,
  });
  const failureDelivered = failureReport?.opsPosted === true
    || failureReport?.ownerNotified === true;
  console.log(formatResultLogLine(withDelivery(failureResult, failureDelivered,
    failureDelivered ? 'failure card posted or owner notified' : 'the failure report reached nobody')));
  if (!failureDelivered) {
    console.error(
      `[bridge-agent] Task ${run.msg.ts} FAILED and the failure report reached nobody ` +
      `(ops post and owner notification both failed).`
    );
  }
  // taskSuccess stays false: the heartbeat ends on :x:.
  console.error(`[bridge-agent] Task ${run.msg.ts} failed (${elapsed}s):`, safeErrMsg);

  await endTask('fail', {
    queueId: run.queueId,
    reason: safeErrMsg,
    delivery: {
      delivered: failureDelivered,
      detail: failureDelivered
        ? 'failure report posted to the ops channel or DMed to the owner'
        : 'the failure report reached neither the ops channel nor the owner',
    },
    description: task.description,
    postToOps,
  });
  taskMemory.recordFailed(run.memoryTaskId, safeErrMsg);
}

/**
 * The pipeline found the work already done: report it and stop before any model run.
 * Unchanged from processTask: it writes no terminal queue row (WORK-TODO #10 B36 note:
 * `alreadyDoneEvidence` is never set today, so this path is not reached).
 */
async function reportAlreadyDone(run, reason, deps) {
  const { postToOps } = deps;
  await postToOps(`:white_check_mark: *Already implemented:* ${reason}\nSource: ${run.sourceLink}`);
  await deps.react(run.sourceChannel, run.msg.ts, deps.emojiDone);
  run.taskSuccess = true;
}

module.exports = { deliverInterrupted, deliverCompleted, deliverFailure, reportAlreadyDone, elapsedSince };
