'use strict';

/**
 * lib/backlog-report.js
 *
 * THE parser for `WORK-TODO.md`. It turns the backlog into records so that "how long
 * has this been open" is a computation rather than someone's impression.
 *
 * LOGIC CHANGE 2026-09-16: New file, for the jester's weekly critique
 * (docs/JESTER-DESIGN.md, WORK-TODO #53). #53 named this signal itself: "items in this
 * file carrying a **Filed** date and still `Status: open` — how long each has been
 * open". An item deferred across many sessions is a FACT, and it is the sharpest thing
 * a critic without authority can hold. A model asked to notice it from a diff would
 * guess; this counts.
 *
 * PURE TEXT. It opens no socket, runs no subprocess and reads at most one file. The
 * git half of the same question — how many times the backlog was edited while an item
 * stayed open — lives in `lib/repo-history.js`, because that half needs a subprocess
 * and this half must stay testable against a string.
 *
 * The format it parses is the one WORK-TODO.md's own header declares: flat, one
 * `### N. Title` heading per open item, under a `## P1`/`## P2`/`## P3` tier heading,
 * with `**Filed YYYY-MM-DD**`, `**Priority:** Px` and `**Status:** …` in the body.
 * Anything it cannot parse is reported as unparsed rather than dropped — a backlog
 * item that silently vanishes from the critique is the failure this file would
 * otherwise introduce.
 */

const fs = require('fs');
const path = require('path');

const BACKLOG_FILE = path.join(__dirname, '..', 'WORK-TODO.md');

/** `### 12. Title` or `### 4b. Title` — the heading shape WORK-TODO.md declares. */
const ITEM_HEADING = /^### ([0-9]+[a-z]?)\. (.*)$/;

/** `## P1 — …` / `## P2 — …` / `## P3 — …` */
const TIER_HEADING = /^## (P[123])\b/;

/** `**Filed 2026-09-14,**` / `**Filed 2026-09-15.**` / `**Filed 2026-09-14**` */
const FILED = /\*\*Filed\s+(\d{4}-\d{2}-\d{2})/;

/**
 * `**Priority:** P2 | **Effort:** …`
 *
 * The LEADING value only. A conditional priority ("P2, or P1 if the deploy lands")
 * names several tiers in one line, and grepping for the word would count the item in
 * every tier it mentions.
 */
const PRIORITY = /\*\*Priority:\*\*\s*(P[123])/;

/** `**Status:** open — …` */
const STATUS = /\*\*Status:\*\*\s*(.+?)\s*$/;

/**
 * Whole days between two dates, floored. Both are treated as instants; a Filed date
 * with no time is midnight UTC, which is accurate to the day and no finer — which is
 * all a "filed on" date ever claimed.
 *
 * @param {string} filedISO - `YYYY-MM-DD`.
 * @param {Date} now - Clock.
 * @returns {number|null} Whole days, or null if the date does not parse.
 */
function ageDays(filedISO, now) {
    const t = Date.parse(`${filedISO}T00:00:00Z`);
    if (Number.isNaN(t)) return null;
    return Math.floor((now.getTime() - t) / 86400000);
}

/**
 * Does this status line read as open?
 *
 * Deliberately generous: WORK-TODO.md purges closed items, so anything still carrying
 * a heading is open by construction and the status line is prose about HOW open. A
 * status that says "closed" would be an item that should have been purged, and is
 * reported as such rather than silently counted.
 *
 * @param {string|null} status
 * @returns {boolean}
 */
function readsAsOpen(status) {
    if (!status) return true;
    return !/^\s*(closed|done|resolved|fixed|landed)\b/i.test(status);
}

/**
 * Parse the backlog text into records.
 *
 * @param {string} text - Contents of WORK-TODO.md.
 * @param {Date} [now] - Clock, for ageDays.
 * @returns {{ items: object[], tiers: object, unparsed: object[] }}
 */
function parseBacklog(text, now = new Date()) {
    const lines = String(text || '').split('\n');
    const items = [];
    const unparsed = [];

    let tier = null;
    let current = null;
    let body = [];

    /** Close the item being accumulated and push it. */
    const flush = () => {
        if (!current) return;
        const blob = body.join('\n');
        const filed = (blob.match(FILED) || [])[1] || null;
        const priority = (blob.match(PRIORITY) || [])[1] || null;
        const statusLine = blob.split('\n').map(l => (l.match(STATUS) || [])[1]).find(Boolean) || null;

        const record = {
            id: current.id,
            title: current.title,
            tier: current.tier,
            priority,
            filed,
            ageDays: filed ? ageDays(filed, now) : null,
            status: statusLine,
            open: readsAsOpen(statusLine),
        };
        items.push(record);
        // An item with no Filed date cannot be aged, which is the whole point of the
        // report. Say so rather than treating it as new or as ancient.
        if (!filed) unparsed.push({ id: record.id, title: record.title, reason: 'no **Filed** date' });
        current = null;
        body = [];
    };

    for (const line of lines) {
        const tierMatch = line.match(TIER_HEADING);
        if (tierMatch) {
            flush();
            tier = tierMatch[1];
            continue;
        }
        const itemMatch = line.match(ITEM_HEADING);
        if (itemMatch) {
            flush();
            current = { id: itemMatch[1], title: itemMatch[2].trim(), tier };
            continue;
        }
        if (current) body.push(line);
    }
    flush();

    const tiers = { P1: 0, P2: 0, P3: 0, untiered: 0 };
    for (const it of items) {
        const key = it.tier && Object.prototype.hasOwnProperty.call(tiers, it.tier) ? it.tier : 'untiered';
        tiers[key] += 1;
    }

    return { items, tiers, unparsed };
}

/**
 * Read and parse the repository's own backlog.
 *
 * A missing or unreadable file is reported as `available: false` with a reason. It is
 * NEVER reported as an empty backlog: "no open items" and "I could not read the file"
 * are opposite findings, and collapsing them is the class of failure
 * `lib/test-verdict.js` exists to prevent on the test side.
 *
 * @param {object} [options]
 * @param {string} [options.file] - Override path (tests).
 * @param {Date} [options.now] - Clock.
 * @returns {{ available: boolean, reason: string|null, items: object[], tiers: object, unparsed: object[] }}
 */
function loadBacklog(options = {}) {
    const file = options.file || BACKLOG_FILE;
    const now = options.now || new Date();
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return { available: false, reason: `could not read ${path.basename(file)}: ${err.message}`, items: [], tiers: { P1: 0, P2: 0, P3: 0, untiered: 0 }, unparsed: [] };
    }
    const parsed = parseBacklog(text, now);
    if (!parsed.items.length) {
        return { available: false, reason: `${path.basename(file)} parsed to zero items — the heading format may have changed`, ...parsed };
    }
    return { available: true, reason: null, ...parsed };
}

/**
 * The oldest open items, newest-filed last.
 *
 * @param {object[]} items - From parseBacklog.
 * @param {object} [options]
 * @param {number} [options.limit=5]
 * @param {number} [options.minAgeDays=0] - Only items at least this old.
 * @returns {object[]}
 */
function stalest(items, options = {}) {
    const { limit = 5, minAgeDays = 0 } = options;
    return (items || [])
        .filter(it => it.open && Number.isFinite(it.ageDays) && it.ageDays >= minAgeDays)
        .sort((a, b) => b.ageDays - a.ageDays)
        .slice(0, limit);
}

module.exports = {
    BACKLOG_FILE,
    parseBacklog,
    loadBacklog,
    stalest,
    // Exported for testing
    ageDays,
    readsAsOpen,
};
