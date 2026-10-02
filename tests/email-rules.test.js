/**
 * tests/email-rules.test.js
 *
 * The LIVE agents/email-monitor/memory/rules.json against the two emails the
 * owner saw flagged [vendor_deal/high] on 2026-10-01. Unlike
 * tests/email-categorizer.test.js this reads the real file, because the defect
 * was in the file's configuration as much as in the matcher.
 *
 * The email bodies are SYNTHETIC reconstructions (no real email is in the repo).
 * They carry the kind of text those senders' bodies carry - a Nextdoor digest's
 * other listings, a Square report's "Cash Sales" row - which is what a
 * body-wide substring match on `sale` fired on. Which keyword actually matched
 * the real emails is inferred, not observed.
 */

'use strict';

jest.mock('../lib/bulletin-board', () => ({
    postBulletin: jest.fn(() => ({ success: true })),
}));

const fs = require('fs');
const path = require('path');
const categorizer = require('../lib/integrations/email-categorizer');
const bulletinBoard = require('../lib/bulletin-board');

const NEXTDOOR = {
    from: 'Your Gilbert neighbours <no-reply@is.ca.nextdoor.com>',
    subject: 'Mechanics and Apprentices needed in Mount Hope...',
    snippet: 'Mechanics and Apprentices needed in Mount Hope. Apply today.',
    body: 'Mechanics and Apprentices needed. Also nearby: Garage sale this Saturday. Couch for sale. Unsubscribe from these emails.',
};

const SQUARE_CASH_DRAWER = {
    from: 'Square <noreply@messaging.squareup.com>',
    subject: 'Square - Cash Drawer Report: Sep 28 to Oct 01',
    snippet: 'Cash Drawer Report Starting Cash Cash Sales Cash Refunds',
    body: 'Starting Cash $200.00. Cash Sales $512.40. Cash Refunds $0.00. Paid In/Out $0.00. Expected in Drawer $712.40.',
};

describe('live rules.json', () => {
    beforeEach(() => bulletinBoard.postBulletin.mockClear());

    it('is the file the categorizer loads', () => {
        expect(path.resolve(categorizer.RULES_FILE))
            .toBe(path.resolve(__dirname, '..', 'agents', 'email-monitor', 'memory', 'rules.json'));
        expect(fs.existsSync(categorizer.RULES_FILE)).toBe(true);
    });

    it('does not flag a Nextdoor job digest as a vendor deal', () => {
        const r = categorizer.categorizeEmail(NEXTDOOR);
        expect(r.category).not.toBe('vendor_deal');
        expect(r.priority).not.toBe('high');
        expect(bulletinBoard.postBulletin).not.toHaveBeenCalled();
    });

    it('does not flag a Square Cash Drawer Report as a vendor deal', () => {
        const r = categorizer.categorizeEmail(SQUARE_CASH_DRAWER);
        expect(r.category).not.toBe('vendor_deal');
        expect(r.priority).not.toBe('high');
        expect(bulletinBoard.postBulletin).not.toHaveBeenCalled();
    });

    it('does not flag a Square daily "sales summary" subject', () => {
        const r = categorizer.categorizeEmail({ from: 'Square <noreply@messaging.squareup.com>', subject: 'Your daily sales summary', body: '' });
        expect(r.category).not.toBe('vendor_deal');
    });

    // Positive controls: the change narrows vendor_deal, it does not kill it.
    it.each([
        'Fall SALE on dog food',
        '20% off all cat litter',
        'Clearance: last chance on kibble',
        'Special pricing for retailers',
    ])('still flags a vendor deal subject: %s', (subject) => {
        const r = categorizer.categorizeEmail({ from: 'rep@vendor.example', subject, body: '' });
        expect(r.category).toBe('vendor_deal');
        expect(r.priority).toBe('high');
    });

    // Negative control: the same emails DO match under the old rule (all fields,
    // substring), proving the tests above would have failed before the fix.
    it('the old matching rule hits both emails', () => {
        const kws = categorizer.loadRules().categories.vendor_deal.keywords;
        const oldText = (e) => [e.subject, e.snippet, e.body].join(' ');
        expect(categorizer.containsKeyword(oldText(NEXTDOOR), kws)).toBe(true);
        expect(categorizer.containsKeyword(oldText(SQUARE_CASH_DRAWER), kws)).toBe(true);
    });
});

describe('match_in / whole_word options', () => {
    it('default (no options) still matches every field by substring', () => {
        expect(categorizer.searchableTextFor({ subject: 's', snippet: 'n', body: 'b' }, {})).toBe('s n b');
        expect(categorizer.containsKeyword('wholesale', ['sale'])).toBe(true);
    });

    it('a match_in naming no known field falls back to all fields', () => {
        expect(categorizer.searchableTextFor({ subject: 's', snippet: 'n', body: 'b' }, { match_in: ['subjct'] })).toBe('s n b');
    });

    it('whole_word does not match inside a longer word, keeps punctuation keywords working', () => {
        expect(categorizer.containsKeyword('Cash Sales', ['sale'], { wholeWord: true })).toBe(false);
        expect(categorizer.containsKeyword('wholesale', ['sale'], { wholeWord: true })).toBe(false);
        expect(categorizer.containsKeyword('Big SALE!', ['sale'], { wholeWord: true })).toBe(true);
        expect(categorizer.containsKeyword('now 40% off', ['% off'], { wholeWord: true })).toBe(true);
        expect(categorizer.containsKeyword('a+b', ['a.b'], { wholeWord: true })).toBe(false);
    });
});
