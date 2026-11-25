'use strict';

/**
 * lib/subtask-graph.js
 *
 * The subtask record and its dependency graph: SUBTASK_STATUS, createSubtask,
 * getReadySubtasks (which pending subtasks may run, marking blocked and skipped ones)
 * and allSubtasksComplete.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-decomposer.js, which re-exports every name. The decomposer has no production
 * caller (docs/WIRING-AND-SEAMS.md section 3); whether to wire or delete it is the
 * owner's decision and is not made here.
 */

/**
 * Subtask status enum
 */
const SUBTASK_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    BLOCKED: 'blocked', // Waiting for dependency
    SKIPPED: 'skipped', // Dependency failed
};

/**
 * Create a subtask object
 * @param {object} options - Subtask options
 * @returns {object} Subtask object
 */
function createSubtask({
    id,
    parentTaskId,
    description,
    instructions,
    repo = null,
    branch = 'main',
    skill = '',
    agentId = 'bridge',
    dependsOn = [],
    priority = 0,
}) {
    return {
        id: id || `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        parentTaskId,
        description,
        instructions,
        repo,
        branch,
        skill,
        agentId,
        dependsOn, // Array of subtask IDs this depends on
        priority,  // Higher = run first (when no dependencies)
        status: SUBTASK_STATUS.PENDING,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
    };
}

/**
 * Determine which subtasks are ready to run (dependencies satisfied)
 * @param {Array} subtasks - All subtasks
 * @returns {Array} Subtasks ready to run
 */
function getReadySubtasks(subtasks) {
    const completedIds = new Set(
        subtasks
            .filter(st => st.status === SUBTASK_STATUS.COMPLETED)
            .map(st => st.id)
    );

    const failedIds = new Set(
        subtasks
            .filter(st => st.status === SUBTASK_STATUS.FAILED)
            .map(st => st.id)
    );

    return subtasks
        .filter(st => {
            // Skip already processed
            if (st.status !== SUBTASK_STATUS.PENDING) return false;

            // Check dependencies
            for (const depId of st.dependsOn) {
                if (failedIds.has(depId)) {
                    // Dependency failed - mark as skipped
                    st.status = SUBTASK_STATUS.SKIPPED;
                    st.error = `Dependency ${depId} failed`;
                    return false;
                }
                if (!completedIds.has(depId)) {
                    // Dependency not yet complete
                    st.status = SUBTASK_STATUS.BLOCKED;
                    return false;
                }
            }

            // All dependencies satisfied
            return true;
        })
        .sort((a, b) => b.priority - a.priority);
}

/**
 * Check if all subtasks are complete (or skipped/failed)
 * @param {Array} subtasks - All subtasks
 * @returns {boolean} True if all done
 */
function allSubtasksComplete(subtasks) {
    return subtasks.every(st =>
        st.status === SUBTASK_STATUS.COMPLETED ||
        st.status === SUBTASK_STATUS.FAILED ||
        st.status === SUBTASK_STATUS.SKIPPED
    );
}

module.exports = {
    SUBTASK_STATUS,
    createSubtask,
    getReadySubtasks,
    allSubtasksComplete,
};
