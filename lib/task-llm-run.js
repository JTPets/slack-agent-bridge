'use strict';

/**
 * lib/task-llm-run.js
 *
 * WORK-TODO #10, B36 (2026-11-25): a TASK:'s model run, moved out of bridge-agent.js
 * processTask. One call through the fallback chain, and ONE retry at double the turns
 * (capped at TURNS_CEILING) when the first run stops at its turn limit.
 *
 * Every value that identifies the run is the EXECUTING agent's (WORK-TODO #38): provider,
 * model, metrics id and the record whose permissions decide the Claude tools.
 */

const { runWithFallback } = require('./llm-runner');
const { TURNS_CEILING } = require('./task-parser');
const { formatDeadlineWarning, formatRunAlert } = require('./deadline-warning');

/**
 * @param {object} run - { task, currentAgent, currentAgentId, llmProvider, sourceLink }
 * @param {string} prompt
 * @param {string} cwd - the task's own directory (lib/task-workspace.js), never WORK_DIR
 * @param {object} deps - { postToOps, taskTimeout, claudeBin }
 * @returns {Promise<{ result: object, didRetry: boolean, originalTurns: number, currentTurns: number }>}
 *   `result` is runWithFallback's. Throws what runWithFallback throws.
 */
async function runTaskLlm(run, prompt, cwd, deps) {
  const { task, currentAgent, currentAgentId, llmProvider } = run;
  const { postToOps } = deps;

  // LOGIC CHANGE 2026-03-26: per-task turns (TURNS:), and one retry on a max-turns stop.
  const originalTurns = task.turns;
  let currentTurns = originalTurns;
  let retryCount = 0;
  let didRetry = false;
  let result;

  // LOGIC CHANGE 2026-09-13: bound here; it was once referenced unbound and every TASK:
  // threw `agentId is not defined` before the spawn. LOGIC CHANGE 2026-09-15: it is the
  // METRICS identity, so it follows the executing agent: one counter per agent is what
  // makes "what fraction of the secretary's calls fell back?" answerable.
  const agentId = currentAgentId;

  while (retryCount <= 1) {
    // LOGIC CHANGE 2026-09-13: runLLM -> runWithFallback (one verdict per logical call).
    result = await runWithFallback(prompt, {
      cwd,
      maxTurns: currentTurns,
      timeout: deps.taskTimeout,
      claudeBin: deps.claudeBin,
      provider: llmProvider,
      // LOGIC CHANGE 2026-09-15: the executing agent's model, not the bridge's.
      model: currentAgent?.llm_model,
      agentId,
      // LOGIC CHANGE 2026-11-07: the agent whose declared permissions decide the
      // Claude tools this run gets (lib/agent-tools.js).
      agentRecord: currentAgent,
      // LOGIC CHANGE 2026-10-04 (WORK-TODO #7): say so in #sqtools-ops at 80% of
      // TASK_TIMEOUT_MS instead of the kill being the first sign of a long task.
      onDeadlineWarning: (info) => postToOps(formatDeadlineWarning({
        ...info, description: task.description, repo: task.repo, agentId, isRetry: retryCount > 0,
      })),
      // LOGIC CHANGE 2026-10-10 (WORK-TODO #59): a stalled or looping run is reported
      // to #sqtools-ops while it happens. Report-only by default; see lib/claude-stream-watch.js.
      onRunAlert: (info) => postToOps(formatRunAlert({
        ...info, description: task.description, repo: task.repo, agentId,
      })),
    });

    if (!result.hitMaxTurns) break;

    // LOGIC CHANGE 2026-10-04 (WORK-TODO #20): the cap is the parser's TURNS_CEILING.
    if (retryCount === 0 && currentTurns < TURNS_CEILING) {
      const retryTurns = Math.min(currentTurns * 2, TURNS_CEILING);
      await postToOps(
        `:hourglass_flowing_sand: *Task hit max turns (${currentTurns}). Retrying with ${retryTurns} turns...*\n` +
        `Source: ${run.sourceLink}`
      );
      currentTurns = retryTurns;
      retryCount++;
      didRetry = true;
      continue;
    }

    // Either already retried once, or the original turns were already at the ceiling.
    await postToOps(
      `:warning: *Task hit max turns limit${didRetry ? ' on retry' : ''}. May be partially complete.*\n` +
      `Source: ${run.sourceLink}`
    );
    break;
  }

  return { result, didRetry, originalTurns, currentTurns };
}

module.exports = { runTaskLlm };
