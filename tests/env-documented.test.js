'use strict';

/**
 * tests/env-documented.test.js
 *
 * THE enumerating guard for "the code reads an environment variable nobody documented"
 * (WORK-TODO #34 and the .env.example half of #4b, 2026-10-04). Every
 * `process.env.NAME` / `process.env['NAME']` read in production code, enumerated from
 * disk with comments stripped, must have a `NAME=` line in .env.example (commented out is
 * fine: most are optional) and a `NAME` row in CLAUDE.md. When this was written 25 such
 * reads were missing from .env.example, `DEPLOY_KEY_PATH` among them, so a rebuilder
 * working from the example could not know the bridge pushes with a key at a container
 * path, and a wrong path silently makes every clone READ-ONLY.
 *
 * Known blind spot, stated: modules that take an injected `env` object
 * (lib/slack-socket.js, lib/agent-llm-resolver.js, lib/config.js getConfiguredRepos) read
 * `env.NAME`, which this pattern does not see. Their variables are documented today; a new
 * one added that way is not caught here.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, stripComments, REPO_ROOT } = require('./helpers/source-scan');

const ENV_READ = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;

/** Names read by `code`. */
function envReads(code) {
    const names = new Set();
    for (const m of code.matchAll(ENV_READ)) names.add(m[1] || m[2]);
    return names;
}

/** Names with a `NAME=` line, commented or not, in an env-example text. */
function exampleNames(text) {
    return new Set([...text.matchAll(/^#?[ \t]*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

describe('the patterns match what they claim (negative controls)', () => {
    test('envReads sees both read forms and not a comment', () => {
        const code = stripComments([
            "const a = process.env.DEPLOY_KEY_PATH || '/x';",
            "const b = process.env['TASK_LOCK_STALE_MS'];",
            '// process.env.IN_A_COMMENT',
        ].join('\n'));
        expect([...envReads(code)].sort()).toEqual(['DEPLOY_KEY_PATH', 'TASK_LOCK_STALE_MS']);
    });

    test('exampleNames accepts a commented-out line and rejects prose', () => {
        const names = exampleNames('# DEPLOY_KEY_PATH=/bridge/.deploy_key\nWORK_DIR=/tmp\n# set DEPLOY_KEY_PATH to change it\n');
        expect([...names].sort()).toEqual(['DEPLOY_KEY_PATH', 'WORK_DIR']);
    });

    test('a read missing from the example is reported (the shape of #34)', () => {
        const missing = [...envReads("process.env.DEPLOY_KEY_PATH")].filter((n) => !exampleNames('WORK_DIR=/tmp\n').has(n));
        expect(missing).toEqual(['DEPLOY_KEY_PATH']);
    });
});

describe('every environment variable the code reads is documented', () => {
    const reads = new Map();
    for (const abs of listSourceFiles()) {
        for (const name of envReads(stripComments(fs.readFileSync(abs, 'utf8')))) {
            if (!reads.has(name)) reads.set(name, []);
            reads.get(name).push(path.relative(REPO_ROOT, abs));
        }
    }

    test('the walk found the reads it should', () => {
        expect(reads.get('DEPLOY_KEY_PATH')).toEqual(['lib/clone-lifecycle.js']);
        expect(reads.size).toBeGreaterThan(40);
    });

    test('in .env.example', () => {
        const documented = exampleNames(read('.env.example'));
        const missing = [...reads].filter(([n]) => !documented.has(n)).map(([n, files]) => `${n} (${files.join(', ')})`);
        expect(missing).toEqual([]);
    });

    test('in CLAUDE.md', () => {
        const claude = read('CLAUDE.md');
        const missing = [...reads].filter(([n]) => !claude.includes(`\`${n}\``)).map(([n, files]) => `${n} (${files.join(', ')})`);
        expect(missing).toEqual([]);
    });

    test('MAX_TURNS is not read: it reached no LLM call (WORK-TODO #20)', () => {
        expect(reads.has('MAX_TURNS')).toBe(false);
    });
});
