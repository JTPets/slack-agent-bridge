#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so restarts retain env vars
// (originally written for PM2; now for container restarts, which are the same problem)
require('dotenv').config();
// auto-update.js - Auto-update agent for bridge-agent
// Polls git for changes on main and restarts the bridge by exiting this process.
//
// LOGIC CHANGE 2026-09-13: Replaced the `pm2 restart` step with process.exit(0).
// The bridge runs as the `jt-agent` container with `restart: unless-stopped`, so
// the supervisor re-runs `npm install && node bridge-agent.js` on exit - exiting
// IS the restart. There is no pm2 in that image, so the old path failed with
// ENOENT on every single update and returned before saving the new commit hash,
// re-pulling and re-failing every CHECK_INTERVAL_MS forever.
//
// Self-restarting is intended: the bridge is a code agent and updating itself is
// the point. But `unless-stopped` means a commit that cannot start restarts into
// failure forever with no way into the container, so the exit is gated on four
// guards - see restartIntoUpdate() and lib/update-verifier.js.
//
// auto-update tracks `main` on purpose. This is a single-operator repo; a deploy
// branch that has to be moved by hand would just go stale. The consequence is
// that merging to main deploys within CHECK_INTERVAL_MS, and guard (a) is the
// only thing standing between a bad merge and an unrecoverable restart loop.

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient, postText } = require('./lib/slack-web');
const path = require('path');
const { verifyEntryPoints, runSmokeTest, planRestart } = require('./lib/update-verifier');
const { runGate, formatGateResult } = require('./lib/update-gate');
const updateDrain = require('./lib/update-drain');
// LOGIC CHANGE 2026-11-11 (WORK-TODO #10, Wave 4): split. This file keeps the cycle's
// order (checkForUpdates), the dependency bag, the Slack post and the daemon entry point;
// the configuration, the git porcelain, the state file, the deferral gate and the apply
// half moved to the five modules below, unchanged, and are re-exported under the names
// this file always exported (tests/module-splits.test.js pins it).
const {
    LOCAL_REPO_DIR, CHECK_INTERVAL_MS, RESTART_EXIT_CODE, WORK_DIR, UPDATE_PENDING_FILE,
} = require('./lib/update-config');
const git = require('./lib/update-git');
const { loadState, saveState } = require('./lib/update-state');
const { checkTaskQueue, evaluateTaskDeferral, holdUpdate, clearDeferral } = require('./lib/update-deferral');
const { revertTo, abortUpdate, applyUpdate, flushAndExit } = require('./lib/update-apply');

// Configuration from environment variables (the rest is lib/update-config.js)
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;

// Initialize Slack client
const slack = createWebClient(SLACK_BOT_TOKEN);

/**
 * Post a message to the ops channel
 * @param {string} message - Message to post
 */
// LOGIC CHANGE 2026-10-04 (WORK-TODO #30): delegates to lib/slack-web.js postText. This copy
// did not redact and did not set unfurl_links: false; the helper does both, and like this
// copy it never throws, so a Slack failure still cannot break the update loop.
async function postToOps(message) {
    return postText(slack, OPS_CHANNEL_ID, message, 'auto-update');
}

/**
 * Main update check routine
 *
 * LOGIC CHANGE 2026-09-13: Takes an optional dependency bag. Production calls it
 * with no argument and gets DEFAULT_DEPS. Tests pass fakes so every guard - and
 * in particular "does it exit?" - is assertable without a real repo, a real npm,
 * or a real process.exit.
 *
 * @param {object} [overrides] - Dependency overrides (tests only)
 */
async function checkForUpdates(overrides = {}) {
    const deps = { ...DEFAULT_DEPS, ...overrides };
    const state = deps.loadState();

    try {
        // LOGIC CHANGE 2026-03-26: Fetch before comparing to ensure we have latest remote refs
        const fetchResult = deps.gitFetch();
        if (!fetchResult.success) {
            console.error('Git fetch failed:', fetchResult.error);
            await deps.postToOps(`❌ Auto-update: git fetch failed - ${fetchResult.error}`);
            return;
        }

        const localHead = deps.getLocalHead();
        const remoteHead = deps.getRemoteHead();

        if (!localHead || !remoteHead) {
            console.error('Failed to get commit hashes');
            await deps.postToOps('❌ Auto-update: Failed to get commit hashes');
            return;
        }

        // No update needed
        if (localHead === remoteHead) {
            console.log(`No updates available. Current: ${localHead.substring(0, 7)}`);
            // LOGIC CHANGE 2026-09-20 (drain-one): nothing is pending any more, so
            // stop refusing dispatches. This is also the recovery path after a
            // MANUAL `docker compose restart` applied the merge out from under this
            // loop - the commit landed, the marker did not know, and without this
            // line every dispatch would be refused until the marker went stale.
            deps.clearUpdatePending({ reason: 'local head is already the remote head' });
            return;
        }

        // A commit that already failed verification. Silent on purpose - the
        // failure was announced once. Re-announcing every 5 minutes is how a
        // real alert becomes noise nobody reads.
        if (state.failedCommit && state.failedCommit === remoteHead) {
            console.log(`Skipping ${remoteHead.substring(0, 7)}: failed verification earlier, awaiting a newer commit`);
            // This commit is never going to land, so refusing work on its account
            // would be a permanent refusal for an update that does not exist.
            deps.clearUpdatePending({ reason: 'the pending commit failed verification and will not be retried' });
            return;
        }

        console.log(`Update available: ${localHead.substring(0, 7)} -> ${remoteHead.substring(0, 7)}`);

        // ---- THE GATE: the full suite on exactly this commit, before anything else ----
        // LOGIC CHANGE 2026-11-08 (WORK-TODO #17, owner's choice: "once merged, it should
        // run a gate check of our testing and if it passes it can auto deploy"). Runs in
        // a checkout of its own (lib/update-gate.js), so nothing about the running
        // process changes while it runs and no dispatch is refused yet: the pending
        // marker below is written only after a green. A red commit is recorded in
        // failedCommit and never retried; the next commit on main is gated normally.
        // `runGate` is null in the bare dependency bag (the guard suites inject their
        // own); every real caller passes it - main() below and lib/self-deploy.js.
        if (deps.runGate && state.gatedCommit !== remoteHead) {
            // A marker left by an earlier commit's deferral must not refuse work
            // through a gate run that is minutes long.
            deps.clearUpdatePending({ reason: `gating ${remoteHead.substring(0, 7)} before it may apply` });
            await deps.postToOps(`:test_tube: Update gate: running the full suite on ${remoteHead.substring(0, 7)} - ${deps.getCommitMessage(remoteHead)}`);
            const gate = await deps.runGate({ commit: remoteHead });
            await deps.postToOps(deps.formatGateResult(remoteHead, gate));
            if (gate.moved) return;
            if (!gate.ok) {
                state.failedCommit = remoteHead;
                deps.saveState(state);
                return;
            }
            state.gatedCommit = remoteHead;
            deps.saveState(state);
        }

        // ---- DRAIN-ONE: the update is PENDING from this moment ----
        // LOGIC CHANGE 2026-09-20. Marked BEFORE the deferral gate is evaluated, not
        // after, and that ordering is the whole mechanism: from the instant an update
        // is known, bridge-agent.js refuses NEW dispatches, so the only task this
        // update can ever wait for is the one already in flight. ONE task, not a
        // queue to empty - a queue to empty waits on how often work arrives, which is
        // not a bound at all.
        //
        // It is also set on the path where nothing is running, because the apply
        // phase itself (reset, pull, npm install, smoke test) takes minutes during
        // which the poll loop would happily start a task the imminent restart would
        // kill. That window is the original race, one level down.
        //
        // NO CEILING. This never forces an update and never kills a task. The marker
        // is cleared on every path out of this function - applied, aborted, refused
        // by a guard, or thrown out of - because a marker left behind refuses work
        // forever. See lib/update-drain.js for why its staleness rule is a heartbeat
        // and not a deadline.
        const marked = deps.markUpdatePending({
            commit: remoteHead,
            reason: `update ${remoteHead.substring(0, 7)} is waiting to apply`,
        });
        if (!marked.marked) {
            // Best effort, and never silent: without the marker, new dispatches are
            // NOT refused, which is exactly the behaviour that existed before
            // drain-one - degraded, not broken, and now said out loud.
            await deps.postToOps(
                `:warning: Auto-update: could not record ${remoteHead.substring(0, 7)} as pending ` +
                `(${marked.error}). The update still defers for a running task, but new dispatches will ` +
                `NOT be refused while it waits, so the wait is unbounded.`
            );
        }

        // ---- DEFERRAL GATE: never mutate the tree under a running task ----
        // LOGIC CHANGE 2026-09-14: This check moved to BEFORE `git reset --hard`
        // and `git pull`. It used to sit after them (and after verification),
        // so even a correctly-deferred update had already rewritten the working
        // tree beneath a task that was still executing. Deciding to stand aside
        // after the destructive step is not standing aside.
        const deferral = deps.evaluateTaskDeferral();
        // LOGIC CHANGE 2026-11-08 (WORK-TODO #71): run inside the bridge, this loop can
        // also see work the files cannot - an `ASK:` being answered takes no lock and
        // writes no queue row. inProcessBusy names it; the bridge refuses NEW asks while
        // the marker above is set, so this waits for the one in flight only.
        const busy = deferral.defer ? null : deps.inProcessBusy();
        if (busy) {
            deferral.defer = true;
            deferral.reason = busy;
        }

        // A stale lock or an orphaned queue entry is released/ignored here, and
        // that is never silent: log (in lib/task-lock.js) plus a post, every time.
        for (const verdict of deferral.staleVerdicts) {
            await deps.postToOps(`:unlock: Auto-update: ${verdict}`);
        }

        if (deferral.defer) {
            await holdUpdate(deferral, state, remoteHead, deps);
            return;
        }
        clearDeferral(state);

        await applyUpdate({ localHead, remoteHead, state, deps });
    } catch (error) {
        console.error('Update check failed:', error.message);
        // LOGIC CHANGE 2026-09-20 (drain-one): an unexpected throw must not leave the
        // bridge refusing every dispatch for an update that is not proceeding. The
        // next cycle re-marks it if the update is still there.
        try {
            deps.clearUpdatePending({ reason: `update check threw: ${error.message}` });
        } catch (clearErr) {
            console.error('Failed to clear the pending-update marker:', clearErr.message);
        }
        await deps.postToOps(`❌ Auto-update: Unexpected error - ${error.message}`);
    }
}

// Real implementations. Kept in one object so checkForUpdates has a single,
// explicit seam rather than a scattering of test-only globals.
const DEFAULT_DEPS = {
    loadState,
    saveState,
    gitFetch: git.gitFetch,
    getLocalHead: git.getLocalHead,
    getRemoteHead: git.getRemoteHead,
    getCommitMessage: git.getCommitMessage,
    gitResetHard: git.gitResetHard,
    gitResetTo: git.gitResetTo,
    gitPull: git.gitPull,
    npmInstall: git.npmInstall,
    verifyEntryPoints,
    runSmokeTest,
    planRestart,
    evaluateTaskDeferral,
    // LOGIC CHANGE 2026-09-20 (drain-one): injected like everything else here so the
    // marker lifecycle is assertable without a real filesystem race.
    markUpdatePending: (opts) => updateDrain.markPending({ ...opts, markerFile: UPDATE_PENDING_FILE }),
    clearUpdatePending: (opts) => updateDrain.clear({ ...opts, markerFile: UPDATE_PENDING_FILE }),
    postToOps,
    exit: flushAndExit,
    // LOGIC CHANGE 2026-11-08 (WORK-TODO #17, #71): no gate and no in-process view in
    // the bare bag; the real callers supply both (see GATED_DEPS and lib/self-deploy.js).
    runGate: null,
    formatGateResult,
    inProcessBusy: () => null,
};

/** The dependency bag every real deploy uses: the bare one plus the gate. */
function gatedDeps(extra = {}) {
    return {
        runGate: (opts) => runGate({
            repoDir: LOCAL_REPO_DIR,
            gateDir: path.join(WORK_DIR, 'update-gate'),
            ...opts,
        }),
        ...extra,
    };
}

// LOGIC CHANGE 2026-11-11 (WORK-TODO #10): the daemon's startup log, config check and loop
// are lib/update-daemon.js; only the run-directly test stays here, because it is about THIS file.
// LOGIC CHANGE 2026-09-13: Only start the loop when run directly. The restart
// path now decides whether to call process.exit(0), and that decision has to be
// assertable from a test - which means the module has to be requireable without
// starting a polling daemon.
if (require.main === module) {
    require('./lib/update-daemon').main({ checkForUpdates, gatedDeps }).catch(error => {
        console.error('Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = {
    checkForUpdates,
    abortUpdate,
    revertTo,
    flushAndExit,
    loadState,
    saveState,
    gitResetTo: git.gitResetTo,
    checkTaskQueue,
    evaluateTaskDeferral,
    UPDATE_PENDING_FILE,
    RESTART_EXIT_CODE,
    DEFAULT_DEPS,
    LOCAL_REPO_DIR,
    CHECK_INTERVAL_MS,
    gatedDeps,
};
