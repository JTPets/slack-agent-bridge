/**
 * tests/file-size-gate.test.js
 *
 * THE enumerating guard for the 300-line-per-file rule. Cite this test — not a count,
 * not a `npm run validate` you ran once — when claiming the size gate means something.
 *
 * LOGIC CHANGE 2026-09-15: New file. The rule existed and was enforced by
 * lib/validate.js, but it failed on every over-limit file unconditionally (65 of them),
 * so it was red on every run. A permanently red gate cannot report a new violation:
 * telling one apart from the standing ones meant diffing path lists by hand, and twice
 * in the week of 2026-09-08 nobody did. The rule is now declaration-driven
 * (lib/file-size-gate.js + lib/validate-exceptions.json) and this is its guard.
 *
 * Two live assertions and one direction each, following tests/architecture-tree.test.js:
 *   1. GREEN ON A CLEAN TREE — every over-limit file carries a recorded justification.
 *      This is what makes a new violation visible: it is the only thing that can turn
 *      this red.
 *   2. NO ROT — no declared entry names a file that is gone or has since come back
 *      under the limit. Without this, the list becomes a permanent amnesty that stops
 *      describing reality, which is the same doc-vs-reality drift the architecture-tree
 *      guard exists to catch in CLAUDE.md.
 *
 * Plus negative controls, because both assertions above are "expect this list to be
 * empty" and an evaluator that always returned empty lists would pass them.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gate = require('../lib/file-size-gate');

const REPO_ROOT = path.join(__dirname, '..');

describe('the size gate is green on this tree', () => {
    test('the walk found the files it is supposed to cover', () => {
        // An anchor, so the gate cannot be green merely by enumerating nothing.
        const files = gate.measure();
        const paths = files.map((f) => f.path);
        expect(paths).toEqual(expect.arrayContaining([
            'bridge-agent.js',
            'lib/config.js',
            'lib/integrations/gmail.js',
            'tests/smoke.test.js',
        ]));
        expect(files.length).toBeGreaterThan(80);
        expect(paths.some((p) => p.startsWith('node_modules/'))).toBe(false);
    });

    test('the declaration file parses and every entry carries a reason', () => {
        const exceptions = gate.loadExceptions();
        expect(exceptions.length).toBeGreaterThan(0);
        for (const e of exceptions) {
            expect(typeof e.path).toBe('string');
            expect(e.path.length).toBeGreaterThan(0);
            expect(typeof e.reason).toBe('string');
            // A reason has to say something. "yes" would satisfy a truthiness check.
            expect(e.reason.trim().length).toBeGreaterThan(40);
        }
    });

    test('no file is over the limit without a recorded justification', () => {
        const result = gate.check();
        expect(result.undeclared.map((f) => `${f.path}: ${f.lines} lines`)).toEqual([]);
    });

    test('no declared exception has rotted — every entry names a file that still exceeds the limit', () => {
        const result = gate.check();
        expect(result.stale.map((e) => `${e.path}: ${e.reason}`)).toEqual([]);
    });

    test('no path is declared twice', () => {
        expect(gate.check().duplicates).toEqual([]);
    });

    test('the gate as a whole passes, and says how many exceptions it is carrying', () => {
        const result = gate.check();
        expect(result.ok).toBe(true);
        expect(gate.formatReport(result).join('\n')).toContain('declared exceptions');
    });

    test('every declared path exists on disk', () => {
        for (const e of gate.loadExceptions()) {
            expect(fs.existsSync(path.join(REPO_ROOT, e.path))).toBe(true);
        }
    });
});

describe('the guard itself detects what it claims to', () => {
    const REASON = 'a reason long enough to be a real justification, stating why';

    test('an undeclared file over the limit is reported', () => {
        const result = gate.evaluate({
            files: [{ path: 'lib/new-thing.js', lines: 301 }, { path: 'lib/small.js', lines: 12 }],
            exceptions: [],
            maxLines: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.undeclared.map((f) => f.path)).toEqual(['lib/new-thing.js']);
    });

    test('a file exactly at the limit is not a violation, and one line over is', () => {
        const at = gate.evaluate({ files: [{ path: 'a.js', lines: 300 }], exceptions: [], maxLines: 300 });
        const over = gate.evaluate({ files: [{ path: 'a.js', lines: 301 }], exceptions: [], maxLines: 300 });
        expect(at.ok).toBe(true);
        expect(over.undeclared.map((f) => f.path)).toEqual(['a.js']);
    });

    test('a declared file over the limit passes, and is counted as declared', () => {
        const result = gate.evaluate({
            files: [{ path: 'big.js', lines: 900 }],
            exceptions: [{ path: 'big.js', reason: REASON }],
            maxLines: 300,
        });
        expect(result.ok).toBe(true);
        expect(result.declared.map((f) => f.path)).toEqual(['big.js']);
    });

    test('an entry for a file that is now under the limit is reported as stale', () => {
        const result = gate.evaluate({
            files: [{ path: 'shrunk.js', lines: 120 }],
            exceptions: [{ path: 'shrunk.js', reason: REASON }],
            maxLines: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.stale.map((e) => e.path)).toEqual(['shrunk.js']);
        expect(result.stale[0].reason).toContain('under the 300-line limit');
    });

    test('an entry for a file that no longer exists is reported as stale', () => {
        const result = gate.evaluate({
            files: [{ path: 'kept.js', lines: 400 }],
            exceptions: [
                { path: 'kept.js', reason: REASON },
                { path: 'deleted.js', reason: REASON },
            ],
            maxLines: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.stale.map((e) => e.path)).toEqual(['deleted.js']);
        expect(result.stale[0].reason).toContain('does not exist');
    });

    test('an entry with a blank reason is reported — the cost of an exception is writing down why', () => {
        const result = gate.evaluate({
            files: [{ path: 'big.js', lines: 900 }],
            exceptions: [{ path: 'big.js', reason: '   ' }],
            maxLines: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.unreasoned.map((e) => e.path)).toEqual(['big.js']);
    });

    test('an entry with no reason key at all is reported', () => {
        const result = gate.evaluate({
            files: [{ path: 'big.js', lines: 900 }],
            exceptions: [{ path: 'big.js' }],
            maxLines: 300,
        });
        expect(result.unreasoned.map((e) => e.path)).toEqual(['big.js']);
    });

    test('the same path declared twice is reported', () => {
        const result = gate.evaluate({
            files: [{ path: 'big.js', lines: 900 }],
            exceptions: [
                { path: 'big.js', reason: REASON },
                { path: 'big.js', reason: 'a different reason, equally long, and now ignored' },
            ],
            maxLines: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.duplicates).toEqual(['big.js']);
    });

    test('the report names the offending file and says what to do about it', () => {
        const result = gate.evaluate({
            files: [{ path: 'lib/new-thing.js', lines: 412 }],
            exceptions: [],
            maxLines: 300,
        });
        const text = gate.formatReport(result, 300).join('\n');
        expect(text).toContain('lib/new-thing.js: 412 lines');
        expect(text).toContain('lib/validate-exceptions.json');
    });

    test('a missing declaration file throws rather than defaulting to no exceptions', () => {
        // Failing open here would turn all 63 recorded justifications into fresh
        // violations, or worse, report a green with nothing declared.
        expect(() => gate.loadExceptions(path.join(REPO_ROOT, 'lib', 'no-such-file.json'))).toThrow();
    });

    test('a declaration file with no exceptions array throws', () => {
        const tmp = path.join(require('os').tmpdir(), `exc-${process.pid}.json`);
        fs.writeFileSync(tmp, JSON.stringify({ nope: true }), 'utf8');
        try {
            expect(() => gate.loadExceptions(tmp)).toThrow(/exceptions/);
        } finally {
            fs.rmSync(tmp, { force: true });
        }
    });
});
