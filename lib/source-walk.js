'use strict';

/**
 * lib/source-walk.js
 *
 * THE one walk of the source tree from disk. lib/file-size-gate.js measure() uses it,
 * and tests/helpers/source-scan.js re-exports it for every enumerating guard.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #36): until now the tree was walked by eight
 * separate copies of the same discover-then-recurse loop (the file-size gate, two in
 * tests/architecture-tree.test.js, and one each in the no-shell, timezone, test-gate,
 * bulletin-types and weekly-critique-gating guards). None tolerated a directory that
 * vanished between being listed and being entered, so a parallel jest worker removing a
 * temp directory turned a full run red (2026-09-20, recorded under #56). One walker
 * makes that tolerance one place instead of eight.
 *
 * Two rules, both deliberate:
 *   - A directory BELOW the root that disappears mid-walk is skipped: it was listed by a
 *     readdir that raced its removal, and it held nothing that is still there.
 *   - The ROOT not existing throws. A walk of a missing root that returned [] would be a
 *     guard enumerating nothing and passing, which is the failure every guard here
 *     exists to prevent.
 */

const fs = require('fs');
const path = require('path');

/**
 * Every file under `root` whose name ends with `ext`, as absolute paths. Entries whose
 * name starts with `.` are always skipped; directories named in `skipDirs` are not
 * entered.
 *
 * @param {string} root
 * @param {{ skipDirs?: Iterable<string>, ext?: string }} [opts]
 * @returns {string[]}
 */
function walkFiles(root, { skipDirs = ['node_modules'], ext = '.js' } = {}) {
    const skip = new Set(skipDirs);
    const out = [];
    const walk = (dir, isRoot) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            if (err.code === 'ENOENT' && !isRoot) return;
            throw err;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!skip.has(entry.name)) walk(full, false);
            } else if (entry.isFile() && entry.name.endsWith(ext)) {
                out.push(full);
            }
        }
    };
    walk(root, true);
    return out;
}

module.exports = { walkFiles };
