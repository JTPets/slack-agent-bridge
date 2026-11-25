'use strict';

/**
 * lib/task-prompt.js
 *
 * WORK-TODO #10, B36 (2026-11-25): the prompt a TASK: runs with, moved out of
 * bridge-agent.js processTask.
 *
 *   repo task     the code-review pipeline's enriched prompt (lib/code-review-pipeline.js
 *                 buildPrompt), or the basic prompt when the pipeline throws
 *   no-repo task  the executing agent's persona, its own data context and the recent
 *                 task history, before the instructions
 *
 * Every identity here is the EXECUTING agent's (`run.currentAgent`, WORK-TODO #38), never
 * the bridge's. tests/task-agent-identity.test.js reads this file for that.
 */

const fs = require('fs');
const path = require('path');

const memory = require('../memory/memory-manager');
const bulletinBoard = require('./bulletin-board');
const agentContext = require('./agent-context');
const { isProductionRepo } = require('./agent-registry');
const { reviewTask, createExecutionPlan, buildPrompt } = require('./code-review-pipeline');

const COMMANDMENTS_PATH = path.join(__dirname, '..', 'COMMANDMENTS.md');

/** A text file's contents, or '' with a log line. Never throws. */
function readOptional(filePath, label) {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    console.warn(`[bridge-agent] ${label} not found: ${filePath}`);
  } catch (readErr) {
    console.error(`[bridge-agent] Could not read ${label}:`, readErr.message);
  }
  return '';
}

/** A context builder's text, or '' with a log line. Never blocks the task. */
function optionalContext(label, build) {
  try {
    return build() || '';
  } catch (ctxErr) {
    console.error(`[bridge-agent] ${label} failed:`, ctxErr.message);
    return '';
  }
}

/**
 * The prompt for a task with a cloned repository.
 *
 * @param {object} run - { task, currentAgent, currentAgentId, taskDir }; sets
 *   run.taskTestScript from the repo's own `scripts.test` (LOGIC CHANGE 2026-09-14: Phase
 *   3 used to run a hardcoded `npm test` while the plan had already read the real one).
 * @returns {{ prompt: string } | { alreadyDone: string }}
 */
function repoTaskPrompt(run) {
  const { task, currentAgent, currentAgentId, taskDir } = run;

  // LOGIC CHANGE 2026-03-26: skills/<skill>/SKILL.md from the clone, when SKILL: is set.
  const skillContent = task.skill
    ? readOptional(path.join(taskDir, 'skills', task.skill, 'SKILL.md'), `Skill ${task.skill}`)
    : '';
  if (skillContent) console.log(`[bridge-agent] Loaded skill template: ${task.skill}`);

  // LOGIC CHANGE 2026-03-26: a PRODUCTION repo must go through a feature branch and a PR.
  let productionWarning = '';
  if (isProductionRepo(task.repo)) {
    productionWarning = 'This is a PRODUCTION repo. You MUST create a feature branch, commit there, push the branch, and create a pull request using `gh pr create`. Do NOT push to main. Do NOT merge.\n\n';
    console.log(`[bridge-agent] Production repo detected: ${task.repo}`);
  }

  // LOGIC CHANGE 2026-09-15: the EXECUTING agent's prompt, not the bridge's.
  const agentSystemPrompt = currentAgent?.system_prompt || '';

  // LOGIC CHANGE 2026-03-28: Phase 1 and 2 of the code review pipeline. reviewTask reads
  // CLAUDE.md, structure, history and relevant files; buildPrompt assembles them in order.
  try {
    const pipelineContext = reviewTask(task, taskDir);
    const pipelinePlan = createExecutionPlan(task, pipelineContext);
    run.taskTestScript = pipelinePlan.testScript || run.taskTestScript;
    if (pipelinePlan.skip) return { alreadyDone: pipelinePlan.reason };

    const prompt = buildPrompt(task, pipelineContext, pipelinePlan, {
      commandmentsContent: readOptional(COMMANDMENTS_PATH, 'COMMANDMENTS.md'),
      agentSystemPrompt,
      productionWarning,
      skillContent,
      memoryContext: optionalContext('buildTaskContext', () => memory.buildTaskContext()),
      // LOGIC CHANGE 2026-09-15: the executing agent's view of the bulletin stream.
      bulletinContext: optionalContext('formatBulletinsForContext',
        () => bulletinBoard.formatBulletinsForContext(currentAgentId, 10)),
      repoRef: `${task.repo} (branch: ${task.branch})`,
    });
    console.log('[bridge-agent] Using pipeline-enriched prompt for task:', task.description);
    return { prompt };
  } catch (pipelineErr) {
    console.error('[bridge-agent] Code review pipeline failed, falling back to basic prompt:', pipelineErr.message);
  }

  // Fallback: basic prompt assembly (original behavior)
  return {
    prompt: [
      agentSystemPrompt,
      productionWarning,
      skillContent,
      `You are working in a cloned repo: ${task.repo} (branch: ${task.branch}).`,
      `Your working directory is the repo root.`,
      productionWarning ? '' : `When done, commit and push your changes if you made any code changes.`,
      '',
      task.instructions || task.description,
    ].filter(Boolean).join('\n'),
  };
}

/**
 * The prompt for a task with no repository.
 *
 * LOGIC CHANGE 2026-09-15: the executing agent's OWN DATA is injected here, the same data
 * lib/agent-context.js injects on the ASK: path. Before, a scheduled agent's TASK: got its
 * persona and none of its facts (story-bot's Friday job drafted posts about milestones it
 * was never told). Scoped to no-repo tasks: a repo prompt's order belongs to the pipeline.
 * LOGIC CHANGE 2026-03-26: the recent task history goes first, so the agent builds on
 * earlier results. Neither context ever blocks the task.
 */
async function noRepoTaskPrompt(run) {
  const { task, currentAgent, currentAgentId } = run;
  const agentSystemPrompt = currentAgent?.system_prompt || '';
  let prompt = agentSystemPrompt
    ? `${agentSystemPrompt}\n\n${task.instructions || task.description}`
    : (task.instructions || task.description);

  try {
    const agentData = await agentContext.buildAgentDataContext(currentAgentId);
    if (agentData) prompt = agentData + '\n\n' + prompt;
  } catch (agentCtxErr) {
    console.error('[bridge-agent] buildAgentDataContext failed:', agentCtxErr.message);
  }

  const taskContext = optionalContext('buildTaskContext', () => memory.buildTaskContext());
  if (taskContext) prompt = taskContext + '\n\n' + prompt;
  return { prompt };
}

/**
 * @param {object} run - processTask's run record
 * @returns {Promise<{ prompt: string } | { alreadyDone: string }>}
 */
async function buildTaskPrompt(run) {
  return run.task.repo ? repoTaskPrompt(run) : noRepoTaskPrompt(run);
}

module.exports = { buildTaskPrompt, repoTaskPrompt, noRepoTaskPrompt };
