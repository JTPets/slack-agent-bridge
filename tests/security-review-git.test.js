'use strict';

/**
 * tests/security-review-git.test.js
 *
 * lib/security-review-git.js holds the git reads that security-review.js had inline
 * until 2026-10-05 (WORK-TODO #10, wave 3). Nothing tested them before the move. These
 * tests run them against a REAL temporary repository: commits older than a day are left
 * out, merges are left out, the diff spans the window, a repository whose first commit
 * falls inside the window still produces a diff (the `git show` fallback), and the clone
 * refuses a malformed repository before git runs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gitReads = require('../lib/security-review-git');

const DAY_AGO_PLUS = new Date(Date.now() - 30 * 3600 * 1000).toISOString();

function git(dir, args, env = {}) {
    return execFileSync('git', args, {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env },
        encoding: 'utf8',
    }).trim();
}

function commit(dir, file, content, message, when) {
    fs.writeFileSync(path.join(dir, file), content);
    git(dir, ['add', file]);
    const env = when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : {};
    git(dir, ['commit', '-q', '-m', message], env);
    return git(dir, ['rev-parse', 'HEAD']);
}

let dir;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srgit-'));
    git(dir, ['init', '-q', '-b', 'main']);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('getRecentCommits / getCommitLog / getDiff on a real repository', () => {
    test('only the last 24 hours, newest first; old commits and merges are left out', async () => {
        commit(dir, 'a.js', 'old\n', 'old work', DAY_AGO_PLUS);
        const c1 = commit(dir, 'a.js', 'new one\n', 'recent one');
        git(dir, ['checkout', '-q', '-b', 'side']);
        commit(dir, 'b.js', 'side\n', 'side work');
        git(dir, ['checkout', '-q', 'main']);
        const c2 = commit(dir, 'a.js', 'new two\n', 'recent two');
        git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

        const commits = await gitReads.getRecentCommits(dir);
        expect(commits[0]).toBe(git(dir, ['log', '-1', '--no-merges', '--format=%H']));
        expect(commits).toEqual(expect.arrayContaining([c1, c2]));
        expect(commits).toHaveLength(3); // c1, side work, c2 — not the merge, not old work

        const log = await gitReads.getCommitLog(dir, commits);
        expect(log).toContain('recent two (T)');
        expect(log).not.toContain('old work');
        expect(log).not.toContain('merge side');
    });

    test('the diff runs from the parent of the oldest commit in the window to the newest', async () => {
        commit(dir, 'a.js', 'old\n', 'old work', DAY_AGO_PLUS);
        commit(dir, 'a.js', 'middle\n', 'recent one');
        commit(dir, 'a.js', 'newest\n', 'recent two');
        const commits = await gitReads.getRecentCommits(dir);
        const diff = await gitReads.getDiff(dir, commits);
        expect(diff).toContain('-old');
        expect(diff).toContain('+newest');
    });

    test('a first commit inside the window still yields a diff (the git show fallback)', async () => {
        commit(dir, 'a.js', 'first\n', 'initial');
        const commits = await gitReads.getRecentCommits(dir);
        expect(commits).toHaveLength(1);
        expect(await gitReads.getDiff(dir, commits)).toContain('+first');
    });

    test('no commits in the window: empty list, no diff, and a log that says so', async () => {
        commit(dir, 'a.js', 'old\n', 'old work', DAY_AGO_PLUS);
        const commits = await gitReads.getRecentCommits(dir);
        expect(commits).toEqual([]);
        expect(await gitReads.getDiff(dir, commits)).toBe('');
        expect(await gitReads.getCommitLog(dir, commits)).toBe('No commits in the last 24 hours.');
    });

    test('a directory that is not a repository is an empty list, not a throw', async () => {
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'srgit-plain-'));
        try {
            jest.spyOn(console, 'error').mockImplementation(() => {});
            expect(await gitReads.getRecentCommits(plain)).toEqual([]);
        } finally {
            console.error.mockRestore();
            fs.rmSync(plain, { recursive: true, force: true });
        }
    });
});

describe('execCommand and cloneRepo', () => {
    test('execCommand resolves trimmed stdout and rejects with stderr on failure', async () => {
        await expect(gitReads.execCommand('git', ['--version'])).resolves.toMatch(/^git version/);
        await expect(gitReads.execCommand('git', ['not-a-command'], { cwd: dir }))
            .rejects.toThrow(/Command failed with code/);
    });

    test('execCommand reports a missing binary as a spawn failure', async () => {
        await expect(gitReads.execCommand('definitely-not-a-binary-xyz', []))
            .rejects.toThrow(/Spawn failed/);
    });

    test('cloneRepo refuses a malformed repository before any git runs', async () => {
        await expect(gitReads.cloneRepo('-o/../x', dir)).rejects.toThrow();
        await expect(gitReads.cloneRepo('owner/name;rm -rf', dir)).rejects.toThrow();
        expect(fs.readdirSync(dir)).toEqual(['.git']); // nothing cloned into the target
    });
});
