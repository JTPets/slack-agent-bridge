'use strict';

/**
 * lib/critique-signals.js
 *
 * THE individual computed signals behind the jester's digest. One function per source;
 * each returns `{ available, reason, ... }` and NEVER collapses "I could not read it"
 * into "there was nothing there".
 *
 * LOGIC CHANGE 2026-09-16: New file, split out of `lib/critique-digest.js` in the same
 * change that created it — the combined module was 328 lines against this repository's
 * 300-line rule (`lib/file-size-gate.js`), and the seam is obvious: gathering a signal
 * and deciding what a week of them means are different jobs. `lib/critique-digest.js`
 * keeps the second and imports the first. See docs/JESTER-DESIGN.md section 3.
 *
 * Every function here takes its sources through a `deps` bag, so the whole digest is
 * computable in a test with no git, no queue file and no bulletin board.
 */

/** The critique is weekly; the digest window matches the schedule by default. */
const DEFAULT_WINDOW_DAYS = 7;

/**
 * The age at which an open item stops being "recent" and starts being deferred.
 *
 * It is a REPORTING threshold, not a filter. The oldest open items are always listed
 * with their ages; this decides how many of them get counted as deferred. Filtering on
 * it was the first implementation and it was wrong: every item in this backlog is
 * currently under three days old, so the sharpest signal in the digest came back empty
 * and the critique would have had nothing to say about a backlog with 48 open items.
 * An empty list from a threshold is indistinguishable from an empty backlog, which is
 * the collapse this whole module is built to avoid.
 */
const STALE_DAYS = 3;

/** How many of each list reach the prompt. A digest that lists everything is a log. */
const LIMITS = { stale: 6, failures: 5, slow: 3, bulletins: 5, merged: 5 };

/** A task is an outlier at this multiple of the median AND at least this many minutes. */
const OUTLIER_FACTOR = 3;
const OUTLIER_FLOOR_MIN = 5;

/**
 * Elapsed minutes between two ISO stamps, or null if either is missing/unparseable.
 *
 * @param {string|null} startedAt
 * @param {string|null} completedAt
 * @returns {number|null}
 */
function durationMinutes(startedAt, completedAt) {
    const a = Date.parse(startedAt || '');
    const b = Date.parse(completedAt || '');
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return Math.round(((b - a) / 60000) * 10) / 10;
}

/** @param {number[]} values @returns {number|null} */
function median(values) {
    const v = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10;
}

/**
 * Signal 1 + 2: the backlog, aged, joined to how often it was revised.
 *
 * @param {Date} now
 * @param {Date} since
 * @param {object} deps
 * @returns {object}
 */
function backlogSignal(now, since, deps) {
    const loaded = deps.backlog.loadBacklog({ now });
    if (!loaded.available) {
        return { available: false, reason: loaded.reason, open: 0, tiers: null, undated: 0, stale: [], staleThresholdDays: STALE_DAYS, overThreshold: 0, revisions: null };
    }
    const open = loaded.items.filter(i => i.open);
    const revisions = deps.history.revisionsSince('WORK-TODO.md', since);
    return {
        available: true,
        reason: null,
        open: open.length,
        tiers: loaded.tiers,
        // An item with no Filed date cannot be aged. That is a gap in the backlog's own
        // discipline and is surfaced as a count rather than quietly excluded.
        undated: loaded.unparsed.length,
        // Oldest first, UNFILTERED by STALE_DAYS — see the constant's comment.
        stale: deps.backlog.stalest(open, { limit: LIMITS.stale, minAgeDays: 0 })
            .map(i => ({ id: i.id, title: i.title, tier: i.tier, ageDays: i.ageDays, filed: i.filed })),
        staleThresholdDays: STALE_DAYS,
        overThreshold: open.filter(i => Number.isFinite(i.ageDays) && i.ageDays >= STALE_DAYS).length,
        revisions: revisions.available ? revisions.count : null,
        revisionsReason: revisions.available ? null : revisions.reason,
    };
}

/**
 * Signal 2 + 4: commit claims, and what landed.
 *
 * @param {Date} since
 * @param {object} deps
 * @returns {object}
 */
function historySignal(since, deps) {
    const log = deps.history.commitsSince(since);
    if (!log.available) {
        return {
            available: false, reason: log.reason, commits: 0,
            closes: [], addresses: [], repeatedlyAddressed: [], merged: [],
        };
    }
    const claims = deps.history.claimsFrom(log.commits);
    return {
        available: true,
        reason: null,
        commits: log.commits.length,
        closes: claims.closes,
        addresses: claims.addresses,
        repeatedlyAddressed: claims.repeatedlyAddressed,
        merged: log.commits.slice(0, LIMITS.merged).map(c => ({ sha: c.shortSha, subject: c.subject, date: c.date })),
    };
}

/**
 * Signal 3: task outcomes from the queue.
 *
 * The coverage window is reported alongside the counts BECAUSE the queue retains 24
 * hours (`COMPLETED_RETENTION_MS`) and the critique is weekly. Without it a quiet
 * section reads as "nothing failed this week" when it means "the queue only remembers
 * yesterday" — the exact false-green this repository treats as its worst defect class.
 *
 * @param {object} deps
 * @returns {object}
 */
function taskSignal(deps) {
    let rows;
    try {
        rows = deps.queue.getRecentCompleted(100);
    } catch (err) {
        return { available: false, reason: `could not read the task queue: ${err.message}`, counts: null, failures: [], reattempted: [], slow: [], medianMinutes: null };
    }
    rows = Array.isArray(rows) ? rows : [];

    const counts = { completed: 0, failed: 0, interrupted: 0 };
    for (const r of rows) if (counts[r.status] !== undefined) counts[r.status] += 1;

    const durations = rows.map(r => durationMinutes(r.startedAt, r.completedAt)).filter(Number.isFinite);
    const med = median(durations);

    const slow = med === null ? [] : rows
        .map(r => ({ description: r.description, minutes: durationMinutes(r.startedAt, r.completedAt), status: r.status }))
        .filter(r => Number.isFinite(r.minutes) && r.minutes >= OUTLIER_FLOOR_MIN && r.minutes >= med * OUTLIER_FACTOR)
        .sort((a, b) => b.minutes - a.minutes)
        .slice(0, LIMITS.slow);

    return {
        available: true,
        reason: null,
        retentionHours: 24,
        rows: rows.length,
        counts,
        failures: rows.filter(r => r.status === 'failed' || r.status === 'interrupted')
            .slice(0, LIMITS.failures)
            .map(r => ({ description: r.description, status: r.status, error: r.error, attempts: r.attempts || 1 })),
        reattempted: rows.filter(r => (r.attempts || 1) > 1)
            .slice(0, LIMITS.failures)
            .map(r => ({ description: r.description, attempts: r.attempts, previousStatus: r.previousStatus || null })),
        slow,
        medianMinutes: med,
        outlierRule: `at least ${OUTLIER_FACTOR}x the median and at least ${OUTLIER_FLOOR_MIN} minutes`,
    };
}

/**
 * Signal 6: bulletins in the window.
 *
 * `unreadBy` is deliberately NOT applied. Nothing in production calls `markRead`
 * (docs/JESTER-DESIGN.md section 1.2), so the filter passes everything today and would
 * begin silently hiding material the day anything calls it. A critique that quietly
 * stops seeing its own input is the failure mode; asking for the window explicitly is
 * not.
 *
 * @param {Date} since
 * @param {object} deps
 * @returns {object}
 */
function bulletinSignal(since, deps) {
    try {
        const list = deps.bulletins.getBulletins({ since: since.toISOString(), limit: LIMITS.bulletins }) || [];
        return {
            available: true,
            reason: null,
            items: list.map(b => ({
                type: b.type,
                agentId: b.agentId,
                timestamp: b.timestamp,
                summary: deps.bulletins.formatBulletinData ? deps.bulletins.formatBulletinData(b.data, 120) : '',
            })),
        };
    } catch (err) {
        return { available: false, reason: `could not read the bulletin board: ${err.message}`, items: [] };
    }
}

/**
 * Signal 5: declared output with no reader.
 *
 * @param {object} deps
 * @returns {object}
 */
function orphanSignal(deps) {
    try {
        return { available: true, reason: null, items: deps.surface.findOrphans(deps.surface.buildSurface()) };
    } catch (err) {
        return { available: false, reason: `could not build the agent surface: ${err.message}`, items: [] };
    }
}

module.exports = {
    DEFAULT_WINDOW_DAYS,
    STALE_DAYS,
    LIMITS,
    OUTLIER_FACTOR,
    OUTLIER_FLOOR_MIN,
    durationMinutes,
    median,
    backlogSignal,
    historySignal,
    taskSignal,
    bulletinSignal,
    orphanSignal,
};
