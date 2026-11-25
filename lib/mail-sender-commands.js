/**
 * lib/mail-sender-commands.js
 *
 * The two verbs over the sender ledger (lib/mail-senders.js):
 *
 *   ASK: unsubscribe [n]                  the n noisiest bulk senders you have not decided
 *                                         on (default 15, max 50), each with its unsubscribe
 *                                         link; read-only, so it answers in any channel,
 *                                         the secretary's included
 *   ASK: sender <id> unsubscribed|keep    record what you did about one sender; it leaves
 *                                         the list. `unsubscribed` senders that keep writing
 *                                         10+ days later are listed again, separately
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #88, phase 1): new file.
 *
 * THE BRIDGE NEVER OPENS A LINK. It shows them; the owner opens the one he chooses.
 * The reply is posted with unfurl_links off (bridge-agent.js posts every verb reply that
 * way), because a link preview is an HTTP GET, and some one-click unsubscribe links act
 * on a GET. Every link and name here came from an email, so each is escaped for Slack
 * and the link's host is shown beside it, flagged when it is not the sender's domain.
 *
 * Handlers never post (the command-table contract) and never throw.
 */

'use strict';

const senders = require('./mail-senders');
const { formatTimestamp } = require('./time-format');

const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
/** CAN-SPAM allows ten business days to honour an unsubscribe; two weeks is a safe reading. */
const STILL_SENDING_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** Slack mrkdwn text escape for an untrusted string, on one line. */
function escapeText(s) {
    return String(s || '').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A Slack link to an already-parsed URL; `|`, `<` and `>` cannot end it early. */
function slackLink(href, label) {
    const safe = String(href).replace(/&/g, '&amp;').replace(/\|/g, '%7C').replace(/</g, '%3C').replace(/>/g, '%3E');
    return `<${safe}|${escapeText(label)}>`;
}

/** The last two labels of a host name, a deliberately crude "same organisation" test. */
const baseDomain = (host) => String(host || '').toLowerCase().split('.').filter(Boolean).slice(-2).join('.');

/** One line describing where the unsubscribe link goes, and how it was found. */
function describeLink(entry) {
    const u = entry.unsubscribe;
    if (!u) return 'no unsubscribe link found';
    const parts = [];
    if (u.url) {
        const host = new URL(u.url).hostname;
        const senderDomain = entry.address.split('@')[1];
        const foreign = baseDomain(host) !== baseDomain(senderDomain);
        parts.push(`${slackLink(u.url, 'unsubscribe')} (${escapeText(host)}${foreign ? ', not the sender\'s domain' : ''})`);
    }
    if (u.mailto) parts.push(`${slackLink(u.mailto, 'by email')}`);
    parts.push(u.source === 'header' ? (u.oneClick ? 'published one-click' : 'published in the header') : 'found in the footer, check it before you confirm');
    return parts.join(' · ');
}

function senderLine(e) {
    return `• \`${senders.senderId(e.address)}\` *${escapeText(e.name)}* (${escapeText(e.address)}) — ${e.count} email${e.count === 1 ? '' : 's'}, last ${formatTimestamp(new Date(e.lastSeen), { precision: 'date' })}\n    ${describeLink(e)}`;
}

/**
 * `ASK: unsubscribe [n]`.
 * @param {{ args?: string, file?: string, now?: Date }} ctx
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function handleUnsubscribe(ctx = {}) {
    const arg = String(ctx.args || '').trim();
    if (arg && !/^\d+$/.test(arg)) {
        return { ok: false, text: 'Usage: `ASK: unsubscribe [n]` lists your noisiest bulk senders; `ASK: sender <id> unsubscribed|keep` records what you did.' };
    }
    const limit = Math.min(Math.max(Number(arg) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const { state, error } = senders.readLedger(ctx.file);
    if (error) return { ok: false, text: `:x: The sender ledger cannot be read (${escapeText(error)}), so nothing can be listed.` };

    const all = Object.values(state.senders);
    const now = ctx.now || new Date();
    const open = all.filter(e => !e.verdict && e.unsubscribe)
        .sort((a, b) => (b.count - a.count) || b.lastSeen.localeCompare(a.lastSeen));
    const linkless = all.filter(e => !e.verdict && !e.unsubscribe).length;
    const stillSending = all.filter(e => e.verdict === 'unsubscribed' && e.seenSinceVerdict > 0 &&
        Date.parse(e.lastSeen) - Date.parse(e.verdictAt) >= STILL_SENDING_AFTER_MS && Date.parse(e.verdictAt) <= now.getTime());

    if (all.length === 0) {
        return { ok: true, text: 'No bulk mail is recorded yet. The inbox check records it as it reads new mail, so the list fills over the next days.' };
    }
    const lines = [`*Bulk senders you have not decided on* (${open.length} with a link, top ${Math.min(limit, open.length)}, most emails first):`];
    lines.push(...(open.length ? open.slice(0, limit).map(senderLine) : ['• none']));
    if (linkless) lines.push(`_${linkless} other bulk sender${linkless === 1 ? '' : 's'} published no unsubscribe link._`);
    if (stillSending.length) {
        lines.push('', '*Still sending two weeks after you unsubscribed:*', ...stillSending.map(senderLine));
    }
    lines.push('', 'I never open these links; you choose which to open. Then tell me what you did: `ASK: sender <id> unsubscribed` or `ASK: sender <id> keep`, and that sender leaves this list.');
    return { ok: true, text: lines.join('\n') };
}

/**
 * `ASK: sender <id> unsubscribed|keep`.
 * @param {{ args?: string, file?: string, now?: Date, userId?: string }} ctx
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function handleSender(ctx = {}) {
    const [id, verdict, ...rest] = String(ctx.args || '').trim().split(/\s+/);
    if (!id || !verdict || rest.length) {
        return { ok: false, text: `Usage: \`ASK: sender <id> ${senders.VERDICTS.join('|')}\` with an id from \`ASK: unsubscribe\`.` };
    }
    const result = senders.setVerdict(id, verdict.toLowerCase(), { file: ctx.file, now: ctx.now, userId: ctx.userId || null });
    if (!result.ok) return { ok: false, text: `:x: ${result.error}` };
    const e = result.entry;
    const what = e.verdict === 'unsubscribed'
        ? 'marked unsubscribed. If it is still writing to you in two weeks, `ASK: unsubscribe` lists it again.'
        : 'kept. It will not be suggested for unsubscribing again.';
    return { ok: true, text: `:white_check_mark: *${escapeText(e.name)}* (${escapeText(e.address)}) ${what}` };
}

module.exports = {
    handleUnsubscribe, handleSender, escapeText, slackLink, describeLink,
    DEFAULT_LIMIT, MAX_LIMIT, STILL_SENDING_AFTER_MS,
};
