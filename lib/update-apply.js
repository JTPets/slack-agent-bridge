'use strict';

/**
 * lib/update-apply.js
 *
 * Applying an update that is cleared to proceed: reset, fast-forward to the gated
 * commit, guards (a)-(d), and the exit that is the restart; and reverting when a guard
 * refuses. Moved out of auto-update.js on 2026-11-11 (WORK-TODO #10, Wave 4): revertTo
 * and abortUpdate unchanged, and applyUpdate, the second half of checkForUpdates, which
 * was 340 lines, over the owner's 300-lines-per-function rule. Every side effect goes
 * through the caller's dependency bag, exactly as it did inline.
 */

const { LOCAL_REPO_DIR, RESTART_EXIT_CODE } = require('./update-config');

/**
 * Revert the working tree to a known-good commit after a failed verification.
 *
 * Reinstalls dependencies for the reverted tree, because the failed update may
 * already have installed the new commit's package set over them.
 *
 * @param {string} commit - Commit hash known to have started
 * @param {object} deps - Injected dependencies
 * @returns {{ success: boolean, error?: string, npmError?: string }}
 */
function revertTo(commit, deps) {
    const reset = deps.gitResetTo(commit);
    if (!reset.success) {
        return { success: false, error: reset.error };
    }

    const npm = deps.npmInstall();
    return { success: true, npmError: npm.success ? undefined : npm.error };
}

/**
 * Abort an update that failed verification.
 *
 * Guard (a)'s "do not exit" half: put the working tree back on the commit that
 * was running, remember the remote head that failed so it is not retried every
 * check interval, and tell #sqtools-ops what broke. The process keeps running on
 * the code that works.
 *
 * @param {object} options
 * @returns {Promise<void>}
 */
async function abortUpdate(options) {
    const { previousHead, remoteHead, reason, details, state, deps } = options;
    const shortRemote = remoteHead ? remoteHead.substring(0, 7) : '(unknown)';
    const shortPrev = previousHead ? previousHead.substring(0, 7) : '(unknown)';

    console.error(`Update verification failed for ${shortRemote}: ${reason}`);

    const revert = revertTo(previousHead, deps);

    state.failedCommit = remoteHead;
    deps.saveState(state);

    let revertNote;
    if (!revert.success) {
        revertNote = `:rotating_light: REVERT FAILED (${revert.error}) - the working tree may be on the bad commit. Do not let this container exit.`;
    } else if (revert.npmError) {
        revertNote = `Reverted to ${shortPrev}, but npm install on the reverted tree failed: ${revert.npmError}`;
    } else {
        revertNote = `Reverted to ${shortPrev} and still running on it.`;
    }

    await deps.postToOps(
        `:no_entry: Auto-update: refusing to restart into ${shortRemote} - ${reason}\n` +
        `${details}\n${revertNote}\n` +
        `This commit will not be retried; push a fix to main and the next commit deploys normally.`
    );
}

/**
 * Apply `remoteHead` over `localHead`: reset, fast-forward, guards (a) to (d), exit.
 * Every early return clears the pending marker first, as it did inline. Throws are the
 * caller's to catch (checkForUpdates' catch clears the marker and posts).
 *
 * @param {{ localHead: string, remoteHead: string, state: object, deps: object }} options
 * @returns {Promise<void>}
 */
async function applyUpdate({ localHead, remoteHead, state, deps }) {
    // LOGIC CHANGE 2026-03-26: Added git reset --hard HEAD before pull to ensure any local
    // modifications (from npm install modifying package.json, or stray files) don't block the pull
    const resetResult = deps.gitResetHard();
    if (!resetResult.success) {
        console.error('Git reset failed:', resetResult.error);
        await deps.postToOps(`❌ Auto-update: git reset --hard HEAD failed - ${resetResult.error}`);
        deps.clearUpdatePending({ reason: 'git reset failed; this update is not landing' });
        return;
    }
    console.log('Reset local changes with git reset --hard HEAD');

    // Pull the changes
    const pullResult = deps.gitPull(remoteHead);
    if (!pullResult.success) {
        console.error('Git pull failed:', pullResult.error);
        await deps.postToOps(`❌ Auto-update: git pull failed - ${pullResult.error}`);
        deps.clearUpdatePending({ reason: 'git pull failed; this update is not landing' });
        return;
    }

    // ---- GUARD (a), part 1: does the pulled code parse? ----
    // Cheap, side-effect-free, and runs before npm install so a typo on main
    // never gets as far as touching node_modules.
    const verification = deps.verifyEntryPoints({ repoDir: LOCAL_REPO_DIR });
    if (!verification.ok) {
        const details = verification.failures
            .map(f => `• ${f.file}: ${f.error}`)
            .join('\n');
        await abortUpdate({
            previousHead: localHead,
            remoteHead,
            reason: 'entry point failed `node --check`',
            details,
            state,
            deps
        });
        deps.clearUpdatePending({ reason: 'update aborted: entry point failed `node --check`' });
        return;
    }
    console.log(`Syntax check passed for ${verification.checked.length} entry point(s)`);
    if (verification.missing.length > 0) {
        console.log(`Optional entry points absent (not checked): ${verification.missing.join(', ')}`);
    }

    // ---- GUARD (a), part 2: does npm install succeed? ----
    // LOGIC CHANGE 2026-03-26: Run npm install after pull so new dependencies get installed
    // automatically when the repo is updated
    console.log('Running npm install...');
    const npmResult = deps.npmInstall();
    if (!npmResult.success) {
        await abortUpdate({
            previousHead: localHead,
            remoteHead,
            reason: 'npm install failed on the pulled commit',
            details: npmResult.error,
            state,
            deps
        });
        deps.clearUpdatePending({ reason: 'update aborted: npm install failed' });
        return;
    }
    console.log('npm install completed successfully');

    // ---- GUARD (a), part 3: does the repo's own smoke test pass? ----
    // node --check (part 1) is syntax-only: a commit that deletes a required
    // file or adds a dependency missing from package.json parses clean and
    // still bricks the container. The smoke suite (`npm run test:smoke`)
    // require()s every entry point and lib module, so it catches exactly those.
    // It runs AFTER npm install because it needs node_modules present, and
    // BEFORE the exit. Bounded by SMOKE_TEST_TIMEOUT_MS: a wedged test is a
    // FAILURE that reverts, never a hang of the update loop.
    console.log('Running smoke test...');
    const smokeResult = deps.runSmokeTest({ repoDir: LOCAL_REPO_DIR });
    if (!smokeResult.ok) {
        await abortUpdate({
            previousHead: localHead,
            remoteHead,
            reason: smokeResult.timedOut
                ? 'smoke test timed out on the pulled commit'
                : 'smoke test failed on the pulled commit',
            details: smokeResult.error,
            state,
            deps
        });
        deps.clearUpdatePending({ reason: 'update aborted: smoke test failed' });
        return;
    }
    console.log('Smoke test passed');

    // Get the new commit info
    const newHead = deps.getLocalHead();
    const commitMessage = deps.getCommitMessage(newHead);

    // ---- GUARD (c): never exit twice for the same commit ----
    const plan = deps.planRestart({
        newHead,
        restartedIntoCommit: state.restartedIntoCommit
    });
    if (!plan.exit) {
        console.warn(`Not restarting: ${plan.reason}`);
        await deps.postToOps(
            `:warning: Auto-update: pulled ${newHead ? newHead.substring(0, 7) : '(unknown)'} but ` +
            `not restarting - ${plan.reason}. The new code is on disk and will be live after the ` +
            `next manual container restart.`
        );
        deps.clearUpdatePending({ reason: 'not restarting for this commit; the new code awaits a manual restart' });
        return;
    }

    // ---- GUARD (b): state is durable BEFORE the exit ----
    // This is the exact bug the pm2 path had - it returned before saveState,
    // so lastKnownCommit never advanced. Exit-restart inherits it unless the
    // write happens first AND is confirmed.
    state.lastKnownCommit = newHead;
    state.restartedIntoCommit = newHead;
    state.failedCommit = null;
    const saved = deps.saveState(state);
    if (!saved.success) {
        console.error('Refusing to restart: state file could not be written');
        await deps.postToOps(
            `:warning: Auto-update: pulled ${newHead.substring(0, 7)} but could not write the state file ` +
            `(${saved.error}). Not restarting - exiting now would re-pull this commit on every boot.`
        );
        deps.clearUpdatePending({ reason: 'state file unwritable; not restarting' });
        return;
    }

    // ---- GUARD (d): notify BEFORE the exit; there is no "after" ----
    const shortHash = newHead.substring(0, 7);
    await deps.postToOps(
        `✅ Auto-update: updated to ${shortHash} - ${commitMessage}. ` +
        `npm install OK, entry points parse. Exiting now so the container supervisor restarts the bridge.`
    );
    console.log(`Successfully updated to ${shortHash}, exiting for restart`);

    // LOGIC CHANGE 2026-09-20 (drain-one): clear the marker BEFORE the exit, for
    // the same reason guard (b) writes state before the exit - there is no
    // "after" an exit. A marker that survived the restart would have the new
    // process refusing every dispatch for an update that has already applied.
    deps.clearUpdatePending({ reason: `update ${shortHash} applied; restarting` });

    await deps.exit(RESTART_EXIT_CODE);
}

// LOGIC CHANGE 2026-09-13: restartPM2() deleted. `pm2` does not exist in the
// `jt-agent` container, so it returned ENOENT on every update and the caller
// returned before saveState() - the same commit was re-pulled and re-failed every
// 5 minutes, permanently. The restart is now this process exiting, which the
// compose `restart: unless-stopped` policy turns into a full re-run of
// `npm install && node bridge-agent.js`.

/**
 * Flush stdout, then exit.
 *
 * Guard (d): there is no "after" an exit. Everything that has to be visible -
 * the Slack post (awaited by the caller) and the log lines - has to be out the
 * door first. console.log is asynchronous when stdout is a pipe, which is
 * exactly how it is wired under docker compose, so the queue gets drained
 * explicitly rather than hoped over.
 *
 * @param {number} code - Exit code
 * @returns {Promise<void>}
 */
async function flushAndExit(code) {
    await new Promise(resolve => process.stdout.write('', resolve));
    process.exit(code);
}

module.exports = { revertTo, abortUpdate, applyUpdate, flushAndExit };
