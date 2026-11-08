/**
 * lib/sqtools-alert-buttons.js
 *
 * Buttons on a SqTools alert post: Silence / Nag / Close today, one row per alert that
 * needs the owner. A press does exactly what `ASK: ack <id> <action>` does.
 *
 * LOGIC CHANGE 2026-11-07: Created (WORK-TODO #78, item 1, the button half). The verb
 * half is lib/sqtools-alert-ack.js; a press calls its handleAck, so the typed verb and
 * the button cannot record different things.
 *
 * ACKNOWLEDGEMENT IS PER OCCURRENCE (owner, 2026-11-07: "the alert is never sent again,
 * but identical alerts from a new alert can be sent again ... a backup failure would
 * alert every backup even if ack in the past"). Each button's value is the alert's FULL
 * Gmail message id, and the decision is stored on that one record. Nothing is keyed by
 * subject, kind or title, so a new email with the same subject is a new record with
 * `ack: null` and is posted like any other. tests/sqtools-alert-buttons.test.js pins it.
 *
 * Reached from lib/slack-socket.js's `interactive` seam (bridge-agent.js routes a
 * block_actions press here and every view_submission to lib/dispatch-command.js).
 * Needs Socket Mode and Slack Interactivity on the app, the same owner-side steps as
 * /dispatch. Without them a press does nothing, so the post still names the typed verb.
 *
 * NEVER REJECTS: an error is a reply to the presser, or an ops post if that fails.
 */

'use strict';

const ackVerb = require('./sqtools-alert-ack');
const { formatTimestamp } = require('./time-format');

const ACTION_PREFIX = 'sqtools_ack_';
const BLOCK_PREFIX = 'sqtools_ack:';
const BUTTONS = [
    { action: 'silence', label: 'Silence' },
    { action: 'nag', label: 'Nag me' },
    { action: 'close', label: 'Close today' },
];
const DONE = { silence: 'Silenced', nag: 'Nagging', close: 'Closed for today' };
// Slack allows 50 blocks per message and 3000 characters per section.
const MAX_BUTTON_ALERTS = 10;
const MAX_SECTION_CHARS = 2900;
const MAX_SECTIONS = 20;

/** Split post text into section blocks on line boundaries. */
function textSections(text) {
    const chunks = [];
    let cur = '';
    for (const line of String(text).split('\n')) {
        const piece = line.length > MAX_SECTION_CHARS ? `${line.slice(0, MAX_SECTION_CHARS - 1)}…` : line;
        if (cur && cur.length + 1 + piece.length > MAX_SECTION_CHARS) { chunks.push(cur); cur = piece; } else {
            cur = cur ? `${cur}\n${piece}` : piece;
        }
    }
    if (cur) chunks.push(cur);
    const kept = chunks.slice(0, MAX_SECTIONS);
    if (chunks.length > kept.length) kept.push('_Post truncated; `ASK: ack` lists every open alert._');
    return kept.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } }));
}

/**
 * The blocks for an alert post: the text, then one labelled button row per alert that
 * can be acknowledged. Alerts with no Gmail id get no buttons (nothing to key them by).
 *
 * @param {string} text - The post text (lib/sqtools-alert-intake.js formatAlertPost)
 * @param {Array} records - Alert records to offer buttons for
 * @returns {Array} Slack blocks
 */
function buildAlertBlocks(text, records = []) {
    const blocks = textSections(text);
    const seen = new Set();
    const ackable = records.filter((r) => r && r.id && r.needsAck && !seen.has(r.id) && seen.add(r.id));
    for (const r of ackable.slice(0, MAX_BUTTON_ALERTS)) {
        const sid = ackVerb.shortId(r.id);
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `\`${sid}\` ${r.title}` }] });
        blocks.push({
            type: 'actions',
            block_id: `${BLOCK_PREFIX}${r.id}`,
            elements: BUTTONS.map((b) => ({
                type: 'button',
                action_id: `${ACTION_PREFIX}${b.action}`,
                text: { type: 'plain_text', text: `${b.label} ${sid}` },
                value: r.id,
            })),
        });
    }
    if (ackable.length > MAX_BUTTON_ALERTS) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn',
            text: `_${ackable.length - MAX_BUTTON_ALERTS} more need you: use \`ASK: ack\` in #claude-bridge._` }] });
    }
    return blocks;
}

/** The first action of an interactive payload, when it is one of these buttons. */
function readAction(body) {
    if (!body || body.type !== 'block_actions' || !Array.isArray(body.actions)) return null;
    const a = body.actions[0];
    if (!a || typeof a.action_id !== 'string' || !a.action_id.startsWith(ACTION_PREFIX)) return null;
    const action = a.action_id.slice(ACTION_PREFIX.length);
    if (!BUTTONS.some((b) => b.action === action)) return null;
    return { action, id: typeof a.value === 'string' ? a.value : '' };
}

/** Whether an interactive payload is a press of one of these buttons. */
function isAckAction(body) {
    return readAction(body) !== null;
}

/** The message's blocks with the pressed alert's button row replaced by the outcome. */
function markDone(blocks, id, action, userId, when) {
    return (blocks || []).map((b) => (b && b.block_id === `${BLOCK_PREFIX}${id}`
        ? { type: 'context', elements: [{ type: 'mrkdwn',
            text: `:white_check_mark: ${DONE[action]} by ${userId ? `<@${userId}>` : 'someone'} at ${when}` }] }
        : b));
}

/**
 * Handle one button press. Acknowledges first (Slack's three-second window).
 *
 * @param {{ ack: Function, body: object }} envelope
 * @param {object} deps - `isAuthorized(userId)`, `updateMessage({channel, ts, text, blocks})`,
 *   `postEphemeral({channel, user, text})`, `notify(text)`, `logger`, `stateFile`, `now`
 * @returns {Promise<{ ok: boolean, reason: string }>} Never rejects.
 */
async function handleAckAction({ ack, body }, deps = {}) {
    const { isAuthorized, updateMessage, postEphemeral, logger = console } = deps;
    const notify = deps.notify || (async () => {});
    try { await ack(); } catch (err) { logger.error(`[sqtools-ack] Failed to acknowledge: ${err.message}`); }

    const userId = (body && body.user && body.user.id) || '';
    const channel = (body && body.channel && body.channel.id) || (body && body.container && body.container.channel_id) || null;
    const message = (body && body.message) || null;
    const reply = async (text) => {
        try {
            if (!postEphemeral || !channel || !userId) throw new Error('no channel or user to reply to');
            await postEphemeral({ channel, user: userId, text });
        } catch (err) {
            logger.error(`[sqtools-ack] Could not reply to the presser: ${err.message}`);
            try { await notify(`:warning: A SqTools alert button press got no reply (${err.message}). Its outcome: ${text}`); } catch (_) { /* logged above */ }
        }
    };

    try {
        const pressed = readAction(body);
        if (!pressed) return { ok: false, reason: 'not_ours' };
        if (typeof isAuthorized !== 'function' || !isAuthorized(userId)) {
            logger.warn(`[sqtools-ack] Refusing a button press from unauthorized user: ${userId}`);
            await reply(':x: You are not on the bridge allowlist (ALLOWED_USER_IDS); nothing was recorded.');
            return { ok: false, reason: 'unauthorized' };
        }
        const now = deps.now || new Date();
        const result = await ackVerb.handleAck({ args: `${pressed.id} ${pressed.action}`, userId, now, stateFile: deps.stateFile });
        if (!result.ok) {
            await reply(result.text);
            return { ok: false, reason: 'refused' };
        }
        if (!updateMessage || !message || !message.ts || !channel) {
            await reply(result.text);
            return { ok: true, reason: 'recorded' };
        }
        const when = formatTimestamp(now);
        try {
            await updateMessage({ channel, ts: message.ts, text: message.text || 'SqTools alerts',
                blocks: markDone(message.blocks, pressed.id, pressed.action, userId, when) });
        } catch (err) {
            await reply(`${result.text} _(The post could not be updated: ${err.message}.)_`);
        }
        return { ok: true, reason: 'recorded' };
    } catch (err) {
        logger.error(`[sqtools-ack] Button press failed: ${err.message}`);
        await reply(`:x: That press failed (${err.message}); nothing may have been recorded. Try \`ASK: ack\`.`);
        return { ok: false, reason: 'error' };
    }
}

module.exports = {
    ACTION_PREFIX, BLOCK_PREFIX, BUTTONS, MAX_BUTTON_ALERTS,
    textSections, buildAlertBlocks, readAction, isAckAction, markDone, handleAckAction,
};
