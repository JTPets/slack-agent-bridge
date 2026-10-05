'use strict';

/**
 * lib/bridge-state-poll.js
 *
 * The poll loop's own state: per-channel `lastChecked` cursors in
 * .bridge-agent-state.json (with the legacy single-channel migration) and the
 * task-dedup timestamps in agents/shared/processed-tasks.json. Both are held in
 * memory and written through on every change; nothing outside this module touches
 * the two maps.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of lib/bridge-state.js,
 * which re-exports every function here and forwards its init() options to init()
 * below. Paths are still anchored to the repo root via `path.join(__dirname, '..')`.
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
// (not IDs) so the dedup set survives a restart. Gitignored, local-only file.
// LOGIC CHANGE 2026-09-14: "PM2 restarts" -> "a restart". There is no pm2 here.
let processedTaskTimestamps = {};

/**
 * Override the two file paths (tests), record the bridge channel for the legacy
 * migration, then load both files into memory. Called by lib/bridge-state.js init().
 *
 * @param {object} [options] - See lib/bridge-state.js init().
 */
function init(options = {}) {
  if (options.stateFile) STATE_FILE = options.stateFile;
  if (options.processedTasksFile) PROCESSED_TASKS_FILE = options.processedTasksFile;
  bridgeChannel = options.bridgeChannel || null;
  channelLastChecked = loadState();
  processedTaskTimestamps = loadProcessedTasks();
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
