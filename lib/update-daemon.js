'use strict';

/**
 * lib/update-daemon.js
 *
 * auto-update.js run as its own process (`node auto-update.js`): the startup log, the
 * configuration check and the polling loop. Moved out of auto-update.js unchanged on
 * 2026-11-11 (WORK-TODO #10, Wave 4). The deployment does not start it: the bridge runs
 * the same gated cycle in-process (lib/self-deploy.js). Takes the cycle and the gated
 * dependency bag as arguments so it never requires auto-update.js back.
 */

const fs = require('fs');
const { LOCAL_REPO_DIR, CHECK_INTERVAL_MS, STATE_FILE } = require('./update-config');
const { getLocalHead } = require('./update-git');
const { loadState } = require('./update-state');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const OPS_CHANNEL_ID = process.env.OPS_CHANNEL_ID;
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
 * @param {{ checkForUpdates: Function, gatedDeps: Function }} cycleFns - from auto-update.js
 */
async function main({ checkForUpdates, gatedDeps }) {
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
    // LOGIC CHANGE 2026-11-08 (WORK-TODO #17): gated, and one cycle at a time - a gate run
    // is minutes long and outlasts the interval.
    let inFlight = false;
    const cycle = async () => {
        if (inFlight) return;
        inFlight = true;
        try { await checkForUpdates(gatedDeps()); } finally { inFlight = false; }
    };
    await cycle();

    // Start the polling loop
    console.log(`Starting update check loop (every ${CHECK_INTERVAL_MS / 1000} seconds)`);
    setInterval(cycle, CHECK_INTERVAL_MS);
}

module.exports = { main, logStartupConfig, validateConfig };
