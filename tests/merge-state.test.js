'use strict';

/**
 * tests/merge-state.test.js
 *
 * WORK-TODO #39, the merge half: lib/merge-state.js against a REAL bare origin in a temp
 * dir. A task's commit merged into main reads "merged"; a pushed branch nobody merged
 * reads "not on main yet"; a later merge flips it on the next query (the cache fetches
 * incrementally); an unreachable remote is "unknown", never "not merged"; and the status
 * reply in bridge-agent.js renders the state and resolves it before formatting.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { resolveMergeStates, formatMergeState, isOnMain, cacheDirFor } = require('../lib/merge-state');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let root, origin, work, workDir;

function commit(dir, name) {
    fs.writeFileSync(path.join(dir, name), `${name}\n`);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', name]);
    return git(dir, ['rev-parse', 'HEAD']);
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-state-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    workDir = path.join(root, 'bridge-work');
    fs.mkdirSync(workDir);
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(root, ['init', '-q', '-b', 'main', work]);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(work, ['config', k, v]);
    commit(work, 'seed');
    git(work, ['push', '-q', origin, 'main']);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const urlFor = () => `file://${origin}`;
const row = (id, head, newCommits = 1) => ({ id, repo: 'jtpets/example', work: { head, newCommits } });

test('a merged commit reads merged; a pushed, unmerged branch reads not on main yet', async () => {
    git(work, ['checkout', '-q', '-b', 'feature/done']);
    const merged = commit(work, 'merged-change');
    git(work, ['checkout', '-q', 'main']);
    git(work, ['merge', '-q', '--no-ff', '-m', 'Merge feature/done', 'feature/done']);
    git(work, ['push', '-q', origin, 'main']);

    git(work, ['checkout', '-q', '-b', 'feature/open']);
    const open = commit(work, 'open-change');
    git(work, ['push', '-q', origin, 'feature/open']);
    git(work, ['checkout', '-q', 'main']);

    const states = await resolveMergeStates([row('a', merged), row('b', open)], { workDir, urlFor });
    expect(states.get('a')).toEqual({ state: 'merged', reason: null });
    expect(states.get('b')).toEqual({ state: 'not_on_main', reason: null });
    expect(fs.existsSync(path.join(cacheDirFor(workDir, 'jtpets/example'), 'HEAD'))).toBe(true);

    // The branch merges later: the next query sees it, through the same cache.
    git(work, ['merge', '-q', '--no-ff', '-m', 'Merge feature/open', 'feature/open']);
    git(work, ['push', '-q', origin, 'main']);
    const later = await resolveMergeStates([row('b', open)], { workDir, urlFor });
    expect(later.get('b').state).toBe('merged');
});

test('an unreachable remote is unknown with a reason, never not-merged', async () => {
    const sha = git(work, ['rev-parse', 'HEAD']);
    const states = await resolveMergeStates([row('c', sha)], {
        workDir: path.join(root, 'other-work'), urlFor: () => `file://${path.join(root, 'nope.git')}`,
    });
    expect(states.get('c').state).toBe('unknown');
    expect(states.get('c').reason).toMatch(/fetch of main failed/);
    expect(formatMergeState(states.get('c'))).toMatch(/merge state unknown \(fetch of main failed/);
});

test('rows with no work, no repo, or no new commits are not asked about', async () => {
    const states = await resolveMergeStates([
        { id: 'x', repo: null, work: { head: 'a'.repeat(40), newCommits: 1 } },
        { id: 'y', repo: 'jtpets/example', work: null },
        row('z', git(work, ['rev-parse', 'HEAD']), 0),
    ], { workDir, urlFor });
    expect(states.size).toBe(0);
});

test('a refused repository name or a non-hex head never reaches git', async () => {
    const calls = [];
    const run = async (args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
    const states = await resolveMergeStates([{ id: 'r', repo: '--upload-pack=x/y', work: { head: 'b'.repeat(40), newCommits: 1 } }], { workDir, run });
    expect(states.get('r')).toEqual({ state: 'unknown', reason: 'repository name refused' });
    expect(calls).toEqual([]);
    expect(await isOnMain(workDir, 'HEAD', run)).toEqual({ unknown: 'no head commit recorded' });
    expect(calls).toEqual([]);
});

test('formatMergeState wording', () => {
    expect(formatMergeState(undefined)).toBe('');
    expect(formatMergeState({ state: 'merged' })).toBe(', merged to main');
    expect(formatMergeState({ state: 'not_on_main' })).toBe(', not on main yet');
});

describe('the bridge-agent.js wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    test('the status reply resolves merge state, then renders it per row', () => {
        const at = src.indexOf('const statusResponse = formatStatusResponse(mergeStates);');
        expect(at).toBeGreaterThan(-1);
        expect(src.slice(at - 600, at)).toMatch(/await resolveMergeStates\(taskQueue\.getQueue\(\)\.getRecentCompleted\(5\), \{ workDir: WORK_DIR \}\)/);
        const fn = src.slice(src.indexOf('function formatStatusResponse('));
        expect(fn.slice(0, 4500)).toMatch(/formatMergeState\(mergeStates\.get\(task\.id\)\)/);
    });
});
