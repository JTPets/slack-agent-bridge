'use strict';

/**
 * lib/high-notices.js
 *
 * WORK-TODO #37: the store behind PRIORITY.HIGH. Until now a HIGH notification was
 * logged and reported as delivered (`return true`), so the owner received nothing and
 * the caller was told it worked. The owner's answer of 2026-11-08: "build the digest and
 * it should be pushed to slack and we can have one of our agents read and diagnose next
 * steps for approval." This file is the durable half: notify-owner.js records each HIGH
 * notice here, and lib/high-digest.js posts the undigested ones and marks them.
 *
 * LOGIC CHANGE 2026-11-09: new file.
 *
 * Where: `$WORK_DIR/high-notices.json`. WORK_DIR is a bind mount on the box (WORK-TODO
 * #25), so a notice recorded before a restart is still posted after it. Kept bounded:
 * digested notices older than RETAIN_MS are dropped on the next write.
 *
 * A write that fails returns { recorded: false, error } and never throws, so the caller
 * can fall back to posting the notice directly rather than lose it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', 'high-notices.json');
const RETAIN_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 2000;

let file = DEFAULT_FILE;

/** Tests point the store at a temp file. */
function init(options = {}) {
    file = options.file || DEFAULT_FILE;
}

function read() {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(parsed.notices) ? parsed : { notices: [] };
    } catch (err) {
        if (err.code === 'ENOENT') return { notices: [] };
        throw err;
    }
}

function write(state, now) {
    const keepAfter = now - RETAIN_MS;
    state.notices = state.notices.filter(n => !n.digestedAt || Date.parse(n.digestedAt) >= keepAfter);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

/**
 * Record one HIGH notice.
 * @returns {{ recorded: boolean, id?: string, error?: string }}
 */
function record(text, { source = 'notify-owner', now = Date.now() } = {}) {
    try {
        const state = read();
        const id = crypto.randomBytes(4).toString('hex');
        state.notices.push({ id, text: String(text).slice(0, MAX_TEXT), source, at: new Date(now).toISOString(), digestedAt: null });
        write(state, now);
        return { recorded: true, id };
    } catch (err) {
        return { recorded: false, error: err.message };
    }
}

/** Notices not yet posted in a digest, oldest first. Throws on an unreadable store. */
function undigested() {
    return read().notices.filter(n => !n.digestedAt);
}

/** Mark the given ids digested. Throws on a failed write, so a digest is never posted twice silently. */
function markDigested(ids, now = Date.now()) {
    const wanted = new Set(ids);
    const state = read();
    for (const n of state.notices) if (wanted.has(n.id)) n.digestedAt = new Date(now).toISOString();
    write(state, now);
}

module.exports = { init, record, undigested, markDigested, DEFAULT_FILE, RETAIN_MS };
