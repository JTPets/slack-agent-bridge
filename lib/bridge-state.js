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
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): split by file, the seam the #10 table named.
 * lib/bridge-state-poll.js owns the poll cursors and the dedup set; lib/bridge-state-workspace.js
 * owns the channel map and the activation store. This file keeps init(), which forwards
 * every option to both, and re-exports every name it exported before, so the six
 * production consumers and tests/helpers/workspace-fixture.js are unchanged.
 */

const poll = require('./bridge-state-poll');
const workspace = require('./bridge-state-workspace');

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
  workspace.setPaths(options);
  poll.init(options);
  return module.exports;
}

module.exports = {
  init,
  loadState: poll.loadState,
  saveState: poll.saveState,
  getLastChecked: poll.getLastChecked,
  setLastChecked: poll.setLastChecked,
  loadProcessedTasks: poll.loadProcessedTasks,
  saveProcessedTasks: poll.saveProcessedTasks,
  isTaskProcessed: poll.isTaskProcessed,
  markTaskProcessed: poll.markTaskProcessed,
  cleanupProcessedTasks: poll.cleanupProcessedTasks,
  // Workspace-resolved agent state.
  loadChannelMap: workspace.loadChannelMap,
  saveChannelMap: workspace.saveChannelMap,
  getChannelId: workspace.getChannelId,
  setChannelId: workspace.setChannelId,
  loadActivations: workspace.loadActivations,
  getActivation: workspace.getActivation,
  setActivation: workspace.setActivation,
  clearActivation: workspace.clearActivation,
  DEFAULT_CHANNEL_MAP_FILE: workspace.DEFAULT_CHANNEL_MAP_FILE,
  DEFAULT_ACTIVATION_FILE: workspace.DEFAULT_ACTIVATION_FILE,
};
