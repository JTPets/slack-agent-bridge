/**
 * tests/timezone-explicit.test.js
 *
 * THE enumerating guard for the claim "this codebase does not depend on the
 * process timezone". Cite this test, not a grep, when that claim is made.
 *
 * LOGIC CHANGE 2026-09-14: New file. The `jt-agent` compose sets
 * `TZ: America/New_York` while every document in this repo said the system runs on
 * `America/Toronto`. The two zones share an offset and DST rule, so the
 * disagreement is invisible at runtime today — which is exactly why it needed an
 * executable statement rather than a sentence. What makes the compose value
 * harmless is not that the zones agree; it is that **no code reads `process.env.TZ`
 * and every date-rendering and cron site names its zone explicitly**. That is a
 * property of the source, it can regress in one un-reviewed line, and nothing
 * asserted it. Now something does.
 *
 * Scanned: every non-test `.js` file in the repo, enumerated from disk, so a new
 * file is covered the moment it is added rather than when somebody remembers to
 * list it here (the `tests/no-shell-execution.test.js` pattern).
 *
 * Three checks:
 *   1. No source file reads `process.env.TZ` (directly or by bracket access).
 *   2. Every `Date.prototype.toLocale*String` / `Intl.DateTimeFormat` call passes an
 *      explicit `timeZone:` in its options.
 *   3. Every `cron.schedule(...)` call passes an explicit `timezone:`.
 *
 * Deliberately NOT asserted: *which* zone each site names. `lib/llm-metrics.js`
 * buckets by UTC on purpose (a stable key across a DST transition), and a future
 * site may have its own reason. The defect class is an *implicit* zone — one that
 * silently becomes whatever the container's `TZ` happens to be — not a zone that
 * disagrees with its neighbours. A test that pinned the string would fail the
 * deliberate UTC case and teach the reader to edit the test.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// LOGIC CHANGE 2026-10-04 (WORK-TODO #36): the walk and the comment scanner are
// tests/helpers/source-scan.js. String literals are left intact on purpose: every check
// here looks for a zone name, which is a string literal, and the process.env.TZ check
// must see bracket access written as process.env['TZ'].
const { listSourceFiles, stripComments } = require('./helpers/source-scan');




/**
 * Extract the full argument text of every call whose callee matches `calleeRe`.
 *
 * Paren-balanced rather than regex-matched: an options object spans lines and
 * contains its own parens and braces, and a line-oriented regex would either miss
 * the `timeZone:` two lines down or match a neighbouring call's.
 *
 * @param {string} src Comment-stripped source.
 * @param {RegExp} calleeRe Global regex whose match ends at the opening paren.
 * @returns {Array<{ line: number, text: string }>}
 */
function callsWithArgs(src, calleeRe) {
    const found = [];
    const re = new RegExp(calleeRe.source, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
        const open = src.indexOf('(', m.index + m[0].length - 1);
        if (open === -1) continue;

        let depth = 0;
        let i = open;
        let quote = null;
        for (; i < src.length; i += 1) {
            const ch = src[i];
            if (quote) {
                if (ch === '\\') { i += 1; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
            if (ch === '(') depth += 1;
            else if (ch === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }

        found.push({
            line: src.slice(0, m.index).split('\n').length,
            text: src.slice(open, Math.min(i + 1, src.length)),
        });
    }
    return found;
}

const SOURCE_FILES = listSourceFiles(REPO_ROOT);

describe('no source file depends on the process timezone', () => {
    test('the walk found the files it is supposed to cover', () => {
        // A guard that silently enumerates nothing passes forever. Anchor it on
        // files that must always be in scope.
        const rel = SOURCE_FILES.map((f) => path.relative(REPO_ROOT, f));
        expect(rel).toEqual(expect.arrayContaining([
            'bridge-agent.js',
            'morning-digest.js',
            path.join('lib', 'agent-scheduler.js'),
            path.join('lib', 'agent-context.js'),
        ]));
        expect(rel.length).toBeGreaterThan(20);
    });

    test('nothing reads process.env.TZ', () => {
        const offenders = [];
        for (const file of SOURCE_FILES) {
            const src = stripComments(fs.readFileSync(file, 'utf8'));
            const re = /process\s*\.\s*env\s*(?:\.\s*TZ\b|\[\s*['"]TZ['"]\s*\])/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                offenders.push(`${path.relative(REPO_ROOT, file)}:${src.slice(0, m.index).split('\n').length}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('every toLocale*String / Intl.DateTimeFormat call names its timeZone', () => {
        const offenders = [];
        for (const file of SOURCE_FILES) {
            const src = stripComments(fs.readFileSync(file, 'utf8'));
            const calls = callsWithArgs(src, /\.toLocale(?:Date|Time)?String\s*\(|Intl\s*\.\s*DateTimeFormat\s*\(/);
            for (const call of calls) {
                if (!/\btimeZone\s*:/.test(call.text)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${call.line}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('every cron.schedule call names its timezone', () => {
        const offenders = [];
        for (const file of SOURCE_FILES) {
            const src = stripComments(fs.readFileSync(file, 'utf8'));
            const calls = callsWithArgs(src, /\bcron\s*\.\s*schedule\s*\(/);
            for (const call of calls) {
                if (!/\btimezone\s*:/i.test(call.text)) {
                    offenders.push(`${path.relative(REPO_ROOT, file)}:${call.line}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Negative controls. Without these the three checks above could be passing
    // because they match nothing at all — the failure mode that let an earlier
    // guard in this repo silently scan blanked-out source and go green on every
    // file. Each control is the offending shape, fed in directly.

    test('an implicit-zone toLocaleTimeString is caught', () => {
        const src = "const s = new Date().toLocaleTimeString('en-US', { hour: '2-digit' });";
        const calls = callsWithArgs(stripComments(src), /\.toLocale(?:Date|Time)?String\s*\(/);
        expect(calls).toHaveLength(1);
        expect(/\btimeZone\s*:/.test(calls[0].text)).toBe(false);
    });

    test('an explicit-zone toLocaleTimeString is allowed, options spanning lines', () => {
        const src = [
            "const s = new Date().toLocaleTimeString('en-US', {",
            "    hour: '2-digit',",
            "    timeZone: 'America/Toronto',",
            '});',
        ].join('\n');
        const calls = callsWithArgs(stripComments(src), /\.toLocale(?:Date|Time)?String\s*\(/);
        expect(calls).toHaveLength(1);
        expect(/\btimeZone\s*:/.test(calls[0].text)).toBe(true);
    });

    test('an implicit-zone cron.schedule is caught', () => {
        const src = "cron.schedule('0 18 * * 5', () => run(), { scheduled: true });";
        const calls = callsWithArgs(stripComments(src), /\bcron\s*\.\s*schedule\s*\(/);
        expect(calls).toHaveLength(1);
        expect(/\btimezone\s*:/i.test(calls[0].text)).toBe(false);
    });

    test('process.env.TZ is detected in both spellings', () => {
        const re = /process\s*\.\s*env\s*(?:\.\s*TZ\b|\[\s*['"]TZ['"]\s*\])/;
        expect(re.test(stripComments('const z = process.env.TZ;'))).toBe(true);
        expect(re.test(stripComments("const z = process.env['TZ'];"))).toBe(true);
        // Not a false positive on a longer name that merely starts with TZ.
        expect(re.test(stripComments('const z = process.env.TZDATA;'))).toBe(false);
    });

    test('a banned shape inside a comment does not trip the guard', () => {
        const src = '// const s = new Date().toLocaleTimeString("en-US", {});\nconst x = 1;';
        expect(callsWithArgs(stripComments(src), /\.toLocale(?:Date|Time)?String\s*\(/)).toEqual([]);
    });
});
