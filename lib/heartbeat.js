/**
 * lib/heartbeat.js
 *
 * LOGIC CHANGE 2026-03-27: Heartbeat reaction system to show task progress.
 * Cycles through emojis every 30 seconds while task is running.
 * Wrapped in try/catch so heartbeat failures never affect task execution.
 */

const HEARTBEAT_EMOJIS = ['hourglass_flowing_sand', 'gear'];
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * Creates a heartbeat controller for visual progress feedback.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {string} channel - Channel ID
 * @param {string} timestamp - Message timestamp
 * @returns {object} Heartbeat controller with start() and stop() methods
 */
function createHeartbeat(slack, channel, timestamp) {
  let intervalId = null;
  let currentIndex = 0;
  let previousEmoji = null;
  let isCleanedUp = false;

  const react = async (emoji) => {
    try {
      await slack.reactions.add({ channel, timestamp, name: emoji });
    } catch (err) {
      if (err.data?.error !== 'already_reacted') {
        console.error(`[heartbeat] react(${emoji}) failed:`, err.message);
      }
    }
  };

  const unreact = async (emoji) => {
    try {
      await slack.reactions.remove({ channel, timestamp, name: emoji });
    } catch {
      // Reaction may not exist
    }
  };

  const tick = async () => {
    if (isCleanedUp) return;

    try {
      const emoji = HEARTBEAT_EMOJIS[currentIndex % HEARTBEAT_EMOJIS.length];

      // Remove previous heartbeat emoji if set
      if (previousEmoji) {
        await unreact(previousEmoji);
      }

      // Add new heartbeat emoji
      await react(emoji);
      previousEmoji = emoji;
      currentIndex++;
    } catch (err) {
      // Heartbeat failure must never affect task execution
      console.error('[heartbeat] tick failed:', err.message);
    }
  };

  return {
    start: async () => {
      try {
        // Initial reaction: eyes
        await react('eyes');

        // Start cycling after initial 30s delay
        intervalId = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      } catch (err) {
        // Heartbeat failure must never affect task execution
        console.error('[heartbeat] start failed:', err.message);
      }
    },

    // success: true = :white_check_mark:, false = :x:, null = no final emoji (rate limit)
    stop: async (success) => {
      isCleanedUp = true;

      try {
        // Clear interval
        if (intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }

        // Remove eyes reaction
        await unreact('eyes');

        // Remove last heartbeat emoji if set
        if (previousEmoji) {
          await unreact(previousEmoji);
        }

        // Add final status emoji (skip if success is null - rate limit case)
        if (success !== null) {
          await react(success ? 'white_check_mark' : 'x');
        }
      } catch (err) {
        // Heartbeat failure must never affect task execution
        console.error('[heartbeat] stop failed:', err.message);
      }
    },
  };
}

module.exports = {
  createHeartbeat,
  HEARTBEAT_EMOJIS,
  HEARTBEAT_INTERVAL_MS,
};
