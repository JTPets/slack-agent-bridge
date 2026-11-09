'use strict';

const meta = require('../lib/social-meta');
const gbp = require('../lib/social-gbp');
const bluesky = require('../lib/social-bluesky');
const platforms = require('../lib/social-platforms');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch that answers by the first matching [method, url-substring] route and records calls. */
function router(routes) {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method, body: init.body, headers: init.headers || {} });
        const hit = routes.find(([m, part]) => m === method && url.includes(part));
        if (!hit) return json({ error: { message: `no route for ${method} ${url}` } }, 404);
        return typeof hit[2] === 'function' ? hit[2](url, init) : hit[2];
    };
    return { fetchImpl, calls };
}

const META_ENV = { META_PAGE_ACCESS_TOKEN: 'tok-meta-123456', META_PAGE_ID: 'PAGE1', INSTAGRAM_BUSINESS_ID: 'IG1' };
const GBP_ENV = { GBP_ACCOUNT_ID: '11', GBP_LOCATION_ID: '22', GBP_REFRESH_TOKEN: 'rt-xyz-123456', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret' };
const BSKY_ENV = { BLUESKY_HANDLE: '@jtpets.bsky.social', BLUESKY_APP_PASSWORD: 'app-pass-1234' };

describe('Facebook and Instagram (lib/social-meta.js)', () => {
    test('a photo post goes to /photos on the newest Graph version and returns a link', async () => {
        const r = router([['POST', '/v26.0/PAGE1/photos', json({ id: 'PH', post_id: 'PAGE1_99' })]]);
        const out = await meta.publishFacebook({ text: 'New!', imageUrl: 'https://img/a.jpg' }, { env: META_ENV, fetchImpl: r.fetchImpl });
        expect(out).toEqual({ id: 'PAGE1_99', url: 'https://www.facebook.com/PAGE1_99' });
        expect(JSON.parse(r.calls[0].body)).toEqual({ url: 'https://img/a.jpg', caption: 'New!' });
    });

    test('a text post goes to /feed', async () => {
        const r = router([['POST', '/PAGE1/feed', json({ id: 'PAGE1_1' })]]);
        await meta.publishFacebook({ text: 'Hi', link: 'https://jtpets.ca' }, { env: META_ENV, fetchImpl: r.fetchImpl });
        expect(JSON.parse(r.calls[0].body)).toEqual({ message: 'Hi', link: 'https://jtpets.ca' });
    });

    test('Instagram creates a container, waits for FINISHED, then publishes', async () => {
        let polls = 0;
        const r = router([
            ['POST', '/IG1/media_publish', json({ id: 'M1' })],
            ['POST', '/IG1/media', json({ id: 'C1' })],
            ['GET', '/C1?fields=status_code', () => json({ status_code: (polls += 1) < 2 ? 'IN_PROGRESS' : 'FINISHED' })],
            ['GET', '/M1?fields=permalink', json({ permalink: 'https://instagram.com/p/x' })],
        ]);
        const out = await meta.publishInstagram({ text: 'Cap', imageUrl: 'https://img/a.jpg' }, { env: META_ENV, fetchImpl: r.fetchImpl, sleep: async () => {} });
        expect(out).toEqual({ id: 'M1', url: 'https://instagram.com/p/x' });
        expect(JSON.parse(r.calls.find(c => c.url.includes('media_publish')).body)).toEqual({ creation_id: 'C1' });
    });

    test('Instagram refuses without a photo, and stops on an ERROR container without publishing', async () => {
        await expect(meta.publishInstagram({ text: 'x' }, { env: META_ENV })).rejects.toThrow(/needs a photo/);
        const r = router([
            ['POST', '/IG1/media', json({ id: 'C1' })],
            ['GET', '/C1?fields=status_code', json({ status_code: 'ERROR' })],
        ]);
        await expect(meta.publishInstagram({ text: 'x', imageUrl: 'https://i' }, { env: META_ENV, fetchImpl: r.fetchImpl, sleep: async () => {} }))
            .rejects.toThrow(/status ERROR/);
        expect(r.calls.some(c => c.url.includes('media_publish'))).toBe(false);
    });

    test('readInstagram reports followers, posts, and which comments were answered; a failed part is unavailable', async () => {
        const r = router([
            ['GET', '/IG1?fields=username', json({ username: 'jtpets', followers_count: 812, media_count: 40 })],
            ['GET', '/IG1/insights', json({ error: { message: 'metric not available' } }, 400)],
            ['GET', '/IG1/media?', json({ data: [{ id: 'M1', caption: 'Kibble', permalink: 'https://ig/1', like_count: 9, comments_count: 2 }] })],
            ['GET', '/M1/comments', json({ data: [
                { id: 'c1', username: 'amy', text: 'Love it', replies: { data: [{ id: 'r' }] } },
                { id: 'c2', username: 'bob', text: 'Price?' },
            ] })],
        ]);
        const out = await meta.readInstagram({ env: META_ENV, fetchImpl: r.fetchImpl });
        expect(out.account).toMatchObject({ available: true, followers: 812 });
        expect(out.day.available).toBe(false);
        expect(out.day.reason).toMatch(/metric not available/);
        expect(out.comments.items.map(c => [c.user, c.answered])).toEqual([['amy', true], ['bob', false]]);
    });
});

describe('Google Business Profile (lib/social-gbp.js)', () => {
    const tokenRoute = ['POST', 'oauth2.googleapis.com/token', () => json({ access_token: 'at-1' })];

    test('a post exchanges the refresh token, then creates a localPost with the photo', async () => {
        const r = router([tokenRoute, ['POST', '/v4/accounts/11/locations/22/localPosts', json({ name: 'accounts/11/locations/22/localPosts/5', searchUrl: 'https://g/5' })]]);
        const out = await gbp.publishGbp({ text: 'New', imageUrl: 'https://img/a.jpg' }, { env: GBP_ENV, fetchImpl: r.fetchImpl });
        expect(out.url).toBe('https://g/5');
        expect(r.calls[0].body.toString()).toContain('grant_type=refresh_token');
        expect(r.calls[1].headers.Authorization).toBe('Bearer at-1');
        expect(JSON.parse(r.calls[1].body)).toMatchObject({ summary: 'New', topicType: 'STANDARD', media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://img/a.jpg' }] });
    });

    test('readGbp sums the week and lists unanswered reviews; a failed token makes every part unavailable', async () => {
        const r = router([
            tokenRoute,
            ['GET', '/reviews', json({ averageRating: 4.8, totalReviewCount: 52, reviews: [
                { reviewId: 'r1', reviewer: { displayName: 'Sam' }, starRating: 'FIVE', comment: 'Great', reviewReply: { comment: 'Thanks' } },
                { reviewId: 'r2', reviewer: { displayName: 'Kim' }, starRating: 'TWO', comment: 'Slow' },
            ] })],
            ['GET', 'fetchMultiDailyMetricsTimeSeries', json({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [
                { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [{ value: '2' }, { value: '3' }] } },
                { dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', timeSeries: { datedValues: [{ value: '40' }, {}] } },
            ] }] })],
        ]);
        const out = await gbp.readGbp({ env: GBP_ENV, fetchImpl: r.fetchImpl, now: new Date('2026-11-09T15:00:00Z') });
        expect(out.reviews.items.filter(v => !v.answered).map(v => [v.user, v.stars])).toEqual([['Kim', 2]]);
        expect(out.week).toMatchObject({ available: true, from: '2026-11-02', to: '2026-11-08', calls: 5, views: 40 });

        const bad = router([['POST', 'oauth2.googleapis.com/token', json({ error: 'invalid_grant' }, 400)]]);
        const failed = await gbp.readGbp({ env: GBP_ENV, fetchImpl: bad.fetchImpl });
        expect(failed.account.available).toBe(false);
        expect(failed.reviews.available).toBe(false);
    });
});

describe('Bluesky (lib/social-bluesky.js)', () => {
    test('a post signs in with the app password, uploads the photo and creates the record', async () => {
        const r = router([
            ['POST', 'createSession', json({ accessJwt: 'jwt', did: 'did:plc:abc', handle: 'jtpets.bsky.social' })],
            ['GET', 'img.test', new Response(Buffer.from('jpg'), { status: 200, headers: { 'content-type': 'image/jpeg' } })],
            ['POST', 'uploadBlob', json({ blob: { ref: 'b' } })],
            ['POST', 'createRecord', json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kq' })],
        ]);
        const out = await bluesky.publishBluesky({ text: 'Hi', imageUrl: 'https://img.test/a.jpg', alt: 'Kibble' },
            { env: BSKY_ENV, fetchImpl: r.fetchImpl, now: new Date('2026-11-09T12:00:00Z') });
        expect(out.url).toBe('https://bsky.app/profile/jtpets.bsky.social/post/3kq');
        expect(JSON.parse(r.calls[0].body)).toEqual({ identifier: 'jtpets.bsky.social', password: 'app-pass-1234' });
        const rec = JSON.parse(r.calls[3].body).record;
        expect(rec).toMatchObject({ $type: 'app.bsky.feed.post', text: 'Hi', embed: { images: [{ alt: 'Kibble', image: { ref: 'b' } }] } });
    });

    test('a text over 300 graphemes is refused before anything is sent', async () => {
        const r = router([]);
        await expect(bluesky.publishBluesky({ text: 'x'.repeat(301) }, { env: BSKY_ENV, fetchImpl: r.fetchImpl })).rejects.toThrow(/300/);
        expect(r.calls).toHaveLength(0);
        expect(bluesky.graphemeCount('🐶🐱')).toBe(2);
    });

    test('readBluesky needs no password and lists follower handles', async () => {
        const r = router([
            ['GET', 'getProfile', json({ handle: 'jtpets.bsky.social', followersCount: 30, postsCount: 4 })],
            ['GET', 'getAuthorFeed', json({ feed: [{ post: { uri: 'at://d/app.bsky.feed.post/1', record: { text: 'yo' }, likeCount: 3 } }] })],
            ['GET', 'getFollowers', json({ followers: [{ handle: 'a.bsky.social' }, { handle: 'b.bsky.social' }] })],
        ]);
        const out = await bluesky.readBluesky({ env: { BLUESKY_HANDLE: 'jtpets.bsky.social' }, fetchImpl: r.fetchImpl });
        expect(out.account.followers).toBe(30);
        expect(out.followers.handles).toEqual(['a.bsky.social', 'b.bsky.social']);
        expect(r.calls.every(c => !c.headers.Authorization)).toBe(true);
    });
});

describe('lib/social-platforms.js', () => {
    test('unconfigured platforms are skipped and named; one failure does not stop the others', async () => {
        const r = router([
            ['POST', '/PAGE1/feed', json({ error: { message: 'boom' } }, 500)],
            ['POST', 'createSession', json({ accessJwt: 'j', did: 'did:x' })],
            ['POST', 'createRecord', json({ uri: 'at://did:x/app.bsky.feed.post/9' })],
        ]);
        const env = { META_PAGE_ACCESS_TOKEN: 't-123456789', META_PAGE_ID: 'PAGE1', ...BSKY_ENV };
        const results = await platforms.publishEverywhere({ text: 'long text', short: 'short' }, { env, fetchImpl: r.fetchImpl });
        expect(results.map(x => [x.platform, x.status])).toEqual([
            ['facebook', 'failed'], ['instagram', 'skipped'], ['gbp', 'skipped'], ['bluesky', 'published'],
        ]);
        expect(JSON.parse(r.calls.find(c => c.url.includes('createRecord')).body).record.text).toBe('short');
        const text = platforms.formatPublishResults(results);
        expect(text).toMatch(/Facebook: failed/);
        expect(text).toMatch(/Instagram: skipped, not set up \(META_PAGE_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ID\)/);
    });

    test('publishTargets names what is ready; readEverything marks unconfigured platforms', async () => {
        expect(platforms.publishTargets(BSKY_ENV).ready).toEqual(['bluesky']);
        const out = await platforms.readEverything({ env: {}, fetchImpl: async () => { throw new Error('should not be called'); } });
        expect(Object.values(out).every(p => p.notConfigured)).toBe(true);
    });
});
