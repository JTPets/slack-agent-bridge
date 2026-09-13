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
 *   planRestart()       - have we already restarted for this exact commit?
 *
 * KNOWN LIMIT (stated deliberately rather than papered over): `node --check` is
 * a SYNTAX check. It does not execute the module, so a commit that deletes a
 * required file or adds a dependency missing from package.json parses clean and
 * still bricks the container. Closing that gap needs a real load/smoke gate;
 * `npm run test:smoke` is the repo's designated one but currently does not exit
 * (jest holds an open handle), so it cannot be wired in here yet.
 */

const { spawnSync } = require('child_process');
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
    defaultRunSyntaxCheck,
    verifyEntryPoints,
    planRestart,
};
