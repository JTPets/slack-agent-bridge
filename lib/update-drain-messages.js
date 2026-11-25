'use strict';

/**
 * lib/update-drain-messages.js
 *
 * The words of DRAIN-ONE: the refusal posted back to a dispatch while an update is
 * pending, and the two verdicts for an orphaned marker (cleared, or could not be). Pure:
 * builds strings, reads and posts nothing.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved out of lib/update-drain.js, which
 * re-exports describeRefusal. The two stale-marker verdicts were inline in clearIfStale;
 * they are the same text, now named.
 */

/**
 * Short commit hash for a message, never throwing on a null.
 * @param {string|null} commit
 * @returns {string}
 */
function short(commit) {
    return commit ? `\`${String(commit).substring(0, 7)}\`` : '(unknown commit)';
}

/**
 * The verdict when an orphaned marker was removed.
 *
 * @param {object} state - An inspect() result
 * @param {number} quietMin - Minutes since its heartbeat
 * @param {number} thresholdMin - The staleness limit in minutes
 * @returns {string}
 */
function describeStaleCleared(state, quietMin, thresholdMin) {
    return `Cleared an orphaned pending-update marker: ${short(state.commit)} was recorded as waiting but its `
        + `heartbeat stopped ${quietMin}m ago, past the ${thresholdMin}m limit, so no updater is tending it. `
        + `Dispatches are accepted again. NOTE: this did not cancel, force or hurry any update — a live `
        + `updater refreshes the marker every check interval, so a marker this quiet belongs to a process `
        + `that is gone.`;
}

/**
 * The verdict when an orphaned marker could NOT be removed.
 *
 * @param {object} state - An inspect() result
 * @param {number} quietMin
 * @param {number} thresholdMin
 * @param {string} [error] - Why the removal failed
 * @returns {string}
 */
function describeStaleClearFailed(state, quietMin, thresholdMin, error) {
    return `A pending-update marker at \`${state.markerFile}\` (${short(state.commit)}) has not been `
        + `refreshed for ${quietMin}m, past the ${thresholdMin}m limit, but it could NOT be removed `
        + `(${error || 'unknown error'}). Every new dispatch stays refused until this file is `
        + `removed by hand.`;
}

/**
 * The message posted back to Slack when a dispatch is refused.
 *
 * A refused dispatch MUST be visible. This repo has already had one silent-drop
 * defect on the intake path — a body with no `INSTRUCTIONS:` label was dropped and
 * the executor ran on the one-line description, with nothing reported — and the fix
 * there was to refuse and name what was unclaimed. This matches that shape: say what
 * was refused, say why, and say what to do about it. A race is eventually noticed; a
 * disappearance is not.
 *
 * @param {object} state - An inspect() result
 * @param {string} [description] - The refused task's description
 * @returns {string} Slack message text
 */
function describeRefusal(state, description) {
    const waitedMin = Math.round((state.waitingMs || 0) / 60000);
    const what = description ? `*${description}*` : 'this task';

    return (
        `:no_entry: *Dispatch refused — a self-update is pending.*\n`
        + `${what} was NOT queued and NOT started.\n`
        + `Update ${short(state.commit)} has been waiting ${waitedMin}m for the current task to finish. `
        + `While it waits, new dispatches are refused so the wait is bounded by one task rather than by how `
        + `often work arrives.\n`
        + `Nothing has been lost except this request: **resubmit it once the update has applied.** `
        + `The update is never forced and the running task is never killed.`
    );
}

module.exports = { short, describeRefusal, describeStaleCleared, describeStaleClearFailed };
