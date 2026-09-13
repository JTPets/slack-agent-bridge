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
const { verifyEntryPoints, planRestart } = require('./lib/update-verifier');

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
const TASK_WAIT_INTERVAL_MS = 30000; // 30 seconds between checks
const TASK_WAIT_MAX_ATTEMPTS = 10;   // Max 10 attempts = 5 minutes max wait

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
// Checks for task lock file every 30 seconds, up to 10 times (5 min max).
// This prevents interrupting a running task during auto-update.
// LOGIC CHANGE 2026-04-01: Also checks task queue for pending/running tasks.
// Queue is more reliable than lock file since it persists task state to disk.

/**
 * Check if task queue has active tasks (pending or running)
 * @returns {{ hasActive: boolean, pending: number, running: object|null }}
 */
function checkTaskQueue() {
    try {
        if (!fs.existsSync(TASK_QUEUE_FILE)) {
            return { hasActive: false, pending: 0, running: null };
        }
        const data = fs.readFileSync(TASK_QUEUE_FILE, 'utf8');
        if (!data || !data.trim()) {
            return { hasActive: false, pending: 0, running: null };
        }
        const queue = JSON.parse(data);
        if (!Array.isArray(queue)) {
            return { hasActive: false, pending: 0, running: null };
        }

        const pending = queue.filter(t => t.status === 'pending');
        const running = queue.find(t => t.status === 'running');
        const hasActive = pending.length > 0 || running != null;

        return { hasActive, pending: pending.length, running };
    } catch (err) {
        console.error('Failed to check task queue:', err.message);
        return { hasActive: false, pending: 0, running: null };
    }
}

/**
 * Wait for any running or pending task to complete
 * @returns {Promise<{ waited: boolean, attempts: number }>}
 */
async function waitForTaskCompletion() {
    let attempts = 0;

    while (attempts < TASK_WAIT_MAX_ATTEMPTS) {
        // Check both lock file and task queue for active tasks
        const lockFileExists = fs.existsSync(TASK_LOCK_FILE);
        const queueStatus = checkTaskQueue();

        // If neither indicates active tasks, proceed
        if (!lockFileExists && !queueStatus.hasActive) {
            return { waited: attempts > 0, attempts };
        }

        // Task is running or pending, wait and retry
        attempts++;

        // Build status message
        let taskInfo = '';
        if (queueStatus.running) {
            taskInfo = queueStatus.running.description || 'unknown';
            if (queueStatus.pending > 0) {
                taskInfo += ` (+${queueStatus.pending} pending)`;
            }
        } else if (lockFileExists) {
            try {
                taskInfo = fs.readFileSync(TASK_LOCK_FILE, 'utf8').split('\n')[2] || '';
            } catch {
                // Ignore read errors
            }
        } else if (queueStatus.pending > 0) {
            taskInfo = `${queueStatus.pending} pending task(s)`;
        }

        console.log(`Task active (attempt ${attempts}/${TASK_WAIT_MAX_ATTEMPTS}). Task: ${taskInfo || 'unknown'}`);

        if (attempts === 1) {
            // Notify on first wait
            const queueInfo = queueStatus.pending > 0
                ? ` (${queueStatus.pending} pending in queue)`
                : '';
            await postToOps(`:hourglass_flowing_sand: Auto-update: waiting for running task to complete before restart...${queueInfo}`);
        }

        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, TASK_WAIT_INTERVAL_MS));
    }

    // Max attempts reached, task still running
    const finalStatus = checkTaskQueue();
    console.log(`Max wait attempts (${TASK_WAIT_MAX_ATTEMPTS}) reached. Proceeding with restart.`);
    const warningMsg = finalStatus.running
        ? `:warning: Auto-update: max wait time reached. Restarting with running task: ${finalStatus.running.description || 'unknown'}`
        : `:warning: Auto-update: max wait time reached. Restarting despite possible running task.`;
    await postToOps(warningMsg);
    return { waited: true, attempts };
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
                failedCommit: data.failedCommit || null
            };
        }
    } catch (error) {
        console.error('Failed to load state file:', error.message);
    }
    return { lastKnownCommit: null, restartedIntoCommit: null, failedCommit: null };
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
            return;
        }

        // A commit that already failed verification. Silent on purpose - the
        // failure was announced once. Re-announcing every 5 minutes is how a
        // real alert becomes noise nobody reads.
        if (state.failedCommit && state.failedCommit === remoteHead) {
            console.log(`Skipping ${remoteHead.substring(0, 7)}: failed verification earlier, awaiting a newer commit`);
            return;
        }

        console.log(`Update available: ${localHead.substring(0, 7)} -> ${remoteHead.substring(0, 7)}`);

        // LOGIC CHANGE 2026-03-26: Added git reset --hard HEAD before pull to ensure any local
        // modifications (from npm install modifying package.json, or stray files) don't block the pull
        const resetResult = deps.gitResetHard();
        if (!resetResult.success) {
            console.error('Git reset failed:', resetResult.error);
            await deps.postToOps(`❌ Auto-update: git reset --hard HEAD failed - ${resetResult.error}`);
            return;
        }
        console.log('Reset local changes with git reset --hard HEAD');

        // Pull the changes
        const pullResult = deps.gitPull();
        if (!pullResult.success) {
            console.error('Git pull failed:', pullResult.error);
            await deps.postToOps(`❌ Auto-update: git pull failed - ${pullResult.error}`);
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
            return;
        }
        console.log('npm install completed successfully');

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
            return;
        }

        // LOGIC CHANGE 2026-03-27: Wait for any running task to complete before restarting.
        // Checks for task lock file every 30 seconds, up to 10 times (5 min max).
        const waitResult = await deps.waitForTaskCompletion();
        if (waitResult.waited) {
            console.log(`Waited ${waitResult.attempts} attempts for task completion`);
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
            return;
        }

        // ---- GUARD (d): notify BEFORE the exit; there is no "after" ----
        const shortHash = newHead.substring(0, 7);
        await deps.postToOps(
            `✅ Auto-update: updated to ${shortHash} - ${commitMessage}. ` +
            `npm install OK, entry points parse. Exiting now so the container supervisor restarts the bridge.`
        );
        console.log(`Successfully updated to ${shortHash}, exiting for restart`);

        await deps.exit(RESTART_EXIT_CODE);

    } catch (error) {
        console.error('Update check failed:', error.message);
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
    planRestart,
    waitForTaskCompletion,
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
    waitForTaskCompletion,
    RESTART_EXIT_CODE,
    DEFAULT_DEPS
};
