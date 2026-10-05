'use strict';

/**
 * lib/task-history.js
 *
 * WORK-TODO #9: `ASK: history [n]` - the last n finished tasks with when they finished
 * and how. `what's queued` shows five, from a queue that keeps 24 hours; this reads the
 * task memory (memory/history.json, written by completeTask/failTask), which keeps all.
 *
 * LOGIC CHANGE 2026-10-04: new file. Read-only; posts nothing (the router's caller does).
 */

const { formatTimestamp } = require('./time-format');

const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;

/** What happened, in words a person can act on. */
function describeOutcome(entry) {
    if (entry.status === 'failed') {
        const err = String(entry.error || 'no error recorded').replace(/\s+/g, ' ');
        return `:x: failed - ${err.length > 100 ? `${err.slice(0, 99)}…` : err}`;
    }
    const outcome = entry.outcome || {};
    if (outcome.interrupted) return ':warning: interrupted (not re-run)';
    if (outcome.partial) return ':warning: stopped at max turns';
    if (entry.status === 'completed') return `:white_check_mark: completed${outcome.retried ? ' (after a retry)' : ''}`;
    return `:grey_question: ${entry.status || 'unknown'}`;
}

/** One line per entry, newest first. */
function formatHistory(entries, requested) {
    if (!entries.length) return 'No finished tasks are recorded in the task memory (memory/history.json).';
    const lines = entries.map((e) => {
        const when = e.completedAt || e.failedAt || e.created;
        const elapsed = e.outcome && Number.isFinite(e.outcome.elapsed) ? ` (${e.outcome.elapsed}s)` : '';
        return `• ${when ? formatTimestamp(when) : 'unknown time'} - ${describeOutcome(e)}${elapsed}\n` +
            `   ${e.description || 'Unnamed task'}${e.repo ? ` - \`${e.repo}\`` : ''}`;
    });
    const header = `*Last ${entries.length} finished task(s)*` +
        (entries.length < requested ? ` (all that are recorded; asked for ${requested})` : '');
    return [header, ...lines].join('\n');
}

/**
 * The verb handler.
 * @param {object} ctx - { args }
 * @param {object} [deps] - { readHistory(limit) } for tests; defaults to the task memory.
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function handleHistory(ctx = {}, deps = {}) {
    const raw = String(ctx.args || '').trim();
    let count = DEFAULT_COUNT;
    if (raw) {
        if (!/^\d+$/.test(raw)) {
            return { ok: false, text: `:x: Usage: \`history [n]\` - n is a number of tasks, 1-${MAX_COUNT}. Got \`${raw.slice(0, 40)}\`.` };
        }
        count = Math.min(Math.max(parseInt(raw, 10), 1), MAX_COUNT);
    }
    const readHistory = deps.readHistory || ((n) => require('../memory/memory-manager').getTaskHistory(n));
    let entries;
    try {
        entries = readHistory(count);
    } catch (err) {
        return { ok: false, text: `:x: Could not read the task memory: ${err.message}` };
    }
    return { ok: true, text: formatHistory(entries || [], count) };
}

module.exports = { DEFAULT_COUNT, MAX_COUNT, describeOutcome, formatHistory, handleHistory };
