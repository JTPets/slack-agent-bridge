'use strict';

/**
 * lib/task-followups.js
 *
 * WORK-TODO #10, B36 (2026-11-25): what happens after a completed task's result card and
 * terminal queue row, moved out of bridge-agent.js processTask. None of it decides
 * whether the task succeeded, and no failure here fails it.
 *
 *   1. the rate-limit pause is cleared (a task just succeeded)
 *   2. Phase 3 DETAIL the card does not hold: a gate that threw, did not run, or failed,
 *      and the advisory warnings
 *   3. the task_completed bulletin, posted AS the executing agent, and its watchers
 *   4. ACTION REQUIRED lines into the OWNER's inbox
 *   5. the history entry
 */

const notifyOwner = require('./notify-owner');
const bulletinBoard = require('./bulletin-board');
const bulletinWatcher = require('./bulletin-watcher');
const taskMemory = require('./task-memory-record');

/**
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #6): the gate ran before the result card, which
 * carries its verdict; the green "Code review passed" post is gone. LOGIC CHANGE
 * 2026-09-14: three outcomes, none of them silence — a gate that threw is not a gate that
 * passed, and a run that executed nothing countable did not run (docs/EXECUTOR-CONTRACT.md
 * section 4).
 */
async function postPhase3Detail(run, { validation, validationError }, postToOps) {
  const { task } = run;
  if (validationError) {
    console.error('[bridge-agent] Phase 3 validation error:', validationError.message);
    await postToOps(
      `:rotating_light: *Code review did not complete* — the gate threw before reaching a verdict.\n` +
      `Task: ${task.description}\n${validationError.message}\n` +
      `Source: ${run.sourceLink}`
    ).catch(postErr => {
      console.error('[bridge-agent] Could not post Phase 3 failure:', postErr.message);
    });
    return;
  }
  if (!validation) return;
  try {
    const testRun = validation.testRun;
    if (!validation.passed && testRun && !testRun.ran) {
      // The runner never started, or nothing countable executed: not a test failure.
      await postToOps(
        `:rotating_light: *Code review: the test gate DID NOT RUN.*\n` +
        `Task: ${task.description}\n` +
        `Command: \`${validation.testCommand || run.taskTestScript}\` — outcome: \`${testRun.outcome}\`\n` +
        `${testRun.reason}\n` +
        `\`\`\`\n${validation.testOutput.slice(-1200)}\n\`\`\`\n` +
        `Source: ${run.sourceLink}`
      );
    } else if (!validation.passed) {
      await postToOps(
        `:warning: *Code review: tests failed after task completion.*\n` +
        `Task: ${task.description}\n` +
        `Failed: ${validation.testsFailed}, Passed: ${validation.testsPassed}\n` +
        `\`\`\`\n${validation.testOutput.slice(-1500)}\n\`\`\`\n` +
        `Source: ${run.sourceLink}`
      );
    }
    if (validation.warnings.length > 0) {
      await postToOps(
        `:mag: *Code review warnings:*\n${validation.warnings.map(w => `• ${w}`).join('\n')}\n` +
        `Source: ${run.sourceLink}`
      );
    }
  } catch (detailErr) {
    console.error('[bridge-agent] Could not post the Phase 3 detail:', detailErr.message);
  }
}

/**
 * LOGIC CHANGE 2026-03-28: a task_completed bulletin for inter-agent awareness, and its
 * watchers notified. LOGIC CHANGE 2026-09-15: posted AS the agent that did the work, not
 * the bridge: lib/bulletin-watcher.js skips the poster when fanning out, so posting as the
 * bridge notified the agent about its OWN completion and left bridge watchers silent.
 */
function postCompletionBulletin(run, { output, elapsed, hitMaxTurns }, slack) {
  const { task, currentAgentId } = run;
  try {
    const commitMatch = output.match(/\[([a-f0-9]{7,40})\]|commit\s+([a-f0-9]{7,40})/i);
    const commitHash = commitMatch ? (commitMatch[1] || commitMatch[2]) : null;
    const bulletinResult = bulletinBoard.postBulletin(currentAgentId, 'task_completed', {
      description: task.description,
      repo: task.repo || null,
      branch: task.branch || 'main',
      commitHash,
      elapsed: parseInt(elapsed, 10),
      partial: hitMaxTurns || false,
    });
    if (bulletinResult.success && bulletinResult.bulletin) {
      bulletinWatcher.processBulletin(slack, bulletinResult.bulletin).catch(watchErr => {
        console.error('[bridge-agent] Bulletin watcher error:', watchErr.message);
      });
    }
  } catch (bulletinErr) {
    console.error('[bridge-agent] Failed to post task completion bulletin:', bulletinErr.message);
  }
}

/**
 * @param {object} run - processTask's run record
 * @param {object} llm - runTaskLlm's return ({ didRetry, originalTurns, currentTurns })
 * @param {object} done - deliverCompleted's return
 * @param {object} deps - { slack, postToOps, truncate, clearRateLimitState }
 */
async function afterCompletion(run, llm, done, deps) {
  const { output, elapsed, hitMaxTurns } = done;

  // LOGIC CHANGE 2026-03-26: a success resets the rate-limit backoff.
  await deps.clearRateLimitState();
  await postPhase3Detail(run, done, deps.postToOps);
  postCompletionBulletin(run, done, deps.slack);

  // LOGIC CHANGE 2026-03-26: ACTION REQUIRED lines go to the owner's action inbox.
  // LOGIC CHANGE 2026-09-15: DELIBERATELY still the bridge's, the one identity that did
  // NOT move to the executing agent: it is the OWNER's inbox, not the agent's identity,
  // and addTask() returns false, telling nobody, for an agent with no entry in
  // agents/activation-checklists.json, so routing by agent would add a silent drop path to
  // the one message class that must not be lost (WORK-TODO #38's close).
  try {
    await notifyOwner.processActionRequired(output, { agentId: 'bridge' });
  } catch (actionErr) {
    console.error('[bridge-agent] Failed to process ACTION REQUIRED:', actionErr.message);
  }

  taskMemory.recordCompleted(run.memoryTaskId, {
    output: deps.truncate(output, 500),
    elapsed,
    hitMaxTurns,
    didRetry: llm.didRetry,
    originalTurns: llm.originalTurns,
    currentTurns: llm.currentTurns,
  });
}

module.exports = { afterCompletion, postPhase3Detail, postCompletionBulletin };
