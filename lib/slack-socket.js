'use strict';

/**
 * lib/slack-socket.js
 *
 * An ADDITIVE Slack Socket Mode connection. It carries slash commands and nothing
 * else. The HTTP poll loop in bridge-agent.js keeps handling every message exactly
 * as before and is not touched by this module.
 *
 * LOGIC CHANGE 2026-09-14: New file. The transport-vs-parser argument behind it is in
 * docs/WIRING-AND-SEAMS.md section 7: a pasted multi-line dispatch flattened to one
 * line stops being line-anchored, so `REPO:` swallows the rest of the message. A form
 * cannot be flattened; a slash command opens a form; a slash command needs a socket.
 *
 * THE ADDITIVITY CONTRACT — each clause is asserted in tests/slack-socket.test.js:
 *   1. startSocketMode() NEVER throws and NEVER rejects. No token, a malformed token, a
 *      missing dependency, a rejected handshake — each resolves to a handle carrying
 *      { started: false, reason }, and an absent token is a reported condition rather
 *      than a startup failure. Every async handler is wrapped (see `guarded`), so this
 *      module cannot kill the bridge with an unhandled rejection either.
 *   2. `@slack/socket-mode` is required LAZILY inside the start call, so a dependency
 *      that is absent or fails to load cannot break require('./bridge-agent.js').
 *   3. bridge-agent.js starts this AFTER setInterval(poll, ...) and does not await it,
 *      so nothing here can delay the path every task actually arrives on.
 *
 * RECONNECTION. SocketModeClient reconnects on its own (autoReconnectEnabled, set
 * explicitly rather than relied on as a library default). What it does not do is tell
 * anyone when reconnection has stopped working — and a quietly dead socket is
 * indistinguishable from a quiet Slack, the shape describeSkipReason exists to
 * prevent. So an outage lasting SOCKET_MODE_DOWN_ALERT_MS posts to #sqtools-ops via
 * the single owner-notification path (lib/notify-owner.js notifyOps, which redacts),
 * re-posts once per interval while it persists, and posts a recovery line on return.
 *
 * TOKEN HANDLING. The value of SLACK_APP_TOKEN is never logged, posted, or returned —
 * only its NAME and a shape verdict. lib/redact-secrets.js covers it twice over (the
 * TOKEN name match, the xapp- pattern), but that is a backstop, not the reason this is safe.
 */

const DEFAULT_DOWN_ALERT_MS = 300000; // 5 minutes
const APP_TOKEN_PREFIX = 'xapp-';

/**
 * Classify the app-level token in an environment WITHOUT revealing its value.
 * @param {object} [env=process.env] - Environment map to read.
 * @returns {{ ok, reason, detail, token }} reason: 'ok'|'not_configured'|'invalid_token_shape'.
 */
function readAppTokenConfig(env = process.env) {
  const raw = env && env.SLACK_APP_TOKEN;
  const token = typeof raw === 'string' ? raw.trim() : '';

  if (!token) {
    return {
      ok: false,
      reason: 'not_configured',
      detail:
        'SLACK_APP_TOKEN is not set, so Socket Mode is off. The bridge runs normally ' +
        'on the HTTP poll loop; slash commands are unavailable until the owner creates ' +
        'an app-level token and adds it to .env.',
      token: null,
    };
  }

  if (!token.startsWith(APP_TOKEN_PREFIX)) {
    // Say what is wrong with the shape; never echo the value, not even a prefix of it.
    return {
      ok: false,
      reason: 'invalid_token_shape',
      detail:
        `SLACK_APP_TOKEN is set but does not begin with "${APP_TOKEN_PREFIX}". An ` +
        'app-level token (Basic Information -> App-Level Tokens) is required; a bot ' +
        'token (xoxb-) will not open a Socket Mode connection. Socket Mode is off.',
      token: null,
    };
  }

  return { ok: true, reason: 'ok', detail: 'SLACK_APP_TOKEN is present.', token };
}

/**
 * Read the down-alert threshold; the default when unset, blank or not a positive number.
 * @param {object} [env=process.env] - Environment map to read.
 * @returns {number} Milliseconds.
 */
function readDownAlertMs(env = process.env) {
  const parsed = parseInt((env && env.SOCKET_MODE_DOWN_ALERT_MS) || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DOWN_ALERT_MS;
}

/**
 * Default client factory: lazily load `@slack/socket-mode` and construct a client.
 * Lazy by contract (additivity rule 2). `logLevel` is pinned to INFO because the
 * library logs the signed WebSocket URL — which carries a connection ticket — at DEBUG.
 * @param {{ appToken: string }} opts
 * @returns {object} A SocketModeClient instance.
 */
function defaultClientFactory({ appToken }) {
  // eslint-disable-next-line global-require
  const { SocketModeClient, LogLevel } = require('@slack/socket-mode');
  return new SocketModeClient({
    appToken,
    autoReconnectEnabled: true,
    logLevel: LogLevel.INFO,
  });
}

/**
 * Open the Socket Mode connection. Resolves to a handle in EVERY case, failures
 * included: callers need no try/catch and must not treat `started: false` as fatal.
 *
 * @param {object} [deps] - All optional; tests supply fakes. `env` (default
 *   process.env), `createClient` (default defaultClientFactory), `notify` (async
 *   human-facing reporter, default notifyOps), `logger` ({log,warn,error}, default
 *   console), `downAlertMs` (default from env), `onSlashCommand` (THE COMMAND SEAM,
 *   default null), `setTimeoutFn`/`clearTimeoutFn`.
 * @returns {Promise<object>} Handle: `{ started, reason, detail, getState, stop, client }`.
 */
async function startSocketMode(deps = {}) {
  const {
    env = process.env,
    createClient = defaultClientFactory,
    logger = console,
    downAlertMs = readDownAlertMs(env),
    onSlashCommand = null,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  const notify = deps.notify || ((m) => require('./notify-owner').notifyOps(m));

  /** Report a condition to a human AND the log; a failure to report is never fatal. */
  const report = async (line) => {
    logger.warn(`[slack-socket] ${line}`);
    try {
      await notify(`:electric_plug: *Socket Mode:* ${line}`);
    } catch (err) {
      logger.error(`[slack-socket] Could not report to a human: ${err.message}`);
    }
  };

  // An async function handed to setTimeout or an EventEmitter is fire-and-forget: if it
  // rejects, Node 20+ terminates the process on the unhandled rejection — which would
  // let this module kill the bridge, the one thing it must never do. All wrapped.
  const guarded = (fn) => (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => logger.error(`[slack-socket] Handler failed: ${err.message}`));

  const inert = (reason, detail) => ({
    started: false, reason, detail, client: null,
    getState: () => 'off',
    stop: async () => ({ stopped: false, reason }),
  });

  const tokenConfig = readAppTokenConfig(env);
  if (!tokenConfig.ok) {
    await report(tokenConfig.detail);
    return inert(tokenConfig.reason, tokenConfig.detail);
  }

  let client;
  try {
    client = createClient({ appToken: tokenConfig.token });
  } catch (err) {
    const detail =
      `Could not construct the Socket Mode client: ${err.message}. ` +
      'The bridge is running normally on the poll loop; slash commands are unavailable.';
    await report(detail);
    return inert('dependency_missing', detail);
  }

  // ---- Outage detection -------------------------------------------------------
  // `state` is reporting only: nothing here gates on it, and nothing outside this
  // module may gate task dispatch on it.
  let state = 'starting';
  let stopping = false;
  let downTimer = null;
  let outageAlerts = 0;
  let downSince = null;

  const clearDownTimer = () => {
    if (downTimer) {
      clearTimeoutFn(downTimer);
      downTimer = null;
    }
  };

  const armDownTimer = () => {
    clearDownTimer();
    downTimer = setTimeoutFn(guarded(async () => {
      downTimer = null;
      if (stopping || state === 'connected') return;
      outageAlerts += 1;
      const mins = Math.round((Date.now() - (downSince || Date.now())) / 60000);
      await report(
        `the connection has been down for about ${mins} minute(s) and has not recovered ` +
          `(alert ${outageAlerts}). Slash commands are not being received. Message ` +
          'handling via the poll loop is unaffected.'
      );
      // Re-arm: an outage that goes quiet after one alert is the failure this prevents.
      if (!stopping && state !== 'connected') armDownTimer();
    }), downAlertMs);
    if (downTimer && typeof downTimer.unref === 'function') downTimer.unref();
  };

  const markDown = (why) => {
    if (stopping) return;
    if (state !== 'connected' && downSince) return; // already counting this outage
    state = 'disconnected';
    downSince = Date.now();
    logger.warn(`[slack-socket] ${why}; awaiting automatic reconnection.`);
    armDownTimer();
  };

  const markUp = async () => {
    const wasAlerted = outageAlerts > 0;
    state = 'connected';
    downSince = null;
    clearDownTimer();
    logger.log('[slack-socket] Connection ready.');
    if (wasAlerted) {
      outageAlerts = 0;
      await report('the connection has recovered. Slash commands are being received again.');
    }
  };

  client.on('connected', guarded(markUp));
  client.on('disconnected', guarded(async () => markDown('Disconnected')));
  client.on('reconnecting', guarded(async () => markDown('Reconnecting')));

  // ---- THE COMMAND SEAM -------------------------------------------------------
  // Where the NEXT change attaches: register the command in the Slack app config (no
  // Request URL needed in Socket Mode), pass `onSlashCommand({ ack, body })` here,
  // open a modal with SEPARATE inputs for task/repo/branch/turns/instructions, and
  // build the task the way lib/task-parser.js reads it back (uppercase, line-anchored
  // labels — that round trip is already pinned in tests/integration.test.js).
  //
  // Nothing is registered in this branch, so no `slash_commands` envelope should
  // arrive. The listener exists anyway because an unacknowledged envelope shows the
  // user "operation timed out" with no trace here. Acknowledging an unhandled command
  // is a safety property, not a command.
  client.on('slash_commands', guarded(async ({ ack, body }) => {
    if (typeof onSlashCommand === 'function') {
      await onSlashCommand({ ack, body });
      return;
    }
    const command = (body && body.command) || 'unknown command';
    logger.warn(`[slack-socket] Received ${command} but no handler is attached; acknowledging.`);
    try {
      await ack({
        response_type: 'ephemeral',
        text: 'That command is not wired up yet.',
      });
    } catch (err) {
      logger.error(`[slack-socket] Failed to acknowledge ${command}: ${err.message}`);
    }
  }));

  // The handshake is the one call that can reject. A rejection is reported, never
  // thrown: an invalid token or unreachable Slack must leave the bridge polling.
  armDownTimer();
  downSince = Date.now();
  try {
    await client.start();
  } catch (err) {
    clearDownTimer();
    const detail =
      `Handshake failed: ${err.message}. The bridge is running normally on the poll ` +
      'loop; slash commands are unavailable until this is fixed.';
    await report(detail);
    return inert('start_failed', detail);
  }

  logger.log('[slack-socket] Socket Mode started (commands only; the poll loop is unchanged).');

  return {
    started: true,
    reason: 'ok',
    detail: 'Socket Mode connection open.',
    getState: () => state,
    client,
    stop: async () => {
      stopping = true;
      clearDownTimer();
      try {
        await client.disconnect();
        state = 'off';
        return { stopped: true };
      } catch (err) {
        logger.error(`[slack-socket] Failed to disconnect cleanly: ${err.message}`);
        return { stopped: false, error: err.message };
      }
    },
  };
}

module.exports = {
  startSocketMode, readAppTokenConfig, readDownAlertMs, defaultClientFactory,
  DEFAULT_DOWN_ALERT_MS, APP_TOKEN_PREFIX,
};
