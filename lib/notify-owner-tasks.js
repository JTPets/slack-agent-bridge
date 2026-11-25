/**
 * lib/notify-owner-tasks.js
 *
 * Task result notices: a failed task (ops post plus a CRITICAL owner notice), a
 * completed task (ops only), and the task result card both post when processTask passes
 * lib/task-result.js's record.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B38): moved out of lib/notify-owner.js, which
 * re-exports it. The two copies of the 3500-character middle cut (failure text and
 * completion summary) are now one helper, truncateMiddle, with the same output.
 */

'use strict';

const { redact } = require('./redact-secrets');
const { postText, postBlocks } = require('./slack-web');
const { renderTaskResult } = require('./task-result');
const { getContext, notifyChannel, notifyOwner, PRIORITY } = require('./notify-owner-core');

// A Slack message carries at most ~4000 characters of text; past this the middle goes.
const TRUNCATE_OVER = 3500;
const TRUNCATE_KEEP = 1750;

/**
 * Keep the first and last TRUNCATE_KEEP characters of a long text, marking the cut.
 *
 * @param {string} text
 * @returns {string}
 */
function truncateMiddle(text) {
  return text.length > TRUNCATE_OVER
    ? text.slice(0, TRUNCATE_KEEP) + '\n\n... [truncated] ...\n\n' + text.slice(-TRUNCATE_KEEP)
    : text;
}

/**
 * Format and send a task failure notification.
 *
 * LOGIC CHANGE 2026-03-26: Centralizes task failure notification formatting.
 * Posts to ops channel and sends critical DM to owner.
 * LOGIC CHANGE 2026-04-01: Added llmProvider option to surface which LLM engine
 * was used when the task failed. Displays as badge in ops notification.
 *
 * @param {Object} task - Task object with description, repo, etc.
 * @param {string} task.description - Task description
 * @param {string} [task.repo] - Repository (optional)
 * @param {Error|string} error - Error object or message
 * @param {Object} [options] - Additional options
 * @param {string} [options.elapsed] - Elapsed time in seconds
 * @param {string} [options.sourceLink] - Link to source message
 * @param {string} [options.llmProvider] - LLM engine used (claude, gemini, etc.)
 * @param {object} [options.result] - lib/task-result.js record; when given, the ops post is its card
 * @returns {Promise<{ opsPosted: boolean, ownerNotified: boolean }>} Status of notifications
 */
async function taskFailed(task, error, options = {}) {
  const errorMessage = redact(error instanceof Error ? error.message : String(error));
  const elapsed = options.elapsed || 'N/A';
  const sourceLink = options.sourceLink || '';
  const llmProvider = options.llmProvider || null;

  // Format error summary (truncate for DM)
  const errorSummary = errorMessage.length > 200
    ? errorMessage.slice(0, 200) + '...'
    : errorMessage;

  // Format truncated error for ops channel
  const truncatedError = truncateMiddle(errorMessage);

  let opsPosted = false;
  let ownerNotified = false;

  // Build LLM engine badge if available
  const engineBadge = llmProvider ? ` [${llmProvider}]` : '';

  // Post to ops channel
  // LOGIC CHANGE 2026-11-12 (WORK-TODO #6): with options.result (lib/task-result.js) the
  // ops post is the result card; without it, the text below exactly as before.
  const { opsChannelId } = getContext();
  if (opsChannelId && options.result) {
    opsPosted = await postResultCard(options.result);
  } else if (opsChannelId) {
    const opsMessage =
      `:x: *Task failed*${engineBadge} (${elapsed}s)\n` +
      (sourceLink ? `Source: ${sourceLink}\n\n` : '') +
      `\`\`\`\n${truncatedError}\n\`\`\``;

    opsPosted = await notifyChannel(opsChannelId, opsMessage);
  }

  // Send critical notification to owner
  const ownerMessage = `Task failed: ${task.description || 'Unknown task'} - ${errorSummary}. Check #sqtools-ops for details.`;
  ownerNotified = await notifyOwner(ownerMessage, PRIORITY.CRITICAL);

  return { opsPosted, ownerNotified };
}

/**
 * Format and send a task completion notification.
 *
 * LOGIC CHANGE 2026-03-26: Task completions go to ops channel only (no DM).
 * Owner receives completion summaries in daily digest instead of per-task DMs.
 * LOGIC CHANGE 2026-04-01: Added llmProvider option to surface which LLM engine
 * executed the task. Displays as badge in ops notification for visibility.
 *
 * @param {Object} task - Task object with description, repo, branch, etc.
 * @param {string} summary - Completion summary (truncated output)
 * @param {Object} [options] - Additional options
 * @param {string} [options.elapsed] - Elapsed time in seconds
 * @param {string} [options.sourceLink] - Link to source message
 * @param {string} [options.llmProvider] - LLM engine used (claude, gemini, etc.)
 * @param {object} [options.result] - lib/task-result.js record; when given, the post is its card
 * @returns {Promise<boolean>} True if ops channel notification was sent
 */
async function taskCompleted(task, summary, options = {}) {
  // LOGIC CHANGE 2026-11-12 (WORK-TODO #6): processTask passes the structured result and
  // the post is the card (facts as Block Kit fields plus the same facts as `text`).
  // Still a boolean, still never throws: the caller records it as the delivery verdict.
  if (options.result) return postResultCard(options.result);
  const { opsChannelId } = getContext();
  const elapsed = options.elapsed || 'N/A';
  const sourceLink = options.sourceLink || '';
  const llmProvider = options.llmProvider || null;

  // Truncate summary if needed
  const truncatedSummary = truncateMiddle(summary);

  // Build repo label
  const repoLabel = task.repo ? `\nRepo: \`${task.repo}\` (${task.branch || 'main'})` : '';

  // Build LLM engine badge if available
  const engineBadge = llmProvider ? ` [${llmProvider}]` : '';

  const opsMessage =
    `:white_check_mark: *Task completed*${engineBadge} (${elapsed}s)\n` +
    (sourceLink ? `Source: ${sourceLink}` : '') +
    repoLabel + '\n\n' +
    `\`\`\`\n${truncatedSummary}\n\`\`\``;

  // Post to ops channel only - no owner DM for completions
  return notifyChannel(opsChannelId, opsMessage);
}

/**
 * Post a task result card (lib/task-result.js) to the ops channel. Never throws.
 *
 * @param {object} result - buildTaskResult()
 * @returns {Promise<boolean>} Whether Slack accepted it.
 */
async function postResultCard(result) {
  const { slackClient, opsChannelId } = getContext();
  if (!slackClient || !opsChannelId) {
    console.error('[notify-owner] Not initialized or no opsChannelId; task result card not posted');
    return false;
  }
  let rendered;
  try {
    rendered = renderTaskResult(result);
  } catch (err) {
    console.error('[notify-owner] Could not render the task result card:', err.message);
    return false;
  }
  if (await postBlocks(slackClient, opsChannelId, rendered, 'notify-owner')) return true;
  // A card Slack refuses (invalid_blocks, say) must not cost the result: the same facts go
  // again as plain text. Only when that also fails is the result undelivered.
  console.error('[notify-owner] Task result card refused; posting its text fallback alone');
  return postText(slackClient, opsChannelId, rendered.text, 'notify-owner');
}

module.exports = { taskFailed, taskCompleted, postResultCard, truncateMiddle };
