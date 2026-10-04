'use strict';

/**
 * lib/dispatch-delivery.js
 *
 * Where and how a /dispatch submission is delivered: resolveDispatchTarget picks the
 * channel (WORK-TODO #46), raceWithTimeout bounds the post inside Slack's ack window.
 * Split from lib/dispatch-command.js 2026-10-04 so that file stays under the 300-line
 * rule; lib/dispatch-command.js re-exports both, so callers are unchanged.
 *
 * LOGIC CHANGE 2026-10-04: new file (moved code plus resolveDispatchTarget, new).
 */

/**
 * Where a submission is posted: the invoking channel when the poll loop watches it.
 * A miss is refused with the reason, never redirected (WORK-TODO #46).
 * @returns {{ok: true, channelId, agentId} | {ok: false, reason, detail}}
 */
function resolveDispatchTarget(invokingChannelId, watchedChannels, logger = console) {
  let watched = [];
  try {
    watched = (typeof watchedChannels === 'function' ? watchedChannels() : watchedChannels) || [];
  } catch (err) {
    logger.error(`[dispatch] Could not read the poll set: ${err.message}`);
  }
  if (!watched.length) {
    return { ok: false, reason: 'no_channel', detail: 'the bridge is polling no channels (is BRIDGE_CHANNEL_ID set?), so nothing would read the task.' };
  }
  const hit = watched.find((c) => c && c.channelId && c.channelId === invokingChannelId);
  if (hit) return { ok: true, channelId: hit.channelId, agentId: hit.agentId || 'unknown' };
  return {
    ok: false,
    reason: 'unwatched_channel',
    detail: 'this form was opened in a channel the bridge does not poll, so a task posted ' +
      'there would never be read. Run /dispatch in #claude-bridge, or in the channel of the ' +
      'active agent the task should run as.',
  };
}

/**
 * Race a promise against a timer. Resolves to { state: 'ok'|'failed'|'timeout' }.
 * On timeout the original promise is left running but permanently guarded, so an
 * eventual rejection cannot become an unhandled rejection and kill the bridge.
 */
function raceWithTimeout(promise, ms, logger, setTimeoutFn = setTimeout) {
  let timer = null;
  const guarded = promise.then(
    (value) => ({ state: 'ok', value }),
    (error) => ({ state: 'failed', error })
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeoutFn(() => resolve({ state: 'timeout' }), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([guarded, timeout]).then((outcome) => {
    if (timer) clearTimeout(timer);
    if (outcome.state === 'timeout') {
      // Say what the post eventually did, even though nobody is waiting any more.
      guarded.then((late) => {
        logger.warn(
          `[dispatch] The channel post that exceeded ${ms}ms eventually ` +
            `${late.state === 'ok' ? 'SUCCEEDED - the task was dispatched' : `failed: ${late.error.message}`}.`
        );
      });
    }
    return outcome;
  });
}

module.exports = { resolveDispatchTarget, raceWithTimeout };
