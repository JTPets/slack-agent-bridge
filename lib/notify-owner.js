/**
 * lib/notify-owner.js
 *
 * Centralized notification layer for owner-facing communications.
 * When secretary agent is active, routes notifications through its channel.
 * Falls back to direct DM when secretary is not active.
 *
 * LOGIC CHANGE 2026-03-26: Initial implementation of notification abstraction layer.
 * All owner notifications should go through this module instead of direct Slack calls.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): the hub. Every name it exported is still
 * exported here, as the same function object (tests/module-splits.test.js), from the
 * module that now holds it:
 *
 *   lib/notify-owner-core.js        init, PRIORITY, notifyChannel, notifyOps, notifyOwner,
 *                                   getSecretaryStatus: the state and the routing
 *   lib/notify-owner-tasks.js       taskFailed, taskCompleted (and the result card)
 *   lib/notify-owner-actions.js     actionRequired, processActionRequired
 *   lib/notify-owner-rate-limit.js  rateLimitHit, rateLimitCleared
 *
 * Callers keep requiring this file; docs/CANONICAL-HELPERS.md names it as the one path
 * for owner and ops notices.
 */

'use strict';

const core = require('./notify-owner-core');
const tasks = require('./notify-owner-tasks');
const actions = require('./notify-owner-actions');
const rateLimit = require('./notify-owner-rate-limit');

module.exports = {
  // Initialization
  init: core.init,

  // Priority constants
  PRIORITY: core.PRIORITY,

  // Core notification functions
  notifyOwner: core.notifyOwner,
  notifyChannel: core.notifyChannel,
  notifyOps: core.notifyOps,

  // Task notifications
  taskFailed: tasks.taskFailed,
  taskCompleted: tasks.taskCompleted,
  actionRequired: actions.actionRequired,
  processActionRequired: actions.processActionRequired,

  // Rate limit notifications
  rateLimitHit: rateLimit.rateLimitHit,
  rateLimitCleared: rateLimit.rateLimitCleared,

  // Internal helpers (exported for testing)
  getSecretaryStatus: core.getSecretaryStatus,
};
