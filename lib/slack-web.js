'use strict';

/**
 * lib/slack-web.js
 *
 * THE one place a Slack Web API client is constructed, and the canonical way to post a
 * line of text to a channel or a DM.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #30): secret redaction reached 3 of 55
 * `chat.postMessage` sites. `lib/redact-secrets.js` exists because spawned-LLM stderr
 * was posted verbatim to #sqtools-ops, yet the nightly security review posted
 * LLM-generated findings, quoted from diffs, with no scrubbing at all. Patching 52 call
 * sites would leave the 56th to land unscrubbed. Instead every client is built here, and
 * the client itself redacts: `createWebClient()` replaces the client's `chat.*` posting
 * methods with wrappers that run `text`, `blocks` and `attachments` through `redact()`
 * before the request is made. Every call site in the repository reaches Slack through a
 * client from this function, so every call site is covered, including ones not yet
 * written. tests/slack-redaction.test.js enforces it: `new WebClient(` anywhere else is
 * a red run.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #21): the SDK forwards Slack's
 * `response_metadata.warnings` to `logger.warn`, so every boot printed one
 * `already_in_channel` warning per agent channel and trained the reader to skip WARN
 * lines. The client gets a logger that drops exactly that warning (which
 * joinAgentChannels already counts as success) and passes every other warning through.
 * Raising the level to ERROR instead would have hidden real SDK warnings too.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #30): `postText()` and `sendDM()` replace six
 * copies (`postToOps` in bridge-agent.js, security-review.js and auto-update.js;
 * `sendDM` in security-review.js, morning-digest.js and scripts/watercooler.js) that
 * disagreed on redaction, on `unfurl_links`, and on whether a Slack error aborts the
 * caller. The rule is now one rule: they NEVER throw, they return whether the message
 * landed, and a caller whose whole job is that message checks the result and fails
 * visibly. A Slack hiccup no longer aborts an unrelated loop in one file and not another.
 */

const { WebClient } = require('@slack/web-api');
const { redact } = require('./redact-secrets');

/** The `chat.*` methods that carry message content and are therefore redacted. */
const REDACTED_METHODS = ['postMessage', 'postEphemeral', 'update', 'scheduleMessage'];

/** The message-content fields of those methods. */
const CONTENT_FIELDS = ['text', 'blocks', 'attachments'];

/**
 * Slack warnings that are expected and carry no information. `already_in_channel` is
 * returned for every conversations.join on a channel the bot is already in, which is
 * every agent channel on every boot after the first.
 */
const EXPECTED_WARNINGS = new Set(['already_in_channel']);

/** Redact every string inside a value: strings, arrays and plain objects, recursively. */
function redactDeep(value) {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(redactDeep);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
        return out;
    }
    return value;
}

/** A copy of a chat.* argument object with its content fields redacted. */
function redactArgs(args) {
    if (!args || typeof args !== 'object') return args;
    const out = { ...args };
    for (const field of CONTENT_FIELDS) {
        if (field in out) out[field] = redactDeep(out[field]);
    }
    return out;
}

/**
 * Replace a client's chat.* posting methods with redacting wrappers. Mutates and returns
 * the client. A client with no `chat` (a narrow test double) is returned unchanged.
 */
function guardChat(client) {
    if (!client || !client.chat) return client;
    const original = client.chat;
    const chat = { ...original };
    for (const method of REDACTED_METHODS) {
        if (typeof original[method] === 'function') {
            chat[method] = (args, ...rest) => original[method].call(original, redactArgs(args), ...rest);
        }
    }
    client.chat = chat;
    return client;
}

/**
 * A logger in the shape @slack/web-api expects. Level `warn` by default, so the SDK's
 * debug line that dumps every full API result (message text included) never prints.
 */
function createLogger() {
    const ORDER = { debug: 0, info: 1, warn: 2, error: 3 };
    let level = 'warn';
    let name = 'slack';
    const on = (l) => ORDER[l] >= (ORDER[level] ?? ORDER.warn);
    return {
        debug: (...m) => { if (on('debug')) console.debug(`[${name}]`, ...m); },
        info: (...m) => { if (on('info')) console.info(`[${name}]`, ...m); },
        warn: (...m) => {
            if (!on('warn') || EXPECTED_WARNINGS.has(m[0])) return;
            console.warn(`[${name}]`, ...m);
        },
        error: (...m) => { if (on('error')) console.error(`[${name}]`, ...m); },
        setLevel: (l) => { level = l; },
        getLevel: () => level,
        setName: (n) => { name = n; },
    };
}

/**
 * Construct a Slack Web API client. The only `new WebClient(` in the repository.
 *
 * @param {string} token - Bot token. Never logged.
 * @param {object} [options] - Passed to WebClient; `logger` defaults to createLogger().
 * @returns {WebClient} A client whose chat.* posts are redacted.
 */
function createWebClient(token, options = {}) {
    return guardChat(new WebClient(token, { logger: createLogger(), ...options }));
}

/**
 * Post a line of text to a channel. Never throws.
 *
 * @param {object} client - A Slack client (from createWebClient in production).
 * @param {string} channel - Channel id.
 * @param {string} text - Message text. Redacted here as well as by the client, so a
 *   client not built by createWebClient (a test double) is still covered.
 * @param {string} [label] - Log prefix naming the caller.
 * @returns {Promise<boolean>} Whether Slack accepted the post.
 */
async function postText(client, channel, text, label = 'slack') {
    try {
        await client.chat.postMessage({ channel, text: redact(text), unfurl_links: false });
        return true;
    } catch (err) {
        console.error(`[${label}] Failed to post to ${channel}:`, err.message);
        return false;
    }
}

/**
 * Send a direct message. Never throws.
 *
 * @param {object} client
 * @param {string} userId - Slack user id.
 * @param {string} text
 * @param {string} [label]
 * @returns {Promise<boolean>} Whether Slack accepted the DM.
 */
async function sendDM(client, userId, text, label = 'slack') {
    let channel;
    try {
        const opened = await client.conversations.open({ users: userId });
        channel = opened.channel.id;
    } catch (err) {
        console.error(`[${label}] Failed to open a DM:`, err.message);
        return false;
    }
    return postText(client, channel, text, label);
}

module.exports = {
    REDACTED_METHODS,
    EXPECTED_WARNINGS,
    createWebClient,
    createLogger,
    guardChat,
    redactArgs,
    postText,
    sendDM,
};
