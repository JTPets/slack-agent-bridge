'use strict';

/**
 * lib/bridge-state.js
 *
 * File-backed state persistence for bridge-agent (seam B in
 * docs/WIRING-AND-SEAMS.md). This module is the single owner of the two
 * on-disk state files the bridge keeps between restarts:
 *
 *   .bridge-agent-state.json          — per-channel `lastChecked` poll cursors
 *   agents/shared/processed-tasks.json — task-dedup message timestamps
 *
 * The two mutable maps (`channelLastChecked`, `processedTaskTimestamps`) live
 * here and are never exported directly — callers reach them only through the
 * accessors below, so the module stays the sole writer of both files.
 *
 * LOGIC CHANGE 2026-09-14: Extracted verbatim from bridge-agent.js (the
 * "State persistence" section, seam B). Behaviour is unchanged; each moved
 * function keeps its original dated LOGIC CHANGE comment. Two deliberate
 * adjustments the move required:
 *   1. File paths are anchored to the repo root via `path.join(__dirname, '..')`
 *      because bridge-agent.js computed them from its own `__dirname` at the
 *      repo root — resolving them against `lib/` would move the files.
 *   2. `loadState`'s legacy single-channel migration needs BRIDGE_CHANNEL, which
 *      was a closure variable in bridge-agent.js. It is now supplied via init()
 *      so this module has no dependency on config/env loading. init() also
 *      accepts file-path overrides so the CRUD behaviour is testable in a temp dir.
 * Regression coverage lives in tests/bridge-state.test.js.
 */

const fs = require('fs');
const path = require('path');

// Anchored to the repo root (one level up from lib/), NOT this module's dir.
const DEFAULT_STATE_FILE = path.join(__dirname, '..', '.bridge-agent-state.json');
const DEFAULT_PROCESSED_TASKS_FILE = path.join(__dirname, '..', 'agents', 'shared', 'processed-tasks.json');

let STATE_FILE = DEFAULT_STATE_FILE;
let PROCESSED_TASKS_FILE = DEFAULT_PROCESSED_TASKS_FILE;

// Bridge channel id, used only to migrate the legacy single-channel state format.
let bridgeChannel = null;

// LOGIC CHANGE 2026-03-27: Changed from single lastChecked to per-channel lastChecked map.
// Each channel has its own timestamp to track which messages have been processed.
// Format: { channelId: timestamp, ... }
let channelLastChecked = {};

// LOGIC CHANGE 2026-03-28: Task deduplication via processed-tasks.json.
// Prevents re-processing old messages after bot restarts. Stores message timestamps
// (not IDs) to survive PM2 restarts. Gitignored, local-only file.
let processedTaskTimestamps = {};

/**
 * Initialise the module: (optionally) override file paths, record the bridge
 * channel for legacy migration, then load both files into memory.
 *
 * @param {object} [options]
 * @param {string} [options.bridgeChannel]      Bridge channel id for legacy state migration.
 * @param {string} [options.stateFile]          Override path for the poll-cursor file (tests).
 * @param {string} [options.processedTasksFile] Override path for the dedup file (tests).
 * @returns {object} module.exports (for chaining)
 */
function init(options = {}) {
  if (options.stateFile) STATE_FILE = options.stateFile;
  if (options.processedTasksFile) PROCESSED_TASKS_FILE = options.processedTasksFile;
  bridgeChannel = options.bridgeChannel || null;
  channelLastChecked = loadState();
  processedTaskTimestamps = loadProcessedTasks();
  return module.exports;
}

function loadProcessedTasks() {
  try {
    const data = fs.readFileSync(PROCESSED_TASKS_FILE, 'utf8');
    if (!data || !data.trim()) return {};
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.warn('[bridge-agent] processed-tasks.json corrupted, resetting');
    return {};
  }
}

function saveProcessedTasks() {
  try {
    const dir = path.dirname(PROCESSED_TASKS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROCESSED_TASKS_FILE, JSON.stringify(processedTaskTimestamps, null, 2), 'utf8');
  } catch (err) {
    console.error('[bridge-agent] Failed to save processed-tasks.json:', err.message);
  }
}

function isTaskProcessed(ts) {
  return Object.prototype.hasOwnProperty.call(processedTaskTimestamps, ts);
}

function markTaskProcessed(ts) {
  processedTaskTimestamps[ts] = Date.now();
  saveProcessedTasks();
}

function cleanupProcessedTasks() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [ts, processedAt] of Object.entries(processedTaskTimestamps)) {
    if (processedAt < sevenDaysAgo) {
      delete processedTaskTimestamps[ts];
      removed++;
    }
  }
  if (removed > 0) {
    saveProcessedTasks();
    console.log(`[bridge-agent] Cleaned up ${removed} old processed task entries`);
  }
}

// LOGIC CHANGE 2026-03-27: Updated loadState to support per-channel timestamps.
// Returns an object mapping channelId -> lastChecked timestamp.
// Migrates legacy single-channel format ({ lastChecked: ts }) to multi-channel format.
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Legacy format: { lastChecked: "timestamp" }
    // New format: { channels: { channelId: "timestamp", ... } }
    if (data.channels) {
      return data.channels;
    }
    // Migrate legacy format: assign old timestamp to bridge channel
    if (data.lastChecked && bridgeChannel) {
      return { [bridgeChannel]: data.lastChecked };
    }
    return {};
  } catch {
    return {};
  }
}

// LOGIC CHANGE 2026-03-27: Updated saveState to save per-channel timestamps.
// Saves the entire channelLastChecked object to disk.
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ channels: channelLastChecked }), 'utf8');
  } catch (err) {
    console.error('[bridge-agent] Failed to save state:', err.message);
  }
}

// LOGIC CHANGE 2026-03-27: Helper to get lastChecked timestamp for a channel.
// Returns '0' if channel has never been polled.
function getLastChecked(channelId) {
  return channelLastChecked[channelId] || '0';
}

// LOGIC CHANGE 2026-03-27: Helper to update lastChecked timestamp for a channel.
function setLastChecked(channelId, ts) {
  channelLastChecked[channelId] = ts;
  saveState();
}

module.exports = {
  init,
  loadState,
  saveState,
  getLastChecked,
  setLastChecked,
  loadProcessedTasks,
  saveProcessedTasks,
  isTaskProcessed,
  markTaskProcessed,
  cleanupProcessedTasks,
};
