'use strict';

/**
 * tests/close-reconcile.test.js
 *
 * Tests for lib/close-reconcile.js and scripts/close-reconcile.js (WORK-TODO #69): a
 * `Closes #N` commit that leaves #N in WORK-TODO.md is detected; a reused id is not
 * mistaken for it; and a shallow clone is UNAVAILABLE (exit 2), never a pass. Every
 * repository here is a real git repository in a temp dir, because the defect is about
 * history and a mocked git proves nothing about history.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { classifyClaim, reconcile, formatReport } = require('../lib/close-reconcile');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'close-reconcile.js');
const temps = [];
afterAll(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const backlog = (items) => `# Work Backlog\n\n${items.map(([id, t]) => `### ${id}. ${t}\nbody\n`).join('\n')}`;

/** A repo whose commits each write WORK-TODO.md (or leave it alone when `items` is undefined). */
function makeRepo(steps) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-reconcile-')); temps.push(dir);
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    steps.forEach((s, i) => {
        if (s.items) fs.writeFileSync(path.join(dir, 'WORK-TODO.md'), backlog(s.items));
        else fs.writeFileSync(path.join(dir, `other-${i}.txt`), `${i}\n`);
        git(['add', '-A'], dir);
        git(['commit', '-q', '-m', s.message], dir);
    });
    return dir;
}

const runScript = (args) => spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });

describe('classifyClaim', () => {
    const now = new Map([['2', 'Beta'], ['3', 'Something else']]);
    test.each([
        ['1', 'Alpha', 'purged'],
        ['2', 'Beta', 'still_open'],
        ['3', 'Gamma', 'id_reused'],
        ['4', null, 'unverifiable'],
    ])('#%s titled %p -> %s', (id, titleBefore, verdict) => {
        expect(classifyClaim({ id, titleBefore, itemsNow: now })).toBe(verdict);
    });
});

describe('reconcile against real history', () => {
    test('a close that purged is clean; a close that did not is still_open — the 723dfed shape', () => {
        const dir = makeRepo([
            { message: 'file two items', items: [['1', 'Alpha'], ['2', 'Beta']] },
            { message: 'fix alpha\n\nCloses WORK-TODO #1', items: [['2', 'Beta']] },
            { message: 'fix beta, forgot the backlog\n\nCloses WORK-TODO #2.' },
        ]);
        const r = reconcile({ repoRoot: dir });
        expect(r.available).toBe(true);
        expect(r.checked).toBe(2);
        expect(r.purged.map(c => c.id)).toEqual(['1']);
        expect(r.still_open.map(c => c.id)).toEqual(['2']);
        expect(formatReport(r).join('\n')).toMatch(/Closes #2, and #2 "Beta" is still in WORK-TODO\.md/);
        expect(runScript(['--repo', dir]).status).toBe(1);
    });

    test('purging later clears it: the check judges the backlog at the ref, not at the claim', () => {
        const dir = makeRepo([
            { message: 'file', items: [['1', 'Alpha']] },
            { message: 'fix\n\nCloses #1' },
            { message: 'purge #1', items: [] },
        ]);
        expect(reconcile({ repoRoot: dir }).still_open).toEqual([]);
        expect(runScript(['--repo', dir]).status).toBe(0);
        const firstClose = git(['rev-parse', 'HEAD~1'], dir).trim();
        expect(reconcile({ repoRoot: dir, at: firstClose }).still_open.map(c => c.id)).toEqual(['1']);
    });

    test('an id reused for a new item is reported, not flagged — the 3d7ad70 / #43 shape', () => {
        const dir = makeRepo([
            { message: 'file', items: [['43', 'Old ordering bug']] },
            { message: 'fix\n\nCloses #43 (ordering)', items: [] },
            { message: 'file a new item on a colliding number', items: [['43', 'A different problem']] },
        ]);
        const r = reconcile({ repoRoot: dir });
        expect(r.still_open).toEqual([]);
        expect(r.id_reused).toEqual([expect.objectContaining({ id: '43', titleBefore: 'Old ordering bug', titleNow: 'A different problem' })]);
        expect(runScript(['--repo', dir]).status).toBe(0);
    });

    test('a claim with no heading to compare is unverifiable, never counted as purged', () => {
        const dir = makeRepo([
            { message: 'file', items: [['1', 'Alpha']] },
            { message: 'mystery\n\nCloses #9' },
        ]);
        const r = reconcile({ repoRoot: dir });
        expect(r.unverifiable.map(c => c.id)).toEqual(['9']);
        expect(r.purged).toEqual([]);
    });

    test('`Closes WORK-TODO P1 #18.` is a claim about #18, not #1 (repo-history\'s corrected parser)', () => {
        const dir = makeRepo([
            { message: 'file', items: [['1', 'One'], ['18', 'Eighteen']] },
            { message: 'fix\n\nCloses WORK-TODO P1 #18.', items: [['1', 'One']] },
        ]);
        const r = reconcile({ repoRoot: dir });
        expect(r.purged.map(c => c.id)).toEqual(['18']);
        expect(r.still_open).toEqual([]);
    });
});

describe('it cannot pass by not looking', () => {
    test('a SHALLOW clone is UNAVAILABLE and the CLI exits 2, not 0', () => {
        const origin = makeRepo([
            { message: 'file', items: [['1', 'Alpha']] },
            { message: 'fix\n\nCloses #1' },
            { message: 'unrelated' },
        ]);
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'close-reconcile-shallow-')); temps.push(parent);
        const target = path.join(parent, 'clone');
        // file:// because git ignores --depth for a plain local path.
        git(['clone', '-q', '--depth', '1', '--', `file://${origin}`, target], parent);
        const r = reconcile({ repoRoot: target });
        expect(r.available).toBe(false);
        expect(r.reason).toMatch(/shallow/);
        expect(r.checked).toBe(0);
        expect(formatReport(r)[0]).toMatch(/^\[close-reconcile\] UNAVAILABLE — nothing was checked/);
        const run = runScript(['--repo', target]);
        expect(run.status).toBe(2);
        // The same history, unshallowed, does find the open claim — so the 2 above is the
        // shallow clone being refused, not a repository with nothing in it.
        expect(runScript(['--repo', origin]).status).toBe(1);
    });

    test('a directory that is not a checkout is UNAVAILABLE', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'close-reconcile-none-')); temps.push(dir);
        expect(reconcile({ repoRoot: dir }).available).toBe(false);
        expect(runScript(['--repo', dir]).status).toBe(2);
    });

    test('a ref that is not HEAD or hex is refused before it reaches git', () => {
        for (const at of ['--output=/tmp/x', 'main;rm', '', 'HEAD~1']) {
            const r = reconcile({ at });
            expect(r.available).toBe(false);
            expect(r.reason).toMatch(/refusing a ref/);
        }
    });
});
