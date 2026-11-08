'use strict';

/**
 * lib/poll-wake.js
 *
 * WORK-TODO #4, the remaining half: a typed TASK:/ASK: waited up to POLL_INTERVAL_MS
 * (30 s) for the next poll tick. When Slack's Events API says a message arrived in a
 * channel the bridge polls, this starts one poll soon instead.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * The event is a WAKE-UP, not intake. Nothing here reads the message: the poll that
 * follows reads it through the one path that owns dedup (lib/bridge-state.js), the
 * allowlist and describeSkipReason, exactly like a tick would. A lost event costs only
 * the old 30 s wait, because the interval keeps running.
 *
 * Coalesced: a burst of events (the bridge's own posts are message events too) produces
 * one poll after `delayMs`, not one per event. A channel outside the poll set wakes
 * nothing. Never throws.
 */

const DEFAULT_DELAY_MS = 1500;

/**
 * @param {object} deps
 * @param {(reason: string) => void} deps.trigger - pollNow in bridge-agent.js
 * @param {() => Array<{ channelId: string }>} deps.watchedChannels - the poll set, read per event
 * @param {number} [deps.delayMs]
 * @param {Function} [deps.setTimeoutFn]
 * @returns {{ wake: (channelId: string|null) => boolean, pending: () => boolean }}
 *   wake returns true when this event scheduled a poll, false when it was ignored or
 *   folded into one already scheduled.
 */
function createPollWake({ trigger, watchedChannels, delayMs = DEFAULT_DELAY_MS, setTimeoutFn = setTimeout }) {
    let timer = null;

    function wake(channelId) {
        try {
            if (typeof channelId !== 'string' || !channelId) return false;
            const watched = (watchedChannels() || []).some((c) => c && c.channelId === channelId);
            if (!watched || timer) return false;
            timer = setTimeoutFn(() => {
                timer = null;
                try { trigger('socket message'); } catch (_) { /* pollNow never throws; belt and braces */ }
            }, delayMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
            return true;
        } catch (_) {
            return false;
        }
    }

    return { wake, pending: () => timer !== null };
}

/**
 * The Socket Mode `message` handler (registered literally in lib/slack-socket.js). It
 * acks, then hands `onMessageSignal` the CHANNEL ID ONLY: it never reads the text, the
 * user or the ts, so it cannot run, answer, authorise or dedup anything. Slack sends no
 * such event unless the app subscribes to `message.channels`, so without that it is inert.
 *
 * @param {Function|null} onMessageSignal
 * @param {{ error: Function }} logger
 */
function messageSignalHandler(onMessageSignal, logger = console) {
    return async ({ ack, event } = {}) => {
        try {
            if (typeof ack === 'function') await ack();
        } catch (err) {
            logger.error(`[slack-socket] Failed to acknowledge a message event: ${err.message}`);
        }
        if (typeof onMessageSignal !== 'function') return;
        onMessageSignal(event && typeof event.channel === 'string' ? event.channel : null);
    };
}

module.exports = { createPollWake, messageSignalHandler, DEFAULT_DELAY_MS };
