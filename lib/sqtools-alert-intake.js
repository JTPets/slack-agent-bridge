/**
 * lib/sqtools-alert-intake.js
 *
 * The secretary's SqTools alert intake: takes the SqTools emails out of an inbox
 * check, records each one once, and posts the new ones to the secretary's channel.
 *
 * LOGIC CHANGE 2026-11-02: Created (owner request 2026-11-02; requirements of
 * 2026-10-02 in WORK-TODO.md's triage section). Called by lib/email-check.js after
 * every successful fetch, so it runs on the email-monitor's `*\/30 9-21 * * *`
 * schedule and needs no second Gmail client, no second credential and no new cron.
 *
 * What is recorded: agents/secretary/memory/sqtools-alerts.json (gitignored by the
 * agents/*\/memory/* rule). It holds the Gmail ids already handled, so a re-scanned
 * window never posts an alert twice, the most recent alerts (read by the
 * secretary's briefing context), and the last SqTools heartbeat seen.
 *
 * Never silent:
 *   - a post that fails leaves the alerts UNRECORDED, so the next check posts
 *     them again, and the verdict says so for lib/email-check.js to escalate;
 *   - a state file that cannot be written is in the verdict too;
 *   - no secretary channel posts in the fallback channel and says why;
 *   - once a SqTools heartbeat has been seen, a heartbeat older than
 *     HEARTBEAT_QUIET_MS is reported once per Toronto day: SqTools' own alerting
 *     going quiet is itself an alert.
 *
 * Acknowledgement (silence / nag / close for the day) is lib/sqtools-alert-ack.js,
 * the `ASK: ack` verb, and the buttons on each post, lib/sqtools-alert-buttons.js
 * (WORK-TODO #78, 2026-11-07). This module posts the reminders
 * for nagged alerts on each check, and re-reads the state file after its post so an
 * acknowledgement written meanwhile is not overwritten.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const alerts = require('./sqtools-alerts');
const ack = require('./sqtools-alert-ack');
const buttons = require('./sqtools-alert-buttons');
const { dayKey, STORE_TIME_ZONE, formatTimestamp } = require('./time-format');

const STATE_FILE = path.join(__dirname, '..', 'agents', 'secretary', 'memory', 'sqtools-alerts.json');

// How long a handled Gmail id is remembered. Longer than the inbox check's 24 h
// lookback ceiling (EMAIL_CHECK_MAX_LOOKBACK_MS), so no id ages out while it can
// still be fetched again.
const SEEN_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// How many recorded alerts are kept for the briefing and the future ack verbs.
const MAX_RECENT = 200;

// SqTools sends its heartbeat daily. Two missed hours of slack on top of a day.
const HEARTBEAT_QUIET_MS = 26 * 60 * 60 * 1000;

const ICON = {
    [alerts.SEVERITY.ACTION]: ':red_circle:',
    [alerts.SEVERITY.REVIEW]: ':large_orange_circle:',
    [alerts.SEVERITY.INFO]: ':large_blue_circle:',
};

/**
 * Read the intake state. Missing = empty. Unreadable = empty plus the reason,
 * so a corrupt file shows up rather than silently reposting everything.
 *
 * @param {string} [stateFile]
 * @returns {{ seen: Object<string,string>, recent: Array, lastHeartbeatAt: string|null, quietReportedDay: string|null, error: string|null }}
 */
function readState(stateFile = STATE_FILE) {
    const empty = { seen: {}, recent: [], lastHeartbeatAt: null, quietReportedDay: null, error: null };
    try {
        if (!fs.existsSync(stateFile)) return empty;
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        return {
            seen: parsed && typeof parsed.seen === 'object' && parsed.seen ? parsed.seen : {},
            recent: Array.isArray(parsed?.recent) ? parsed.recent : [],
            lastHeartbeatAt: typeof parsed?.lastHeartbeatAt === 'string' ? parsed.lastHeartbeatAt : null,
            quietReportedDay: typeof parsed?.quietReportedDay === 'string' ? parsed.quietReportedDay : null,
            error: null,
        };
    } catch (err) {
        return { ...empty, error: err.message };
    }
}

/**
 * Write the intake state.
 *
 * @param {Object} state
 * @param {string} [stateFile]
 * @returns {{ written: boolean, error: string|null }}
 */
function writeState(state, stateFile = STATE_FILE) {
    try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        const { seen, recent, lastHeartbeatAt, quietReportedDay } = state;
        fs.writeFileSync(stateFile, JSON.stringify({ seen, recent, lastHeartbeatAt, quietReportedDay }, null, 2));
        return { written: true, error: null };
    } catch (err) {
        return { written: false, error: err.message };
    }
}

/**
 * Split a fetched batch into SqTools alerts and everything else.
 *
 * @param {Array} emails
 * @param {string[]} [senders]
 * @returns {{ sqtools: Array, rest: Array }}
 */
function partition(emails, senders = alerts.configuredSenders()) {
    const sqtools = [];
    const rest = [];
    for (const email of emails || []) {
        (alerts.isSqToolsAlert(email, senders) ? sqtools : rest).push(email);
    }
    return { sqtools, rest };
}

/**
 * The Slack text for a batch of new alerts. Returns null when nothing needs
 * saying (only liveness emails, and no quiet-heartbeat note).
 *
 * @param {Array} records - New alert records
 * @param {{ fallbackReason?: string|null, quietNote?: string|null, nagged?: Array }} [opts]
 * @returns {string|null}
 */
function formatAlertPost(records, { fallbackReason = null, quietNote = null, nagged = [] } = {}) {
    const shown = records.filter(r => r.severity !== alerts.SEVERITY.OK);
    const okCount = records.length - shown.length;
    if (shown.length === 0 && !quietNote && nagged.length === 0) return null;

    const needAck = shown.filter(r => r.needsAck).length;
    const routine = shown.length - needAck;
    const head = needAck > 0
        ? `:rotating_light: *SqTools alerts*: ${needAck} need you${routine ? `, ${routine} routine` : ''}`
        : `:inbox_tray: *SqTools reports*: ${routine} routine`;
    const lines = shown.length ? [head] : (quietNote ? [':warning: *SqTools alerting*'] : []);

    const order = [alerts.SEVERITY.ACTION, alerts.SEVERITY.REVIEW, alerts.SEVERITY.INFO];
    for (const severity of order) {
        for (const r of shown.filter(x => x.severity === severity)) {
            const when = r.receivedAt ? ` (${formatTimestamp(new Date(r.receivedAt))})` : '';
            const tag = r.needsAck ? `\`${ack.shortId(r.id)}\` ` : '';
            lines.push(`${ICON[severity]} ${tag}*${r.title}*: ${r.detail}${when}`);
            if (r.kind === 'cycle_count' && r.facts && r.facts.discrepancies !== null) {
                lines.push(`      ${r.facts.discrepancies} item(s) off${r.facts.totalVariance !== null ? `, ${r.facts.totalVariance} units total variance` : ''}`);
            }
            if (r.next) lines.push(`      _Next:_ ${r.next}`);
        }
    }
    if (okCount > 0) lines.push(`_Also ${okCount} liveness email(s) (Job OK, heartbeat), recorded and not shown._`);
    if (quietNote) lines.push(quietNote);
    lines.push(...ack.formatNagLines(nagged));
    if (needAck > 0 || nagged.length > 0) lines.push('_Use the buttons below, or in #claude-bridge: `ASK: ack <id> silence|nag|close`._');
    if (fallbackReason) lines.push(`_Posted here because ${fallbackReason}._`);
    return lines.join('\n');
}

/**
 * Handle the SqTools emails from one inbox check.
 *
 * @param {Object} input
 * @param {Array} input.emails - The SqTools emails (partition().sqtools)
 * @param {Object|null} input.slack - Slack client
 * @param {string|null} input.channelId - The secretary's channel
 * @param {string|null} [input.fallbackChannelId] - Where to post without one
 * @param {Date} [input.now]
 * @param {string} [input.stateFile]
 * @returns {Promise<{ ok: boolean, received: number, fresh: number, needAck: number, posted: boolean, channel: string|null, stateWritten: boolean, error: string|null }>}
 */
async function processSqToolsAlerts({ emails, slack, channelId, fallbackChannelId = null, now = new Date(), stateFile = STATE_FILE }) {
    const state = readState(stateFile);
    const received = (emails || []).length;

    const fresh = [];
    for (const email of emails || []) {
        if (email.id && state.seen[email.id]) continue;
        const c = alerts.classify(email);
        const receivedAt = email.date && !Number.isNaN(Date.parse(email.date)) ? new Date(email.date).toISOString() : null;
        fresh.push({ id: email.id || null, ...c, receivedAt, recordedAt: now.toISOString(), ack: null });
    }

    // Heartbeat: the newest one in this batch, and whether SqTools has gone quiet.
    for (const r of fresh.filter(x => x.kind === 'heartbeat')) {
        const at = r.receivedAt || r.recordedAt;
        if (!state.lastHeartbeatAt || at > state.lastHeartbeatAt) state.lastHeartbeatAt = at;
    }
    const today = dayKey(now, STORE_TIME_ZONE);
    let quietNote = null;
    if (state.lastHeartbeatAt && state.quietReportedDay !== today
        && now.getTime() - Date.parse(state.lastHeartbeatAt) > HEARTBEAT_QUIET_MS) {
        quietNote = `:warning: No SqTools daily heartbeat since ${formatTimestamp(new Date(state.lastHeartbeatAt))}. `
            + 'SqTools may be down, or its email may have stopped.';
    }

    const channel = channelId || fallbackChannelId || null;
    const fallbackReason = channelId ? null : 'the secretary\'s channel is not resolved in this workspace';
    const nagged = ack.dueNags(state, { now });
    const text = formatAlertPost(fresh, { fallbackReason, quietNote, nagged });
    const needAck = fresh.filter(r => r.needsAck).length;

    let posted = false;
    if (text) {
        if (!slack || !channel) {
            return { ok: false, received, fresh: fresh.length, needAck, posted: false, channel, stateWritten: false,
                error: `${fresh.length} SqTools alert(s) not posted: no Slack client or channel. They will be retried on the next check.` };
        }
        try {
            // LOGIC CHANGE 2026-11-07 (WORK-TODO #78): buttons per alert that needs the
            // owner, keyed by that alert's Gmail id (lib/sqtools-alert-buttons.js).
            const ackable = [...fresh.filter(r => r.needsAck && r.severity !== alerts.SEVERITY.OK), ...nagged];
            const blocks = buttons.buildAlertBlocks(text, ackable);
            await slack.chat.postMessage({ channel, text, blocks, unfurl_links: false });
            posted = true;
        } catch (err) {
            return { ok: false, received, fresh: fresh.length, needAck, posted: false, channel, stateWritten: false,
                error: `${fresh.length} SqTools alert(s) not posted (${err.message}). They will be retried on the next check.` };
        }
    }

    // Nothing new and nothing said: leave the file alone.
    if (fresh.length === 0 && !posted) {
        return { ok: true, received, fresh: 0, needAck: 0, posted: false, channel: null, stateWritten: false, error: state.error
            ? `SqTools alert state is unreadable (${state.error}); already-handled alerts may be posted again.` : null };
    }

    // Recorded only now that the post landed (or nothing needed posting). Re-read first:
    // an `ASK: ack` may have written the file while the post was in flight.
    const latest = readState(stateFile);
    if (!latest.error) {
        const freshIds = new Set(fresh.map(r => r.id).filter(Boolean));
        state.seen = { ...latest.seen, ...state.seen };
        state.recent = latest.recent.filter(r => !r.id || !freshIds.has(r.id));
        state.quietReportedDay = latest.quietReportedDay || state.quietReportedDay;
    }
    if (posted) ack.markNagged(state, nagged.map(r => r.id), now);
    const cutoff = now.getTime() - SEEN_RETENTION_MS;
    for (const [id, at] of Object.entries(state.seen)) {
        if (Date.parse(at) < cutoff) delete state.seen[id];
    }
    for (const r of fresh) if (r.id) state.seen[r.id] = r.recordedAt;
    state.recent = [...fresh, ...state.recent].slice(0, MAX_RECENT);
    if (quietNote && posted) state.quietReportedDay = today;

    const written = writeState(state, stateFile);
    return {
        ok: written.written,
        received,
        fresh: fresh.length,
        needAck,
        posted,
        channel: posted ? channel : null,
        stateWritten: written.written,
        error: written.written ? null
            : `SqTools alerts were posted but could not be recorded (${written.error}); the next check may post them again.`,
    };
}

/**
 * Recorded alerts received since `since`, newest first. For the secretary's
 * briefing context. An unreadable file is reported, never read as "no alerts".
 *
 * @param {Date} since
 * @param {string} [stateFile]
 * @returns {{ available: boolean, reason: string|null, alerts: Array }}
 */
function recentAlerts(since, stateFile = STATE_FILE) {
    const state = readState(stateFile);
    if (state.error) return { available: false, reason: state.error, alerts: [] };
    const floor = since.getTime();
    const list = state.recent.filter(r => Date.parse(r.receivedAt || r.recordedAt) >= floor);
    return { available: true, reason: null, alerts: list };
}

module.exports = {
    STATE_FILE,
    SEEN_RETENTION_MS,
    HEARTBEAT_QUIET_MS,
    MAX_RECENT,
    readState,
    writeState,
    partition,
    formatAlertPost,
    processSqToolsAlerts,
    recentAlerts,
};
