'use strict';

/**
 * tests/untrusted-text.test.js — lib/untrusted-text.js (WORK-TODO #87).
 */

const { escapeSlackText, quoteForSlack, logSafe, LOG_SAFE_MAX } = require('../lib/untrusted-text');

describe('escapeSlackText', () => {
    test('escapes the three characters Slack treats as markup, & first', () => {
        expect(escapeSlackText('<!channel> & <@U1> <https://x|y>'))
            .toBe('&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;https://x|y&gt;');
        expect(escapeSlackText('&lt;')).toBe('&amp;lt;');
    });

    test('leaves ordinary text alone and turns null/undefined into an empty string', () => {
        expect(escapeSlackText('Kibble, 2 bags *please*')).toBe('Kibble, 2 bags *please*');
        expect(escapeSlackText(null)).toBe('');
        expect(escapeSlackText(undefined)).toBe('');
        expect(escapeSlackText(42)).toBe('42');
    });
});

describe('quoteForSlack', () => {
    test('quotes every line, whatever the line break', () => {
        expect(quoteForSlack('a\nb\r\nc\rd\u2028e')).toBe('> a\n> b\n> c\n> d\n> e');
    });

    test('escapes before quoting', () => {
        expect(quoteForSlack('<!here>\nok')).toBe('> &lt;!here&gt;\n> ok');
    });
});

describe('logSafe', () => {
    test('a newline or carriage return cannot start a new log line', () => {
        const out = logSafe('Acme\n[storefront] forged\rx\u2028y');
        expect(out).not.toMatch(/[\n\r\u2028\u2029]/);
        expect(out).toBe('"Acme\\n[storefront] forged\\rx\\u2028y"');
    });

    test('caps the length', () => {
        const out = logSafe('x'.repeat(LOG_SAFE_MAX + 50));
        expect(out.length).toBeLessThanOrEqual(LOG_SAFE_MAX + 3);
        expect(out.endsWith('…"')).toBe(true);
    });

    test('non-strings are stringified', () => {
        expect(logSafe(undefined)).toBe('""');
        expect(logSafe(7)).toBe('"7"');
    });
});
