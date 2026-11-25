'use strict';

/**
 * lib/task-memory-record.js
 *
 * WORK-TODO #10, B36 (2026-11-25): a task's entry in the global task history
 * (memory/history.json via memory/memory-manager.js) and the executing agent's working
 * memory. Moved out of bridge-agent.js processTask, where the same try / log block was
 * written five times.
 *
 * LOGIC CHANGE 2026-03-26 (the rule, unchanged): memory errors are logged and NEVER fail
 * or stop the task. Every function here returns instead of throwing.
 */

const memory = require('../memory/memory-manager');

/** One call, logged on failure, never thrown. */
function guarded(step, fn) {
  try {
    return fn();
  } catch (memErr) {
    console.error(`[bridge-agent] Memory ${step} failed:`, memErr.message);
    return null;
  }
}

/** The history entry for a task that is starting. Returns its id, or null. */
function startRecord(task) {
  const memTask = guarded('addTask', () => memory.addTask({
    description: task.description,
    repo: task.repo,
    branch: task.branch,
    status: 'running',
  }));
  return memTask ? memTask.id : null;
}

/** A task whose LLM run was interrupted (not a failure). */
function recordInterrupted(memoryTaskId, elapsed) {
  if (!memoryTaskId) return;
  guarded('completeTask', () => memory.completeTask(memoryTaskId,
    { output: 'interrupted', elapsed: parseInt(elapsed, 10), interrupted: true }));
}

/**
 * A completed task. LOGIC CHANGE 2026-03-26: retry tracking (retried, originalTurns,
 * retryTurns) and a partial outcome when max turns was hit.
 *
 * @param {string|null} memoryTaskId
 * @param {object} p
 * @param {string} p.output - already truncated to 500 by the caller's truncate
 * @param {string} p.elapsed
 * @param {boolean} p.hitMaxTurns
 * @param {boolean} p.didRetry
 * @param {number} p.originalTurns
 * @param {number} p.currentTurns
 */
function recordCompleted(memoryTaskId, { output, elapsed, hitMaxTurns, didRetry, originalTurns, currentTurns }) {
  if (!memoryTaskId) return;
  const outcome = { output, elapsed: parseInt(elapsed, 10) };
  if (didRetry) {
    outcome.retried = true;
    outcome.originalTurns = originalTurns;
    outcome.retryTurns = currentTurns;
  }
  if (hitMaxTurns) {
    outcome.partial = true;
    outcome.output = 'max turns reached';
  }
  guarded('completeTask', () => memory.completeTask(memoryTaskId, outcome));
}

/** A failed task; `safeErrMsg` is already redacted. */
function recordFailed(memoryTaskId, safeErrMsg) {
  if (!memoryTaskId) return;
  guarded('failTask', () => memory.failTask(memoryTaskId, safeErrMsg));
}

/**
 * Clear the EXECUTING agent's working memory after its task. LOGIC CHANGE 2026-09-15
 * (WORK-TODO #38): the executing agent's, not the bridge's: clearing the bridge's after a
 * story-bot task left story-bot's stale entries and wiped a directory the task never
 * wrote to.
 */
function clearWorkingMemory(agentId) {
  try {
    memory.clearAgentWorkingMemory(agentId);
  } catch (memErr) {
    console.error('[bridge-agent] Failed to clear working memory:', memErr.message);
  }
}

module.exports = { startRecord, recordInterrupted, recordCompleted, recordFailed, clearWorkingMemory };
