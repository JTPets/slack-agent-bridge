/**
 * tests/repo-history.test.js
 *
 * Tests for lib/repo-history.js, against REAL git repositories built in temp dirs —
 * a mocked `execFileSync` would assert the mock, not git's behaviour, and the defect
 * this file's regression test covers was a parsing bug over real commit bodies.
 *
 * THE REGRESSION TEST THAT MATTERS: `Closes WORK-TODO P1 #18.` is a real commit body
 * in this repository (`6454fb0`). The first version of the claim parser made `#`
 * optional and read that line as a claim about item **#1**, because `P1` supplies a
 * digit first. It fabricated a citation, which is worse than finding nothing, because
 * an invented citation is repeated to a human as a fact. That case is asserted below
 * and fails against the optional-`#` pattern.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const history = require('../lib/repo-history');

/** Run git in a directory, argv array, no shell. */
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Build a throwaway repository with the given commits (oldest first).
 * @param {Array<{ file: string, message: string }>} commits
 * @returns {string} repo root
 */
function makeRepo(commits) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-history-'));
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    for (const c of commits) {
        fs.writeFileSync(path.join(dir, c.file), `${Math.random()}\n`);
        git(['add', '--', c.file], dir);
        git(['commit', '-q', '-m', c.message], dir);
    }
    return dir;
}

const LONG_AGO = new Date(Date.now() - 365 * 86400000);
const temps = [];
afterAll(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

describe('historyAvailable', () => {
    test('a normal checkout is available', () => {
        const dir = makeRepo([{ file: 'a.txt', message: 'first' }]); temps.push(dir);
        expect(history.historyAvailable(dir)).toMatchObject({ available: true, shallow: false });
    });

    test('a directory that is not a git checkout is UNAVAILABLE with a reason', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-')); temps.push(dir);
        const r = history.historyAvailable(dir);
        expect(r.available).toBe(false);
        expect(r.reason).toMatch(/git/i);
    });

    test('a SHALLOW clone is UNAVAILABLE, not a short history', () => {
        const origin = makeRepo([
            { file: 'a.txt', message: 'one' },
            { file: 'b.txt', message: 'two' },
            { file: 'c.txt', message: 'three' },
        ]); temps.push(origin);
        const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-')); temps.push(shallow);
        const target = path.join(shallow, 'clone');
        // `file://` is required: git IGNORES --depth for a local path clone
        // ("warning: --depth is ignored in local clones; use file:// instead"), so a
        // plain path here would build a FULL clone and the test would pass against a
        // broken guard.
        git(['clone', '-q', '--depth', '1', '--', `file://${origin}`, target], shallow);

        const r = history.historyAvailable(target);
        expect(r).toMatchObject({ available: false, shallow: true });
        expect(r.reason).toMatch(/shallow/);
        // And every reader inherits the refusal rather than reporting zero.
        expect(history.commitsSince(LONG_AGO, target)).toMatchObject({ available: false, commits: [] });
        expect(history.revisionsSince('a.txt', LONG_AGO, target)).toMatchObject({ available: false, count: 0 });
    });
});

describe('commitsSince', () => {
    test('returns commits newest first with sha, subject and body', () => {
        const dir = makeRepo([
            { file: 'a.txt', message: 'oldest subject\n\nbody line' },
            { file: 'b.txt', message: 'newest subject' },
        ]); temps.push(dir);
        const r = history.commitsSince(LONG_AGO, dir);
        expect(r.available).toBe(true);
        expect(r.commits.map(c => c.subject)).toEqual(['newest subject', 'oldest subject']);
        expect(r.commits[1].body).toContain('body line');
        expect(r.commits[0].shortSha).toHaveLength(7);
    });

    test('a since value in the future yields an available, empty result', () => {
        const dir = makeRepo([{ file: 'a.txt', message: 'one' }]); temps.push(dir);
        const r = history.commitsSince(new Date(Date.now() + 86400000), dir);
        // available:true with zero commits is "nothing happened"; that is a DIFFERENT
        // answer from available:false, and both must be reachable.
        expect(r).toMatchObject({ available: true, commits: [] });
    });
});

describe('claimsFrom', () => {
    test('REGRESSION: "Closes WORK-TODO P1 #18." is item 18, not item 1', () => {
        const commits = [{ shortSha: 'abc1234', subject: 'a fix', body: 'Closes WORK-TODO P1 #18. DoD checks that actually ran:' }];
        const { closes } = history.claimsFrom(commits);
        expect(closes.map(c => c.id)).toEqual(['18']);
    });

    test('a claim line with no #id names no item', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: 'Addresses the dispatch. Not closed: X remains.\nAddresses nothing yet.' }];
        expect(history.claimsFrom(commits)).toMatchObject({ closes: [], addresses: [] });
    });

    test('Closes and Addresses are separated, and suffixed ids survive', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: 'Closes #50\nAddresses WORK-TODO #4b — the topology half' }];
        const r = history.claimsFrom(commits);
        expect(r.closes.map(c => c.id)).toEqual(['50']);
        expect(r.addresses.map(c => c.id)).toEqual(['4b']);
    });

    test('an id repeated on ONE line is one claim, not two', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: 'Addresses #41 (filed here; the DoD of #41 is unchanged)' }];
        expect(history.claimsFrom(commits).addresses).toHaveLength(1);
    });

    test('only a line that STARTS with the word counts — prose about closing does not', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: 'This nearly closes #9 but does not.' }];
        expect(history.claimsFrom(commits).closes).toEqual([]);
    });

    test('repeatedlyAddressed names items claimed partial more than once, most first', () => {
        const commits = [
            { shortSha: 'aaaaaaa', subject: 's', body: 'Addresses #3' },
            { shortSha: 'bbbbbbb', subject: 's', body: 'Addresses #3' },
            { shortSha: 'ccccccc', subject: 's', body: 'Addresses #3\nAddresses #10' },
            { shortSha: 'ddddddd', subject: 's', body: 'Addresses #10' },
            { shortSha: 'eeeeeee', subject: 's', body: 'Addresses #7' },
        ];
        expect(history.claimsFrom(commits).repeatedlyAddressed).toEqual([
            { id: '3', count: 3, shas: ['aaaaaaa', 'bbbbbbb', 'ccccccc'] },
            { id: '10', count: 2, shas: ['ccccccc', 'ddddddd'] },
        ]);
    });

    test('case is ignored, as commit bodies in this repo vary', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: 'closes #12\nADDRESSES #13' }];
        const r = history.claimsFrom(commits);
        expect(r.closes.map(c => c.id)).toEqual(['12']);
        expect(r.addresses.map(c => c.id)).toEqual(['13']);
    });
});

describe('revisionsSince', () => {
    test('counts only commits touching the named path', () => {
        const dir = makeRepo([
            { file: 'WORK-TODO.md', message: 'backlog 1' },
            { file: 'other.txt', message: 'unrelated' },
            { file: 'WORK-TODO.md', message: 'backlog 2' },
        ]); temps.push(dir);
        expect(history.revisionsSince('WORK-TODO.md', LONG_AGO, dir)).toMatchObject({ available: true, count: 2 });
    });

    test('a path that does not exist is available with a count of zero', () => {
        const dir = makeRepo([{ file: 'a.txt', message: 'one' }]); temps.push(dir);
        expect(history.revisionsSince('never-existed.md', LONG_AGO, dir)).toMatchObject({ available: true, count: 0 });
    });
});

describe('the module builds no shell command', () => {
    test('it names execFileSync and never exec/execSync/shell:true', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'repo-history.js'), 'utf8');
        // The repo-wide enumerating guard is tests/no-shell-execution.test.js; this is
        // the local restatement for the one module that deliberately runs a subprocess.
        expect(src).toContain('execFileSync');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        expect(code).not.toMatch(/\bexecSync\s*\(/);
        expect(code).not.toMatch(/shell\s*:\s*true/);
    });
});
