/**
 * lib/social-insights.js
 *
 * The daily snapshot of every platform's numbers, kept as history, and the weekly
 * digest computed from it: the things a person checking each app would not notice.
 *
 * LOGIC CHANGE 2026-11-09: created (owner, 2026-11-09: "interact with our follower
 * counts, followers, etc and find out information we wouldnt otherwise catch").
 *
 * Platforms show today's numbers, not a history, so the history is ours:
 * agents/shared/social-metrics.json (gitignored), one snapshot per Toronto day,
 * RETENTION_DAYS kept. The digest is computed, not written by a model, so every line
 * in it is a fact from a snapshot. A section whose source was unavailable says so; it
 * is never rendered as zero.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { STORE_TIME_ZONE, dayKey, addDays } = require('./time-format');

const DEFAULT_METRICS_FILE = path.join(__dirname, '..', 'agents', 'shared', 'social-metrics.json');
const RETENTION_DAYS = 400;
const LABELS = { facebook: 'Facebook', instagram: 'Instagram', gbp: 'Google Business', bluesky: 'Bluesky' };

function readHistory(file = DEFAULT_METRICS_FILE) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && parsed.days && typeof parsed.days === 'object' ? parsed : { days: {} };
    } catch (err) {
        if (err.code === 'ENOENT') return { days: {} };
        throw err;
    }
}

/** Store today's snapshot (replacing an earlier one the same day) and drop old days. */
function recordSnapshot(snapshot, { file = DEFAULT_METRICS_FILE, now = new Date() } = {}) {
    const history = readHistory(file);
    const today = dayKey(now, STORE_TIME_ZONE);
    history.days[today] = { at: now.toISOString(), platforms: snapshot };
    const cutoff = addDays(today, -RETENTION_DAYS);
    for (const key of Object.keys(history.days)) if (key < cutoff) delete history.days[key];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, file);
    return today;
}

/** The snapshot on or before `key`, searching back up to 3 days (a missed run). */
function snapshotNear(history, key) {
    for (let i = 0; i <= 3; i += 1) {
        const k = addDays(key, -i);
        if (history.days[k]) return { key: k, ...history.days[k] };
    }
    return null;
}

function followers(snap, id) {
    const p = snap && snap.platforms && snap.platforms[id];
    return p && p.account && p.account.available && typeof p.account.followers === 'number' ? p.account.followers : null;
}

function signed(n) { return n > 0 ? `+${n}` : `${n}`; }

function engagement(post) { return (post.likes || 0) + (post.comments || 0) * 2 + (post.shares || 0) * 3; }

/** Every post seen in the week's snapshots for a platform, deduplicated, newest numbers kept. */
function weekPosts(history, keys, id) {
    const byId = new Map();
    for (const k of keys) {
        const p = history.days[k] && history.days[k].platforms && history.days[k].platforms[id];
        if (p && p.posts && p.posts.available) for (const post of p.posts.items || []) byId.set(post.id, post);
    }
    return [...byId.values()];
}

/**
 * The weekly digest text from the history.
 * @returns {{ text: string, thin: boolean }}
 */
function buildWeeklyDigest(history, { now = new Date() } = {}) {
    const today = dayKey(now, STORE_TIME_ZONE);
    const latest = snapshotNear(history, today);
    if (!latest) return { text: ':information_source: Social digest: no snapshot has been recorded yet, so there is nothing to compare.', thin: true };
    const before = snapshotNear(history, addDays(today, -7));
    const keys = Array.from({ length: 7 }, (_, i) => addDays(today, -i)).filter(k => history.days[k]);
    const lines = [`*Social media this week* (${keys.length} daily snapshot${keys.length === 1 ? '' : 's'}${before ? `, compared with ${before.key}` : ', no snapshot from a week ago to compare with yet'})`];

    for (const id of Object.keys(LABELS)) {
        const p = latest.platforms[id];
        if (!p || p.notConfigured) { lines.push(`• ${LABELS[id]}: not set up`); continue; }
        if (p.account && p.account.available === false) { lines.push(`• ${LABELS[id]}: could not be read (${p.account.reason})`); continue; }
        const current = followers(latest, id);
        const then = followers(before, id);
        let line = `• ${LABELS[id]}:`;
        if (current !== null) line += ` ${current} followers${then !== null ? ` (${signed(current - then)} this week)` : ''}`;
        const best = weekPosts(history, keys, id).sort((a, b) => engagement(b) - engagement(a))[0];
        if (best && engagement(best) > 0) {
            line += `. Best post: ${best.url ? `<${best.url}|"${best.text.slice(0, 50)}">` : `"${best.text.slice(0, 50)}"`} (${best.likes || 0} likes, ${best.comments || 0} comments)`;
        }
        lines.push(line);
    }

    lines.push(...instagramPeople(history, keys, latest), ...blueskyPeople(latest, before), ...googleLines(latest, before));
    const thin = lines.length <= 1 + Object.keys(LABELS).length && !before;
    return { text: lines.join('\n'), thin };
}

/** Comments nobody answered, and people who commented more than once this week. */
function instagramPeople(history, keys, latest) {
    const out = [];
    const ig = latest.platforms.instagram;
    if (!ig || !ig.comments) return out;
    if (!ig.comments.available) return [`• Instagram comments could not be read (${ig.comments.reason})`];
    const unanswered = (ig.comments.items || []).filter(c => !c.answered);
    if (unanswered.length) {
        out.push(`• *${unanswered.length} Instagram comment${unanswered.length === 1 ? '' : 's'} with no reply:* ` +
            unanswered.slice(0, 5).map(c => `@${c.user} "${c.text.slice(0, 40)}"`).join('; '));
    }
    const seen = new Map();
    for (const k of keys) {
        const c = history.days[k].platforms.instagram && history.days[k].platforms.instagram.comments;
        for (const item of (c && c.available && c.items) || []) seen.set(item.id, item.user);
    }
    const perUser = {};
    for (const user of seen.values()) if (user) perUser[user] = (perUser[user] || 0) + 1;
    const fans = Object.entries(perUser).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    if (fans.length) out.push(`• Regulars on Instagram (2+ comments): ${fans.slice(0, 5).map(([u, n]) => `@${u} (${n})`).join(', ')}`);
    return out;
}

/** Bluesky names its followers, so new and lost ones can be listed. */
function blueskyPeople(latest, before) {
    const now = latest.platforms.bluesky && latest.platforms.bluesky.followers;
    const then = before && before.platforms.bluesky && before.platforms.bluesky.followers;
    if (!now || !now.available || !then || !then.available) return [];
    const was = new Set(then.handles);
    const is = new Set(now.handles);
    const gained = now.handles.filter(h => !was.has(h));
    const lost = then.handles.filter(h => !is.has(h));
    const out = [];
    if (gained.length) out.push(`• New on Bluesky: ${gained.slice(0, 10).map(h => `@${h}`).join(', ')}`);
    if (lost.length) out.push(`• Unfollowed on Bluesky: ${lost.slice(0, 10).map(h => `@${h}`).join(', ')}`);
    return out;
}

/** Reviews nobody answered, and the listing's week against the week before. */
function googleLines(latest, before) {
    const g = latest.platforms.gbp;
    if (!g || g.notConfigured) return [];
    const out = [];
    if (g.reviews && g.reviews.available) {
        const unanswered = (g.reviews.items || []).filter(r => !r.answered);
        out.push(`• Google reviews: ${g.reviews.rating ?? '?'} stars from ${g.reviews.total ?? '?'}` +
            (unanswered.length ? `. *${unanswered.length} with no reply:* ${unanswered.slice(0, 3).map(r => `${r.user} (${r.stars}★)`).join(', ')}` : ', all answered'));
    } else if (g.reviews) {
        out.push(`• Google reviews could not be read (${g.reviews.reason})`);
    }
    if (g.week && g.week.available) {
        const prev = before && before.platforms.gbp && before.platforms.gbp.week && before.platforms.gbp.week.available ? before.platforms.gbp.week : null;
        const cmp = (k) => (prev ? ` (${signed(g.week[k] - prev[k])})` : '');
        out.push(`• Google listing ${g.week.from} to ${g.week.to}: ${g.week.views} views${cmp('views')}, ${g.week.calls} calls${cmp('calls')}, ${g.week.directions} direction requests${cmp('directions')}, ${g.week.websiteClicks} website clicks${cmp('websiteClicks')}`);
    }
    return out;
}

module.exports = {
    DEFAULT_METRICS_FILE, RETENTION_DAYS, LABELS,
    readHistory, recordSnapshot, snapshotNear, buildWeeklyDigest,
};
