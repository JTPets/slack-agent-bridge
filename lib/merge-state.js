'use strict';

/**
 * lib/merge-state.js
 *
 * WORK-TODO #39, the merge half: has the commit a finished repo task ended on reached
 * `main`? lib/task-work.js records the branch and head commit on the queue row; this
 * answers the question that record could not, at the moment someone asks
 * (`ASK: what's queued`), because a merge happens hours after the task finished.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * How. One bare cache repository per target repo under $WORK_DIR/merge-check/. Each
 * status query fetches that repo's `main` into it (incremental after the first time)
 * and asks `git merge-base --is-ancestor <head> main`:
 *   exit 0                          -> merged
 *   exit 1, or the commit is absent -> not on main. The cache holds main's complete
 *     history, so a commit it does not have is not in that history.
 *   anything else, or a failed fetch -> unknown, with the reason. Never "not merged".
 * Asked of the remote, never of the task's scratch clone: that clone is --depth 1 and
 * --single-branch, and it is deleted when the task ends.
 *
 * What it cannot see, stated: a squash or rebase merge writes new commits, so the task's
 * own head is never an ancestor of main and reads as "not on main". This repository is
 * merged with merge commits. Private repositories cannot be fetched (the URL is the
 * same anonymous https one cloneRepo uses) and read as unknown.
 *
 * NO SHELL. execFile with an argv array; the repo name passes lib/git-identifiers.js and
 * the commit is hex-asserted before either reaches argv, and `--` precedes the url.
 * Never rejects.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { isValidRepo } = require('./git-identifiers');

const SHA = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 30000;

/** Resolves { code, stdout, stderr }; never rejects. code is null when git did not run. */
function runGit(args, cwd, timeout = 15000, execFileFn = execFile) {
    return new Promise((resolve) => {
        execFileFn('git', args, { cwd, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
            (err, stdout, stderr) => {
                const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
                resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && err.message) || '').trim() });
            });
    });
}

function cacheDirFor(workDir, repo) {
    return path.join(workDir, 'merge-check', `${repo.replace('/', '__')}.git`);
}

/**
 * Bring the cache's `main` up to the remote's. Resolves { ok, dir } or { ok: false, reason }.
 */
const githubUrl = (repo) => `https://github.com/${repo}.git`;

async function refreshMain(repo, workDir, run = runGit, urlFor = githubUrl) {
    if (!isValidRepo(repo)) return { ok: false, reason: 'repository name refused' };
    if (!path.isAbsolute(workDir)) return { ok: false, reason: 'WORK_DIR is not an absolute path' };
    const dir = cacheDirFor(workDir, repo);
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
        fs.mkdirSync(dir, { recursive: true });
        const init = await run(['init', '--bare', '-q', '--', dir], workDir);
        if (init.code !== 0) return { ok: false, reason: `cache init failed: ${init.stderr.slice(0, 200)}` };
    }
    const url = urlFor(repo);
    const fetched = await run(['fetch', '--quiet', '--no-tags', '--', url, '+refs/heads/main:refs/heads/main'], dir, FETCH_TIMEOUT_MS);
    if (fetched.code !== 0) return { ok: false, reason: `fetch of main failed: ${fetched.stderr.slice(0, 200) || 'no output'}` };
    return { ok: true, dir };
}

/** Resolves 'merged' | 'not_on_main' | { unknown: reason }. */
async function isOnMain(dir, sha, run = runGit) {
    if (!SHA.test(sha || '')) return { unknown: 'no head commit recorded' };
    const has = await run(['cat-file', '-e', `${sha}^{commit}`], dir);
    if (has.code !== 0) return 'not_on_main';
    const res = await run(['merge-base', '--is-ancestor', sha, 'refs/heads/main'], dir);
    if (res.code === 0) return 'merged';
    if (res.code === 1) return 'not_on_main';
    return { unknown: `merge-base failed: ${res.stderr.slice(0, 200) || 'no output'}` };
}

/**
 * Merge state for every queue row that recorded work. One fetch per repository.
 *
 * @param {object[]} rows - queue rows ({ id, repo, work })
 * @param {{ workDir: string, run?: Function, urlFor?: Function }} options
 *   urlFor maps a repo to its fetch url; the default is cloneRepo's https url. Tests
 *   point it at a local origin.
 * @returns {Promise<Map<string, { state: 'merged'|'not_on_main'|'unknown', reason: string|null }>>}
 */
async function resolveMergeStates(rows, { workDir, run = runGit, urlFor = githubUrl } = {}) {
    const out = new Map();
    const byRepo = new Map();
    for (const row of rows || []) {
        if (!row || !row.repo || !row.work || !row.work.head) continue;
        if (row.work.newCommits === 0) continue; // nothing of the task's own to merge
        if (!byRepo.has(row.repo)) byRepo.set(row.repo, []);
        byRepo.get(row.repo).push(row);
    }
    for (const [repo, repoRows] of byRepo) {
        let refreshed;
        try {
            refreshed = await refreshMain(repo, workDir, run, urlFor);
        } catch (e) {
            refreshed = { ok: false, reason: e.message };
        }
        for (const row of repoRows) {
            if (!refreshed.ok) { out.set(row.id, { state: 'unknown', reason: refreshed.reason }); continue; }
            const v = await isOnMain(refreshed.dir, row.work.head, run);
            out.set(row.id, typeof v === 'string' ? { state: v, reason: null } : { state: 'unknown', reason: v.unknown });
        }
    }
    return out;
}

/** One status-line fragment, or '' when no state was resolved for the row. */
function formatMergeState(ms) {
    if (!ms) return '';
    if (ms.state === 'merged') return ', merged to main';
    if (ms.state === 'not_on_main') return ', not on main yet';
    return `, merge state unknown (${ms.reason || 'no reason'})`;
}

module.exports = { cacheDirFor, refreshMain, isOnMain, resolveMergeStates, formatMergeState, runGit };
