'use strict';

/**
 * lib/code-review-pipeline.js
 *
 * 3-phase code review pipeline for task execution:
 *   Phase 1 (reviewTask):       Read codebase before executing to build context
 *   Phase 2 (buildPrompt):      Assemble enriched prompt with context + COMMANDMENTS + plan
 *   Phase 3 (validateOutput):   Run tests + checks after execution
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of code review pipeline.
 * Provides context-aware task execution to prevent duplicate work, broken patterns,
 * and missed tests. Claude gets plan + codebase context, not just raw instructions.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): a facade, one part per phase. Every
 * name it exported is still exported here and is the same object as in its part
 * (tests/module-splits.test.js):
 *   - lib/review-context.js   Phase 1: reviewTask, createExecutionPlan
 *   - lib/review-prompt.js    Phase 2: buildPrompt
 *   - lib/review-validate.js  Phase 3: validateOutput
 *   - lib/pipeline-command.js runCommand, which Phase 1 and Phase 3 share
 * The phases share the context object (Phase 1 produces it, Phase 2 and 3 read the
 * plan made from it); its shape is documented on reviewTask.
 */

const { reviewTask, createExecutionPlan } = require('./review-context');
const { buildPrompt } = require('./review-prompt');
const { validateOutput } = require('./review-validate');
const { runCommand } = require('./pipeline-command');

module.exports = {
    reviewTask,
    createExecutionPlan,
    buildPrompt,
    validateOutput,
    // Exported for testing
    runCommand,
};
