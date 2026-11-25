'use strict';

/**
 * lib/task-decomposer.js
 *
 * LOGIC CHANGE 2026-04-01: Automated task decomposition system.
 * Analyzes complex tasks, identifies subtasks, routes to appropriate agents,
 * tracks dependencies, and aggregates results.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): the hub. decomposeTask stays here and
 * reads as its steps (judge complexity, ask the model, read the answer, build the
 * subtasks); everything else moved to one part per concern, re-exported under the names
 * it always had (tests/module-splits.test.js):
 *   - lib/task-complexity.js      the heuristic: analyzeComplexity and its indicators
 *   - lib/subtask-routing.js      detectTaskType, findAgentForTask
 *   - lib/subtask-graph.js        SUBTASK_STATUS, createSubtask, dependency readiness
 *   - lib/subtask-format.js       generateSummary, formatSubtaskAsMessage
 *   - lib/decomposition-prompt.js the model prompt and the answer parser
 * The split dropped three imports nothing used (getAgent, isProductionRepo, parseTask)
 * and found a defect, fixed below: subtask dependencies never matched a subtask id.
 * The module still has no production caller (docs/WIRING-AND-SEAMS.md section 3).
 */

const { runLLM } = require('./llm-runner');
const complexity = require('./task-complexity');
const routing = require('./subtask-routing');
const graph = require('./subtask-graph');
const format = require('./subtask-format');
const prompt = require('./decomposition-prompt');

const { analyzeComplexity } = complexity;
const { detectTaskType, findAgentForTask } = routing;
const { createSubtask } = graph;
const { buildDecompositionPrompt, parseDecompositionResponse } = prompt;

/**
 * The model's subtasks as subtask records, routed to agents, with `dependsOn` naming
 * the ids of the subtasks it depends on.
 *
 * LOGIC CHANGE 2026-11-25 (B37): every id shares ONE base, read once. Before, each id
 * and each dependency read Date.now() separately, and the "fix dependency ids" pass
 * took the first id's two dash-separated parts as the base, which is the whole id
 * (`<ms>-0`), so a dependency on subtask 0 became `<ms>-0-0`: an id no subtask has,
 * which getReadySubtasks reads as blocked forever. Regression test in
 * tests/task-decomposer.test.js ("a dependency names the id of the subtask it depends on").
 *
 * @param {{ subtasks: object[] }} parsed - A decomposition parseDecompositionResponse accepted
 * @param {object} task - The parent task
 * @returns {object[]}
 */
function toSubtasks(parsed, task) {
    const base = Date.now();
    return parsed.subtasks.map((st, idx) => {
        const taskType = st.taskType || detectTaskType(st.instructions);
        const agent = findAgentForTask(task.repo, taskType);
        return createSubtask({
            id: `${base}-${idx}`,
            parentTaskId: task.id,
            description: st.description,
            instructions: st.instructions,
            repo: task.repo,
            branch: task.branch,
            skill: st.skill || task.skill || '',
            agentId: agent ? agent.id : 'bridge',
            dependsOn: (st.dependsOn || []).map(i => `${base}-${i}`),
            priority: st.priority || 0,
        });
    });
}

/**
 * Decompose a task into subtasks using LLM analysis
 * @param {object} task - Parsed task object from parseTask()
 * @param {object} options - Options
 * @param {boolean} options.skipLLM - Skip LLM and use heuristics only (for testing)
 * @param {number} options.maxTurns - Max LLM turns (default 5)
 * @returns {Promise<object>} Decomposition result
 */
async function decomposeTask(task, options = {}) {
    const { skipLLM = false, maxTurns = 5 } = options;

    // First, analyze complexity heuristically
    const analysis = analyzeComplexity(task.instructions || task.raw);
    const notDecomposed = (reason, extra = {}) =>
        ({ decomposed: false, reason, complexity: analysis, subtasks: [], ...extra });

    // If not complex enough, skip decomposition
    if (!analysis.isComplex && !skipLLM) {
        return notDecomposed('Task is not complex enough for decomposition');
    }

    // If skipLLM, return heuristic analysis only
    if (skipLLM) {
        return notDecomposed('LLM analysis skipped');
    }

    try {
        const result = await runLLM(buildDecompositionPrompt(task), {
            maxTurns,
            // LOGIC CHANGE 2026-11-07: no longer pinned to gemini (owner: "move all to
            // claude"); the global LLM_PROVIDER decides. No agentId, so a Claude run
            // gets no tools (lib/agent-tools.js): decomposition is text in, JSON out.
        });

        const parsed = parseDecompositionResponse(result.output);
        if (!parsed) {
            return notDecomposed('Failed to parse LLM decomposition response', { llmOutput: result.output });
        }
        if (!parsed.shouldDecompose) {
            return notDecomposed(parsed.reasoning || 'LLM determined task is atomic');
        }

        return {
            decomposed: true,
            reason: parsed.reasoning,
            complexity: analysis,
            subtasks: toSubtasks(parsed, task),
        };
    } catch (err) {
        console.error('[task-decomposer] LLM decomposition failed:', err.message);
        return notDecomposed(`LLM error: ${err.message}`, { error: err.message });
    }
}

module.exports = {
    // Core functions
    analyzeComplexity,
    detectTaskType,
    decomposeTask,
    findAgentForTask,

    // Subtask management
    createSubtask,
    getReadySubtasks: graph.getReadySubtasks,
    allSubtasksComplete: graph.allSubtasksComplete,

    // Formatting
    generateSummary: format.generateSummary,
    formatSubtaskAsMessage: format.formatSubtaskAsMessage,
    buildDecompositionPrompt,
    parseDecompositionResponse,

    // Constants
    SUBTASK_STATUS: graph.SUBTASK_STATUS,
    DEFAULT_COMPLEXITY_THRESHOLD: complexity.DEFAULT_COMPLEXITY_THRESHOLD,
    MULTI_TASK_INDICATORS: complexity.MULTI_TASK_INDICATORS,
    TASK_TYPE_PATTERNS: routing.TASK_TYPE_PATTERNS,
};
