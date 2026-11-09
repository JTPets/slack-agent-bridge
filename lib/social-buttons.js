/**
 * lib/social-buttons.js
 *
 * The presses on a social post draft: Publish, Edit (a form), Reject, and the Edit
 * form coming back. THE ONLY PATH from a draft to a live post.
 *
 * LOGIC CHANGE 2026-11-09: created. Owner's rule: nothing is published without a
 * person's approval. Approval here is a press by someone on the bridge allowlist
 * (ALLOWED_USER_IDS, the same check the poll loop and the SqTools alert buttons use),
 * behind a Slack confirm dialog that names the platforms.
 *
 * A draft publishes ONCE: the press moves it pending -> publishing in one file write
 * before any platform is called, and a second press (a double click, two people) finds
 * it no longer pending and is told so. Each platform's outcome is recorded on the draft
 * and shown on the post.
 *
 * Reached from lib/slack-socket.js's `interactive` seam; bridge-agent.js routes here
 * first. NEVER REJECTS: a failure is a reply to the presser, or an ops post.
 */

'use strict';

const drafts = require('./social-drafts');
const platforms = require('./social-platforms');
const { formatTimestamp } = require('./time-format');
const { graphemeCount, MAX_GRAPHEMES } = require('./social-bluesky');

const EDIT_CALLBACK_ID = 'social_draft_edit';

function readPress(body) {
    if (!body || body.type !== 'block_actions' || !Array.isArray(body.actions)) return null;
    const a = body.actions[0];
    if (!a || typeof a.action_id !== 'string' || !a.action_id.startsWith(drafts.ACTION_PREFIX)) return null;
    const action = a.action_id.slice(drafts.ACTION_PREFIX.length);
    if (!drafts.ACTIONS.includes(action)) return null;
    return { action, id: typeof a.value === 'string' ? a.value : '' };
}

function isEditSubmission(body) {
    return Boolean(body && body.type === 'view_submission' && body.view && body.view.callback_id === EDIT_CALLBACK_ID);
}

/** Whether an interactive payload belongs here. */
function isSocialInteraction(body) {
    return readPress(body) !== null || isEditSubmission(body);
}

function editModal(draft) {
    const input = (id, label, value, max) => ({
        type: 'input', block_id: id, label: { type: 'plain_text', text: label },
        element: { type: 'plain_text_input', action_id: 'value', multiline: true, initial_value: value, max_length: max },
    });
    return {
        type: 'modal', callback_id: EDIT_CALLBACK_ID, private_metadata: draft.id,
        title: { type: 'plain_text', text: 'Edit post' },
        submit: { type: 'plain_text', text: 'Save' }, close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
            input('text', 'Facebook, Instagram and Google', draft.text, drafts.MAX_TEXT),
            input('short', 'Bluesky (300 characters max)', draft.short, 300),
        ],
    };
}

function rerender(draft, footer) {
    const targets = platforms.publishTargets().ready.map(id => platforms.getPlatform(id).label);
    return {
        text: `Social post draft: ${draft.itemName}`,
        blocks: drafts.buildDraftBlocks(draft, { targets, footer }),
    };
}

/**
 * Handle one interaction. Acknowledges first (Slack's three-second window), except an
 * Edit form, whose ack carries field errors when the text is refused.
 *
 * @param {{ ack: Function, body: object }} envelope
 * @param {object} deps - isAuthorized, updateMessage, postEphemeral, openView, notify,
 *   logger, file (drafts file), env, fetchImpl, now
 * @returns {Promise<{ ok: boolean, reason: string }>} never rejects
 */
async function handleSocialInteraction({ ack, body }, deps = {}) {
    const { isAuthorized, updateMessage, postEphemeral, openView, logger = console } = deps;
    const notify = deps.notify || (async () => {});
    const file = deps.file || drafts.DEFAULT_DRAFTS_FILE;
    const userId = (body && body.user && body.user.id) || '';
    const now = deps.now || new Date();
    const authorized = typeof isAuthorized === 'function' && isAuthorized(userId);

    if (isEditSubmission(body)) {
        return handleEditSubmission({ ack, body, authorized, userId, updateMessage, notify, logger, file });
    }

    try { await ack(); } catch (err) { logger.error(`[social] Failed to acknowledge: ${err.message}`); }
    const channel = (body && body.channel && body.channel.id) || (body && body.container && body.container.channel_id) || null;
    const reply = async (text) => {
        try {
            if (!postEphemeral || !channel || !userId) throw new Error('no channel or user to reply to');
            await postEphemeral({ channel, user: userId, text });
        } catch (err) {
            try { await notify(`:warning: A social post button press got no reply (${err.message}). Its outcome: ${text}`); } catch (_) { /* nothing left */ }
        }
    };

    try {
        const press = readPress(body);
        if (!press) return { ok: false, reason: 'not_ours' };
        if (!authorized) {
            logger.warn(`[social] Refusing a press from unauthorized user: ${userId}`);
            await reply(':x: You are not on the bridge allowlist (ALLOWED_USER_IDS); nothing was done.');
            return { ok: false, reason: 'unauthorized' };
        }
        const current = drafts.readDrafts(file).drafts[press.id];
        if (!current) { await reply(':x: That draft is not on record any more; nothing was done.'); return { ok: false, reason: 'unknown_draft' }; }
        if (current.status !== 'pending') {
            await reply(`That draft is already ${current.status}; nothing was done.`);
            return { ok: false, reason: 'not_pending' };
        }

        if (press.action === 'edit') {
            if (!openView || !body.trigger_id) { await reply(':x: The edit form could not be opened (no trigger).'); return { ok: false, reason: 'no_trigger' }; }
            await openView({ trigger_id: body.trigger_id, view: editModal(current) });
            return { ok: true, reason: 'edit_opened' };
        }

        const when = formatTimestamp(now);
        if (press.action === 'reject') {
            const done = drafts.updateDraft(press.id, { status: 'rejected', decidedBy: userId, decidedAt: now.toISOString() }, file);
            await safeUpdate(updateMessage, current.post, rerender(done, `:no_entry_sign: Rejected by <@${userId}> at ${when}. Nothing was published.`), reply);
            return { ok: true, reason: 'rejected' };
        }

        // publish: claim it first, so a second press cannot publish twice.
        const claimed = drafts.updateDraft(press.id, (d) => (d.status === 'pending'
            ? { ...d, status: 'publishing', decidedBy: userId, decidedAt: now.toISOString() } : null), file);
        if (!claimed) { await reply('That draft was already being handled; nothing was done.'); return { ok: false, reason: 'not_pending' }; }
        await safeUpdate(updateMessage, current.post, rerender(claimed, `:hourglass_flowing_sand: Publishing, pressed by <@${userId}> at ${when}...`), reply);

        const results = await platforms.publishEverywhere(claimed, { env: deps.env, fetchImpl: deps.fetchImpl, now });
        // Nothing went live: back to pending, so Publish can be pressed again once fixed.
        // Anything went live: published, so a second press cannot post it twice.
        const anyLive = results.some(r => r.status === 'published');
        const done = drafts.updateDraft(press.id, anyLive
            ? { status: 'published', results, publishedAt: new Date().toISOString() }
            : { status: 'pending', results, decidedBy: null, decidedAt: null }, file);
        const lines = platforms.formatPublishResults(results);
        const head = anyLive ? `Published by <@${userId}> at ${when}:` : `Nothing was published (pressed by <@${userId}> at ${when}); the draft is still pending:`;
        await safeUpdate(updateMessage, current.post, rerender(done, `${head}\n${lines}`), reply);
        if (results.some(r => r.status === 'failed')) {
            await notify(`:warning: Social post "${claimed.itemName}" did not publish everywhere:\n${lines}`);
        }
        return { ok: true, reason: 'published' };
    } catch (err) {
        logger.error(`[social] Press failed: ${err.message}`);
        await reply(`:x: That press failed (${err.message}). Check the post before pressing again.`);
        return { ok: false, reason: 'error' };
    }
}

async function safeUpdate(updateMessage, post, content, reply) {
    if (!updateMessage || !post || !post.channel || !post.ts) return;
    try {
        await updateMessage({ channel: post.channel, ts: post.ts, ...content });
    } catch (err) {
        await reply(`The draft post could not be updated (${err.message}).`);
    }
}

async function handleEditSubmission({ ack, body, authorized, userId, updateMessage, notify, logger, file }) {
    const values = (body.view && body.view.state && body.view.state.values) || {};
    const text = ((values.text && values.text.value && values.text.value.value) || '').trim();
    const short = ((values.short && values.short.value && values.short.value.value) || '').trim();
    const id = body.view.private_metadata || '';
    const errors = {};
    if (!authorized) errors.text = 'You are not on the bridge allowlist; nothing was saved.';
    if (!text) errors.text = errors.text || 'The post cannot be empty.';
    if (!short) errors.short = 'The Bluesky version cannot be empty.';
    if (short && graphemeCount(short) > MAX_GRAPHEMES) errors.short = `Bluesky allows ${MAX_GRAPHEMES} characters.`;
    if (Object.keys(errors).length) {
        try { await ack({ response_action: 'errors', errors }); } catch (err) { logger.error(`[social] ack failed: ${err.message}`); }
        return { ok: false, reason: authorized ? 'invalid' : 'unauthorized' };
    }
    let saved = null;
    try {
        saved = drafts.updateDraft(id, (d) => (d.status === 'pending' ? { ...d, text, short, editedBy: userId } : null), file);
    } catch (err) {
        logger.error(`[social] Edit save failed: ${err.message}`);
    }
    if (!saved) {
        try { await ack({ response_action: 'errors', errors: { text: 'That draft is no longer pending, or could not be saved.' } }); } catch (_) { /* logged */ }
        return { ok: false, reason: 'not_saved' };
    }
    try { await ack(); } catch (err) { logger.error(`[social] ack failed: ${err.message}`); }
    await safeUpdate(updateMessage, saved.post, rerender(saved, `:pencil2: Edited by <@${userId}>.`),
        async (t) => { try { await notify(`:warning: ${t}`); } catch (_) { /* nothing left */ } });
    return { ok: true, reason: 'edited' };
}

module.exports = {
    EDIT_CALLBACK_ID,
    readPress,
    isEditSubmission,
    isSocialInteraction,
    editModal,
    handleSocialInteraction,
};
