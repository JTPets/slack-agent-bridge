/**
 * lib/sqtools-alert-ack.js
 *
 * The owner's acknowledgement of a SqTools alert: silence, nag, or close for the day.
 *
 * LOGIC CHANGE 2026-11-07: Created (WORK-TODO #78, item 1, the verb half; the owner's
 * requirement of 2026-10-02: "silence / nag / close for the day"). The buttons need
 * Slack Interactivity on the app; this verb does not, so it comes first. Typed in
 * #claude-bridge, where the command table runs:
 *
 *   ASK: ack                      list the alerts that need you, with their ids
 *   ASK: ack <id> silence         this alert, for good: never reminded again
 *   ASK: ack <id> nag             remind me on every inbox check (at most every
 *                                 SQTOOLS_ALERT_NAG_MS) until I silence or close it
 *   ASK: ack <id> close           done for today: no reminder until tomorrow (a nagged
 *                                 alert resumes nagging the next Toronto day)
 *
 * The reading taken where the requirement was silent, stated so it can be changed: an
 * alert nobody acknowledged behaves as before (posted once, never reminded); only
 * `nag` produces reminders. `<id>` is any unambiguous prefix of the Gmail id (the post
 * shows the first 6 characters); an ambiguous or unknown prefix is refused, never
 * guessed.
 *
 * Record shape (on each entry of `recent` in agents/secretary/memory/sqtools-alerts.json,
 * which was `ack: null` from 2026-11-02):
 *   { state: 'silenced'|'nag'|'closed', nag: boolean, closedDay: 'YYYY-MM-DD'|null,
 *     lastNagAt: ISO|null, at: ISO, by: slack user id|null }
 *
 * State is read and written through lib/sqtools-alert-intake.js readState/writeState,
 * the file's one owner. Handlers never post (the command-table contract).
 */

'use strict';

const { dayKey, STORE_TIME_ZONE } = require('./time-format');

const ACTIONS = ['silence', 'nag', 'close'];
const SHORT_ID = 6;
const DEFAULT_NAG_MS = 2 * 60 * 60 * 1000;

/** Minimum gap between two reminders of one nagged alert. */
function nagIntervalMs(env = process.env) {
    const n = Number(env.SQTOOLS_ALERT_NAG_MS);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_NAG_MS;
}

const shortId = (id) => (id ? String(id).slice(0, SHORT_ID) : '------');

/**
 * Find the one recorded alert an id prefix names.
 * @returns {{ record: object|null, error: string|null }}
 */
function findAlert(state, prefix) {
    const p = String(prefix || '').trim();
    if (!/^[A-Za-z0-9]{3,}$/.test(p)) return { record: null, error: 'An alert id is at least 3 letters or digits.' };
    const hits = state.recent.filter((r) => r.id && r.id.startsWith(p));
    if (hits.length === 0) return { record: null, error: `No recorded SqTools alert has an id starting \`${p}\`.` };
    if (hits.length > 1) return { record: null, error: `\`${p}\` matches ${hits.length} alerts; give more of the id.` };
    return { record: hits[0], error: null };
}

/**
 * Apply one acknowledgement to `state` in place. Pure apart from the mutation.
 * @returns {{ ok: boolean, text: string, record?: object }}
 */
function applyAck(state, prefix, action, { now = new Date(), userId = null } = {}) {
    if (!ACTIONS.includes(action)) {
        return { ok: false, text: `Unknown acknowledgement \`${action}\`. Use one of: ${ACTIONS.join(', ')}.` };
    }
    const { record, error } = findAlert(state, prefix);
    if (!record) return { ok: false, text: error };
    if (!record.needsAck) {
        return { ok: false, text: `\`${shortId(record.id)}\` (${record.title}) is routine and needs no acknowledgement.` };
    }
    const prev = record.ack || {};
    const at = now.toISOString();
    if (action === 'silence') {
        record.ack = { state: 'silenced', nag: false, closedDay: null, lastNagAt: prev.lastNagAt || null, at, by: userId };
    } else if (action === 'nag') {
        record.ack = { state: 'nag', nag: true, closedDay: null, lastNagAt: prev.lastNagAt || null, at, by: userId };
    } else {
        record.ack = { state: 'closed', nag: prev.nag === true, closedDay: dayKey(now, STORE_TIME_ZONE),
            lastNagAt: prev.lastNagAt || null, at, by: userId };
    }
    const said = {
        silence: 'silenced: it will not be shown again',
        nag: `will be re-posted on inbox checks, at most every ${Math.round(nagIntervalMs() / 60000)} min, until you silence or close it`,
        close: record.ack.nag ? 'closed for today: nagging resumes tomorrow' : 'closed for today',
    }[action];
    return { ok: true, text: `:white_check_mark: \`${shortId(record.id)}\` ${record.title}: ${said}.`, record };
}

/** Alerts due a nag reminder now. */
function dueNags(state, { now = new Date(), intervalMs = nagIntervalMs() } = {}) {
    const today = dayKey(now, STORE_TIME_ZONE);
    return state.recent.filter((r) => r.ack && r.ack.nag === true && r.ack.state !== 'silenced'
        && r.ack.closedDay !== today
        && (!r.ack.lastNagAt || now.getTime() - Date.parse(r.ack.lastNagAt) >= intervalMs));
}

/** Stamp `lastNagAt` on the named alerts in `state`, in place. */
function markNagged(state, ids, now = new Date()) {
    const set = new Set(ids);
    for (const r of state.recent) if (r.ack && set.has(r.id)) r.ack.lastNagAt = now.toISOString();
}

/** The reminder lines for a post, or [] when none are due. */
function formatNagLines(records) {
    if (records.length === 0) return [];
    return [`:bell: *Still open (you asked to be nagged):* ${records.length}`,
        ...records.map((r) => `   \`${shortId(r.id)}\` *${r.title}*: ${r.detail}`)];
}

/** One line per alert that needs the owner and is not silenced, for `ASK: ack`. */
function formatOpen(state) {
    const open = state.recent.filter((r) => r.needsAck && !(r.ack && r.ack.state === 'silenced'));
    if (open.length === 0) return 'No SqTools alert is waiting on you.';
    const lines = [`*SqTools alerts waiting on you:* ${open.length}`];
    for (const r of open.slice(0, 25)) {
        const st = r.ack ? r.ack.state : 'not acknowledged';
        lines.push(`\`${shortId(r.id)}\` *${r.title}* (${st}): ${r.detail}`);
    }
    if (open.length > 25) lines.push(`_and ${open.length - 25} more_`);
    lines.push('_`ASK: ack <id> silence|nag|close`_');
    return lines.join('\n');
}

/**
 * The `ack` verb. Never posts, never throws for a user error.
 * @param {{ args?: string, userId?: string, now?: Date, stateFile?: string }} ctx
 */
async function handleAck(ctx = {}) {
    const intake = require('./sqtools-alert-intake');
    const stateFile = ctx.stateFile || intake.STATE_FILE;
    const state = intake.readState(stateFile);
    if (state.error) return { ok: false, text: `:x: SqTools alert state is unreadable (${state.error}); nothing changed.` };
    const [prefix, action, ...extra] = String(ctx.args || '').trim().split(/\s+/).filter(Boolean);
    if (!prefix) return { ok: true, text: formatOpen(state) };
    if (!action || extra.length) return { ok: false, text: 'Usage: `ASK: ack <id> silence|nag|close`, or `ASK: ack` to list.' };
    const result = applyAck(state, prefix, action.toLowerCase(), { now: ctx.now || new Date(), userId: ctx.userId || null });
    if (!result.ok) return { ok: false, text: `:x: ${result.text}` };
    const written = intake.writeState(state, stateFile);
    if (!written.written) return { ok: false, text: `:x: Acknowledgement not saved (${written.error}).` };
    return { ok: true, text: result.text };
}

module.exports = {
    ACTIONS, SHORT_ID, DEFAULT_NAG_MS, nagIntervalMs, shortId,
    findAlert, applyAck, dueNags, markNagged, formatNagLines, formatOpen, handleAck,
};
