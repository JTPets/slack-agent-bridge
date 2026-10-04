'use strict';

/**
 * tests/source-walk.test.js
 *
 * Tests for lib/source-walk.js, the one walk of the source tree (WORK-TODO #36), and the
 * regression test for the 2026-09-20 red full run: lib/file-size-gate.js measure() threw
 * ENOENT when a directory it had just listed was removed by another jest worker before it
 * recursed into it. The removal is simulated by making readdirSync fail for that one
 * directory, which is exactly the order of events in the race.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { walkFiles } = require('../lib/source-walk');
const { measure } = require('../lib/file-size-gate');

let root;

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-walk-'));
    const put = (rel, text = 'x\n') => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
    };
    put('a.js');
    put('lib/b.js');
    put('lib/deep/c.js');
    put('lib/notes.md');
    put('node_modules/dep/index.js');
    put('.hidden/d.js');
    put('vanishing/e.js');
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

/** Make readdirSync behave as if `dir` was removed after its parent was listed. */
function vanish(dir) {
    const real = fs.readdirSync;
    jest.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
        if (p === dir) throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${p}'`), { code: 'ENOENT' });
        return real.call(fs, p, ...rest);
    });
}

const rel = (files) => files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

describe('walkFiles', () => {
    test('finds files by extension, recursively, skipping hidden entries and skipDirs', () => {
        expect(rel(walkFiles(root))).toEqual(['a.js', 'lib/b.js', 'lib/deep/c.js', 'vanishing/e.js']);
        expect(rel(walkFiles(root, { skipDirs: ['node_modules', 'lib'] }))).toEqual(['a.js', 'vanishing/e.js']);
    });

    test('an empty ext matches every file', () => {
        expect(rel(walkFiles(root, { ext: '' }))).toContain('lib/notes.md');
    });

    test('a directory removed between being listed and being entered is skipped, not thrown', () => {
        vanish(path.join(root, 'vanishing'));
        expect(rel(walkFiles(root))).toEqual(['a.js', 'lib/b.js', 'lib/deep/c.js']);
    });

    test('a missing ROOT throws — a walk of nothing must not look like a clean walk', () => {
        expect(() => walkFiles(path.join(root, 'no-such-dir'))).toThrow(/ENOENT/);
    });

    test('an error other than ENOENT below the root still throws', () => {
        const real = fs.readdirSync;
        jest.spyOn(fs, 'readdirSync').mockImplementation((p, ...rest) => {
            if (p === path.join(root, 'lib')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            return real.call(fs, p, ...rest);
        });
        expect(() => walkFiles(root)).toThrow(/EACCES/);
    });
});

describe('lib/file-size-gate.js measure() survives the 2026-09-20 race', () => {
    test('a directory removed mid-walk is skipped and the rest is measured', () => {
        vanish(path.join(root, 'vanishing'));
        expect(measure(root).map((f) => f.path).sort()).toEqual(['a.js', 'lib/b.js', 'lib/deep/c.js']);
    });

    test('a file removed between the listing and the read is skipped', () => {
        const real = fs.readFileSync;
        jest.spyOn(fs, 'readFileSync').mockImplementation((p, ...rest) => {
            if (p === path.join(root, 'lib', 'b.js')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return real.call(fs, p, ...rest);
        });
        expect(measure(root).map((f) => f.path).sort()).toEqual(['a.js', 'lib/deep/c.js', 'vanishing/e.js']);
    });
});

describe('one walker, one scanner (WORK-TODO #36)', () => {
    const REPO = path.join(__dirname, '..');
    const DEFINES_COPY = /\bfunction\s+(stripComments|stripCommentsAndStrings|listSourceFiles|collectSourceFiles)\s*\(/;
    const OWNER = path.join('tests', 'helpers', 'source-scan.js');

    test('the pattern detects a re-derived copy (negative control)', () => {
        expect(DEFINES_COPY.test('function listSourceFiles(dir, out = []) {')).toBe(true);
        expect(DEFINES_COPY.test('function stripComments(src) {')).toBe(true);
        expect(DEFINES_COPY.test('const { listSourceFiles } = require(\'./helpers/source-scan\');')).toBe(false);
    });

    test('no file in tests/ or lib/ defines its own copy outside tests/helpers/source-scan.js', () => {
        const files = [
            ...walkFiles(path.join(REPO, 'tests'), { ext: '.js' }),
            ...walkFiles(path.join(REPO, 'lib'), { ext: '.js' }),
        ].map((f) => path.relative(REPO, f));
        expect(files).toContain(OWNER);
        const copies = files
            .filter((f) => f !== OWNER && f !== path.join('tests', 'source-walk.test.js'))
            .filter((f) => DEFINES_COPY.test(fs.readFileSync(path.join(REPO, f), 'utf8')));
        expect(copies).toEqual([]);
    });
});
