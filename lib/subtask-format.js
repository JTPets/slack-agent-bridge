'use strict';

/**
 * lib/subtask-format.js
 *
 * Subtasks as text: generateSummary (the results report) and formatSubtaskAsMessage (a
 * subtask as a TASK: message the parser reads back; tests/integration.test.js pins the
 * round trip). Pure.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-decomposer.js, which re-exports every name. The decomposer has no production
 * caller (docs/WIRING-AND-SEAMS.md section 3); whether to wire or delete it is the
 * owner's decision and is not made here.
 */

const { SUBTASK_STATUS } = require('./subtask-graph');

/**
 * Generate a summary of decomposition results
 * @param {Array} subtasks - Completed subtasks
 * @returns {string} Summary text
 */
function generateSummary(subtasks) {
    const completed = subtasks.filter(st => st.status === SUBTASK_STATUS.COMPLETED);
    const failed = subtasks.filter(st => st.status === SUBTASK_STATUS.FAILED);
    const skipped = subtasks.filter(st => st.status === SUBTASK_STATUS.SKIPPED);

    const lines = [];
    lines.push(`## Task Decomposition Results`);
    lines.push('');
    lines.push(`- **Total subtasks:** ${subtasks.length}`);
    lines.push(`- **Completed:** ${completed.length}`);
    lines.push(`- **Failed:** ${failed.length}`);
    lines.push(`- **Skipped:** ${skipped.length}`);
    lines.push('');

    if (completed.length > 0) {
        lines.push('### Completed:');
        for (const st of completed) {
            lines.push(`- :white_check_mark: ${st.description}`);
        }
        lines.push('');
    }

    if (failed.length > 0) {
        lines.push('### Failed:');
        for (const st of failed) {
            lines.push(`- :x: ${st.description}: ${st.error || 'Unknown error'}`);
        }
        lines.push('');
    }

    if (skipped.length > 0) {
        lines.push('### Skipped (dependency failed):');
        for (const st of skipped) {
            lines.push(`- :fast_forward: ${st.description}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format a subtask as a TASK: message for execution
 * @param {object} subtask - Subtask object
 * @param {object} context - Additional context from previous subtasks
 * @returns {string} Formatted task message
 */
function formatSubtaskAsMessage(subtask, context = {}) {
    const lines = [];
    lines.push(`TASK: ${subtask.description}`);

    if (subtask.repo) {
        lines.push(`REPO: ${subtask.repo}`);
    }

    if (subtask.branch && subtask.branch !== 'main') {
        lines.push(`BRANCH: ${subtask.branch}`);
    }

    if (subtask.skill) {
        lines.push(`SKILL: ${subtask.skill}`);
    }

    // Include context from dependent subtasks
    let instructions = subtask.instructions;
    if (context.previousResults && Object.keys(context.previousResults).length > 0) {
        instructions = `## Context from Previous Subtasks\n\n`;
        for (const [id, result] of Object.entries(context.previousResults)) {
            if (subtask.dependsOn.includes(id)) {
                instructions += `### From subtask ${id}:\n${result}\n\n`;
            }
        }
        instructions += `## Current Subtask Instructions\n\n${subtask.instructions}`;
    }

    lines.push(`INSTRUCTIONS: ${instructions}`);

    return lines.join('\n');
}

module.exports = {
    generateSummary,
    formatSubtaskAsMessage,
};
