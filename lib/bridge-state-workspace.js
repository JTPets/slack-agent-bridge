'use strict';

/**
 * lib/bridge-state-workspace.js
 *
 * The workspace-resolved half of an agent definition: agents/shared/channel-map.json
 * (channel NAME -> this workspace's Slack id) and agents/shared/agent-activation.json
 * (which agents this workspace turned on). Both are read on demand rather than cached,
 * because an operator or another process may edit them between polls.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved verbatim out of lib/bridge-state.js,
 * which re-exports every function here and forwards its init() path overrides to
 * setPaths() below.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CHANNEL_MAP_FILE = path.join(__dirname, '..', 'agents', 'shared', 'channel-map.json');
const DEFAULT_ACTIVATION_FILE = path.join(__dirname, '..', 'agents', 'shared', 'agent-activation.json');

let CHANNEL_MAP_FILE = DEFAULT_CHANNEL_MAP_FILE;
let ACTIVATION_FILE = DEFAULT_ACTIVATION_FILE;

/**
 * Override the two file paths (tests). Called by lib/bridge-state.js init().
 *
 * @param {object} [options]
 * @param {string} [options.channelMapFile]
 * @param {string} [options.activationFile]
 */
function setPaths(options = {}) {
  if (options.channelMapFile) CHANNEL_MAP_FILE = options.channelMapFile;
  if (options.activationFile) ACTIVATION_FILE = options.activationFile;
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
  setPaths,
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
