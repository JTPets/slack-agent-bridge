/**
 * lib/social-platforms.js
 *
 * THE list of social platforms the bridge can publish to and read from, and the two
 * operations over all of them: publish one approved draft everywhere it can go, and
 * read every platform's numbers for the daily snapshot.
 *
 * LOGIC CHANGE 2026-11-09: created (owner's choice 2026-11-09: Facebook, Instagram,
 * Google Business Profile, Bluesky).
 *
 * A platform with no credentials is SKIPPED and named as skipped, never attempted and
 * never reported as published. One platform failing does not stop the others, and
 * each result is reported on its own.
 */

'use strict';

const meta = require('./social-meta');
const bluesky = require('./social-bluesky');
const gbp = require('./social-gbp');

const PLATFORMS = [
    {
        id: 'facebook', label: 'Facebook',
        configured: (env) => meta.facebookConfigured(env),
        readable: (env) => meta.facebookConfigured(env),
        publish: (d, o) => meta.publishFacebook({ text: d.text, imageUrl: d.imageUrl, link: d.link }, o),
        read: (o) => meta.readFacebook(o),
        needs: 'META_PAGE_ACCESS_TOKEN, META_PAGE_ID',
    },
    {
        id: 'instagram', label: 'Instagram',
        configured: (env) => meta.instagramConfigured(env),
        readable: (env) => meta.instagramConfigured(env),
        publish: (d, o) => meta.publishInstagram({ text: d.text, imageUrl: d.imageUrl }, o),
        read: (o) => meta.readInstagram(o),
        needs: 'META_PAGE_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ID',
    },
    {
        id: 'gbp', label: 'Google Business',
        configured: (env) => gbp.gbpConfigured(env),
        readable: (env) => gbp.gbpConfigured(env),
        publish: (d, o) => gbp.publishGbp({ text: d.text, imageUrl: d.imageUrl, link: d.link }, o),
        read: (o) => gbp.readGbp(o),
        needs: 'GBP_ACCOUNT_ID, GBP_LOCATION_ID, GBP_REFRESH_TOKEN (+ GOOGLE_CLIENT_ID/SECRET)',
    },
    {
        id: 'bluesky', label: 'Bluesky',
        configured: (env) => bluesky.blueskyConfigured(env),
        readable: (env) => bluesky.blueskyReadable(env),
        publish: (d, o) => bluesky.publishBluesky({ text: d.short || d.text, imageUrl: d.imageUrl, alt: d.itemName }, o),
        read: (o) => bluesky.readBluesky(o),
        needs: 'BLUESKY_HANDLE, BLUESKY_APP_PASSWORD',
    },
];

function getPlatform(id) {
    return PLATFORMS.find(p => p.id === id) || null;
}

/** Which platforms can publish, and which cannot and why. Names only, never values. */
function publishTargets(env = process.env) {
    const ready = [];
    const skipped = [];
    for (const p of PLATFORMS) {
        if (p.configured(env)) ready.push(p.id); else skipped.push({ id: p.id, label: p.label, needs: p.needs });
    }
    return { ready, skipped };
}

/**
 * Publish one approved draft to every configured platform.
 *
 * @param {{ text: string, short?: string, imageUrl?: string, link?: string, itemName?: string }} draft
 * @returns {Promise<Array<{ platform: string, label: string, status: 'published'|'failed'|'skipped', url?: string|null, id?: string, error?: string }>>}
 *   never rejects
 */
async function publishEverywhere(draft, { env = process.env, fetchImpl, now } = {}) {
    const results = [];
    for (const p of PLATFORMS) {
        if (!p.configured(env)) {
            results.push({ platform: p.id, label: p.label, status: 'skipped', error: `not set up (${p.needs})` });
            continue;
        }
        try {
            const out = await p.publish(draft, { env, fetchImpl, now });
            results.push({ platform: p.id, label: p.label, status: 'published', id: out.id, url: out.url || null });
        } catch (err) {
            results.push({ platform: p.id, label: p.label, status: 'failed', error: err.message });
        }
    }
    return results;
}

/**
 * Read every readable platform. A platform that is not set up is listed as such; a
 * platform whose read threw is `{ available: false, reason }`.
 * @returns {Promise<object>} keyed by platform id; never rejects
 */
async function readEverything({ env = process.env, fetchImpl, now } = {}) {
    const out = {};
    for (const p of PLATFORMS) {
        if (!p.readable(env)) {
            out[p.id] = { platform: p.id, notConfigured: true, needs: p.needs };
            continue;
        }
        try {
            out[p.id] = await p.read({ env, fetchImpl, now });
        } catch (err) {
            out[p.id] = { platform: p.id, account: { available: false, reason: err.message } };
        }
    }
    return out;
}

/** One line per platform result, for the Slack post after a publish. */
function formatPublishResults(results) {
    return results.map((r) => {
        if (r.status === 'published') return `:white_check_mark: ${r.label}: published${r.url ? ` <${r.url}|view>` : ''}`;
        if (r.status === 'failed') return `:x: ${r.label}: failed, ${r.error}`;
        return `:heavy_minus_sign: ${r.label}: skipped, ${r.error}`;
    }).join('\n');
}

module.exports = {
    PLATFORMS,
    getPlatform,
    publishTargets,
    publishEverywhere,
    readEverything,
    formatPublishResults,
};
