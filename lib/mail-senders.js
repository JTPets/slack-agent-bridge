/**
 * lib/mail-senders.js
 *
 * The sender ledger: one entry per bulk-mail sender the inbox check has seen, with how
 * often it writes, the signals that marked it as bulk, the newest unsubscribe link it
 * published, and the owner's verdict on it.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #88, phase 1): new file. The owner: "i get a lot of
 * junk, i need her to start to learn how to filter out the noise". Phase 1 keeps what
 * the inbox already says (lib/integrations/bulk-mail.js, attached to each fetched email
 * by lib/integrations/gmail.js) so the owner can see his noisiest senders and their
 * unsubscribe links (`ASK: unsubscribe`), and record what he did about each
 * (`ASK: sender <id> unsubscribed|keep`). Those verdicts are the first thing phase 2's
 * learning reads; nothing here classifies on its own beyond the published signals.
 *
 * One sender is one entry, keyed by the lower-cased From address. Only BULK mail is
 * recorded (at least one signal), so a person who writes to the owner is never listed.
 * Nothing here is ever sent to a model. The display name is untrusted text and is
 * stored capped and on one line; it is escaped where it is rendered.
 *
 * File: agents/secretary/memory/mail-senders.json (gitignored by agents/*\/memory/*).
 * Written temp-then-rename, so a crash mid-write cannot truncate it (the durability gap
 * docs/CANONICAL-HELPERS.md §7 records for the other stores; the shared extraction is
 * that section's job, not this item's). Under jest the default file is never written:
 * a test passes its own `file`.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'agents', 'secretary', 'memory', 'mail-senders.json');
/** The verdicts phase 1 records. Phase 2 adds important / noise. */
const VERDICTS = ['unsubscribed', 'keep'];
/** An undecided sender not seen for this long is forgotten. A verdict is kept. */
const FORGET_AFTER_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SENDERS = 2000;

const empty = () => ({ senders: {} });

/**
 * Read the ledger. A missing file is an empty ledger; an unreadable one is an error,
 * never an empty ledger, so a broken file is not mistaken for a quiet inbox.
 * @param {string} [file]
 * @returns {{ state: { senders: Object }, error: string|null }}
 */
function readLedger(file = STATE_FILE) {
    try {
        if (!fs.existsSync(file)) return { state: empty(), error: null };
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const senders = parsed && typeof parsed.senders === 'object' && parsed.senders ? parsed.senders : null;
        if (!senders) return { state: empty(), error: 'the file has no `senders` map' };
        return { state: { senders }, error: null };
    } catch (err) {
        return { state: empty(), error: err.message };
    }
}

/**
 * Write the ledger, temp-then-rename.
 * @returns {{ written: boolean, error: string|null }}
 */
function writeLedger(state, file = STATE_FILE) {
    if (process.env.JEST_WORKER_ID && file === STATE_FILE) {
        return { written: false, error: 'refused: a test may not write the live sender ledger' };
    }
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify({ senders: state.senders }, null, 2));
        fs.renameSync(tmp, file);
        return { written: true, error: null };
    } catch (err) {
        fs.rmSync(tmp, { force: true });
        return { written: false, error: err.message };
    }
}

/** Fold one bulk email into the ledger, in place. */
function foldEmail(senders, bulk, at) {
    const { address, name } = bulk.sender;
    const entry = senders[address] || {
        address, name, count: 0, firstSeen: at, lastSeen: at, signals: [], unsubscribe: null,
        verdict: null, verdictAt: null, seenSinceVerdict: 0,
    };
    entry.name = name || entry.name;
    entry.count += 1;
    if (at > entry.lastSeen) entry.lastSeen = at;
    if (at < entry.firstSeen) entry.firstSeen = at;
    entry.signals = [...new Set([...entry.signals, ...bulk.signals])].sort();
    if (bulk.unsubscribe) entry.unsubscribe = { ...bulk.unsubscribe, seenAt: at };
    if (entry.verdictAt && at > entry.verdictAt) entry.seenSinceVerdict = (entry.seenSinceVerdict || 0) + 1;
    senders[address] = entry;
}

/** Forget stale undecided senders, then cap the ledger (oldest undecided first). */
function prune(senders, now) {
    const cutoff = new Date(now.getTime() - FORGET_AFTER_MS).toISOString();
    for (const [key, e] of Object.entries(senders)) {
        if (!e.verdict && e.lastSeen < cutoff) delete senders[key];
    }
    const keys = Object.keys(senders);
    if (keys.length <= MAX_SENDERS) return;
    keys.sort((a, b) => (Boolean(senders[b].verdict) - Boolean(senders[a].verdict)) || senders[b].lastSeen.localeCompare(senders[a].lastSeen))
        .slice(MAX_SENDERS).forEach(k => delete senders[k]);
}

/**
 * Record the bulk mail in one fetched batch. Emails without a `bulk` description, or
 * with no signal or no parseable sender, are not recorded. Nothing is written when
 * nothing was recorded. A Gmail id already counted is not counted twice (the check's
 * window can overlap the previous one).
 *
 * @param {Array<Object>} emails - lib/integrations/gmail.js fetchRecentEmails() emails
 * @param {{ now?: Date, file?: string }} [opts]
 * @returns {{ recorded: number, written: boolean, error: string|null }}
 */
function recordBulkMail(emails, { now = new Date(), file = STATE_FILE } = {}) {
    const bulk = (emails || []).filter(e => e?.bulk?.isBulk && e.bulk.sender?.address);
    if (bulk.length === 0) return { recorded: 0, written: false, error: null };
    const { state, error } = readLedger(file);
    // An unreadable ledger is not overwritten: that would erase every verdict.
    if (error) return { recorded: 0, written: false, error: `sender ledger unreadable: ${error}` };
    const at = now.toISOString();
    let recorded = 0;
    for (const email of bulk) {
        const entry = state.senders[email.bulk.sender.address];
        if (entry && email.id && (entry.lastIds || []).includes(email.id)) continue;
        foldEmail(state.senders, email.bulk, at);
        const e = state.senders[email.bulk.sender.address];
        e.lastIds = [...(e.lastIds || []), email.id].filter(Boolean).slice(-20);
        recorded++;
    }
    prune(state.senders, now);
    if (recorded === 0) return { recorded: 0, written: false, error: null };
    const w = writeLedger(state, file);
    return { recorded, written: w.written, error: w.error };
}

/** A short stable id for a sender, for the verb: the first 8 hex of a hash of the address. */
function senderId(address) {
    return crypto.createHash('sha256').update(address).digest('hex').slice(0, 8);
}

/**
 * Record the owner's verdict on the sender a short id names.
 * @returns {{ ok: boolean, entry?: Object, error?: string }}
 */
function setVerdict(id, verdict, { now = new Date(), file = STATE_FILE, userId = null } = {}) {
    if (!VERDICTS.includes(verdict)) return { ok: false, error: `Unknown verdict \`${verdict}\`. Use one of: ${VERDICTS.join(', ')}.` };
    if (!/^[0-9a-f]{3,8}$/i.test(String(id || ''))) return { ok: false, error: 'A sender id is 3 to 8 hex characters, as `ASK: unsubscribe` shows it.' };
    const { state, error } = readLedger(file);
    if (error) return { ok: false, error: `The sender ledger cannot be read: ${error}. Nothing was recorded.` };
    const hits = Object.values(state.senders).filter(e => senderId(e.address).startsWith(id.toLowerCase()));
    if (hits.length !== 1) return { ok: false, error: hits.length ? `\`${id}\` matches ${hits.length} senders; give all 8 characters.` : `No recorded sender has the id \`${id}\`.` };
    const entry = hits[0];
    Object.assign(entry, { verdict, verdictAt: now.toISOString(), verdictBy: userId, seenSinceVerdict: 0 });
    const w = writeLedger(state, file);
    return w.written ? { ok: true, entry } : { ok: false, error: `The verdict could not be written: ${w.error}` };
}

module.exports = {
    readLedger, writeLedger, recordBulkMail, setVerdict, senderId,
    STATE_FILE, VERDICTS, FORGET_AFTER_MS, MAX_SENDERS,
};
