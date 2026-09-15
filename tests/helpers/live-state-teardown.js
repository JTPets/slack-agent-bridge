'use strict';

/**
 * tests/helpers/live-state-teardown.js — jest `globalTeardown`.
 *
 * The second half of the guard described in `live-state-setup.js`. Throwing here
 * fails the whole run with a non-zero exit, which `lib/test-verdict.js` classifies as
 * `failed` — a suite that quietly corrupted the deployment's state must not be able
 * to report a pass.
 */

const fs = require('fs');
const setup = require('./live-state-setup');

module.exports = async function globalTeardown() {
    let before;
    try {
        before = JSON.parse(fs.readFileSync(setup.SNAPSHOT_FILE, 'utf8'));
    } catch (err) {
        throw new Error(`live-state guard: the pre-run snapshot is unreadable (${err.message}). ` +
            'A guard that cannot compare must fail, not pass silently.');
    }
    const changed = setup.diff(before, setup.snapshot());

    fs.rmSync(setup.SNAPSHOT_FILE, { force: true });

    if (changed.length) {
        throw new Error(
            'live-state guard: the test run wrote files the deployment reads.\n  ' +
            changed.join('\n  ') +
            '\n\nA suite must own its state. Use tests/helpers/workspace-fixture.js, or give the ' +
            "module an init({ file }) override and point the suite at os.tmpdir() — the shape " +
            'lib/bridge-state.js and lib/approval-queue.js already use (WORK-TODO #24).');
    }
};
