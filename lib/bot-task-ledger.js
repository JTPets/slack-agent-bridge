'use strict';

/**
 * lib/bot-task-ledger.js
 *
 * WORK-TODO #81: which bot-authored TASK messages the bridge itself posted.
 *
 * LOGIC CHANGE 2026-11-25: new file. The poll loop lets a message posted by the bot
 * skip the user allowlist, so scheduled tasks, approved tasks and /dispatch posts (all
 * posted as the bot) are not dropped. But the bot also posts text it did not write:
 * email subjects, SqTools alerts, a task's output, a model's answer. `isTaskMessage`
 * matches `TASK:` anywhere in a message, so any of those that carried a task block
 * would have run as a task, with the allowlist skipped.
 *
 * The fix is to say exactly which bot posts are tasks: every place that posts a task
 * message on purpose posts it through postBridgeTask(), which records the channel and
 * the ts Slack gave the post. The poll loop runs a bot-authored TASK message only when
 * it is recorded here. Nothing a stranger writes can put a ts into this file.
 *
 * Where: `$WORK_DIR/bot-task-posts.json` (a bind mount on the box, WORK-TODO #25), so a
 * task posted just before a restart is still recognised after it. Entries older than
 * RETAIN_MS are dropped on the next write; the poll reads a channel's last messages, and
 * processed-tasks.json keeps a message from being run twice.
 *
 * The race: the poll sweep can read a post before the poster's `await` has recorded it.
 * postBridgeTask() registers itself as in flight BEFORE posting, and the poll loop calls
 * settle() before it decides, so a post the bridge is still recording is waited for.
 *
 * An unreadable file FAILS CLOSED: no bot post is treated as a task, and the caller
 * reports it. Refusing a scheduled task is loud; running a forged one is not.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', 'bot-task-posts.json');
const RETAIN_MS = 14 * 24 * 3600 * 1000;

let file = DEFAULT_FILE;
const inFlight = new Set();

/** Tests point the ledger at a temp file. */
function init(options = {}) {
    file = options.file || DEFAULT_FILE;
    inFlight.clear();
}

function key(channel, ts) {
    return `${channel}:${ts}`;
}

/** Throws on an unreadable file; a missing file is an empty ledger. */
function read() {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return { posts: {} };
        throw err;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.posts !== 'object' || Array.isArray(parsed.posts)) {
        throw new Error(`${file} has no "posts" object`);
    }
    return parsed;
}

function write(state, now) {
    const keepAfter = now - RETAIN_MS;
    for (const [k, at] of Object.entries(state.posts)) {
        if (!(Date.parse(at) >= keepAfter)) delete state.posts[k];
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Record one task post the bridge made.
 * @returns {{ recorded: boolean, error?: string }}
 */
function record(channel, ts, now = Date.now()) {
    if (!channel || !ts) return { recorded: false, error: 'no channel or ts to record' };
    try {
        const state = read();
        state.posts[key(channel, ts)] = new Date(now).toISOString();
        write(state, now);
        return { recorded: true };
    } catch (err) {
        return { recorded: false, error: err.message };
    }
}

/**
 * Was this message posted by the bridge as a task?
 * @returns {{ posted: boolean, error?: string }} error set when the ledger could not be read
 */
function lookup(channel, ts) {
    try {
        return { posted: Object.prototype.hasOwnProperty.call(read().posts, key(channel, ts)) };
    } catch (err) {
        return { posted: false, error: err.message };
    }
}

/** Wait for every task post still being made and recorded. Never rejects. */
async function settle() {
    if (inFlight.size === 0) return;
    await Promise.allSettled([...inFlight]);
}

/**
 * Post a task message as the bridge, and record it so the poll loop will run it.
 *
 * Rejects exactly when chat.postMessage rejects, as the direct call did, so callers keep
 * their existing failure handling. A post that landed but could not be recorded is
 * reported through `onUnrecorded` (the task will be refused by the poll loop, so a human
 * must hear about it) and resolves with `recorded: false` on the result.
 *
 * @param {object} slack - a client from lib/slack-web.js createWebClient
 * @param {object} args - chat.postMessage arguments; `channel` and `text` required
 * @param {object} [options]
 * @param {(text: string) => any} [options.onUnrecorded]
 */
async function postBridgeTask(slack, args, options = {}) {
    const work = (async () => {
        const response = await slack.chat.postMessage(args);
        const ts = response && response.ts;
        const channel = (response && response.channel) || args.channel;
        const verdict = record(channel, ts);
        if (!verdict.recorded) {
            const text =
                `:warning: *A task the bridge posted was not recorded, so it will not run.*\n` +
                `Channel: <#${channel}>, ts ${ts || 'unknown'}: ${verdict.error}\n` +
                `Re-post it once ${file} is writable (WORK-TODO #81).`;
            console.error(`[bot-task-ledger] ${text}`);
            if (options.onUnrecorded) {
                try { await options.onUnrecorded(text); } catch (_) { /* reported above */ }
            }
        }
        return Object.assign({}, response, { recorded: verdict.recorded });
    })();
    inFlight.add(work);
    try {
        return await work;
    } finally {
        inFlight.delete(work);
    }
}

module.exports = {
    init,
    record,
    lookup,
    settle,
    postBridgeTask,
    RETAIN_MS,
    DEFAULT_FILE,
};
