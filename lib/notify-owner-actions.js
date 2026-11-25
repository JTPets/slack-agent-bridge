/**
 * lib/notify-owner-actions.js
 *
 * ACTION REQUIRED items: recorded on an agent's activation checklist and sent to the
 * owner as a HIGH notice (the digest), either given directly or found in task output.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved unchanged out of
 * lib/notify-owner.js, which re-exports it.
 */

'use strict';

const { addTask: addOwnerTask, extractActionRequired } = require('./owner-tasks');
const { notifyOwner, PRIORITY } = require('./notify-owner-core');

/**
 * Format and send an ACTION REQUIRED notification.
 *
 * LOGIC CHANGE 2026-03-26: Auto-extracts and logs ACTION REQUIRED items.
 * Adds to agent's activation checklist and optionally notifies owner.
 *
 * @param {Object} task - Task object (for context)
 * @param {string} action - Action item text
 * @param {Object} [options] - Additional options
 * @param {string} [options.agentId='bridge'] - Agent ID to add task to
 * @param {string} [options.priority='high'] - Task priority
 * @returns {Promise<{ added: boolean, notified: boolean }>} Status of action
 */
async function actionRequired(task, action, options = {}) {
  const agentId = options.agentId || 'bridge';
  const priority = options.priority || 'high';

  // Add to activation checklist
  let added = false;
  try {
    added = addOwnerTask(agentId, action, priority);
    if (added) {
      console.log(`[notify-owner] Added ACTION REQUIRED to ${agentId} checklist: ${action}`);
    }
  } catch (err) {
    console.error('[notify-owner] Failed to add ACTION REQUIRED:', err.message);
  }

  // High priority notifications go to digest, not immediate DM
  const notified = await notifyOwner(
    `ACTION REQUIRED: ${action}`,
    PRIORITY.HIGH
  );

  return { added, notified };
}

/**
 * Process task output for ACTION REQUIRED items.
 *
 * LOGIC CHANGE 2026-03-26: Scans output for ACTION REQUIRED patterns and
 * automatically logs them to activation checklists.
 *
 * @param {string} output - Task output text to scan
 * @param {Object} [options] - Options
 * @param {string} [options.agentId='bridge'] - Agent ID for checklist
 * @returns {Promise<{ found: boolean, action: string | null, added: boolean }>} Result
 */
async function processActionRequired(output, options = {}) {
  const agentId = options.agentId || 'bridge';

  const action = extractActionRequired(output);
  if (!action) {
    return { found: false, action: null, added: false };
  }

  const result = await actionRequired({}, action, { agentId, priority: 'high' });
  return { found: true, action, added: result.added };
}

module.exports = { actionRequired, processActionRequired };
