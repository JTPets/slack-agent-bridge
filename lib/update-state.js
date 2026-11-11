'use strict';

/**
 * lib/update-state.js
 *
 * auto-update's own state file (STATE_FILE): the commits it deployed, refused and
 * gated, and its deferral bookkeeping. Moved out of auto-update.js unchanged on
 * 2026-11-11 (WORK-TODO #10, Wave 4); auto-update.js re-exports both functions.
 */

const fs = require('fs');
const { STATE_FILE } = require('./update-config');

// LOGIC CHANGE 2026-09-13: State carries three hashes now, not one.
//   lastKnownCommit    - guard (b): the commit we deployed, written BEFORE exiting.
//   restartedIntoCommit- guard (c): the commit we already exited for, so a second
//                        exit for the same hash is refused.
//   failedCommit       - the remote head that failed verification. Without it, a
//                        bad commit on main is re-pulled, re-verified, reverted and
//                        re-announced to #sqtools-ops every check interval forever.
//                        A NEW remote head clears it, so the fix still deploys.
// LOGIC CHANGE 2026-11-11: gatedCommit (WORK-TODO #17) - the commit the update gate
// passed, so a green commit held back by a running task is not gated again on every
// cycle. checkForUpdates has saved it since 2026-11-08, but loadState listed its keys
// by hand and this one was never added, so it was written and dropped on the next read:
// every deferred cycle re-ran the 35-minute suite and, because the gate clears the
// pending marker while it runs, accepted new dispatches the whole time. The suites
// stub loadState, so nothing caught it. STATE_KEYS is now the one list, and
// tests/update-state.test.js fails when a key the cycle writes is not in it.
const STATE_KEYS = [
    'lastKnownCommit',
    'restartedIntoCommit',
    'failedCommit',
    'gatedCommit',
    // LOGIC CHANGE 2026-09-14: deferral bookkeeping. Durable so the
    // "deferred for Nm" figure survives an auto-update restart and
    // the escalation post is not reset to zero by one.
    'deferringSince',
    'deferNotifiedAt',
    'deferringCommit',
];

/**
 * Load state from state file. Every key in STATE_KEYS, null when absent.
 * @returns {{ lastKnownCommit: string|null, restartedIntoCommit: string|null, failedCommit: string|null,
 *   gatedCommit: string|null, deferringSince: number|null, deferNotifiedAt: number|null, deferringCommit: string|null }}
 */
function loadState() {
    let data = {};
    try {
        if (fs.existsSync(STATE_FILE)) {
            data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
        }
    } catch (error) {
        console.error('Failed to load state file:', error.message);
        data = {};
    }
    const state = {};
    for (const key of STATE_KEYS) state[key] = data[key] || null;
    return state;
}

/**
 * Save state to state file
 * @param {{ lastKnownCommit: string, restartedIntoCommit?: string, failedCommit?: string }} state
 * @returns {{ success: boolean, error?: string }}
 */
function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
        return { success: true };
    } catch (error) {
        // LOGIC CHANGE 2026-09-13: Return the outcome instead of only logging it.
        // Guard (b) requires the commit hash to be durable BEFORE the process
        // exits; if the write failed, exiting would restart into the same commit
        // and pull it again. The caller now refuses to exit on a failed write.
        console.error('Failed to save state file:', error.message);
        return { success: false, error: error.message };
    }
}

module.exports = { loadState, saveState, STATE_KEYS };
