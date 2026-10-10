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

    test('REGRESSION: "Closes #62. Addresses #75" on one line closes #62 and only addresses #75', () => {
        const commits = [{ shortSha: 'abc1234', subject: 's', body: "Closes #62. Addresses #75 (repo half; the remedy is the owner's choice)." }];
        const r = history.claimsFrom(commits);
        expect(r.closes.map(c => c.id)).toEqual(['62']);
        expect(r.addresses.map(c => c.id)).toEqual(['75']);
    });

    test('a switch errs toward the weaker claim, and an Addresses line can switch to Closes', () => {
        const a = history.claimsFrom([{ shortSha: 'a', subject: 's', body: 'Closes #12 (which addresses #13)' }]);
        expect(a.closes.map(c => c.id)).toEqual(['12']);
        expect(a.addresses.map(c => c.id)).toEqual(['13']);
        const b = history.claimsFrom([{ shortSha: 'b', subject: 's', body: 'Addresses #4; closes #5' }]);
        expect(b.addresses.map(c => c.id)).toEqual(['4']);
        expect(b.closes.map(c => c.id)).toEqual(['5']);
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

// LOGIC CHANGE 2026-10-02 (WORK-TODO #17): the commit the bridge booted on.
describe('loadedCommit and describeLoadedCommit', () => {
    test('reports HEAD of a real repository, clean', () => {
        const dir = makeRepo([{ file: 'a.txt', message: 'first' }, { file: 'b.txt', message: 'second: the head' }]);
        temps.push(dir);
        const c = history.loadedCommit(dir);
        expect(c.available).toBe(true);
        expect(c.sha).toBe(git(['rev-parse', 'HEAD'], dir).trim());
        expect(c.sha.startsWith(c.short)).toBe(true);
        expect(c.subject).toBe('second: the head');
        expect(c.dirty).toBe(false);
    });

    test('a modified tracked file is dirty; an untracked file is not', () => {
        const dir = makeRepo([{ file: 'a.txt', message: 'only' }]);
        temps.push(dir);
        fs.writeFileSync(path.join(dir, 'untracked.json'), '{}');
        expect(history.loadedCommit(dir).dirty).toBe(false);
        fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
        expect(history.loadedCommit(dir).dirty).toBe(true);
    });

    test('works on a shallow clone (HEAD needs no history)', () => {
        const src = makeRepo([{ file: 'a.txt', message: 'one' }, { file: 'b.txt', message: 'two' }]);
        temps.push(src);
        const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'shallow-boot-')); temps.push(shallow);
        git(['clone', '-q', '--depth', '1', `file://${src}`, shallow], os.tmpdir());
        const c = history.loadedCommit(shallow);
        expect(c.available).toBe(true);
        expect(c.subject).toBe('two');
    });

    test('a directory that is not a repository is UNAVAILABLE with a reason, never a fake sha', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-boot-')); temps.push(dir);
        const c = history.loadedCommit(dir);
        expect(c.available).toBe(false);
        expect(c.sha).toBeNull();
        expect(c.reason).toMatch(/git log -1 failed/);
    });

    test('the boot line names the short and full sha and tells the reader how to use it', () => {
        const text = history.describeLoadedCommit({
            available: true, reason: null, sha: 'a'.repeat(40), short: 'aaaaaaa', subject: 'feat: x', dirty: false,
        });
        expect(text).toContain('Bridge started on `aaaaaaa`');
        expect(text).toContain('feat: x');
        expect(text).toContain('a'.repeat(40));
        expect(text).toMatch(/if `main` is newer, its merges are not running yet/);
        expect(text).not.toMatch(/differ/);
    });

    test('the boot line warns when tracked files differ, and says when that could not be checked', () => {
        const base = { available: true, reason: null, sha: 'b'.repeat(40), short: 'bbbbbbb', subject: 's' };
        expect(history.describeLoadedCommit({ ...base, dirty: true })).toMatch(/differ from that commit/);
        expect(history.describeLoadedCommit({ ...base, dirty: null })).toMatch(/could not be checked/);
    });

    test('an unknown commit is said to be unknown, with the reason', () => {
        const text = history.describeLoadedCommit({ available: false, reason: 'dubious ownership', sha: null });
        expect(text).toMatch(/commit UNKNOWN/);
        expect(text).toContain('dubious ownership');
    });
});

describe('bridge-agent.js announces its boot commit', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

    test('it reads the commit once at module scope and posts it', () => {
        // LOGIC CHANGE 2026-10-10: the read is wrapped by lib/boot-record.js recordBootCommit,
        // which stores and returns it unchanged; still one read, at module scope.
        expect(src).toMatch(/^const BOOT_COMMIT = require\('\.\/lib\/boot-record'\)\.recordBootCommit\(repoHistory\.loadedCommit\(\)\);$/m);
        expect(src.match(/repoHistory\.loadedCommit\(/g)).toHaveLength(1);
        expect(src).toMatch(/^postToOps\(repoHistory\.describeLoadedCommit\(BOOT_COMMIT\)\);$/m);
    });
});
