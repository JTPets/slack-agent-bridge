'use strict';

/**
 * lib/digest-failures.js
 *
 * The morning digest's account of yesterday's failed tasks: how they are grouped, and
 * what the owner is told about each group.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #31): extracted from morning-digest.js, which has no
 * exports and calls process.exit() when required, so none of this could be tested. Two
 * defects fixed on the way:
 *
 *   1. The rate-limit test was a third, permissive re-derivation (`includes('rate limit')`,
 *      `includes('bandwidth')`, `includes('429')`) with neither of lib/llm-runner.js's
 *      gates, so a task whose real failure was a bad clone, but whose error text merely
 *      mentioned a rate limit, was filed as one. It now calls llm-runner's own exported
 *      `isRateLimitError`, the tightened 2026-03-27 patterns, so "is this a rate limit?"
 *      has one answer in the repository.
 *   2. The digest told the owner rate-limited tasks "will auto-retry" and temp-directory
 *      failures were "Auto-requeued", and counted both under "Auto-handling (no action
 *      needed)". Nothing retries or re-queues a failed task (bridge-agent.js: "No pausing
 *      the queue. handleRateLimit() is NOT called here anymore"; WORK-TODO #23 made
 *      not-re-running deliberate). A failed task stays failed until someone re-submits
 *      it, so every group is now action needed and says so. The one automatic retry that
 *      does exist, a max-turns retry with doubled turns, is reported only for the tasks
 *      whose recorded outcome says it happened.
 */

const { isRateLimitError } = require('./llm-runner');

const INFRASTRUCTURE_MARKERS = ['clone', 'temp', 'enoent', 'eacces', 'permission denied', 'no space', 'disk full', 'mkdir'];

/**
 * Group failed task records. Pure.
 *
 * @param {object[]} failedTasks - History records with `error` and optional `outcome`.
 * @returns {{ rateLimit: object[], infrastructure: object[], maxTurns: object[], codeFailures: object[] }}
 */
function categorizeFailures(failedTasks) {
    const categories = { rateLimit: [], infrastructure: [], maxTurns: [], codeFailures: [] };
    for (const task of failedTasks || []) {
        const raw = task.error || '';
        const error = raw.toLowerCase();
        if (isRateLimitError(raw)) {
            categories.rateLimit.push(task);
        } else if (INFRASTRUCTURE_MARKERS.some((m) => error.includes(m))) {
            categories.infrastructure.push(task);
        } else if (error.includes('max turns') || error.includes('max_turns') || (task.outcome && task.outcome.partial)) {
            categories.maxTurns.push(task);
        } else {
            categories.codeFailures.push(task);
        }
    }
    return categories;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function listTasks(tasks) {
    return tasks.map((task) => {
        const desc = task.description || 'No description';
        const error = task.error ? ` - ${task.error.slice(0, 100)}` : '';
        return `  - ${desc}${error}`;
    });
}

/**
 * The digest lines for the failure groups, and how many tasks need the owner.
 *
 * @param {ReturnType<typeof categorizeFailures>} c
 * @returns {{ lines: string[], actionNeededCount: number }}
 */
function formatFailureSections(c) {
    const lines = [];
    const section = (heading, tasks) => {
        if (tasks.length === 0) return;
        lines.push('', heading, ...listTasks(tasks));
    };

    section(`*Rate limited:* ${plural(c.rateLimit.length, 'task', 'tasks')} failed on a provider rate limit. ` +
        'Nothing retries them; re-submit when capacity returns.', c.rateLimit);
    section(`*Clone / temp directory failures:* ${plural(c.infrastructure.length, 'task', 'tasks')}. ` +
        'Nothing re-queues them; re-submit once the cause is fixed.', c.infrastructure);

    const retried = c.maxTurns.filter((t) => t.outcome && t.outcome.retried).length;
    section(`*Max turns:* ${plural(c.maxTurns.length, 'task', 'tasks')} ran out of turns` +
        (retried > 0 ? ` (${retried} of them after the automatic retry with doubled turns).` : '.'), c.maxTurns);

    section('*Failed with errors - review needed:*', c.codeFailures);

    const actionNeededCount = c.rateLimit.length + c.infrastructure.length + c.maxTurns.length + c.codeFailures.length;
    return { lines, actionNeededCount };
}

module.exports = { categorizeFailures, formatFailureSections, INFRASTRUCTURE_MARKERS };
