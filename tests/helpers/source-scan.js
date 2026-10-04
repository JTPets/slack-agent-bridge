'use strict';

/**
 * tests/helpers/source-scan.js
 *
 * What the enumerating guards share: which files they scan, and how comments are
 * removed before scanning. Extracted 2026-10-04 (WORK-TODO #36) from the copies in
 * tests/no-shell-execution.test.js, tests/timezone-explicit.test.js and
 * tests/test-gate-honesty.test.js, which were character-for-character equivalent apart
 * from one deliberate difference, kept here as an option rather than merged away:
 *
 *   - `blankStrings: true`  — string and template CONTENTS are blanked too, so message
 *     text that merely names a banned API does not trip a call-site ban (the shell guard).
 *   - `blankStrings: false` — strings are left intact, because the thing being detected
 *     IS a string literal: `'npm test'`, a zone name, the `'child_process'` module name.
 *
 * The walk itself is lib/source-walk.js, the same one lib/file-size-gate.js uses, so a
 * directory removed mid-walk by a parallel worker is skipped in every guard at once.
 */

const path = require('path');
const { walkFiles } = require('../../lib/source-walk');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Directories that hold no production source. `tests` is the guards themselves. */
const NON_SOURCE_DIRS = ['node_modules', 'tests', 'coverage', 'public'];

/**
 * Every non-test .js file in the repository, enumerated from disk. Reproduce with:
 *   find . -name '*.js' -not -path './node_modules/*' -not -path './.*' \
 *          -not -path './tests/*' -not -path './coverage/*' -not -path './public/*' | sort
 *
 * @param {string} [root]
 * @returns {string[]} Absolute paths, sorted.
 */
function listSourceFiles(root = REPO_ROOT) {
    return walkFiles(root, { skipDirs: NON_SOURCE_DIRS, ext: '.js' }).sort();
}

/**
 * Blank out comments — and, with `blankStrings`, string/template contents — preserving
 * offsets and line structure so a reported match still points at real code.
 *
 * A small character scanner rather than a regex, because a regex that tries to tell a
 * string from a comment from a division operator gets this wrong in ways that make a
 * guard either blind or permanently red.
 *
 * @param {string} src
 * @param {{ blankStrings?: boolean }} [opts]
 * @returns {string}
 */
function stripComments(src, { blankStrings = false } = {}) {
    const out = Array.from(src);
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k += 1) {
            if (out[k] !== '\n') out[k] = ' ';
        }
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            const end = src.indexOf('\n', i);
            blank(i, end === -1 ? src.length : end);
            i = end === -1 ? src.length : end;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === c) break;
                j += 1;
            }
            // Keep the delimiters so the code still tokenises.
            if (blankStrings) blank(i + 1, Math.min(j, src.length));
            i = Math.min(j + 1, src.length);
            continue;
        }
        i += 1;
    }
    return out.join('');
}

module.exports = { REPO_ROOT, NON_SOURCE_DIRS, listSourceFiles, stripComments, walkFiles };
