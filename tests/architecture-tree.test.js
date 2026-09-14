/**
 * tests/architecture-tree.test.js
 *
 * THE enumerating guard for CLAUDE.md's Architecture block. Cite this test, not a
 * count and not a `ls | diff`, when claiming the tree is complete.
 *
 * LOGIC CHANGE 2026-09-14: New file. CLAUDE.md carries the rule "Update CLAUDE.md
 * architecture section when adding new files", and docs/EXECUTOR-CONTRACT.md section 6
 * restates it as a gate. Both were being broken by the repository that defines them:
 * seven modules (lib/agent-scheduler.js, lib/bulletin-watcher.js, lib/heartbeat.js,
 * lib/notify-owner.js, lib/redact-secrets.js, lib/integrations/catalog-search.js,
 * lib/integrations/square-catalog.js) and ten test files were absent from the tree.
 * Five of those modules are `require`d directly by bridge-agent.js, so the omission was
 * not of stray files — it was of live wiring, in the document that is supposed to be
 * the source of truth about it.
 *
 * A rule enforced by prose gets broken silently and is discovered by someone reading
 * carefully. That is exactly the "trigger pointing at a nonexistent doc is a silent
 * no-op" shape the contract warns about, so the rule is made executable here.
 *
 * Two directions, because either alone is half a guard:
 *   1. COMPLETENESS — every source file on disk appears in the tree. Fails when a new
 *      module lands without its line.
 *   2. NO GHOSTS — every path-looking basename in the tree exists on disk. Fails when
 *      a module is deleted or renamed and the tree keeps describing it. Doc-vs-reality
 *      drift runs in both directions and only this half catches a deletion.
 *
 * Scope: .js files under lib/, lib/integrations/, bots/, scripts/, memory/ and tests/,
 * plus the top-level entry points. Deliberately NOT asserted: the description text, the
 * box-drawing characters, or the ordering — this guard is about presence, and a guard
 * that also policed prose would be edited into uselessness the first time it was wrong
 * about a wording.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');

/** Directories whose .js files must each have a tree line. */
const TRACKED_DIRS = ['lib', path.join('lib', 'integrations'), 'bots', 'scripts', 'memory', 'tests'];

/**
 * The Architecture block: the fenced code block that begins with the repo name.
 *
 * Located by content rather than by line number so it survives the document being
 * reordered. If the block is ever renamed or removed, `architectureBlock()` throws and
 * every test here fails loudly rather than passing on an empty string — a guard that
 * silently scans nothing is the failure mode this file exists to prevent elsewhere.
 *
 * @returns {string}
 */
function architectureBlock() {
    const md = fs.readFileSync(CLAUDE_MD, 'utf8');
    const start = md.indexOf('```\nslack-agent-bridge/');
    if (start === -1) {
        throw new Error('CLAUDE.md: could not find the Architecture code block (```\\nslack-agent-bridge/)');
    }
    const end = md.indexOf('\n```', start + 3);
    if (end === -1) {
        throw new Error('CLAUDE.md: Architecture code block is unterminated');
    }
    return md.slice(start, end);
}

/**
 * Top-level .js files that are process entry points (not config, not a stray script).
 *
 * @returns {string[]} Basenames.
 */
function topLevelEntryPoints() {
    return fs
        .readdirSync(REPO_ROOT, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.js'))
        .map((e) => e.name);
}

/**
 * Every source file that must appear in the tree, as repo-relative paths.
 *
 * This walk IS the regeneration command. Reproduce it from the shell with:
 *   ls lib/*.js lib/integrations/*.js bots/*.js scripts/*.js memory/*.js tests/*.js *.js
 *
 * @returns {string[]}
 */
function trackedSourceFiles() {
    const files = topLevelEntryPoints();
    for (const dir of TRACKED_DIRS) {
        const full = path.join(REPO_ROOT, dir);
        if (!fs.existsSync(full)) continue;
        for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.js')) {
                files.push(path.join(dir, entry.name));
            }
        }
    }
    return files;
}

describe('CLAUDE.md architecture tree is complete', () => {
    test('the Architecture block is findable and non-trivial', () => {
        const block = architectureBlock();
        expect(block.length).toBeGreaterThan(1000);
        expect(block).toContain('bridge-agent.js');
    });

    test('the walk found the files it is supposed to cover', () => {
        // Anchors, so a broken walk cannot pass by enumerating nothing.
        const files = trackedSourceFiles();
        expect(files).toEqual(expect.arrayContaining([
            'bridge-agent.js',
            path.join('lib', 'config.js'),
            path.join('lib', 'integrations', 'gmail.js'),
            path.join('tests', 'smoke.test.js'),
        ]));
        expect(files.length).toBeGreaterThan(60);
    });

    test('every source file under lib/, bots/, scripts/, memory/, tests/ and every top-level entry point appears in the tree', () => {
        const block = architectureBlock();
        const missing = trackedSourceFiles()
            .filter((rel) => !block.includes(path.basename(rel)))
            .sort();
        expect(missing).toEqual([]);
    });

    test('every file the tree names exists on disk', () => {
        const block = architectureBlock();
        // A tree line looks like "│   ├── name.js   # description". Take the token
        // immediately after the box-drawing prefix; only .js/.json entries are checked,
        // because directories and .md files are covered by their own conventions.
        const named = new Set();
        for (const line of block.split('\n')) {
            const m = line.match(/[├└]──\s+([A-Za-z0-9._-]+\.(?:js|json))\s*(?:#|$)/);
            if (m) named.add(m[1]);
        }
        expect(named.size).toBeGreaterThan(50);

        const onDisk = new Set();
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else onDisk.add(entry.name);
            }
        };
        walk(REPO_ROOT);

        // Runtime-created files are named in the tree deliberately (the tree documents
        // them as "created at runtime, gitignored"), so their absence is not drift.
        const RUNTIME_CREATED = new Set([
            'bulletin.json',
            'watercooler-state.json',
            'processed-tasks.json',
            'channel-map.json',
            'approval-queue.json',
            'delivery-quotes.json',
            'working.json',
            'short-term.json',
            'long-term.json',
            'archive.json',
        ]);

        const ghosts = [...named].filter((n) => !onDisk.has(n) && !RUNTIME_CREATED.has(n)).sort();
        expect(ghosts).toEqual([]);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Negative controls. Both directions are exercised against synthetic input, so the
    // two checks above cannot be green merely because they compared empty sets.

    test('completeness: a file absent from a block is reported', () => {
        const block = '```\nslack-agent-bridge/\n├── lib/\n│   ├── config.js   # present\n```';
        const files = [path.join('lib', 'config.js'), path.join('lib', 'ghost-module.js')];
        const missing = files.filter((rel) => !block.includes(path.basename(rel)));
        expect(missing).toEqual([path.join('lib', 'ghost-module.js')]);
    });

    test('no-ghosts: a tree line naming a deleted file is reported', () => {
        const block = [
            '```',
            'slack-agent-bridge/',
            '├── lib/',
            '│   ├── config.js        # real',
            '│   └── deleted-thing.js # stale line left behind by a removal',
            '```',
        ].join('\n');
        const named = [];
        for (const line of block.split('\n')) {
            const m = line.match(/[├└]──\s+([A-Za-z0-9._-]+\.(?:js|json))\s*(?:#|$)/);
            if (m) named.push(m[1]);
        }
        expect(named).toEqual(['config.js', 'deleted-thing.js']);

        const onDisk = new Set(['config.js']);
        expect(named.filter((n) => !onDisk.has(n))).toEqual(['deleted-thing.js']);
    });

    test('the line parser does not mistake a directory entry for a file', () => {
        const line = '│   └── integrations/';
        expect(line.match(/[├└]──\s+([A-Za-z0-9._-]+\.(?:js|json))\s*(?:#|$)/)).toBeNull();
    });
});
