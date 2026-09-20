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

const { WebClient } = require('@slack/web-api');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { verifyEntryPoints, runSmokeTest, planRestart } = require('./lib/update-verifier');
const taskLock = require('./lib/task-lock');
const updateDrain = require('./lib/update-drain');
// LOGIC CHANGE 2026-09-20: the DELIVERY predicate, not a re-derivation of it. This
// file only ever READS task-queue.json, so it takes the predicate rather than the
// class - but it must ask the same question lib/task-queue.js answers, or the gate
// and the record would disagree about what "finished" means.
const { deliveryRecorded } = require('./lib/task-queue');

// Configuration from environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
// NOTE 2026-09-13: this default is the dead Raspberry Pi path. It is left in place
// rather than guessed at, because the repo's path INSIDE the `jt-agent` container is
// not knowable from this repo (on the NAS host it is /share/CACHEDEV1_DATA/jt-agent).
// Set LOCAL_REPO_DIR explicitly in .env; an unset value points auto-update at a path
// that does not exist.
const LOCAL_REPO_DIR = process.env.LOCAL_REPO_DIR || '/home/jtpets/jt-agent';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 minutes default
const STATE_FILE = process.env.STATE_FILE || path.join(LOCAL_REPO_DIR, '.auto-update-state.json');

// A clean, intentional restart - not a crash. The supervisor restarts on any
// exit code; 0 is what distinguishes "I updated myself" from "I fell over" in
// `docker compose ps` and in the container's exit history.
const RESTART_EXIT_CODE = 0;

// LOGIC CHANGE 2026-03-27: Task lock file path for coordination with bridge-agent.js.
// Auto-update waits for this file to be removed before restarting.
// LOGIC CHANGE 2026-04-01: Added task queue file path for more reliable coordination.
// Task queue is persistent and provides accurate task status across restarts.
const WORK_DIR = process.env.WORK_DIR || '/tmp/bridge-agent';
const TASK_LOCK_FILE = path.join(WORK_DIR, '.task-running');
const TASK_QUEUE_FILE = path.join(WORK_DIR, 'task-queue.json');
// LOGIC CHANGE 2026-09-20 (drain-one): the pending-update marker bridge-agent.js
// reads to decide whether to refuse a new dispatch. Same WORK_DIR as the lock and
// the queue, because the three are one coordination surface between two processes
// in one container. Owned by lib/update-drain.js; this file only names the path.
const UPDATE_PENDING_FILE = updateDrain.DEFAULT_MARKER_FILE;

// LOGIC CHANGE 2026-09-14: Replaced the in-process "wait up to 5 minutes then
// restart anyway" loop (TASK_WAIT_INTERVAL_MS / TASK_WAIT_MAX_ATTEMPTS) with a
// deferral that returns and retries on the next check interval.
//
// The old loop capped its wait at 10 x 30s = 5 minutes and then restarted
// regardless. TASK_TIMEOUT_MS defaults to 600000 (10 minutes) and a task that
// hits max turns retries once, so a task is ALLOWED to run several times longer
// than auto-update was willing to wait. The restart was not a race that
// occasionally bit a long task - it was guaranteed to kill one. That is how a
// long refactor died mid-run.
//
// Deferring instead of force-restarting is only safe because lib/task-lock.js
// ages a lock out: a lock left behind by a killed task is detected and released
// rather than blocking deploys forever. The two changes are one change.
const DEFER_ALERT_AFTER_MS = parseInt(process.env.UPDATE_DEFER_ALERT_MS, 10) || 60 * 60 * 1000;

// Initialize Slack client
const slack = new WebClient(SLACK_BOT_TOKEN);

/**
 * Post a message to the ops channel
 * @param {string} message - Message to post
 */
async function postToOps(message) {
    try {
        await slack.chat.postMessage({
            channel: OPS_CHANNEL_ID,
            text: message
        });
    } catch (error) {
        // Log error but don't throw - we don't want Slack failures to break the update loop
        console.error('Failed to post to Slack:', error.message);
    }
}

/**
 * Run a git command in the repo directory
 * @param {string[]} args - Git command arguments
 * @returns {{ success: boolean, stdout: string, stderr: string }}
 */
function runGit(args) {
    const result = spawnSync('git', args, {
        cwd: LOCAL_REPO_DIR,
        encoding: 'utf8',
        timeout: 60000 // 60 second timeout
    });

    return {
        success: result.status === 0,
        stdout: (result.stdout || '').trim(),
        stderr: (result.stderr || '').trim()
    };
}

/**
 * Get the current local HEAD commit hash
 * @returns {string|null}
 */
function getLocalHead() {
    const result = runGit(['rev-parse', 'HEAD']);
    return result.success ? result.stdout : null;
}

/**
 * Get the remote origin/main commit hash
 * @returns {string|null}
 */
function getRemoteHead() {
    const result = runGit(['rev-parse', 'origin/main']);
    return result.success ? result.stdout : null;
}

/**
 * Get commit message for a given hash
 * @param {string} hash - Commit hash
 * @returns {string}
 */
function getCommitMessage(hash) {
    const result = runGit(['log', '-1', '--format=%s', hash]);
    return result.success ? result.stdout : '(unknown)';
}

/**
 * Fetch from origin
 * @returns {{ success: boolean, error?: string }}
 */
function gitFetch() {
    const result = runGit(['fetch', 'origin', 'main']);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

/**
 * Pull from origin main
 * @returns {{ success: boolean, error?: string }}
 */
function gitPull() {
    const result = runGit(['pull', 'origin', 'main']);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-03-26: Added git reset --hard HEAD before pull to ensure any local
// modifications (from npm install modifying package.json, or stray files) don't block the pull
/**
 * Reset local repo to HEAD (discard any local modifications)
 * @returns {{ success: boolean, error?: string }}
 */
function gitResetHard() {
    const result = runGit(['reset', '--hard', 'HEAD']);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-09-13: Removed removePackageLock(). It existed only because
// package-lock.json was gitignored while npm install kept recreating it locally.
// The lockfile is now committed, so deleting it before every pull would be
// deleting a tracked file; `git reset --hard HEAD` above already restores it.

// LOGIC CHANGE 2026-09-13: Added gitResetTo() for guard (a). When verification
// of a pulled commit fails, the working tree goes back to the commit that was
// running a moment ago, so the process keeps serving code that is known to start.
/**
 * Reset local repo to a specific commit (used to revert a bad update)
 * @param {string} commit - Commit hash to reset to
 * @returns {{ success: boolean, error?: string }}
 */
function gitResetTo(commit) {
    const result = runGit(['reset', '--hard', commit]);
    return {
        success: result.success,
        error: result.success ? undefined : result.stderr
    };
}

// LOGIC CHANGE 2026-03-26: Added npm install after git pull so new dependencies get installed
// automatically when the repo is updated
/**
 * Run npm install in the repo directory
 * @returns {{ success: boolean, error?: string }}
 */
function npmInstall() {
    const result = spawnSync('npm', ['install'], {
        cwd: LOCAL_REPO_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120000 // 2 minute timeout for npm install
    });

    return {
        success: result.status === 0,
        error: result.status === 0 ? undefined : (result.stderr || result.stdout || 'Unknown npm error').trim()
    };
}

// LOGIC CHANGE 2026-03-27: Wait for bridge-agent task to complete before restarting.
// LOGIC CHANGE 2026-04-01: Also checks task queue for pending/running tasks.
// LOGIC CHANGE 2026-09-14: The wait loop is gone; this is now a non-blocking
// deferral check. See DEFER_ALERT_AFTER_MS above for why waiting-then-restarting
// was the defect rather than the safeguard.

/**
 * Check if task queue has active tasks (pending or running).
 *
 * LOGIC CHANGE 2026-09-14: Entries older than the task-lock staleness threshold
 * no longer count as active. `recoverInterrupted()` on bridge startup only
 * rewrites "running" entries, so a task killed between `enqueue()` and
 * `dequeue()` stays "pending" forever. Under the old 5-minute cap that merely
 * delayed each update; now that a deferral has no cap, one such entry would
 * freeze deploys permanently. Stale entries are reported, never rewritten -
 * task-queue.json is bridge-agent's file and auto-update only reads it.
 *
 * @param {object} [options]
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ hasActive: boolean, pending: number, running: object|null, staleIgnored: number }}
 */
function checkTaskQueue({ staleAfterMs, now } = {}) {
    const empty = { hasActive: false, pending: 0, running: null, awaitingDelivery: 0, staleIgnored: 0 };
    try {
        if (!fs.existsSync(TASK_QUEUE_FILE)) {
            return empty;
        }
        const data = fs.readFileSync(TASK_QUEUE_FILE, 'utf8');
        if (!data || !data.trim()) {
            return empty;
        }
        const queue = JSON.parse(data);
        if (!Array.isArray(queue)) {
            return empty;
        }

        const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0
            ? staleAfterMs
            : taskLock.defaultStaleAfterMs();
        const clock = Number.isFinite(now) ? now : Date.now();

        const isStale = (task, stampField) => {
            const stamp = Date.parse(task[stampField]);
            if (!Number.isFinite(stamp)) return false; // no usable stamp -> treat as live
            return clock - stamp > threshold;
        };

        const allPending = queue.filter(t => t.status === 'pending');
        const livePending = allPending.filter(t => !isStale(t, 'enqueuedAt'));

        const allRunning = queue.filter(t => t.status === 'running');
        const liveRunning = allRunning.filter(t => !isStale(t, 'startedAt'));

        // LOGIC CHANGE 2026-09-20: THE FINISH LINE IS DELIVERY, NOT STATUS.
        //
        // Applying an update restarts the process, so "this task is finished" has to
        // mean its RESULT WAS DELIVERED - a task that completed and never posted is,
        // in every durable record, identical to one that never ran. The terminal
        // queue write happens strictly AFTER the result post and now carries that
        // post's verdict (lib/task-queue.js), so an entry with no verdict recorded is
        // still in flight whatever its status says.
        //
        // This does not change the behaviour of any entry written before that field
        // existed: deliveryRecorded() returns true for a row with no `delivery` key
        // at all, precisely so a pre-change queue file cannot freeze every deploy the
        // first time this code runs against it.
        const terminalStamp = t => (t.completedAt ? 'completedAt' : (t.startedAt ? 'startedAt' : 'enqueuedAt'));
        const isTerminal = t => t.status !== 'pending' && t.status !== 'running';
        const allUndelivered = queue.filter(t => isTerminal(t) && !deliveryRecorded(t));
        const liveUndelivered = allUndelivered.filter(t => !isStale(t, terminalStamp(t)));

        const staleIgnored = (allPending.length - livePending.length)
            + (allRunning.length - liveRunning.length)
            + (allUndelivered.length - liveUndelivered.length);

        return {
            hasActive: livePending.length > 0 || liveRunning.length > 0 || liveUndelivered.length > 0,
            pending: livePending.length,
            running: liveRunning[0] || null,
            awaitingDelivery: liveUndelivered.length,
            staleIgnored,
        };
    } catch (err) {
        console.error('Failed to check task queue:', err.message);
        return empty;
    }
}

/**
 * Decide whether this update cycle must stand aside for a running task.
 *
 * Order matters. A stale lock is released FIRST, so a lock left behind by a
 * killed task cannot make the check below defer forever. Anything released here
 * is surfaced twice - logged by lib/task-lock.js and posted to #sqtools-ops by
 * the caller. There is no silent release.
 *
 * On the bound: a deferral retries on the very next check interval because
 * nothing is persisted to suppress it - the caller simply returns, and
 * setInterval(checkForUpdates, CHECK_INTERVAL_MS) runs it again. A SINGLE task
 * can hold the lock for at most the staleness threshold (default 30 min, see
 * lib/task-lock.js) before it is released out from under it. A back-to-back
 * SUCCESSION of healthy tasks can, however, defer an update indefinitely: that
 * is deliberate, because the alternative is killing live work, which is the bug
 * being fixed. It is bounded by visibility rather than by a timer - once a
 * single update has been deferred continuously for DEFER_ALERT_AFTER_MS
 * (default 60 min), every cycle escalates to #sqtools-ops so a deploy that is
 * never landing cannot go unnoticed.
 *
 * @param {object} [options]
 * @param {number} [options.staleAfterMs] Override staleness threshold (tests)
 * @param {number} [options.now]          Override clock (tests)
 * @returns {{ defer: boolean, reason: string|null, staleVerdicts: string[], queue: object, lock: object }}
 */
function evaluateTaskDeferral({ staleAfterMs, now } = {}) {
    const staleVerdicts = [];

    const staleRelease = taskLock.releaseIfStale({
        lockFile: TASK_LOCK_FILE,
        staleAfterMs,
        now,
    });
    if (staleRelease.verdict) {
        staleVerdicts.push(staleRelease.verdict);
    }

    // Re-read after a possible release so the decision uses current truth.
    const lock = taskLock.inspect({ lockFile: TASK_LOCK_FILE, staleAfterMs, now });
    const queue = checkTaskQueue({ staleAfterMs, now });

    if (queue.staleIgnored > 0) {
        const verdict =
            `Ignored ${queue.staleIgnored} stale task-queue entr${queue.staleIgnored === 1 ? 'y' : 'ies'} ` +
            `in ${TASK_QUEUE_FILE} when deciding whether to defer: older than the staleness limit, so they ` +
            `cannot belong to a live task. They were NOT rewritten - task-queue.json belongs to bridge-agent, ` +
            `whose recoverInterrupted() only repairs "running" entries. A "pending" entry orphaned by a kill ` +
            `stays in the file and would otherwise block every future deploy.`;
        console.warn(`[auto-update] ${verdict}`);
        staleVerdicts.push(verdict);
    }

    if (lock.held && !lock.stale) {
        const ageMin = Math.round((lock.ageMs || 0) / 60000);
        return {
            defer: true,
            reason: `a task holds the lock (${lock.description || lock.msgTs || 'unknown task'}, running ${ageMin}m)`,
            staleVerdicts,
            queue,
            lock,
        };
    }

    if (queue.hasActive) {
        // LOGIC CHANGE 2026-09-20: `awaitingDelivery` is reported FIRST when present,
        // because it is the reason a reader would otherwise not believe: an entry
        // whose status already reads `completed` but whose result has not been
        // delivered. Naming it as "the queue is not drained" would send whoever reads
        // the ops post looking for a running task that is not there.
        const detail = queue.awaitingDelivery > 0
            ? `${queue.awaitingDelivery} task(s) finished but their results are not yet delivered`
            : queue.running
                ? `running: ${queue.running.description || 'unknown'}`
                : `${queue.pending} pending task(s)`;
        return {
            defer: true,
            reason: `the task queue is not drained (${detail})`,
            staleVerdicts,
            queue,
            lock,
        };
    }

    return { defer: false, reason: null, staleVerdicts, queue, lock };
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

// LOGIC CHANGE 2026-09-13: State carries three hashes now, not one.
//   lastKnownCommit    - guard (b): the commit we deployed, written BEFORE exiting.
//   restartedIntoCommit- guard (c): the commit we already exited for, so a second
//                        exit for the same hash is refused.
//   failedCommit       - the remote head that failed verification. Without it, a
//                        bad commit on main is re-pulled, re-verified, reverted and
//                        re-announced to #sqtools-ops every check interval forever.
//                        A NEW remote head clears it, so the fix still deploys.
/**
 * Load state from state file
 * @returns {{ lastKnownCommit: string|null, restartedIntoCommit: string|null, failedCommit: string|null }}
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            return {
                lastKnownCommit: data.lastKnownCommit || null,
                restartedIntoCommit: data.restartedIntoCommit || null,
                failedCommit: data.failedCommit || null,
                // LOGIC CHANGE 2026-09-14: deferral bookkeeping. Durable so the
                // "deferred for Nm" figure survives an auto-update restart and
                // the escalation post is not reset to zero by one.
                deferringSince: data.deferringSince || null,
                deferNotifiedAt: data.deferNotifiedAt || null,
                deferringCommit: data.deferringCommit || null
            };
        }
    } catch (error) {
        console.error('Failed to load state file:', error.message);
    }
    return {
        lastKnownCommit: null,
        restartedIntoCommit: null,
        failedCommit: null,
        deferringSince: null,
        deferNotifiedAt: null,
        deferringCommit: null
    };
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

        // A stale lock or an orphaned queue entry is released/ignored here, and
        // that is never silent: log (in lib/task-lock.js) plus a post, every time.
        for (const verdict of deferral.staleVerdicts) {
            await deps.postToOps(`:unlock: Auto-update: ${verdict}`);
        }

        if (deferral.defer) {
            const now = Date.now();
            // The elapsed figure is per-commit. Without this, a commit deferred
            // for 90m would hand its clock to the NEXT commit, which would then
            // escalate immediately quoting an elapsed time that is not its own.
            if (state.deferringCommit !== remoteHead) {
                state.deferringCommit = remoteHead;
                state.deferringSince = now;
                state.deferNotifiedAt = null;
            }
            if (!state.deferringSince) {
                state.deferringSince = now;
            }
            const deferredForMs = now - state.deferringSince;
            const deferredMin = Math.round(deferredForMs / 60000);

            console.log(
                `Deferring update to ${remoteHead.substring(0, 7)}: ${deferral.reason}. ` +
                `Deferred for ${deferredMin}m; retrying next check interval.`
            );

            // Post on the first deferral of this update, then only once past the
            // escalation threshold, so a normal long task does not spam #sqtools-ops
            // every CHECK_INTERVAL_MS.
            const escalating = deferredForMs >= DEFER_ALERT_AFTER_MS;
            if (!state.deferNotifiedAt) {
                await deps.postToOps(
                    `:hourglass_flowing_sand: Auto-update: holding ${remoteHead.substring(0, 7)} - ${deferral.reason}. ` +
                    `Nothing has been pulled; retrying every ${Math.round(CHECK_INTERVAL_MS / 60000)}m until the task finishes.`
                );
                state.deferNotifiedAt = now;
            } else if (escalating) {
                await deps.postToOps(
                    `:warning: Auto-update: ${remoteHead.substring(0, 7)} has been deferred for ${deferredMin}m ` +
                    `(over the ${Math.round(DEFER_ALERT_AFTER_MS / 60000)}m alert threshold) - ${deferral.reason}. ` +
                    `The update is NOT being forced: killing a live task is the failure this deferral exists to ` +
                    `prevent. If no task should be running, check the lock at \`${TASK_LOCK_FILE}\` and the queue ` +
                    `at \`${TASK_QUEUE_FILE}\`.`
                );
                state.deferNotifiedAt = now;
            }

            deps.saveState(state);
            return;
        }

        // Cleared to proceed - forget any deferral history so the next one starts fresh.
        if (state.deferringSince || state.deferNotifiedAt || state.deferringCommit) {
            const heldMin = state.deferringSince ? Math.round((Date.now() - state.deferringSince) / 60000) : 0;
            console.log(`Task lock clear after ${heldMin}m of deferral; proceeding with update`);
            state.deferringSince = null;
            state.deferNotifiedAt = null;
            state.deferringCommit = null;
        }

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
        const pullResult = deps.gitPull();
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
    gitFetch,
    getLocalHead,
    getRemoteHead,
    getCommitMessage,
    gitResetHard,
    gitResetTo,
    gitPull,
    npmInstall,
    verifyEntryPoints,
    runSmokeTest,
    planRestart,
    evaluateTaskDeferral,
    // LOGIC CHANGE 2026-09-20 (drain-one): injected like everything else here so the
    // marker lifecycle is assertable without a real filesystem race.
    markUpdatePending: (opts) => updateDrain.markPending({ ...opts, markerFile: UPDATE_PENDING_FILE }),
    clearUpdatePending: (opts) => updateDrain.clear({ ...opts, markerFile: UPDATE_PENDING_FILE }),
    postToOps,
    exit: flushAndExit
};

/**
 * Log startup configuration (without secrets)
 */
function logStartupConfig() {
    console.log('=== Auto-Update Agent Starting ===');
    console.log('Configuration:');
    console.log(`  LOCAL_REPO_DIR: ${LOCAL_REPO_DIR}`);
    console.log(`  CHECK_INTERVAL_MS: ${CHECK_INTERVAL_MS} (${CHECK_INTERVAL_MS / 1000 / 60} minutes)`);
    console.log(`  STATE_FILE: ${STATE_FILE}`);
    console.log('  RESTART: process.exit(0) - container supervisor restarts us');
    console.log(`  OPS_CHANNEL_ID: ${OPS_CHANNEL_ID ? '(set)' : '(not set)'}`);
    console.log(`  SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN ? '(set)' : '(not set)'}`);
    // NEVER log actual token values
    console.log('==================================');
}

/**
 * Validate required configuration
 * @returns {boolean}
 */
function validateConfig() {
    const errors = [];

    if (!SLACK_BOT_TOKEN) {
        errors.push('SLACK_BOT_TOKEN is required');
    }
    if (!OPS_CHANNEL_ID) {
        errors.push('OPS_CHANNEL_ID is required');
    }
    if (!fs.existsSync(LOCAL_REPO_DIR)) {
        errors.push(`LOCAL_REPO_DIR does not exist: ${LOCAL_REPO_DIR}`);
    }

    if (errors.length > 0) {
        console.error('Configuration errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        return false;
    }

    return true;
}

/**
 * Main entry point
 */
async function main() {
    logStartupConfig();

    if (!validateConfig()) {
        process.exit(1);
    }

    // Load initial state
    const state = loadState();
    const currentHead = getLocalHead();

    if (currentHead) {
        console.log(`Current commit: ${currentHead.substring(0, 7)}`);
        if (state.lastKnownCommit) {
            console.log(`Last known commit from state: ${state.lastKnownCommit.substring(0, 7)}`);
        }
    }

    // Run initial check
    console.log('Running initial update check...');
    await checkForUpdates();

    // Start the polling loop
    console.log(`Starting update check loop (every ${CHECK_INTERVAL_MS / 1000} seconds)`);
    setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

// LOGIC CHANGE 2026-09-13: Only start the loop when run directly. The restart
// path now decides whether to call process.exit(0), and that decision has to be
// assertable from a test - which means the module has to be requireable without
// starting a polling daemon.
if (require.main === module) {
    main().catch(error => {
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
    gitResetTo,
    checkTaskQueue,
    evaluateTaskDeferral,
    UPDATE_PENDING_FILE,
    RESTART_EXIT_CODE,
    DEFAULT_DEPS
};
