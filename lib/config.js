/**
 * lib/config.js
 *
 * Configuration loading and validation for bridge-agent.
 * Extracts all env var handling into a centralized module.
 */

'use strict';

/**
 * Load configuration from environment variables.
 * Returns a frozen config object.
 *
 * @returns {Object} Frozen configuration object
 */
function loadConfig() {
  const config = {
    // Required
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    BRIDGE_CHANNEL: process.env.BRIDGE_CHANNEL_ID,
    OPS_CHANNEL: process.env.OPS_CHANNEL_ID,

    // Optional with defaults
    GITHUB_ORG: process.env.GITHUB_ORG || 'jtpets',
    POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
    // LOGIC CHANGE 2026-03-26: Increased MAX_TURNS default from 15 to 30 to allow
    // more complex tasks to complete without hitting the turn limit.
    // LOGIC CHANGE 2026-03-26: Increased MAX_TURNS default from 30 to 50 to give
    // more headroom for complex multi-step tasks.
    MAX_TURNS: parseInt(process.env.MAX_TURNS || '50', 10),
    TASK_TIMEOUT: parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10),
    CLAUDE_BIN: process.env.CLAUDE_BIN || '/home/jtpets/.local/bin/claude',
    WORK_DIR: process.env.WORK_DIR || '/tmp/bridge-agent',

    // Emoji constants
    EMOJI_RUNNING: 'hourglass_flowing_sand',
    EMOJI_DONE: 'robot_face',
    EMOJI_FAILED: 'x',
  };

  return Object.freeze(config);
}

/**
 * Validate required configuration values.
 * Exits the process if required values are missing.
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {void}
 */
function validate(config) {
  const missing = [];

  if (!config.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!config.BRIDGE_CHANNEL) missing.push('BRIDGE_CHANNEL_ID');
  if (!config.OPS_CHANNEL) missing.push('OPS_CHANNEL_ID');

  if (missing.length) {
    console.error(`[bridge-agent] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Validate required configuration values without exiting.
 * Returns array of missing variable names (useful for testing).
 *
 * @param {Object} config - Configuration object from loadConfig()
 * @returns {string[]} Array of missing variable names
 */
function getMissingVars(config) {
  const missing = [];

  if (!config.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
  if (!config.BRIDGE_CHANNEL) missing.push('BRIDGE_CHANNEL_ID');
  if (!config.OPS_CHANNEL) missing.push('OPS_CHANNEL_ID');

  return missing;
}

// Load config on module load
const config = loadConfig();

module.exports = {
  config,
  loadConfig,
  validate,
  getMissingVars,
};
