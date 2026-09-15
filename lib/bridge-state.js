'use strict';

/**
 * lib/bridge-state.js
 *
 * File-backed state persistence for bridge-agent (seam B in
 * docs/WIRING-AND-SEAMS.md). This module is the single owner of the
 * on-disk state files the bridge keeps between restarts:
 *
 *   .bridge-agent-state.json            — per-channel `lastChecked` poll cursors
 *   agents/shared/processed-tasks.json   — task-dedup message timestamps
 *   agents/shared/channel-map.json       — channel NAME -> resolved Slack id
 *   agents/shared/agent-activation.json  — which agents this workspace has activated
 *
 * The two in-memory maps (`channelLastChecked`, `processedTaskTimestamps`) live
 * here and are never exported directly — callers reach them only through the
 * accessors below, so the module stays the sole writer of those two files. The
 * other two stores are read on demand rather than cached, because an operator or
 * another process may edit them between polls.
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
 *
 * LOGIC CHANGE 2026-09-15: This module took ownership of the WORKSPACE-RESOLVED half
 * of an agent definition, because agent definitions moved to tracked markdown
 * (lib/agent-markdown.js) and a tracked file may not carry a Slack channel id.
 *
 *   - `channel-map.json` was already exactly the right store — a durable, gitignored
 *     channel-name -> id cache — and was written only by `ensureChannel()` in
 *     lib/slack-client.js, which the boot path never calls. The two functions moved
 *     here verbatim so all durable state has one owner; lib/slack-client.js
 *     re-exports them, so every existing caller and test is unchanged. This EXTENDS
 *     the existing mechanism rather than adding a third store beside two that work.
 *   - `agent-activation.json` is new, and is the one genuinely new fact: a tracked
 *     definition declares its `default_status`, and this file records the decision
 *     THIS workspace made. It is gitignored, so an activation survives both a
 *     restart and auto-update's `git reset --hard HEAD` + pull — which is precisely
 *     what a `status` field in a tracked file did not.
 */

const fs = require('fs');
const path = require('path');

// Anchored to the repo root (one level up from lib/), NOT this module's dir.
const DEFAULT_STATE_FILE = path.join(__dirname, '..', '.bridge-agent-state.json');
const DEFAULT_PROCESSED_TASKS_FILE = path.join(__dirname, '..', 'agents', 'shared', 'processed-tasks.json');
const DEFAULT_CHANNEL_MAP_FILE = path.join(__dirname, '..', 'agents', 'shared', 'channel-map.json');
const DEFAULT_ACTIVATION_FILE = path.join(__dirname, '..', 'agents', 'shared', 'agent-activation.json');

let STATE_FILE = DEFAULT_STATE_FILE;
let PROCESSED_TASKS_FILE = DEFAULT_PROCESSED_TASKS_FILE;
let CHANNEL_MAP_FILE = DEFAULT_CHANNEL_MAP_FILE;
let ACTIVATION_FILE = DEFAULT_ACTIVATION_FILE;

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
 * Initialise the module: (optionally) override file paths, record the bridge
 * channel for legacy migration, then load both files into memory.
 *
 * @param {object} [options]
 * @param {string} [options.bridgeChannel]      Bridge channel id for legacy state migration.
 * @param {string} [options.stateFile]          Override path for the poll-cursor file (tests).
 * @param {string} [options.processedTasksFile] Override path for the dedup file (tests).
 * @param {string} [options.channelMapFile]     Override path for the channel map (tests).
 * @param {string} [options.activationFile]     Override path for the activation store (tests).
 * @returns {object} module.exports (for chaining)
 */
function init(options = {}) {
  if (options.stateFile) STATE_FILE = options.stateFile;
  if (options.processedTasksFile) PROCESSED_TASKS_FILE = options.processedTasksFile;
  if (options.channelMapFile) CHANNEL_MAP_FILE = options.channelMapFile;
  if (options.activationFile) ACTIVATION_FILE = options.activationFile;
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


// ---------------------------------------------------------------------------
// Workspace-resolved agent state: channel ids and activation.
//
// Both files are gitignored. That is the point, not an implementation detail: a
// live edit to a TRACKED file has been destroyed twice by auto-update's
// `git reset --hard HEAD`, and a channel id is meaningless in anyone else's
// workspace. `git reset --hard` and `git clean -fd` (without -x) both leave an
// ignored file alone, so what is written here survives a pull.
// ---------------------------------------------------------------------------

/**
 * Read a JSON object file, self-healing on corruption. Shared by the two stores
 * below so they cannot drift in how they treat a damaged file.
 *
 * @param {string} file
 * @param {string} label - For the warning line.
 * @returns {object} `{}` when absent, empty, corrupt, or not a plain object.
 */
function loadJsonObject(file, label) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (typeof data !== 'string' || !data.trim()) return {};
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[bridge-state] ${label} has unexpected format, resetting to {}`);
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.warn(`[bridge-state] Corrupted ${label}: ${err.message}. Resetting to {}.`);
    return {};
  }
}

/**
 * Write a JSON object file, creating its directory. Never throws — a state write
 * that fails must not take a task down with it; it is logged instead.
 *
 * @param {string} file
 * @param {object} obj
 * @param {string} label
 * @returns {boolean} Whether the write landed.
 */
function saveJsonObject(file, obj, label) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`[bridge-state] Failed to save ${label}: ${err.message}`);
    return false;
  }
}

/**
 * The channel-name -> Slack-id map for this workspace.
 * @returns {Object<string,string>}
 */
function loadChannelMap() {
  return loadJsonObject(CHANNEL_MAP_FILE, 'channel-map.json');
}

/**
 * @param {Object<string,string>} map
 */
function saveChannelMap(map) {
  saveJsonObject(CHANNEL_MAP_FILE, map, 'channel-map.json');
}

/**
 * Look up one resolved channel id by channel name.
 *
 * @param {string} name - Channel name, without a leading '#'.
 * @returns {string|null}
 */
function getChannelId(name) {
  if (!name) return null;
  const id = loadChannelMap()[String(name).replace(/^#/, '')];
  return id || null;
}

/**
 * Record a resolved channel id. Idempotent; returns whether anything changed, so a
 * caller can report "resolved" separately from "already known".
 *
 * @param {string} name
 * @param {string} channelId
 * @returns {boolean} True if the mapping was added or changed.
 */
function setChannelId(name, channelId) {
  if (!name || !channelId) return false;
  const key = String(name).replace(/^#/, '');
  const map = loadChannelMap();
  if (map[key] === channelId) return false;
  map[key] = channelId;
  saveChannelMap(map);
  return true;
}

/**
 * The activation decisions this workspace has made.
 * Shape: { "<agentId>": { activated: boolean, at: ISO string, by?: string } }
 *
 * @returns {object}
 */
function loadActivations() {
  return loadJsonObject(ACTIVATION_FILE, 'agent-activation.json');
}

/**
 * Has this workspace overridden an agent's declared default status?
 *
 * Three-valued on purpose. `null` means "no local decision, use the definition's
 * `default_status`" and is NOT the same as an explicit false — a deactivation must
 * be distinguishable from never having been touched, or re-running a migration
 * would silently re-activate something an operator turned off.
 *
 * @param {string} agentId
 * @returns {boolean|null}
 */
function getActivation(agentId) {
  const entry = loadActivations()[agentId];
  if (!entry || typeof entry.activated !== 'boolean') return null;
  return entry.activated;
}

/**
 * Record an activation decision.
 *
 * @param {string} agentId
 * @param {boolean} activated
 * @param {object} [meta] - Free-form provenance, e.g. { by: 'U123', channel: 'C1' }.
 * @returns {object} The stored entry.
 */
function setActivation(agentId, activated, meta = {}) {
  const all = loadActivations();
  all[agentId] = { ...meta, activated: Boolean(activated), at: new Date().toISOString() };
  saveJsonObject(ACTIVATION_FILE, all, 'agent-activation.json');
  return all[agentId];
}

/**
 * Forget a local decision, so the definition's `default_status` governs again.
 *
 * @param {string} agentId
 * @returns {boolean} Whether an entry was removed.
 */
function clearActivation(agentId) {
  const all = loadActivations();
  if (!Object.prototype.hasOwnProperty.call(all, agentId)) return false;
  delete all[agentId];
  saveJsonObject(ACTIVATION_FILE, all, 'agent-activation.json');
  return true;
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
  // Workspace-resolved agent state.
  loadChannelMap,
  saveChannelMap,
  getChannelId,
  setChannelId,
  loadActivations,
  getActivation,
  setActivation,
  clearActivation,
  DEFAULT_CHANNEL_MAP_FILE,
  DEFAULT_ACTIVATION_FILE,
};
