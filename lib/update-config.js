'use strict';

/**
 * lib/update-config.js
 *
 * The self-update loop's configuration, read from the environment ONCE, at load.
 * Moved out of auto-update.js on 2026-11-11 (WORK-TODO #10, Wave 4) so the git, state,
 * deferral and apply modules read one copy instead of each re-deriving a path. Every
 * value here is exactly what auto-update.js computed before the split; auto-update.js
 * re-exports the ones it exported.
 *
 * Read at load on purpose: tests/auto-update-defer.test.js sets WORK_DIR before the
 * first require, and jest gives each suite a fresh module registry.
 */

const path = require('path');
const updateDrain = require('./update-drain');

// NOTE 2026-09-13: the old default was the dead Raspberry Pi path.
// LOGIC CHANGE 2026-11-08 (WORK-TODO #17): the default is the checkout auto-update.js is
// in. auto-update.js lives at the root of the repository it updates, so that directory
// is the repository wherever it is mounted (/bridge in the jt-agent container).
// LOGIC CHANGE 2026-11-11 (WORK-TODO #10): this file is one level below that root, so
// the same directory is `path.resolve(__dirname, '..')` here.
const LOCAL_REPO_DIR = process.env.LOCAL_REPO_DIR || path.resolve(__dirname, '..');
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 5 * 60 * 1000; // 5 minutes default
const STATE_FILE = process.env.STATE_FILE || path.join(LOCAL_REPO_DIR, '.auto-update-state.json');

// A clean, intentional restart - not a crash. The supervisor restarts on any
// exit code; 0 is what distinguishes "I updated myself" from "I fell over" in
// `docker compose ps` and in the container's exit history.
const RESTART_EXIT_CODE = 0;

// LOGIC CHANGE 2026-03-27 / 2026-04-01: the task lock and the task queue, the two files
// that say whether a task is running. Same WORK_DIR as bridge-agent.js.
const WORK_DIR = process.env.WORK_DIR || '/tmp/bridge-agent';
const TASK_LOCK_FILE = path.join(WORK_DIR, '.task-running');
const TASK_QUEUE_FILE = path.join(WORK_DIR, 'task-queue.json');
// LOGIC CHANGE 2026-09-20 (drain-one): the pending-update marker bridge-agent.js
// reads to decide whether to refuse a new dispatch. Owned by lib/update-drain.js;
// this file only names the path.
const UPDATE_PENDING_FILE = updateDrain.DEFAULT_MARKER_FILE;

// LOGIC CHANGE 2026-09-14: a deferral has no ceiling, so it is bounded by visibility:
// once one update has been deferred this long, every cycle escalates to #sqtools-ops.
const DEFER_ALERT_AFTER_MS = parseInt(process.env.UPDATE_DEFER_ALERT_MS, 10) || 60 * 60 * 1000;

module.exports = {
    LOCAL_REPO_DIR,
    CHECK_INTERVAL_MS,
    STATE_FILE,
    RESTART_EXIT_CODE,
    WORK_DIR,
    TASK_LOCK_FILE,
    TASK_QUEUE_FILE,
    UPDATE_PENDING_FILE,
    DEFER_ALERT_AFTER_MS,
};
