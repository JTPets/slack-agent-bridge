/**
 * lib/social-bluesky.js
 *
 * Bluesky publishing and reading over the AT Protocol's XRPC endpoints.
 *
 * LOGIC CHANGE 2026-11-09: created (owner's choice 2026-11-09).
 *
 * Configuration, names only:
 *   BLUESKY_HANDLE        e.g. jtpets.bsky.social
 *   BLUESKY_APP_PASSWORD  an APP password (Settings -> Privacy and security -> App
 *                         passwords), never the account password. It can be revoked
 *                         on its own.
 *   BLUESKY_PDS           where the account lives, default https://bsky.social
 *
 * Reading needs no credential at all: profile, recent posts and the follower list are
 * public on Bluesky's AppView, which is the one platform here that names followers.
 * A post is limited to 300 graphemes; a longer text is REFUSED, never cut.
 */

'use strict';

const { requestJson, fetchBytes, SocialApiError } = require('./social-http');

const DEFAULT_PDS = 'https://bsky.social';
const APPVIEW = 'https://public.api.bsky.app';
const MAX_GRAPHEMES = 300;

function blueskyConfig(env = process.env) {
    return {
        handle: (env.BLUESKY_HANDLE || '').replace(/^@/, ''),
        password: env.BLUESKY_APP_PASSWORD || '',
        pds: (env.BLUESKY_PDS || DEFAULT_PDS).replace(/\/+$/, ''),
    };
}

function blueskyConfigured(env) { const c = blueskyConfig(env); return Boolean(c.handle && c.password); }
function blueskyReadable(env) { return Boolean(blueskyConfig(env).handle); }

function graphemeCount(text) {
    const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
    let n = 0;
    for (const _ of seg.segment(String(text))) n += 1; // eslint-disable-line no-unused-vars
    return n;
}

/** The web link for an at:// post URI. */
function postUrl(handle, uri) {
    const rkey = String(uri || '').split('/').pop();
    return rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
}

/**
 * Publish one post, with the item's photo when there is one.
 * @returns {Promise<{ id: string, url: string|null }>}
 */
async function publishBluesky({ text, imageUrl, alt }, { env, fetchImpl, now = new Date() } = {}) {
    const cfg = blueskyConfig(env);
    if (!blueskyConfigured(env)) throw new SocialApiError('Bluesky is not configured (BLUESKY_HANDLE, BLUESKY_APP_PASSWORD)', { platform: 'bluesky' });
    const length = graphemeCount(text);
    if (length > MAX_GRAPHEMES) {
        throw new SocialApiError(`Bluesky allows ${MAX_GRAPHEMES} characters and this text has ${length}; edit the short version`, { platform: 'bluesky' });
    }
    const session = await requestJson({
        platform: 'bluesky', url: `${cfg.pds}/xrpc/com.atproto.server.createSession`, method: 'POST',
        json: { identifier: cfg.handle, password: cfg.password }, fetchImpl,
    });
    if (!session.accessJwt || !session.did) throw new SocialApiError('Bluesky sign-in returned no session', { platform: 'bluesky' });

    const record = { $type: 'app.bsky.feed.post', text, createdAt: now.toISOString(), langs: ['en'] };
    if (imageUrl) {
        const img = await fetchBytes({ platform: 'bluesky', url: imageUrl, fetchImpl });
        const uploaded = await requestJson({
            platform: 'bluesky', url: `${cfg.pds}/xrpc/com.atproto.repo.uploadBlob`, method: 'POST',
            token: session.accessJwt, raw: img.bytes, contentType: img.contentType, fetchImpl,
        });
        if (!uploaded.blob) throw new SocialApiError('Bluesky image upload returned no blob', { platform: 'bluesky' });
        record.embed = { $type: 'app.bsky.embed.images', images: [{ alt: alt || '', image: uploaded.blob }] };
    }
    const created = await requestJson({
        platform: 'bluesky', url: `${cfg.pds}/xrpc/com.atproto.repo.createRecord`, method: 'POST',
        token: session.accessJwt, json: { repo: session.did, collection: 'app.bsky.feed.post', record }, fetchImpl,
    });
    if (!created.uri) throw new SocialApiError('Bluesky accepted the post but returned no uri', { platform: 'bluesky' });
    return { id: created.uri, url: postUrl(session.handle || cfg.handle, created.uri) };
}

async function section(fn) {
    try {
        return { available: true, ...(await fn()) };
    } catch (err) {
        return { available: false, reason: err.message };
    }
}

/** Profile counts, last 10 posts, and the newest 100 followers (handles), all public. */
async function readBluesky({ env, fetchImpl } = {}) {
    const cfg = blueskyConfig(env);
    const actor = encodeURIComponent(cfg.handle);
    const get = (method, query) => requestJson({ platform: 'bluesky', url: `${APPVIEW}/xrpc/${method}?${query}`, fetchImpl });
    const account = await section(async () => {
        const p = await get('app.bsky.actor.getProfile', `actor=${actor}`);
        return { name: p.handle || cfg.handle, followers: p.followersCount ?? null, posts: p.postsCount ?? null };
    });
    const posts = await section(async () => {
        const r = await get('app.bsky.feed.getAuthorFeed', `actor=${actor}&limit=10&filter=posts_no_replies`);
        return { items: (r.feed || []).map(f => f.post).filter(Boolean).map(p => ({
            id: p.uri, text: ((p.record && p.record.text) || '').slice(0, 120), at: (p.record && p.record.createdAt) || p.indexedAt || null,
            url: postUrl(cfg.handle, p.uri), likes: p.likeCount ?? null, comments: p.replyCount ?? null, shares: p.repostCount ?? null,
        })) };
    });
    const followers = await section(async () => {
        const r = await get('app.bsky.graph.getFollowers', `actor=${actor}&limit=100`);
        return { handles: (r.followers || []).map(f => f.handle).filter(Boolean) };
    });
    return { platform: 'bluesky', account, posts, followers };
}

module.exports = {
    DEFAULT_PDS,
    APPVIEW,
    MAX_GRAPHEMES,
    blueskyConfig,
    blueskyConfigured,
    blueskyReadable,
    graphemeCount,
    postUrl,
    publishBluesky,
    readBluesky,
};
