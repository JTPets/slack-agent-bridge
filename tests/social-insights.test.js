'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const insights = require('../lib/social-insights');
const { runSocialDaily, MAX_DRAFTS_PER_RUN } = require('../lib/social-daily');

const snap = ({ ig = 100, bsky = ['a', 'b'], igComments = [], igPosts = [], gbpWeek = null, reviews = null } = {}) => ({
    facebook: { notConfigured: true },
    instagram: {
        account: { available: true, followers: ig },
        posts: { available: true, items: igPosts },
        comments: { available: true, items: igComments },
    },
    gbp: gbpWeek ? { account: { available: true }, week: { available: true, ...gbpWeek }, reviews: reviews || { available: true, rating: 4.9, total: 10, items: [] } } : { notConfigured: true },
    bluesky: { account: { available: true, followers: bsky.length }, posts: { available: true, items: [] }, followers: { available: true, handles: bsky } },
});

describe('lib/social-insights.js', () => {
    let dir; let file;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-metrics-')); file = path.join(dir, 'm.json'); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('one snapshot per Toronto day, and old days are dropped', () => {
        insights.recordSnapshot({ a: 1 }, { file, now: new Date('2025-01-01T15:00:00Z') });
        insights.recordSnapshot({ a: 2 }, { file, now: new Date('2026-11-09T03:00:00Z') }); // Nov 8 in Toronto
        insights.recordSnapshot({ a: 3 }, { file, now: new Date('2026-11-09T04:00:00Z') });
        expect(Object.keys(insights.readHistory(file).days)).toEqual(['2026-11-08']);
        expect(insights.readHistory(file).days['2026-11-08'].platforms).toEqual({ a: 3 });
    });

    test('the digest says what changed this week, who was not answered and who came and went', () => {
        const history = { days: {
            '2026-11-02': { platforms: snap({ ig: 100, bsky: ['a', 'b'], gbpWeek: { from: 'x', to: 'y', views: 50, calls: 2, directions: 1, websiteClicks: 3 } }) },
            '2026-11-08': { platforms: snap({ ig: 100, bsky: ['b'], igComments: [{ id: 'c0', user: 'amy', text: 'Earlier', answered: true }] }) },
            '2026-11-09': { platforms: snap({
                ig: 112, bsky: ['b', 'c'],
                igPosts: [{ id: 'p1', text: 'Salmon kibble is here', url: 'https://ig/p1', likes: 20, comments: 4 }, { id: 'p2', text: 'Quiet', likes: 1 }],
                igComments: [{ id: 'c1', user: 'amy', text: 'Love it', answered: true }, { id: 'c2', user: 'bob', text: 'Price?', answered: false }],
                gbpWeek: { from: '2026-11-02', to: '2026-11-08', views: 70, calls: 5, directions: 1, websiteClicks: 3 },
                reviews: { available: true, rating: 4.8, total: 11, items: [{ user: 'Kim', stars: 2, answered: false }] },
            }) },
        } };
        const { text } = insights.buildWeeklyDigest(history, { now: new Date('2026-11-09T15:00:00Z') });
        expect(text).toMatch(/compared with 2026-11-02/);
        expect(text).toMatch(/Instagram: 112 followers \(\+12 this week\)/);
        expect(text).toMatch(/Best post: <https:\/\/ig\/p1\|"Salmon kibble is here">/);
        expect(text).toMatch(/1 Instagram comment with no reply:\* @bob "Price\?"/);
        expect(text).toMatch(/Regulars on Instagram \(2\+ comments\): @amy \(2\)/);
        expect(text).toMatch(/New on Bluesky: @c/);
        expect(text).toMatch(/Unfollowed on Bluesky: @a/);
        expect(text).toMatch(/Google reviews: 4\.8 stars from 11\. \*1 with no reply:\* Kim \(2★\)/);
        expect(text).toMatch(/70 views \(\+20\), 5 calls \(\+3\)/);
        expect(text).toMatch(/Facebook: not set up/);
    });

    test('an unreadable platform is said to be unreadable, never zero', () => {
        const history = { days: { '2026-11-09': { platforms: {
            instagram: { account: { available: false, reason: 'HTTP 401' } },
        } } } };
        const { text } = insights.buildWeeklyDigest(history, { now: new Date('2026-11-09T15:00:00Z') });
        expect(text).toMatch(/Instagram: could not be read \(HTTP 401\)/);
        expect(text).not.toMatch(/Instagram: 0 followers/);
        expect(insights.buildWeeklyDigest({ days: {} }).text).toMatch(/no snapshot has been recorded yet/);
    });
});

describe('lib/social-daily.js', () => {
    const agent = { id: 'social-media', channel: 'CSOC' };
    const slack = () => {
        const posts = [];
        return { posts, chat: { postMessage: jest.fn(async (args) => { posts.push(args); return { ts: `t${posts.length}`, channel: args.channel }; }) } };
    };
    const base = (over = {}) => ({
        readEverything: async () => ({ instagram: { account: { available: true, followers: 1 } } }),
        recordSnapshot: () => '2026-11-10',
        publishTargets: () => ({ ready: ['facebook'] }),
        labelOf: () => 'Facebook',
        readHistory: () => ({ days: {} }),
        buildWeeklyDigest: () => ({ text: 'DIGEST' }),
        checkNewItems: async () => ({ status: 'ok', total: 3, newItems: [], newCategories: [] }),
        formatNewItemsReport: () => 'no new items',
        createDrafts: async () => ({ drafts: [], failures: [] }),
        buildDraftBlocks: () => [],
        recordPost: jest.fn(),
        runModel: async () => '',
        ...over,
    });
    const TUESDAY = new Date('2026-11-10T14:00:00Z');
    const MONDAY = new Date('2026-11-09T14:00:00Z');

    test('a quiet Tuesday posts nothing and reports ok', async () => {
        const s = slack();
        const v = await runSocialDaily({ slack: s, agent, now: TUESDAY, env: { SQUARE_ACCESS_TOKEN: 'sq' }, deps: base() });
        expect(v.ok).toBe(true);
        expect(s.posts).toHaveLength(0);
        expect(v.text).toMatch(/Snapshot 2026-11-10: instagram read/);
    });

    test('new items are drafted (at most the cap) and posted with their message id recorded', async () => {
        const s = slack();
        const items = Array.from({ length: MAX_DRAFTS_PER_RUN + 2 }, (_, i) => ({ id: `I${i}`, name: `N${i}` }));
        const createDrafts = jest.fn(async (list) => ({ drafts: list.map(i => ({ id: `d${i.id}`, itemName: i.name })), failures: [{ item: 'N9', reason: 'bad json' }] }));
        const recordPost = jest.fn();
        const notify = jest.fn(async () => {});
        const v = await runSocialDaily({ slack: s, agent, now: TUESDAY, notify, env: { SQUARE_ACCESS_TOKEN: 'sq' },
            deps: base({ checkNewItems: async () => ({ status: 'ok', total: 9, newItems: items, newCategories: [] }), createDrafts, recordPost }) });
        expect(createDrafts.mock.calls[0][0]).toHaveLength(MAX_DRAFTS_PER_RUN);
        expect(s.posts).toHaveLength(MAX_DRAFTS_PER_RUN);
        expect(recordPost).toHaveBeenCalledWith('dI0', { channel: 'CSOC', ts: 't1' });
        expect(v.ok).toBe(false);
        expect(notify.mock.calls[0][0]).toMatch(/draft for "N9" failed: bad json/);
        expect(v.text).toMatch(/first 5 of 7/);
    });

    test('without a Square token the new-item check is skipped and said so', async () => {
        const checkNewItems = jest.fn();
        const v = await runSocialDaily({ slack: slack(), agent, now: TUESDAY, env: {}, deps: base({ checkNewItems }) });
        expect(checkNewItems).not.toHaveBeenCalled();
        expect(v.text).toMatch(/SQUARE_ACCESS_TOKEN is not set/);
    });

    test('Monday, or a person asking, posts the digest; a failed read reaches ops', async () => {
        const s = slack();
        const notify = jest.fn(async () => {});
        await runSocialDaily({ slack: s, agent, now: MONDAY, notify, env: {}, deps: base({
            readEverything: async () => ({ facebook: { account: { available: false, reason: 'HTTP 190' } } }),
        }) });
        expect(s.posts.map(p => p.text)).toEqual(['DIGEST']);
        expect(notify.mock.calls[0][0]).toMatch(/facebook could not be read: HTTP 190/);
        const s2 = slack();
        await runSocialDaily({ slack: s2, agent, now: TUESDAY, onDemand: true, env: {}, deps: base() });
        expect(s2.posts.map(p => p.text)).toEqual(['DIGEST']);
    });

    test('no resolved channel runs nothing and says so', async () => {
        const notify = jest.fn(async () => {});
        const v = await runSocialDaily({ slack: slack(), agent: { id: 'social-media' }, notify, deps: base() });
        expect(v.ok).toBe(false);
        expect(notify).toHaveBeenCalled();
    });
});
