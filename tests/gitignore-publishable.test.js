'use strict';

/**
 * tests/gitignore-publishable.test.js
 *
 * THE guard that files which must never be publishable are ignored by git — asked of
 * `git check-ignore` itself, not of the text of .gitignore.
 *
 * LOGIC CHANGE 2026-10-02: New file (WORK-TODO #62). This repository is public and its
 * deploy directory on the NAS is the working tree. On 2026-10-01 the operator's
 * `git status --short --untracked-files=all` there listed, untracked and NOT ignored:
 * `.env.swo` (a vim swap copy of the live .env), `agents.json.local`,
 * `agents/shared/channel-map.json.pre-rebuild` and `work/task-queue.json` (work/ is the
 * live WORK_DIR, bind-mounted). One `git add -A` would have published every one.
 *
 * WHY check-ignore AND NOT A REGEX OVER .gitignore. Ignore semantics are git's: order,
 * negation, anchoring and directory rules decide the answer, and a test that greps the
 * file for a line can pass while git ignores nothing (a later `!` re-include, a
 * mis-anchored pattern). `--no-index` makes git answer from the rules alone, so a
 * tracked path like `.env.example` is judged by the patterns rather than passing
 * because it is tracked — without it the negative control below would be vacuous.
 *
 * Argv arrays only, no shell (tests/no-shell-execution.test.js's rule, applied here
 * although that guard does not scan tests/).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Each path is a FAMILY representative, not a one-off name: the rules ignore the
// family and re-include known-good names, so a new member is covered without a rule.
const MUST_BE_IGNORED = [
    '.env',
    '.env.swo',
    '.env.swp',
    '.env.local',
    '.env.backup',
    'agents.json.local',
    'agents/shared/channel-map.json.pre-rebuild',
    'work/task-queue.json',
    'work/task-123/package.json',
];

// Tracked on purpose. Each must stay publishable, or the family rules ate a real file.
const MUST_NOT_BE_IGNORED = [
    '.env.example',
    'agents/shared/staff.json',
    'agents/shared/daily-tasks-template.json',
];

/**
 * Ask git whether a path is ignored, from the rules alone.
 *
 * Exit 0 = ignored, 1 = not ignored, anything else = git could not answer — which
 * THROWS, because "git failed" must never read as "not ignored" (or as "ignored").
 *
 * @param {string} cwd - A git working tree.
 * @param {string} rel - Path relative to cwd. Need not exist.
 * @returns {boolean}
 */
function isIgnored(cwd, rel) {
    const r = spawnSync('git', ['check-ignore', '-q', '--no-index', '--', rel], {
        cwd,
        encoding: 'utf8',
    });
    if (r.error) throw r.error;
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    throw new Error(`git check-ignore exited ${r.status} for ${rel}: ${r.stderr}`);
}

describe('files that must never be publishable are ignored by git', () => {
    test.each(MUST_BE_IGNORED)('%s is ignored', (rel) => {
        expect(isIgnored(REPO_ROOT, rel)).toBe(true);
    });

    test.each(MUST_NOT_BE_IGNORED)('NEGATIVE CONTROL: %s is NOT ignored', (rel) => {
        expect(isIgnored(REPO_ROOT, rel)).toBe(false);
    });

    test('no TRACKED file is ignored by the rules (git ls-files -c -i --exclude-standard is empty)', () => {
        const r = spawnSync('git', ['ls-files', '-c', '-i', '--exclude-standard'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
        });
        expect(r.status).toBe(0);
        expect(r.stdout.split('\n').filter(Boolean)).toEqual([]);
    });
});

// The live assertions are all "git says X", which a broken helper could also produce.
// These run the helper against a throwaway repository with known rules, so a helper
// that always answered one way would fail here.
describe('the guard itself detects what it claims to', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-guard-'));
        const init = spawnSync('git', ['init', '-q', '--', dir], { encoding: 'utf8' });
        if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('the exact-name rule that was in place reports a swap copy of .env as NOT ignored', () => {
        // The .gitignore before 2026-10-02 carried `.env` and nothing for its copies.
        fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
        expect(isIgnored(dir, '.env')).toBe(true);
        expect(isIgnored(dir, '.env.swo')).toBe(false);
        expect(isIgnored(dir, 'work/task-queue.json')).toBe(false);
    });

    test('a re-include is reported as NOT ignored, not as ignored', () => {
        fs.writeFileSync(path.join(dir, '.gitignore'), '.env*\n!.env.example\n');
        expect(isIgnored(dir, '.env.example')).toBe(false);
        expect(isIgnored(dir, '.env.local')).toBe(true);
    });

    test('git failing to answer THROWS rather than reading as an answer', () => {
        const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitignore-norepo-'));
        try {
            // Outside any work tree check-ignore exits 128. GIT_CEILING_DIRECTORIES is
            // not needed: os.tmpdir() is not inside a repository.
            expect(() => isIgnored(notARepo, '.env')).toThrow(/exited 128/);
        } finally {
            fs.rmSync(notARepo, { recursive: true, force: true });
        }
    });
});
