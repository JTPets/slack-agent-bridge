'use strict';

/**
 * lib/dispatch-command.js
 *
 * The COMMAND half of the slash-command dispatch path: the two handlers that attach
 * at the seam marked THE COMMAND SEAM in lib/slack-socket.js. The form they open is
 * lib/dispatch-modal.js; the generator they feed is lib/dispatch-message.js.
 *
 * LOGIC CHANGE 2026-09-15: New file. Parts one and four of the change described in
 * docs/WIRING-AND-SEAMS.md section 7 ("What the NEXT change has to do", steps 2, 5
 * and 6).
 *
 * WHERE THE TASK ENTERS THE PIPELINE - the decision step 6 of that section asks for,
 * stated: the form composes a well-formed task message and POSTS IT AS A MESSAGE.
 * poll() picks it up like any other message. It does NOT call processTask.
 * One intake path, one owner of deduplication (lib/bridge-state.js, by message ts),
 * one task that survives a restart because it exists as a message.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #46): the post goes to the channel /dispatch was
 * INVOKED in, when the poll loop watches it, so the task runs as that channel's agent
 * (the routing #38 made real). A channel nothing polls is REFUSED in the form - never
 * redirected to the bridge channel, which would be a silent downgrade of where the
 * operator asked it to run, and never posted where nothing would read it.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #4, the cheap half): after a successful post the
 * caller's onDispatched hook runs, which bridge-agent.js uses to start one poll now
 * instead of waiting up to POLL_INTERVAL_MS. It runs after the ack and cannot fail it.
 *
 * AUTHORISATION IS THIS MODULE'S, NOT THE POLL LOOP'S. The poll loop's allowlist
 * check is `!isUserAuthorized(msg.user) && !isBotMessage` (bridge-agent.js) - a
 * message posted AS THE BOT bypasses it, deliberately, so scheduled tasks are not
 * dropped. Our post is a bot post. So the gate here is the only gate, and it must
 * run before anything is posted. It calls the SAME isUserAuthorized from
 * lib/config.js that the poll loop calls; this is a second call site, not a second
 * check, and it is checked again on submission because a view_submission arrives as
 * its own envelope rather than as a continuation of the command.
 *
 * THE THREE-SECOND RULE. Slack expires a command's `trigger_id` and its
 * acknowledgement window at about three seconds; a late ack shows the operator a
 * timeout with no trace of the cause. So: ack first, open the modal after. On
 * submission the order is inverted deliberately - see handleViewSubmission.
 *
 * NEITHER HANDLER EVER REJECTS. Both are reached from an EventEmitter callback in
 * lib/slack-socket.js, whose additivity contract is that this connection can never
 * kill the bridge. Every failure resolves to a reason and is reported.
 */

const {
  COMMAND_NAME,
  CALLBACK_ID,
  BLOCK_IDS,
  buildModalView,
  readPrivateMetadata,
  extractSubmission,
  toSlackErrors,
} = require('./dispatch-modal');

const { composeDispatchMessage } = require('./dispatch-message');
const { resolveDispatchTarget, raceWithTimeout } = require('./dispatch-delivery');

// How long the channel post may take before the submission acknowledgement must go
// out regardless. Slack expires a view_submission ack at about three seconds; this
// leaves headroom for the ack itself.
const SUBMIT_POST_TIMEOUT_MS = 2500;

/** Acknowledge at most once, and never let an ack failure throw into the socket. */
function ackOnce(ack, logger) {
  let used = false;
  return async (payload) => {
    if (used) return false;
    used = true;
    try {
      await (payload === undefined ? ack() : ack(payload));
      return true;
    } catch (err) {
      logger.error(`[dispatch] Failed to acknowledge: ${err.message}`);
      return false;
    }
  };
}


/**
 * PART ONE - the slash command. Attaches at THE COMMAND SEAM in lib/slack-socket.js.
 *
 * Acknowledge first, open the modal after. Slack gives about three seconds for both
 * the ack and the trigger_id; an ack that arrives late shows the operator "operation
 * timed out" with no trace of the cause anywhere, which is the failure mode this
 * ordering exists to avoid. Nothing slow happens before the ack.
 *
 * @param {{ ack: Function, body: object }} envelope - From the socket.
 * @param {object} deps - `openView({ trigger_id, view })`, `isAuthorized(userId)`,
 *   `notify(text)` (operational escalation), `postEphemeral({channel,user,text})`,
 *   `logger`.
 * @returns {Promise<{opened: boolean, reason: string}>} Never rejects.
 */
async function handleSlashCommand({ ack, body }, deps = {}) {
  const { openView, isAuthorized, logger = console } = deps;
  const notify = deps.notify || (async () => {});
  const postEphemeral = deps.postEphemeral || null;
  const acknowledge = ackOnce(ack, logger);

  const userId = (body && body.user_id) || '';
  const channelId = (body && body.channel_id) || '';
  const triggerId = (body && body.trigger_id) || '';

  // The allowlist, via the SAME lib/config.js isUserAuthorized the poll loop uses.
  // It must run here because our post is a bot post, and the poll loop lets a bot
  // post through without an allowlist check (bridge-agent.js, deliberately, so
  // scheduled tasks are not dropped). There is no second gate after this one.
  if (!isAuthorized(userId)) {
    logger.warn(`[dispatch] Refusing ${COMMAND_NAME} from unauthorized user: ${userId}`);
    await acknowledge({
      response_type: 'ephemeral',
      text: 'You are not on the bridge allowlist (ALLOWED_USER_IDS), so this command is not available to you.',
    });
    return { opened: false, reason: 'unauthorized' };
  }

  if (!triggerId) {
    await acknowledge({
      response_type: 'ephemeral',
      text: 'Slack sent no trigger_id, so the form cannot be opened. Try the command again.',
    });
    return { opened: false, reason: 'no_trigger_id' };
  }

  // The ack itself: empty, so nothing is echoed into the channel.
  await acknowledge();

  try {
    await openView({ trigger_id: triggerId, view: buildModalView({ channelId, userId }) });
    return { opened: true, reason: 'ok' };
  } catch (err) {
    // PART FOUR: a command that fails AFTER the ack looks to the operator exactly
    // like one that worked - the ack already went out and no form appeared. It has
    // to reach them some other way, and it has to reach a human either way.
    const detail = `Could not open the dispatch form: ${err.message}`;
    logger.error(`[dispatch] ${detail}`);
    if (postEphemeral) {
      try {
        await postEphemeral({
          channel: channelId,
          user: userId,
          text: `:x: ${detail}\nNothing was dispatched. Posting a TASK: message by hand still works.`,
        });
      } catch (ephemeralErr) {
        logger.error(`[dispatch] Could not reach the operator either: ${ephemeralErr.message}`);
      }
    }
    await notify(`:x: *${COMMAND_NAME}:* ${detail} Nothing was dispatched.`);
    return { opened: false, reason: 'open_failed' };
  }
}

/**
 * PARTS TWO AND FOUR - the form comes back.
 *
 * WHY THE POST HAPPENS BEFORE THE ACK, the inverse of the command path. Acking a
 * view_submission with `{}` CLOSES the modal; once it is closed the operator's five
 * typed inputs are gone and there is nowhere left to report a failure. So the post
 * is attempted first and bounded by SUBMIT_POST_TIMEOUT_MS, and the ack is chosen
 * from the outcome:
 *
 *   posted   -> ack {}                     the modal closes, poll() takes it from here
 *   rejected -> ack response_action errors  the modal STAYS OPEN, the reason is on the
 *                                           offending input, nothing typed is lost
 *   failed   -> ack response_action errors  same, naming the Slack failure
 *   timeout  -> ack response_action errors  same, but stating the outcome is UNKNOWN
 *
 * The timeout case never claims the post failed. It may well have landed, and a
 * confident "failed" would invite a resubmission that dispatches the task twice -
 * dedup is by message ts, so two posts are two tasks.
 *
 * @param {{ ack: Function, body: object }} envelope
 * @param {object} deps - `postMessage({channel,text})`, `isAuthorized(userId)`,
 *   `watchedChannels()` (the poll set: [{channelId, agentId}]), `onDispatched(target)`,
 *   `notify(text)`, `logger`, `githubOrg`, `postTimeoutMs`.
 * @returns {Promise<{posted: boolean, reason: string}>} Never rejects.
 */
async function handleViewSubmission({ ack, body }, deps = {}) {
  const { postMessage, isAuthorized, logger = console } = deps;
  const notify = deps.notify || (async () => {});
  const postTimeoutMs = deps.postTimeoutMs || SUBMIT_POST_TIMEOUT_MS;
  const acknowledge = ackOnce(ack, logger);

  const view = (body && body.view) || null;

  // Not our modal. Acknowledge so it does not hang, and do nothing else.
  if (!view || view.callback_id !== CALLBACK_ID) {
    await acknowledge();
    return { posted: false, reason: 'not_ours' };
  }

  const userId = (body && body.user && body.user.id) || '';
  if (!isAuthorized(userId)) {
    // Checked again: a view_submission is its own envelope, not a continuation of
    // the command, so it does not inherit the command's gate.
    logger.warn(`[dispatch] Refusing a dispatch submission from unauthorized user: ${userId}`);
    await acknowledge({
      response_action: 'errors',
      errors: { [BLOCK_IDS.task]: 'You are not on the bridge allowlist (ALLOWED_USER_IDS).' },
    });
    return { posted: false, reason: 'unauthorized' };
  }

  const composed = composeDispatchMessage(extractSubmission(view), deps.githubOrg);
  if (!composed.ok) {
    await acknowledge({ response_action: 'errors', errors: toSlackErrors(composed.errors) });
    return { posted: false, reason: 'rejected', errors: composed.errors };
  }

  const target = resolveDispatchTarget(readPrivateMetadata(view).channelId, deps.watchedChannels, logger);
  if (!target.ok) {
    if (target.reason === 'no_channel') {
      logger.error(`[dispatch] ${target.detail}`);
      await notify(`:x: *${COMMAND_NAME}:* ${target.detail}`);
    }
    await acknowledge({
      response_action: 'errors',
      errors: { [BLOCK_IDS.instructions]: `Not dispatched: ${target.detail}` },
    });
    return { posted: false, reason: target.reason };
  }
  const channel = target.channelId;

  const outcome = await raceWithTimeout(
    Promise.resolve().then(() => postMessage({ channel, text: composed.message })),
    postTimeoutMs,
    logger,
    deps.setTimeoutFn
  );

  if (outcome.state === 'ok') {
    logger.log(`[dispatch] Dispatched a task to ${channel} (${target.agentId}) for ${userId}.`);
    await acknowledge();
    if (typeof deps.onDispatched === 'function') {
      try {
        deps.onDispatched({ channelId: channel, agentId: target.agentId });
      } catch (err) {
        logger.warn(`[dispatch] onDispatched threw (the task is posted; the next poll reads it): ${err.message}`);
      }
    }
    return { posted: true, reason: 'ok', message: composed.message, channel, agentId: target.agentId };
  }

  if (outcome.state === 'timeout') {
    const detail =
      `The post to <#${channel}> did not complete within ${postTimeoutMs}ms, so ` +
      'whether the task was dispatched is UNKNOWN.';
    logger.error(`[dispatch] ${detail}`);
    await notify(`:warning: *${COMMAND_NAME}:* ${detail} The operator was told to check before resubmitting.`);
    await acknowledge({
      response_action: 'errors',
      errors: {
        [BLOCK_IDS.instructions]:
          `${detail} CHECK the channel before submitting again - resubmitting would ` +
          'run the task twice.',
      },
    });
    return { posted: false, reason: 'post_timeout' };
  }

  const detail = `Slack refused the post to <#${channel}>: ${outcome.error.message}`;
  logger.error(`[dispatch] ${detail}`);
  await notify(`:x: *${COMMAND_NAME}:* ${detail} Nothing was dispatched.`);
  await acknowledge({
    response_action: 'errors',
    errors: { [BLOCK_IDS.instructions]: `Not dispatched. ${detail}` },
  });
  return { posted: false, reason: 'post_failed' };
}

module.exports = {
  COMMAND_NAME,
  CALLBACK_ID,
  SUBMIT_POST_TIMEOUT_MS,
  raceWithTimeout,
  resolveDispatchTarget,
  handleSlashCommand,
  handleViewSubmission,
};
