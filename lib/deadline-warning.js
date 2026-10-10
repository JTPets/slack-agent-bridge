'use strict';

/**
 * lib/deadline-warning.js
 *
 * The #sqtools-ops text posted when a running task reaches 80% of TASK_TIMEOUT_MS.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #7): new file. The task timeout was a single hard
 * kill with no warning, so the first sign of a long task was its death. lib/llm-runner.js
 * now calls the caller's `onDeadlineWarning` at WARN_AT_FRACTION of the timeout; processTask
 * posts this. The kill itself is unchanged. Pure: builds a string, posts nothing.
 */

const minutes = (ms) => {
    if (ms < 60000) return `${Math.round(ms / 1000)} s`;
    const m = ms / 60000;
    return m >= 10 ? `${Math.round(m)} min` : `${Number(m.toFixed(1))} min`;
};

/**
 * @param {object} p
 * @param {string} p.description - The task's TASK: line.
 * @param {string|null} [p.repo]
 * @param {string} [p.agentId]
 * @param {number} p.elapsedMs
 * @param {number} p.remainingMs
 * @param {number} p.timeoutMs
 * @param {boolean} [p.isRetry] - The max-turns retry, which has its own full timeout.
 * @returns {string}
 */
function formatDeadlineWarning({ description, repo = null, agentId = null, elapsedMs, remainingMs, timeoutMs, isRetry = false }) {
    const where = [agentId && `agent ${agentId}`, repo && `repo ${repo}`].filter(Boolean).join(', ');
    return `:hourglass: Task still running after ${minutes(elapsedMs)} of its ${minutes(timeoutMs)} limit` +
        `${isRetry ? ' (max-turns retry)' : ''}: "${description}"${where ? ` (${where})` : ''}.\n` +
        `If it has not finished in ${minutes(remainingMs)} it will be killed (TASK_TIMEOUT_MS). ` +
        'A killed task is reported as interrupted and is not re-run; it would need re-submitting.';
}

/**
 * LOGIC CHANGE 2026-10-10 (WORK-TODO #59): the text for a run-watch alert from
 * lib/claude-stream-watch.js. In report mode (the default) the run was NOT stopped, and the
 * text says so, because the point of this phase is to learn where the thresholds belong.
 *
 * @param {object} p
 * @param {string} p.description
 * @param {string|null} [p.repo]
 * @param {string} [p.agentId]
 * @param {'stall'|'loop'} p.reason
 * @param {string} p.detail
 * @param {boolean} p.enforced - TASK_LIMITER_MODE=enforce stopped the run.
 * @returns {string}
 */
function formatRunAlert({ description, repo = null, agentId = null, reason, detail, enforced }) {
    const where = [agentId && `agent ${agentId}`, repo && `repo ${repo}`].filter(Boolean).join(', ');
    const what = reason === 'loop' ? 'may be looping' : 'may be stalled';
    return `:mag: Task ${what}: "${description}"${where ? ` (${where})` : ''}.\n${detail}.\n` +
        (enforced
            ? 'The run was STOPPED (TASK_LIMITER_MODE=enforce).'
            : 'Nothing was stopped: the run watch is report-only (TASK_LIMITER_MODE=report). If this run finishes fine, the threshold is too tight.');
}

module.exports = { formatDeadlineWarning, formatRunAlert };
