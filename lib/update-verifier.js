'use strict';

/**
 * lib/update-verifier.js
 *
 * Pre-restart verification for auto-update.js.
 *
 * LOGIC CHANGE 2026-09-13: New module. auto-update.js used to restart the bridge
 * by shelling out to `pm2 restart`, which does not exist in the `jt-agent`
 * container. The replacement is `process.exit(0)` - the compose file sets
 * `restart: unless-stopped`, so the supervisor re-runs
 * `npm install && node bridge-agent.js` and exiting IS the restart.
 *
 * That makes the failure mode much worse than a failed pm2 call: a commit that
 * cannot start means restart-into-failure forever, with no shell in the
 * container to fix it from. So the exit is gated on this module. Nothing here
 * exits or mutates the repo; it answers two questions and auto-update.js acts
 * on the answers:
 *
 *   verifyEntryPoints() - would the pulled code parse?
 *   runSmokeTest()      - does the pulled code actually load and pass the smoke suite?
 *   planRestart()       - have we already restarted for this exact commit?
 *
 * `node --check` is a SYNTAX check. It does not execute the module, so a commit
 * that deletes a required file or adds a dependency missing from package.json
 * parses clean and still bricks the container. runSmokeTest() closes that gap:
 * `npm run test:smoke` require()s every entry point and lib module, so a broken
 * require or a missing dependency is caught before the exit-restart.
 *
 * LOGIC CHANGE 2026-09-13: Added runSmokeTest(). It became wireable once the jest
 * open handle was fixed - bots/storefront.js had a module-scope setInterval that
 * pinned the event loop, so `npm run test:smoke` never exited. That timer now
 * .unref()s, the smoke suite exits on its own, and it can gate the restart.
 * See WORK-TODO.md item 1.
 */

const { spawnSync } = require('child_process');
const { classifyTestRun, OUTCOME } = require('./test-verdict');
const fs = require('fs');
const path = require('path');

// Every file a human or a cron line starts directly. `required: true` means a
// commit that removes the file is itself a brick - bridge-agent.js is the
// container's command, auto-update.js is what would have to pull the fix.
// The rest are cron/manual entry points: absent is a warning, not a veto,
// because vetoing would block every later (good) commit too.
const ENTRY_POINTS = [
    { file: 'bridge-agent.js', required: true },
    { file: 'auto-update.js', required: true },
    { file: 'morning-digest.js', required: false },
    { file: 'security-review.js', required: false },
    { file: 'scripts/watercooler.js', required: false },
    { file: 'bots/storefront.js', required: false },
    { file: 'lib/validate.js', required: false },
];

// A syntax check is a parse, not an execution. 15s is far beyond what parsing
// any file in this repo takes, and bounds the case where the node binary itself
// is wedged so verification can never hang the update loop.
const SYNTAX_CHECK_TIMEOUT_MS = 15000;

// The smoke suite (`npm run test:smoke`) require()s every module and finishes in
// ~2.5s. 120s is ~50x that, headroom for a loaded container, and - critically -
// is well under auto-update's CHECK_INTERVAL_MS (300s), so a WEDGED smoke test is
// killed and scored as a FAILURE long before it could stall the next update check.
// A gate that could itself hang would be worse than no gate.
const SMOKE_TEST_TIMEOUT_MS = 120000;

/**
 * Default syntax checker: `node --check <file>`.
 *
 * Uses process.execPath, not the string 'node', so the check runs on the same
 * interpreter the restarted process will use.
 *
 * @param {string} absPath - Absolute path to the file to parse
 * @returns {{ ok: boolean, error?: string }}
 */
function defaultRunSyntaxCheck(absPath) {
    const result = spawnSync(process.execPath, ['--check', absPath], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: SYNTAX_CHECK_TIMEOUT_MS,
    });

    if (result.status === 0) {
        return { ok: true };
    }

    // spawnSync sets result.error (ENOENT, ETIMEDOUT) and leaves stdout/stderr
    // undefined when the spawn itself fails. Name the real cause instead of
    // collapsing to a generic string - that distinction is what made the old
    // pm2 failure unreadable in Slack for months.
    if (result.error) {
        return { ok: false, error: `could not run node --check (${result.error.code || result.error.message})` };
    }

    return {
        ok: false,
        error: (result.stderr || result.stdout || `node --check exited ${result.status}`).trim(),
    };
}

/**
 * Parse-check every entry point in a repo directory.
 *
 * @param {object} options
 * @param {string} options.repoDir - Absolute path to the repo
 * @param {Array<{file: string, required: boolean}>} [options.entryPoints] - Defaults to ENTRY_POINTS
 * @param {function} [options.runSyntaxCheck] - Injectable checker (for tests)
 * @param {function} [options.exists] - Injectable fs.existsSync (for tests)
 * @returns {{ ok: boolean, checked: string[], missing: string[], failures: Array<{file: string, error: string}> }}
 */
function verifyEntryPoints(options = {}) {
    const {
        repoDir,
        entryPoints = ENTRY_POINTS,
        runSyntaxCheck = defaultRunSyntaxCheck,
        exists = fs.existsSync,
    } = options;

    const checked = [];
    const missing = [];
    const failures = [];

    for (const entry of entryPoints) {
        const absPath = path.join(repoDir, entry.file);

        if (!exists(absPath)) {
            if (entry.required) {
                failures.push({ file: entry.file, error: 'required entry point is missing after pull' });
            } else {
                missing.push(entry.file);
            }
            continue;
        }

        const result = runSyntaxCheck(absPath);
        checked.push(entry.file);
        if (!result.ok) {
            failures.push({ file: entry.file, error: result.error || 'unknown syntax error' });
        }
    }

    return { ok: failures.length === 0, checked, missing, failures };
}

/**
 * Default smoke runner: `npm run test:smoke` in the repo directory.
 *
 * Bounded by SMOKE_TEST_TIMEOUT_MS. On timeout, spawnSync kills the child and
 * returns with a null status and an ETIMEDOUT error, which runSmokeTest reads as
 * a failure - a smoke test that will not finish must never be scored as a pass.
 *
 * @param {string} repoDir - Absolute path to the repo
 * @param {number} timeoutMs - Kill the run after this many ms
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function defaultRunSmoke(repoDir, timeoutMs) {
    return spawnSync('npm', ['run', 'test:smoke'], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: timeoutMs,
        // CI=true keeps jest non-interactive: no watch prompt can wedge the run.
        env: { ...process.env, CI: 'true' },
    });
}

/**
 * Run the repo's smoke suite as the final pre-restart load check.
 *
 * This is what makes the gate a load check and not just a parse: `node --check`
 * passes on a commit that deletes a required file or adds a dependency missing
 * from package.json; the smoke suite require()s the modules and catches it.
 *
 * @param {object} [options]
 * @param {string} options.repoDir - Absolute path to the repo
 * @param {number} [options.timeoutMs] - Defaults to SMOKE_TEST_TIMEOUT_MS
 * @param {function} [options.run] - Injectable runner (for tests)
 * @returns {{ ok: boolean, timedOut?: boolean, error?: string }}
 */
function runSmokeTest(options = {}) {
    const {
        repoDir,
        timeoutMs = SMOKE_TEST_TIMEOUT_MS,
        run = defaultRunSmoke,
    } = options;

    const result = run(repoDir, timeoutMs);

    // LOGIC CHANGE 2026-09-14: classified by lib/test-verdict.js rather than by a
    // `status === 0` branch here. Two cases this changes, both of which used to be
    // scored wrong:
    //   - `npm run test:smoke` under an install that omitted devDependencies exits
    //     127 with "jest: not found" and ran nothing. It was lumped in with "real
    //     test failures", whose comment then told the reader the failing assertions
    //     were at the tail of the output. There were no assertions.
    //   - a smoke run that exits 0 having executed nothing - a changed pattern, a
    //     --passWithNoTests - was scored ok:true and would have ARMED A RESTART.
    //     That is guard (a) of the self-update passing on zero evidence.
    const verdict = classifyTestRun({
        command: 'npm run test:smoke',
        exitCode: result.status,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
    });

    if (verdict.green) {
        return { ok: true, assertions: verdict.assertions.total };
    }

    return {
        ok: false,
        timedOut: verdict.outcome === OUTCOME.TIMED_OUT,
        outcome: verdict.outcome,
        ranAssertions: verdict.ran,
        // The reason names the outcome; the output tail is kept after it because for a
        // genuine failure the failing assertions are at the end, and for an absent
        // runner there is nothing useful there at all.
        error: `${verdict.reason}${verdict.output ? `\n${verdict.output.trim().slice(-800)}` : ''}`,
    };
}

/**
 * Decide whether the process may exit to restart into a commit.
 *
 * Guard (c): the restarted process must not exit again for the same commit. The
 * commit hash it restarted INTO is persisted before exiting, so if the same hash
 * comes back around - state not advancing, remote rolled back to it, a partial
 * pull - the answer is no, and the bridge keeps running on code that works
 * instead of cycling the container every check interval.
 *
 * Pure function: takes state, returns a decision. It never exits.
 *
 * @param {object} options
 * @param {string} options.newHead - Commit hash we would restart into
 * @param {string|null} [options.restartedIntoCommit] - Hash from state, if any
 * @returns {{ exit: boolean, reason: string }}
 */
function planRestart(options = {}) {
    const { newHead, restartedIntoCommit = null } = options;

    if (!newHead) {
        return { exit: false, reason: 'no commit hash to restart into' };
    }

    if (restartedIntoCommit && restartedIntoCommit === newHead) {
        return {
            exit: false,
            reason: `already restarted for ${newHead.substring(0, 7)} - refusing to restart again`,
        };
    }

    return { exit: true, reason: `restarting into ${newHead.substring(0, 7)}` };
}

module.exports = {
    ENTRY_POINTS,
    SYNTAX_CHECK_TIMEOUT_MS,
    SMOKE_TEST_TIMEOUT_MS,
    defaultRunSyntaxCheck,
    defaultRunSmoke,
    verifyEntryPoints,
    runSmokeTest,
    planRestart,
};
