'use strict';

/**
 * tests/toolchain-support.test.js
 *
 * THE enumerating guard that CLAUDE.md's SUPPORTED TOOLCHAINS table describes the
 * ecosystems `lib/dependency-install.js` can actually detect.
 *
 * LOGIC CHANGE 2026-09-20: New file (WORK-TODO #68). The bridge installs a dispatched
 * repo's OWN dependencies into its scratch clone using whatever the `jt-agent` image
 * carries, so the image's toolchain decides which repositories can be verified at all.
 * That list is now written down in three places. A written list drifts: the moment
 * `detectEcosystem` learns a new manifest, the table silently becomes a description of
 * the past, and the failure it would hide is the expensive one — a toolchain that is
 * PRESENT but resolves a different version than the target repo runs on produces a green
 * here that is not a green on the box. An absent toolchain is loud (INSTALLER_ABSENT); a
 * wrong one is not.
 *
 * So the list is held against the code rather than against a reviewer's memory. Two
 * directions, because either alone is half a guard:
 *   1. COMPLETENESS — every `ecosystem:` name and every manifest filename in
 *      detectEcosystem's own source has a row in the table. Fails when the code learns an
 *      ecosystem nobody declared an image status for.
 *   2. NO GHOSTS — every ecosystem the table names is one the source can actually
 *      produce. Fails when the table claims support for something that was removed.
 *
 * Deliberately NOT asserted: whether a declared status is TRUE. "pip is absent from the
 * image" is an off-box fact, operator-supplied and dated on the row itself; no test in a
 * checkout can establish it, and a guard that pretended to would be the exact dishonesty
 * this repo's test-verdict rules exist to prevent. This guard polices presence.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const SOURCE = path.join(REPO_ROOT, 'lib', 'dependency-install.js');

const TABLE_HEADING = '#### Supported toolchains';

/**
 * The toolchain block: the section of CLAUDE.md from its heading to the next heading.
 *
 * Located by content, not by line number, so it survives the document being reordered.
 * Throws when the section is gone, so every assertion here fails loudly rather than
 * passing against an empty string — a guard that silently scans nothing is the failure
 * mode this file exists to prevent.
 *
 * **Fenced code blocks are not scanned for headings.** The section carries a shell block
 * whose output line begins `# /usr/bin/python3: …`; a naive `^#{1,4} ` search ends the
 * section there and every assertion below it then passes against text it never saw. That
 * is not hypothetical — it is how the first version of this guard behaved, and it is the
 * same "a guard that scans nothing looks exactly like a guard that found nothing" shape
 * the negative controls at the bottom exist for.
 *
 * @param {string} [md] - Document text; defaults to CLAUDE.md on disk.
 * @returns {string}
 */
function toolchainBlock(md) {
    const text = md === undefined ? fs.readFileSync(CLAUDE_MD, 'utf8') : md;
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.startsWith(TABLE_HEADING));
    if (start === -1) {
        throw new Error(`CLAUDE.md: could not find the "${TABLE_HEADING}" section`);
    }
    const out = [lines[start]];
    let fenced = false;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('```')) fenced = !fenced;
        if (!fenced && /^#{1,6} /.test(line)) break;
        out.push(line);
    }
    return out.join('\n');
}

/**
 * Every ecosystem name the source can return, read from its own text.
 *
 * `ecosystem: 'node'` / `ecosystem: 'none'` — the literals detectEcosystem returns.
 *
 * @param {string} [src]
 * @returns {string[]} sorted, unique
 */
function ecosystemsInSource(src) {
    const text = src === undefined ? fs.readFileSync(SOURCE, 'utf8') : src;
    const found = new Set();
    for (const m of text.matchAll(/ecosystem:\s*'([a-z0-9_-]+)'/g)) found.add(m[1]);
    return [...found].sort();
}

/**
 * Every filename the source tests a clone for, read from its own text.
 *
 * `has('package.json')` — the manifest and lockfile probes inside detectEcosystem.
 *
 * @param {string} [src]
 * @returns {string[]} sorted, unique
 */
function manifestsInSource(src) {
    const text = src === undefined ? fs.readFileSync(SOURCE, 'utf8') : src;
    const found = new Set();
    for (const m of text.matchAll(/has\('([^']+)'\)/g)) found.add(m[1]);
    return [...found].sort();
}

/**
 * The ecosystem named in the first cell of each table row, with markdown emphasis and
 * code ticks stripped. The header row and the `|---|` separator are skipped.
 *
 * @param {string} block
 * @returns {string[]}
 */
function rowsInBlock(block) {
    const names = [];
    for (const line of block.split('\n')) {
        if (!line.startsWith('|') || /^\|[\s:-]+\|/.test(line)) continue;
        const first = line.split('|')[1];
        if (first === undefined) continue;
        const bare = first.replace(/\*+/g, '').replace(/`/g, '').replace(/\(.*?\)/g, '').trim();
        if (!bare || bare.toLowerCase() === 'ecosystem') continue;
        names.push(bare);
    }
    return names;
}

/** Names present in the source that the block never mentions. */
function undeclared(names, block) {
    return names.filter((n) => !block.includes(n));
}

describe('the SUPPORTED TOOLCHAINS table matches what the code detects', () => {
    test('every ecosystem detectEcosystem can return has a row in the table', () => {
        const names = ecosystemsInSource();
        expect(names.length).toBeGreaterThan(0);
        const rows = rowsInBlock(toolchainBlock());
        expect(rows.length).toBeGreaterThan(0);

        const missing = names.filter((n) => !rows.includes(n));
        expect(missing).toEqual([]);
    });

    test('every manifest filename the code probes for is named in the table', () => {
        const manifests = manifestsInSource();
        expect(manifests.length).toBeGreaterThan(0);
        expect(undeclared(manifests, toolchainBlock())).toEqual([]);
    });

    test('NO GHOSTS: every ecosystem the table names is one the code can produce', () => {
        const names = ecosystemsInSource();
        for (const row of rowsInBlock(toolchainBlock())) {
            expect(names).toContain(row);
        }
    });

    test('the table states an image status for each row, not just a name', () => {
        const block = toolchainBlock();
        expect(block).toMatch(/\*\*SUPPORTED\./);
        expect(block).toMatch(/\*\*NOT SUPPORTED\./);
        // The off-box evidence must stay attached to the claim it supports.
        expect(block).toMatch(/2026-09-20/);
        expect(block).toMatch(/No module named pip/);
    });

    test('the code still refuses an unsupported toolchain loudly — INSTALLER_ABSENT', () => {
        const { OUTCOME, HARNESS_OUTCOMES } = require('../lib/dependency-install');
        expect(HARNESS_OUTCOMES.has(OUTCOME.INSTALLER_ABSENT)).toBe(true);
        // The pattern the pip-absent message is recognised by must still be in the source:
        // without it a missing pip reads as INSTALL_FAILED, i.e. "the repo is broken".
        expect(fs.readFileSync(SOURCE, 'utf8')).toMatch(/No module named pip/);
    });
});

// Both live assertions above are "expect this list to be empty", which is also what a
// broken extractor produces. These prove the extractors and the comparison still work.
describe('the guard itself detects what it claims to', () => {
    const BLOCK = [
        TABLE_HEADING + ' — x',
        '',
        '| Ecosystem | Manifest | Installer | Status |',
        '|---|---|---|---|',
        '| **node** | `package.json` | `npm` | **SUPPORTED.** |',
        '| **`none`** *(anything else)* | no manifest | nothing | **NOT DETECTED.** |',
        '',
    ].join('\n');

    test('ecosystemsInSource finds the literals, and only those', () => {
        const src = "return { ecosystem: 'node' }; return { ecosystem: 'ruby' };";
        expect(ecosystemsInSource(src)).toEqual(['node', 'ruby']);
    });

    test('manifestsInSource finds the probed filenames', () => {
        const src = "if (has('Gemfile')) {} if (has('package.json')) {}";
        expect(manifestsInSource(src)).toEqual(['Gemfile', 'package.json']);
    });

    test('rowsInBlock strips emphasis and ticks, and skips the header and separator', () => {
        expect(rowsInBlock(BLOCK)).toEqual(['node', 'none']);
    });

    test('an ecosystem in the source with no row is REPORTED, not passed over', () => {
        const src = "ecosystem: 'node'\necosystem: 'ruby'";
        const rows = rowsInBlock(BLOCK);
        const missing = ecosystemsInSource(src).filter((n) => !rows.includes(n));
        expect(missing).toEqual(['ruby']);
    });

    test('a manifest in the source that the block never names is REPORTED', () => {
        expect(undeclared(manifestsInSource("has('Gemfile')"), BLOCK)).toEqual(['Gemfile']);
    });

    test('a table row the code cannot produce is REPORTED', () => {
        const ghosts = rowsInBlock(BLOCK).filter((r) => !ecosystemsInSource("ecosystem: 'node'").includes(r));
        expect(ghosts).toEqual(['none']);
    });

    test('a `#` line INSIDE a fenced block does not end the section', () => {
        // The regression this guard was written wrong for once: the shell block's output
        // line starts with `# `, and a naive heading search truncated the section there.
        const md = [
            TABLE_HEADING + ' — x',
            '',
            '```bash',
            "docker exec -i jt-agent sh -c 'python3 -m pip --version'",
            '# /usr/bin/python3: No module named pip',
            '```',
            '',
            'TAIL-SENTINEL',
            '',
            '## the next real heading',
            'NOT-IN-BLOCK',
        ].join('\n');
        const block = toolchainBlock(md);
        expect(block).toContain('No module named pip');
        expect(block).toContain('TAIL-SENTINEL');
        expect(block).not.toContain('NOT-IN-BLOCK');
    });

    test('a missing section THROWS rather than scanning an empty string', () => {
        expect(() => toolchainBlock('# a document with no such section\n')).toThrow(
            /could not find/
        );
    });
});
