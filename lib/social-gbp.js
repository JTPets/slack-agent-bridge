/**
 * lib/social-gbp.js
 *
 * Google Business Profile: publishing a post on the store's listing, and reading its
 * reviews and how often people found it, called it or asked for directions.
 *
 * LOGIC CHANGE 2026-11-09: created (owner's choice 2026-11-09).
 *
 * Configuration, names only:
 *   GBP_ACCOUNT_ID, GBP_LOCATION_ID  the numeric ids (accounts/<id>, locations/<id>)
 *   GBP_REFRESH_TOKEN                an OAuth refresh token minted WITH the scope
 *                                    https://www.googleapis.com/auth/business.manage.
 *                                    GOOGLE_REFRESH_TOKEN is not reused: it was minted
 *                                    for Gmail and Calendar read-only and lacks this scope.
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  the existing OAuth client
 * Google grants API access to a Business Profile project on request (one form, once).
 *
 * Endpoints: posts and reviews are the v4 mybusiness API (still the only home of
 * localPosts and reviews); metrics are the Business Profile Performance API v1.
 */

'use strict';

const { requestJson, SocialApiError } = require('./social-http');
const { STORE_TIME_ZONE, dayKey, addDays } = require('./time-format');

const V4 = 'https://mybusiness.googleapis.com/v4';
const PERF = 'https://businessprofileperformance.googleapis.com/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_SUMMARY = 1500;
const DAILY_METRICS = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'CALL_CLICKS', 'BUSINESS_DIRECTION_REQUESTS', 'WEBSITE_CLICKS',
];
const STAR = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

function gbpConfig(env = process.env) {
    return {
        accountId: env.GBP_ACCOUNT_ID || '',
        locationId: env.GBP_LOCATION_ID || '',
        refreshToken: env.GBP_REFRESH_TOKEN || '',
        clientId: env.GOOGLE_CLIENT_ID || '',
        clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    };
}

function gbpConfigured(env) {
    const c = gbpConfig(env);
    return Boolean(c.accountId && c.locationId && c.refreshToken && c.clientId && c.clientSecret);
}

/** Exchange the refresh token for an access token. The body is form-encoded, never logged. */
async function accessToken(cfg, fetchImpl) {
    const form = new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken, grant_type: 'refresh_token',
    }).toString();
    const r = await requestJson({
        platform: 'gbp', url: TOKEN_URL, method: 'POST',
        raw: Buffer.from(form), contentType: 'application/x-www-form-urlencoded', fetchImpl,
    });
    if (!r.access_token) throw new SocialApiError('Google returned no access token', { platform: 'gbp' });
    return r.access_token;
}

function locationPath(cfg) {
    return `accounts/${encodeURIComponent(cfg.accountId)}/locations/${encodeURIComponent(cfg.locationId)}`;
}

/**
 * Publish a "What's new" post on the listing, with the item's photo when there is one.
 * @returns {Promise<{ id: string, url: string|null }>}
 */
async function publishGbp({ text, imageUrl, link }, { env, fetchImpl } = {}) {
    const cfg = gbpConfig(env);
    if (!gbpConfigured(env)) {
        throw new SocialApiError('Google Business Profile is not configured (GBP_ACCOUNT_ID, GBP_LOCATION_ID, GBP_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)', { platform: 'gbp' });
    }
    if (String(text).length > MAX_SUMMARY) {
        throw new SocialApiError(`Google allows ${MAX_SUMMARY} characters in a post and this text has ${String(text).length}`, { platform: 'gbp' });
    }
    const token = await accessToken(cfg, fetchImpl);
    const body = { languageCode: 'en', summary: text, topicType: 'STANDARD' };
    if (imageUrl) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: imageUrl }];
    if (link) body.callToAction = { actionType: 'LEARN_MORE', url: link };
    const r = await requestJson({
        platform: 'gbp', url: `${V4}/${locationPath(cfg)}/localPosts`, method: 'POST', token, json: body, fetchImpl,
    });
    if (!r.name) throw new SocialApiError('Google accepted the post but returned no name', { platform: 'gbp' });
    return { id: r.name, url: r.searchUrl || null };
}

async function section(fn) {
    try {
        return { available: true, ...(await fn()) };
    } catch (err) {
        return { available: false, reason: err.message };
    }
}

/** Sum each daily metric over the last 7 complete Toronto days. */
function sumSeries(response) {
    const totals = {};
    for (const group of response.multiDailyMetricTimeSeries || []) {
        for (const s of group.dailyMetricTimeSeries || []) {
            let sum = 0;
            for (const v of (s.timeSeries && s.timeSeries.datedValues) || []) sum += Number(v.value || 0);
            totals[s.dailyMetric] = sum;
        }
    }
    return totals;
}

/** Reviews (rating, count, unanswered) and last week's discovery and action counts. */
async function readGbp({ env, fetchImpl, now = new Date() } = {}) {
    const cfg = gbpConfig(env);
    let token = null;
    const auth = await section(async () => { token = await accessToken(cfg, fetchImpl); return {}; });
    if (!auth.available) {
        return { platform: 'gbp', account: auth, reviews: auth, week: auth };
    }
    const reviews = await section(async () => {
        const r = await requestJson({ platform: 'gbp', url: `${V4}/${locationPath(cfg)}/reviews?pageSize=50`, token, fetchImpl });
        return {
            rating: r.averageRating ?? null,
            total: r.totalReviewCount ?? null,
            items: (r.reviews || []).map(v => ({
                id: v.reviewId, user: (v.reviewer && v.reviewer.displayName) || null, stars: STAR[v.starRating] || null,
                text: (v.comment || '').slice(0, 160), at: v.createTime || null, answered: Boolean(v.reviewReply),
            })),
        };
    });
    const week = await section(async () => {
        const end = addDays(dayKey(now, STORE_TIME_ZONE), -1);
        const start = addDays(end, -6);
        const part = (key, which) => {
            const [y, m, d] = key.split('-').map(Number);
            return `dailyRange.${which}.year=${y}&dailyRange.${which}.month=${m}&dailyRange.${which}.day=${d}`;
        };
        const metrics = DAILY_METRICS.map(m => `dailyMetrics=${m}`).join('&');
        const url = `${PERF}/locations/${encodeURIComponent(cfg.locationId)}:fetchMultiDailyMetricsTimeSeries?${metrics}&${part(start, 'startDate')}&${part(end, 'endDate')}`;
        const t = sumSeries(await requestJson({ platform: 'gbp', url, token, fetchImpl }));
        return {
            from: start, to: end,
            views: ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH']
                .reduce((s, k) => s + (t[k] || 0), 0),
            calls: t.CALL_CLICKS || 0,
            directions: t.BUSINESS_DIRECTION_REQUESTS || 0,
            websiteClicks: t.WEBSITE_CLICKS || 0,
        };
    });
    return { platform: 'gbp', account: { available: true }, reviews, week };
}

module.exports = {
    DAILY_METRICS,
    MAX_SUMMARY,
    gbpConfig,
    gbpConfigured,
    publishGbp,
    readGbp,
    sumSeries,
};
