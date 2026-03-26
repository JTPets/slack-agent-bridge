#!/usr/bin/env node
// auto-update.js - Auto-update agent for bridge-agent
// Polls git for changes and restarts PM2 process when updates are available

const { WebClient } = require('@slack/web-api');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration from environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
const LOCAL_REPO_DIR = process.env.LOCAL_REPO_DIR || '/home/jtpets/jt-agent';
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 minutes default
const STATE_FILE = process.env.STATE_FILE || path.join(LOCAL_REPO_DIR, '.auto-update-state.json');
const PM2_PROCESS_NAME = process.env.PM2_PROCESS_NAME || 'bridge-agent';

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

// LOGIC CHANGE 2026-03-26: Added package-lock.json removal before pull since it's gitignored
// but npm install recreates it locally, which can cause merge conflicts
/**
 * Remove package-lock.json if it exists (it's gitignored but npm install creates it)
 * @returns {{ success: boolean, error?: string }}
 */
function removePackageLock() {
    const lockFile = path.join(LOCAL_REPO_DIR, 'package-lock.json');
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            console.log('Removed package-lock.json');
        }
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
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

/**
 * Restart PM2 process
 * @returns {{ success: boolean, error?: string }}
 */
function restartPM2() {
    const result = spawnSync('pm2', ['restart', PM2_PROCESS_NAME], {
        encoding: 'utf8',
        timeout: 30000
    });

    return {
        success: result.status === 0,
        error: result.status === 0 ? undefined : (result.stderr || result.stdout || 'Unknown PM2 error').trim()
    };
}

/**
 * Load state from state file
 * @returns {{ lastKnownCommit: string|null }}
 */
function loadState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
            return { lastKnownCommit: data.lastKnownCommit || null };
        }
    } catch (error) {
        console.error('Failed to load state file:', error.message);
    }
    return { lastKnownCommit: null };
}

/**
 * Save state to state file
 * @param {{ lastKnownCommit: string }} state
 */
function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
        console.error('Failed to save state file:', error.message);
    }
}

/**
 * Main update check routine
 */
async function checkForUpdates() {
    let state = loadState();

    try {
        // LOGIC CHANGE 2026-03-26: Fetch before comparing to ensure we have latest remote refs
        const fetchResult = gitFetch();
        if (!fetchResult.success) {
            console.error('Git fetch failed:', fetchResult.error);
            await postToOps(`❌ Auto-update: git fetch failed - ${fetchResult.error}`);
            return;
        }

        const localHead = getLocalHead();
        const remoteHead = getRemoteHead();

        if (!localHead || !remoteHead) {
            console.error('Failed to get commit hashes');
            await postToOps('❌ Auto-update: Failed to get commit hashes');
            return;
        }

        // No update needed
        if (localHead === remoteHead) {
            console.log(`No updates available. Current: ${localHead.substring(0, 7)}`);
            return;
        }

        console.log(`Update available: ${localHead.substring(0, 7)} -> ${remoteHead.substring(0, 7)}`);

        // LOGIC CHANGE 2026-03-26: Added git reset --hard HEAD before pull to ensure any local
        // modifications (from npm install modifying package.json, or stray files) don't block the pull
        const resetResult = gitResetHard();
        if (!resetResult.success) {
            console.error('Git reset failed:', resetResult.error);
            await postToOps(`❌ Auto-update: git reset --hard HEAD failed - ${resetResult.error}`);
            return;
        }
        console.log('Reset local changes with git reset --hard HEAD');

        // LOGIC CHANGE 2026-03-26: Remove package-lock.json before pull since it's gitignored
        // but npm install recreates it locally, which can cause issues
        const removeLockResult = removePackageLock();
        if (!removeLockResult.success) {
            console.error('Failed to remove package-lock.json:', removeLockResult.error);
            // Non-fatal - continue with pull
        }

        // Pull the changes
        const pullResult = gitPull();
        if (!pullResult.success) {
            console.error('Git pull failed:', pullResult.error);
            await postToOps(`❌ Auto-update: git pull failed - ${pullResult.error}`);
            return;
        }

        // LOGIC CHANGE 2026-03-26: Run npm install after pull so new dependencies get installed
        // automatically when the repo is updated
        console.log('Running npm install...');
        const npmResult = npmInstall();
        if (!npmResult.success) {
            console.error('npm install failed:', npmResult.error);
            await postToOps(`❌ Auto-update: npm install failed after pull - ${npmResult.error}`);
            return;
        }
        console.log('npm install completed successfully');

        // Get the new commit info
        const newHead = getLocalHead();
        const commitMessage = getCommitMessage(newHead);

        // Restart PM2 process
        const restartResult = restartPM2();
        if (!restartResult.success) {
            console.error('PM2 restart failed:', restartResult.error);
            await postToOps(`❌ Auto-update: PM2 restart failed after pull - ${restartResult.error}`);
            return;
        }

        // Success - update state and notify
        state.lastKnownCommit = newHead;
        saveState(state);

        const shortHash = newHead.substring(0, 7);
        await postToOps(`✅ Auto-update: bridge-agent updated to ${shortHash} - ${commitMessage}. npm install + PM2 restarted.`);
        console.log(`Successfully updated to ${shortHash}`);

    } catch (error) {
        console.error('Update check failed:', error.message);
        await postToOps(`❌ Auto-update: Unexpected error - ${error.message}`);
    }
}

/**
 * Log startup configuration (without secrets)
 */
function logStartupConfig() {
    console.log('=== Auto-Update Agent Starting ===');
    console.log('Configuration:');
    console.log(`  LOCAL_REPO_DIR: ${LOCAL_REPO_DIR}`);
    console.log(`  CHECK_INTERVAL_MS: ${CHECK_INTERVAL_MS} (${CHECK_INTERVAL_MS / 1000 / 60} minutes)`);
    console.log(`  STATE_FILE: ${STATE_FILE}`);
    console.log(`  PM2_PROCESS_NAME: ${PM2_PROCESS_NAME}`);
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

// Start the agent
main().catch(error => {
    console.error('Fatal error:', error.message);
    process.exit(1);
});
