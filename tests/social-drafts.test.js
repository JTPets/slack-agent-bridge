'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const drafts = require('../lib/social-drafts');
const buttons = require('../lib/social-buttons');

const ITEM = {
    id: 'ITEM_ABC123', name: 'Salmon Kibble 12kg', description: 'Grain-free salmon recipe.',
    category_names: ['Dog Food'], image_url: 'https://img.test/s.jpg',
    variations: [{ price_money: { amount: 8999, currency: 'CAD' } }],
};
const GOOD = JSON.stringify({ text: 'New in store: Salmon Kibble 12kg, $89.99.', short: 'New: Salmon Kibble 12kg, $89.99.' });

describe('lib/social-drafts.js', () => {
    let dir; let file;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-drafts-')); file = path.join(dir, 'd.json'); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('the prompt carries the item facts and forbids inventing more', () => {
        const p = drafts.buildDraftPrompt(ITEM, { system_prompt: 'You are the Social Media Manager.' });
        expect(p).toMatch(/You are the Social Media Manager/);
        expect(p).toMatch(/Name: Salmon Kibble 12kg/);
        expect(p).toMatch(/Price: \$89\.99/);
        expect(p).toMatch(/Do not invent/);
    });

    test('a malformed answer is a failed draft, never stored', async () => {
        for (const bad of ['sure! here you go', '{"text": ""}', JSON.stringify({ text: 'ok', short: 'x'.repeat(301) }), JSON.stringify({ text: 'ok' })]) {
            expect(() => drafts.parseDraftAnswer(bad)).toThrow();
        }
        const out = await drafts.createDrafts([ITEM], { runModel: async () => 'no json', file });
        expect(out.drafts).toEqual([]);
        expect(out.failures[0]).toMatchObject({ item: 'Salmon Kibble 12kg' });
        expect(drafts.readDrafts(file).drafts).toEqual({});
    });

    test('a good answer is stored pending, with the photo and both texts', async () => {
        const out = await drafts.createDrafts([ITEM], { runModel: async () => `Here:\n${GOOD}`, file, now: new Date('2026-11-09T14:00:00Z') });
        const d = out.drafts[0];
        expect(d).toMatchObject({ status: 'pending', itemName: 'Salmon Kibble 12kg', imageUrl: 'https://img.test/s.jpg' });
        expect(drafts.readDrafts(file).drafts[d.id].short).toBe('New: Salmon Kibble 12kg, $89.99.');
    });

    test('pending drafts show Publish (behind a confirm naming the platforms), Edit and Reject', () => {
        const blocks = drafts.buildDraftBlocks({ id: 'd1', itemName: 'X', text: 't', short: 's', status: 'pending', imageUrl: null }, { targets: ['Facebook', 'Bluesky'] });
        const actions = blocks.find(b => b.type === 'actions');
        expect(actions.elements.map(e => e.action_id)).toEqual(['social_draft_publish', 'social_draft_edit', 'social_draft_reject']);
        expect(actions.elements[0].confirm.text.text).toMatch(/Facebook, Bluesky/);
        expect(JSON.stringify(blocks)).toMatch(/Instagram will refuse/);
        const done = drafts.buildDraftBlocks({ id: 'd1', itemName: 'X', text: 't', short: 's', status: 'published' });
        expect(done.some(b => b.type === 'actions')).toBe(false);
    });
});

describe('lib/social-buttons.js', () => {
    let dir; let file;
    const ENV = { BLUESKY_HANDLE: 'jt.bsky.social', BLUESKY_APP_PASSWORD: 'pw-12345678' };
    const seed = (status = 'pending') => drafts.writeDrafts({ drafts: { d1: {
        id: 'd1', itemName: 'Salmon Kibble', text: 'long', short: 'short', status, imageUrl: null,
        post: { channel: 'C1', ts: '1.1' }, results: [],
    } } }, file);
    const press = (action, user = 'U_OK') => ({
        type: 'block_actions', user: { id: user }, channel: { id: 'C1' }, trigger_id: 'trig',
        actions: [{ action_id: `social_draft_${action}`, value: 'd1' }],
    });
    const deps = (extra = {}) => ({
        file, env: ENV, isAuthorized: (u) => u === 'U_OK', logger: { error() {}, warn() {} },
        updateMessage: jest.fn(async () => {}), postEphemeral: jest.fn(async () => {}),
        openView: jest.fn(async () => {}), notify: jest.fn(async () => {}), ...extra,
    });
    const bskyOk = () => {
        const calls = [];
        const fetchImpl = async (url, init = {}) => {
            calls.push(url);
            if (url.includes('createSession')) return new Response(JSON.stringify({ accessJwt: 'j', did: 'did:x' }), { status: 200 });
            return new Response(JSON.stringify({ uri: 'at://did:x/app.bsky.feed.post/1' }), { status: 200 });
        };
        return { fetchImpl, calls };
    };

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-buttons-')); file = path.join(dir, 'd.json'); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('recognises its own presses and its edit form only', () => {
        expect(buttons.isSocialInteraction(press('publish'))).toBe(true);
        expect(buttons.isSocialInteraction({ type: 'view_submission', view: { callback_id: 'social_draft_edit' } })).toBe(true);
        expect(buttons.isSocialInteraction({ type: 'block_actions', actions: [{ action_id: 'sqtools_ack_nag' }] })).toBe(false);
        expect(buttons.isSocialInteraction({ type: 'view_submission', view: { callback_id: 'bridge_dispatch_modal' } })).toBe(false);
    });

    test('Publish posts once; a second press publishes nothing', async () => {
        seed();
        const { fetchImpl, calls } = bskyOk();
        const d = deps({ fetchImpl });
        const first = await buttons.handleSocialInteraction({ ack: async () => {}, body: press('publish') }, d);
        expect(first.reason).toBe('published');
        const stored = drafts.readDrafts(file).drafts.d1;
        expect(stored.status).toBe('published');
        expect(stored.results.find(r => r.platform === 'bluesky').status).toBe('published');
        const last = d.updateMessage.mock.calls.at(-1)[0];
        expect(JSON.stringify(last.blocks)).toMatch(/Bluesky: published/);
        const before = calls.length;
        const second = await buttons.handleSocialInteraction({ ack: async () => {}, body: press('publish') }, d);
        expect(second.reason).toBe('not_pending');
        expect(calls.length).toBe(before);
    });

    test('when nothing goes live the draft goes back to pending and ops is told', async () => {
        seed();
        const d = deps({ env: {} });
        const out = await buttons.handleSocialInteraction({ ack: async () => {}, body: press('publish') }, d);
        expect(out.reason).toBe('published');
        expect(drafts.readDrafts(file).drafts.d1.status).toBe('pending');
        expect(JSON.stringify(d.updateMessage.mock.calls.at(-1)[0].blocks)).toMatch(/Nothing was published/);
    });

    test('an unauthorized press does nothing and says so', async () => {
        seed();
        const d = deps();
        const out = await buttons.handleSocialInteraction({ ack: async () => {}, body: press('publish', 'U_STRANGER') }, d);
        expect(out.reason).toBe('unauthorized');
        expect(drafts.readDrafts(file).drafts.d1.status).toBe('pending');
        expect(d.postEphemeral.mock.calls[0][0].text).toMatch(/allowlist/);
    });

    test('Reject records it and removes the buttons; Edit opens the form', async () => {
        seed();
        const d = deps();
        await buttons.handleSocialInteraction({ ack: async () => {}, body: press('edit') }, d);
        expect(d.openView.mock.calls[0][0].view.callback_id).toBe('social_draft_edit');
        await buttons.handleSocialInteraction({ ack: async () => {}, body: press('reject') }, d);
        expect(drafts.readDrafts(file).drafts.d1.status).toBe('rejected');
        expect(d.updateMessage.mock.calls.at(-1)[0].blocks.some(b => b.type === 'actions')).toBe(false);
    });

    test('the Edit form saves both texts, and refuses an over-long Bluesky version with the form left open', async () => {
        seed();
        const submit = (short) => ({
            type: 'view_submission', user: { id: 'U_OK' },
            view: { callback_id: 'social_draft_edit', private_metadata: 'd1',
                state: { values: { text: { value: { value: 'edited long' } }, short: { value: { value: short } } } } },
        });
        const ack = jest.fn(async () => {});
        const refused = await buttons.handleSocialInteraction({ ack, body: submit('x'.repeat(301)) }, deps());
        expect(refused.reason).toBe('invalid');
        expect(ack.mock.calls[0][0].response_action).toBe('errors');
        const ok = await buttons.handleSocialInteraction({ ack: async () => {}, body: submit('edited short') }, deps());
        expect(ok.reason).toBe('edited');
        expect(drafts.readDrafts(file).drafts.d1).toMatchObject({ text: 'edited long', short: 'edited short' });
    });

    test('bridge-agent.js routes social interactions before the other handlers', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
        const at = src.indexOf('onInteractive:');
        expect(at).toBeGreaterThan(-1);
        const route = src.slice(at, at + 600);
        expect(route.indexOf('socialButtons.isSocialInteraction')).toBeLessThan(route.indexOf('sqtoolsAlertButtons.isAckAction'));
        expect(route).toMatch(/isAuthorized: isUserAuthorized/);
    });
});
