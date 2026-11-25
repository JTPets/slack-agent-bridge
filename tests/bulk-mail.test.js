/**
 * tests/bulk-mail.test.js
 *
 * WORK-TODO #88, phase 1: lib/integrations/bulk-mail.js reads a Gmail message (format
 * 'full') for its sender, its bulk signals and its unsubscribe link, and keeps only a
 * parsed https/http/mailto link. Every message here is synthetic.
 */

'use strict';

const {
    describeBulkMail, parseListUnsubscribe, findFooterLink, parseSender, parseLink,
} = require('../lib/integrations/bulk-mail');

// A fake mailbox behind the real read API: fetchRecentEmails must attach `bulk`.
let mockMessages = [];
jest.mock('../lib/integrations/gmail-auth', () => ({
    createGmailClient: async () => ({ client: { users: { messages: {
        list: async () => ({ data: { messages: mockMessages.map(m => ({ id: m.id })) } }),
        get: async ({ id }) => ({ data: mockMessages.find(m => m.id === id) }),
    } } }, reason: null, error: null }),
    getGmailClient: async () => null, getRefreshToken: () => null, hasCredentials: () => true,
}));
const gmail = require('../lib/integrations/gmail');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');

function message({ headers = {}, labels = [], html = null, text = null } = {}) {
    const parts = [];
    if (text !== null) parts.push({ mimeType: 'text/plain', body: { data: b64(text) } });
    if (html !== null) parts.push({ mimeType: 'text/html', body: { data: b64(html) } });
    return {
        id: 'm1',
        labelIds: labels,
        payload: {
            mimeType: 'multipart/alternative',
            headers: Object.entries({ From: 'Pet Deals <deals@petdeals.example>', Subject: 'Sale', ...headers })
                .map(([name, value]) => ({ name, value })),
            parts,
        },
    };
}

describe('parseListUnsubscribe', () => {
    test('takes the https link and the mailto link from the header', () => {
        expect(parseListUnsubscribe('<mailto:u@list.example?subject=unsub>, <https://list.example/u?id=1&t=2>'))
            .toEqual({ url: 'https://list.example/u?id=1&t=2', mailto: 'mailto:u@list.example?subject=unsub' });
    });
    test('prefers https over an earlier http link', () => {
        expect(parseListUnsubscribe('<http://a.example/u>, <https://b.example/u>').url).toBe('https://b.example/u');
    });
    test('drops schemes other than https, http and mailto', () => {
        expect(parseListUnsubscribe('<javascript:alert(1)>, <data:text/html,x>, <file:///etc/passwd>'))
            .toEqual({ url: null, mailto: null });
    });
    test('an unbracketed or empty header gives nothing', () => {
        expect(parseListUnsubscribe('https://a.example/u')).toEqual({ url: null, mailto: null });
        expect(parseListUnsubscribe('')).toEqual({ url: null, mailto: null });
    });
});

describe('parseLink', () => {
    test('re-serialises through the URL parser, so a raw `>` or space cannot survive', () => {
        expect(parseLink('https://a.example/u?x=<b>')).toEqual({ href: 'https://a.example/u?x=%3Cb%3E', protocol: 'https:' });
        expect(parseLink('https://a.example/a b').href).toBe('https://a.example/a%20b');
    });
    test('refuses an over-long link and a host-less http link', () => {
        expect(parseLink(`https://a.example/${'x'.repeat(3000)}`)).toBeNull();
        expect(parseLink('http:')).toBeNull();
    });
});

describe('parseSender', () => {
    test('name and lower-cased address', () => {
        expect(parseSender('"Pet Deals" <Deals@PetDeals.example>')).toEqual({ address: 'deals@petdeals.example', name: 'Pet Deals' });
    });
    test('a bare address is its own name', () => {
        expect(parseSender('news@shop.example')).toEqual({ address: 'news@shop.example', name: 'news@shop.example' });
    });
    test('no address is null, and a newline in the name is flattened', () => {
        expect(parseSender('Nobody').address).toBeNull();
        expect(parseSender('A\nB <a@b.example>').name).toBe('A B');
    });
});

describe('findFooterLink', () => {
    test('the anchor whose text says unsubscribe, with &amp; decoded', () => {
        const html = '<p>Shop <a href="https://shop.example/sale">now</a></p><p><a href="https://shop.example/prefs?u=1&amp;t=2">Unsubscribe</a></p>';
        expect(findFooterLink(message({ html }).payload)).toBe('https://shop.example/prefs?u=1&t=2');
    });
    test('the anchor whose href says opt-out, even with plain text', () => {
        const html = '<a href="https://shop.example/opt-out/9">click here</a>';
        expect(findFooterLink(message({ html }).payload)).toBe('https://shop.example/opt-out/9');
    });
    test('a plain-text URL that says unsubscribe', () => {
        expect(findFooterLink(message({ text: 'Bye. https://shop.example/unsubscribe?u=4\n' }).payload))
            .toBe('https://shop.example/unsubscribe?u=4');
    });
    test('a javascript: anchor is never returned, and no matching link is null', () => {
        expect(findFooterLink(message({ html: '<a href="javascript:void(0)">Unsubscribe</a>' }).payload)).toBeNull();
        expect(findFooterLink(message({ html: '<a href="https://x.example/">Hello</a>' }).payload)).toBeNull();
    });
});

describe('describeBulkMail', () => {
    test('a header link, one-click, with every signal named', () => {
        const d = describeBulkMail(message({
            headers: {
                'List-Unsubscribe': '<https://petdeals.example/u/1>',
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'List-Id': '<deals.petdeals.example>',
                Precedence: 'bulk',
            },
            labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
        }));
        expect(d).toEqual({
            sender: { address: 'deals@petdeals.example', name: 'Pet Deals' },
            signals: ['list-unsubscribe', 'list-id', 'precedence', 'promotions'],
            isBulk: true,
            unsubscribe: { url: 'https://petdeals.example/u/1', mailto: null, oneClick: true, source: 'header' },
        });
    });
    test('the footer is read only when the header gives no link', () => {
        const html = '<a href="https://footer.example/unsubscribe">Unsubscribe</a>';
        expect(describeBulkMail(message({ headers: { 'List-Unsubscribe': '<https://hdr.example/u>' }, html })).unsubscribe.url)
            .toBe('https://hdr.example/u');
        const d = describeBulkMail(message({ html }));
        expect(d.unsubscribe).toEqual({ url: 'https://footer.example/unsubscribe', mailto: null, oneClick: false, source: 'footer' });
        expect(d.signals).toEqual(['footer-link']);
    });
    test('a personal email is not bulk: no signal, no link', () => {
        const d = describeBulkMail(message({ headers: { From: 'Jane <jane@friend.example>' }, labels: ['INBOX', 'CATEGORY_PERSONAL'], text: 'See you Friday' }));
        expect(d.isBulk).toBe(false);
        expect(d.unsubscribe).toBeNull();
    });
    test('Gmail Updates (receipts) is not a bulk signal on its own', () => {
        expect(describeBulkMail(message({ labels: ['CATEGORY_UPDATES'] })).isBulk).toBe(false);
    });
});

describe('the read API attaches it', () => {
    test('fetchRecentEmails carries `bulk` on each email, next to the sanitised fields', async () => {
        mockMessages = [
            { ...message({ headers: { 'List-Unsubscribe': '<https://petdeals.example/u/1>' } }), id: 'a1' },
            { ...message({ headers: { From: 'Jane <jane@friend.example>' }, text: 'hi' }), id: 'a2' },
        ];
        const result = await gmail.fetchRecentEmails(null, 10);
        expect(result.ok).toBe(true);
        expect(result.emails.map(e => [e.id, e.bulk.isBulk, e.bulk.unsubscribe?.url || null])).toEqual([
            ['a1', true, 'https://petdeals.example/u/1'],
            ['a2', false, null],
        ]);
        expect(result.emails[0].subject).toBe('Sale');
    });
});
