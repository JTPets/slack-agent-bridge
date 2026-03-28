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

    // LOGIC CHANGE 2026-03-27: Added STORE_TASKS_CHANNEL for staff task management.
    // Slack channel where daily staff tasks are posted and tracked.
    STORE_TASKS_CHANNEL: process.env.STORE_TASKS_CHANNEL_ID || null,

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

    // LOGIC CHANGE 2026-03-26: Added ALLOWED_USER_IDS to restrict which Slack users
    // can submit TASK: and ASK: messages. Comma-separated list of Slack user IDs.
    // Default is U02QKNHHU7J (John Alexander). Messages from other users are ignored.
    ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || 'U02QKNHHU7J')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean),

    // Emoji constants
    EMOJI_RUNNING: 'hourglass_flowing_sand',
    EMOJI_DONE: 'robot_face',
    EMOJI_FAILED: 'x',

    // LOGIC CHANGE 2026-03-27: Added CLAUDE_RATE_LIMIT_PAUSE env var for initial
    // rate limit pause duration in milliseconds. Default: 1800000 (30 minutes).
    // Owner can tune this based on their API quota cycle.
    RATE_LIMIT_PAUSE_MS: parseInt(process.env.CLAUDE_RATE_LIMIT_PAUSE || '1800000', 10),
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

/**
 * Check if a user ID is authorized to submit tasks.
 * LOGIC CHANGE 2026-03-26: Added isUserAuthorized to check if a message sender
 * is in the ALLOWED_USER_IDS list. Unauthorized users are logged and skipped.
 *
 * @param {string} userId - Slack user ID to check
 * @param {string[]} [allowedIds] - Array of allowed user IDs (defaults to config.ALLOWED_USER_IDS)
 * @returns {boolean} True if user is authorized
 */
function isUserAuthorized(userId, allowedIds = config.ALLOWED_USER_IDS) {
  return allowedIds.includes(userId);
}

/**
 * Get Google OAuth refresh token from environment.
 * LOGIC CHANGE 2026-03-28: Added GOOGLE_REFRESH_TOKEN as alias for
 * GOOGLE_CALENDAR_REFRESH_TOKEN. Same token covers both Gmail and Calendar.
 *
 * @returns {string|undefined} Refresh token or undefined if not configured
 */
function getGoogleRefreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
}

/**
 * Check if Google OAuth credentials are configured.
 * LOGIC CHANGE 2026-03-28: Added hasGoogleOAuthCredentials to check if
 * OAuth credentials are available for Google API access.
 *
 * @returns {boolean} True if OAuth credentials are configured
 */
function hasGoogleOAuthCredentials() {
  return !!(
    getGoogleRefreshToken() &&
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET
  );
}

module.exports = {
  config,
  loadConfig,
  validate,
  getMissingVars,
  isUserAuthorized,
  getGoogleRefreshToken,
  hasGoogleOAuthCredentials,
};
