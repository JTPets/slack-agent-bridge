/**
 * lib/social-meta.js
 *
 * Facebook Page and Instagram Business publishing and reading, over Meta's Graph API.
 *
 * LOGIC CHANGE 2026-11-09: created (owner's choice 2026-11-09: Facebook, Instagram,
 * Google Business Profile and Bluesky, posting and reading).
 *
 * Configuration, names only (never logged):
 *   META_PAGE_ACCESS_TOKEN  a long-lived Page access token
 *   META_PAGE_ID            the Facebook Page id
 *   INSTAGRAM_BUSINESS_ID   the Instagram business account linked to that Page (optional)
 *   META_GRAPH_VERSION      default v26.0 (released 2026-07-29, the newest at writing)
 * Permissions the token needs: pages_manage_posts, pages_read_engagement,
 * read_insights, instagram_basic, instagram_content_publish, instagram_manage_insights,
 * instagram_manage_comments.
 *
 * What Meta does NOT give, so nothing here pretends to read it: a list of who follows
 * a Page or an account. Counts, aggregated demographics and the people who comment
 * are what is readable. impressions-style metrics deprecated in 2025-2026 are not used.
 *
 * Nothing here decides WHETHER to publish. Callers publish only after a person pressed
 * Publish (lib/social-buttons.js).
 */

'use strict';

const { requestJson, SocialApiError } = require('./social-http');

const DEFAULT_GRAPH_VERSION = 'v26.0';
const IG_STATUS_POLLS = 5;
const IG_STATUS_WAIT_MS = 2000;

function metaConfig(env = process.env) {
    return {
        token: env.META_PAGE_ACCESS_TOKEN || '',
        pageId: env.META_PAGE_ID || '',
        igId: env.INSTAGRAM_BUSINESS_ID || '',
        version: env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION,
    };
}

function facebookConfigured(env) { const c = metaConfig(env); return Boolean(c.token && c.pageId); }
function instagramConfigured(env) { const c = metaConfig(env); return Boolean(c.token && c.igId); }

function graph(cfg, fetchImpl) {
    const base = `https://graph.facebook.com/${cfg.version}`;
    return (pathAndQuery, { method = 'GET', json } = {}) => requestJson({
        platform: 'meta', url: `${base}/${pathAndQuery}`, method, token: cfg.token, json, fetchImpl,
    });
}

/**
 * Publish to the Facebook Page: a photo post when there is an image, else a text post.
 * @returns {Promise<{ id: string, url: string|null }>}
 */
async function publishFacebook({ text, imageUrl, link }, { env, fetchImpl } = {}) {
    const cfg = metaConfig(env);
    if (!facebookConfigured(env)) throw new SocialApiError('Facebook is not configured (META_PAGE_ACCESS_TOKEN, META_PAGE_ID)', { platform: 'meta' });
    const g = graph(cfg, fetchImpl);
    const out = imageUrl
        ? await g(`${encodeURIComponent(cfg.pageId)}/photos`, { method: 'POST', json: { url: imageUrl, caption: text } })
        : await g(`${encodeURIComponent(cfg.pageId)}/feed`, { method: 'POST', json: { message: text, ...(link ? { link } : {}) } });
    const postId = out.post_id || out.id;
    if (!postId) throw new SocialApiError('Facebook accepted the post but returned no id', { platform: 'meta' });
    return { id: postId, url: `https://www.facebook.com/${postId}` };
}

/**
 * Publish an image post to Instagram: create a container, wait until it is FINISHED,
 * publish it. Instagram has no text-only post, so an image URL is required.
 * @returns {Promise<{ id: string, url: string|null }>}
 */
async function publishInstagram({ text, imageUrl }, { env, fetchImpl, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    const cfg = metaConfig(env);
    if (!instagramConfigured(env)) throw new SocialApiError('Instagram is not configured (META_PAGE_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ID)', { platform: 'meta' });
    if (!imageUrl) throw new SocialApiError('Instagram needs a photo and this item has none in Square', { platform: 'meta' });
    const g = graph(cfg, fetchImpl);
    const igId = encodeURIComponent(cfg.igId);
    const container = await g(`${igId}/media`, { method: 'POST', json: { image_url: imageUrl, caption: text } });
    if (!container.id) throw new SocialApiError('Instagram returned no media container id', { platform: 'meta' });

    let status = null;
    for (let i = 0; i < IG_STATUS_POLLS; i += 1) {
        const s = await g(`${encodeURIComponent(container.id)}?fields=status_code`);
        status = s.status_code || null;
        if (status === 'FINISHED') break;
        if (status === 'ERROR' || status === 'EXPIRED') {
            throw new SocialApiError(`Instagram could not prepare the photo (status ${status})`, { platform: 'meta' });
        }
        await sleep(IG_STATUS_WAIT_MS);
    }
    if (status !== 'FINISHED') {
        throw new SocialApiError(`Instagram's photo was still ${status || 'not ready'} after ${IG_STATUS_POLLS} checks; nothing was published`, { platform: 'meta' });
    }
    const published = await g(`${igId}/media_publish`, { method: 'POST', json: { creation_id: container.id } });
    if (!published.id) throw new SocialApiError('Instagram published but returned no id', { platform: 'meta' });
    let url = null;
    try {
        url = (await g(`${encodeURIComponent(published.id)}?fields=permalink`)).permalink || null;
    } catch (_) { /* the post is live; a missing link is not a failed publish */ }
    return { id: published.id, url };
}

/** A section that failed is { available: false, reason }, never zeros. */
async function section(fn) {
    try {
        return { available: true, ...(await fn()) };
    } catch (err) {
        return { available: false, reason: err.message };
    }
}

function count(summaryHolder) {
    return summaryHolder && summaryHolder.summary && typeof summaryHolder.summary.total_count === 'number'
        ? summaryHolder.summary.total_count : null;
}

/** Facebook Page numbers: followers and the last 10 posts' engagement. */
async function readFacebook({ env, fetchImpl } = {}) {
    const cfg = metaConfig(env);
    const g = graph(cfg, fetchImpl);
    const page = encodeURIComponent(cfg.pageId);
    const account = await section(async () => {
        const p = await g(`${page}?fields=name,followers_count,fan_count`);
        return { name: p.name || null, followers: p.followers_count ?? p.fan_count ?? null };
    });
    const posts = await section(async () => {
        const fields = 'id,message,created_time,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)';
        const r = await g(`${page}/posts?fields=${encodeURIComponent(fields)}&limit=10`);
        return { items: (r.data || []).map(p => ({
            id: p.id, text: (p.message || '').slice(0, 120), at: p.created_time || null, url: p.permalink_url || null,
            likes: count(p.reactions), comments: count(p.comments), shares: p.shares ? p.shares.count : 0,
        })) };
    });
    return { platform: 'facebook', account, posts };
}

/** Instagram numbers: followers, yesterday's account totals, last 10 posts, recent commenters. */
async function readInstagram({ env, fetchImpl, now = new Date() } = {}) {
    const cfg = metaConfig(env);
    const g = graph(cfg, fetchImpl);
    const ig = encodeURIComponent(cfg.igId);
    const account = await section(async () => {
        const a = await g(`${ig}?fields=username,followers_count,follows_count,media_count`);
        return { name: a.username || null, followers: a.followers_count ?? null, posts: a.media_count ?? null };
    });
    const day = await section(async () => {
        const until = Math.floor(now.getTime() / 1000);
        const since = until - 86400;
        const r = await g(`${ig}/insights?metric=reach,accounts_engaged,total_interactions,saves,shares&period=day&metric_type=total_value&since=${since}&until=${until}`);
        const totals = {};
        for (const m of r.data || []) totals[m.name] = m.total_value ? m.total_value.value : null;
        return { totals };
    });
    const posts = await section(async () => {
        const r = await g(`${ig}/media?fields=id,caption,timestamp,permalink,like_count,comments_count,media_type&limit=10`);
        return { items: (r.data || []).map(m => ({
            id: m.id, text: (m.caption || '').slice(0, 120), at: m.timestamp || null, url: m.permalink || null,
            likes: m.like_count ?? null, comments: m.comments_count ?? null,
        })) };
    });
    const comments = await section(async () => {
        const recent = posts.available ? posts.items.filter(p => p.comments > 0).slice(0, 5) : [];
        const items = [];
        for (const p of recent) {
            const r = await g(`${encodeURIComponent(p.id)}/comments?fields=id,username,text,timestamp,replies{id}&limit=50`);
            for (const c of r.data || []) {
                items.push({ id: c.id, user: c.username || null, text: (c.text || '').slice(0, 120),
                    at: c.timestamp || null, postUrl: p.url, answered: Boolean(c.replies && c.replies.data && c.replies.data.length) });
            }
        }
        return { items };
    });
    return { platform: 'instagram', account, day, posts, comments };
}

module.exports = {
    DEFAULT_GRAPH_VERSION,
    metaConfig,
    facebookConfigured,
    instagramConfigured,
    publishFacebook,
    publishInstagram,
    readFacebook,
    readInstagram,
};
