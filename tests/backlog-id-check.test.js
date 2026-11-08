'use strict';

/**
 * tests/backlog-id-check.test.js
 *
 * Tests for lib/backlog-id-check.js and scripts/backlog-id-check.js (WORK-TODO #67): a
 * branch that files an item under a number main already holds is refused before the push;
 * a number main used and purged is refused too; a free number passes; and a check that
 * cannot look exits 2, never 0. Every repository here is real git in a temp dir, because
 * the defect is about two histories meeting and a mocked git proves nothing about that.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { REF_SHAPE, classifyNewIds, checkBacklogIds, formatReport } = require('../lib/backlog-id-check');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backlog-id-check.js');
const temps = [];
afterAll(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const backlog = (items) => `# Work Backlog\n\n${items.map(([id, t]) => `### ${id}. ${t}\nbody\n`).join('\n')}`;

function commitBacklog(dir, items, message) {
    fs.writeFileSync(path.join(dir, 'WORK-TODO.md'), backlog(items));
    git(['add', '-A'], dir);
    git(['commit', '-q', '--allow-empty', '-m', message], dir);
}

/**
 * A repo with `main` and a branch `feature` cut from `baseItems`. `mainSteps` and
 * `branchItems` are what each side writes after the cut.
 */
function makeRepo({ history = [], baseItems, mainSteps = [], branchItems }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-ids-')); temps.push(dir);
    git(['init', '-q', '-b', 'main'], dir);
    git(['config', 'user.email', 'test@example.com'], dir);
    git(['config', 'user.name', 'Test'], dir);
    git(['config', 'commit.gpgsign', 'false'], dir);
    for (const items of history) commitBacklog(dir, items, 'history');
    commitBacklog(dir, baseItems, 'base');
    git(['checkout', '-q', '-b', 'feature'], dir);
    commitBacklog(dir, branchItems, 'branch files items');
    git(['checkout', '-q', 'main'], dir);
    for (const items of mainSteps) commitBacklog(dir, items, 'main moves');
    git(['checkout', '-q', 'feature'], dir);
    return dir;
}

const run = (dir, args = ['--base', 'main']) => spawnSync('node', [SCRIPT, '--repo', dir, ...args], { encoding: 'utf8' });

describe('classifyNewIds', () => {
    const m = (pairs) => new Map(pairs);
    test('only ids absent at the merge base are judged', () => {
        const r = classifyNewIds({
            head: m([['1', 'A'], ['2', 'B'], ['3', 'C'], ['4', 'D']]),
            mergeBase: m([['1', 'A']]),
            base: m([['1', 'A'], ['2', 'Other'], ['3', 'C']]),
            everOnBase: (id) => (id === '4' ? 'abc1234' : null),
        });
        expect(r.newIds).toEqual(['2', '3', '4']);
        expect(r.collisions).toEqual([{ id: '2', titleHead: 'B', titleBase: 'Other' }]);
        expect(r.reused).toEqual([{ id: '4', titleHead: 'D', sha: 'abc1234' }]);
    });
});

describe('checkBacklogIds against real history', () => {
    test('the #57-#61 shape: both sides file the same next number -> collision, exit 1', () => {
        const dir = makeRepo({
            baseItems: [['56', 'Old']],
            mainSteps: [[['56', 'Old'], ['57', 'Main filed this']]],
            branchItems: [['56', 'Old'], ['57', 'Branch filed this']],
        });
        const r = checkBacklogIds({ base: 'main', repoRoot: dir });
        expect(r.available).toBe(true);
        expect(r.collisions).toEqual([{ id: '57', titleHead: 'Branch filed this', titleBase: 'Main filed this' }]);
        expect(formatReport(r).join('\n')).toMatch(/#57 "Branch filed this" — main already has #57 "Main filed this"/);
        expect(run(dir).status).toBe(1);
    });

    test('a number main has not used passes, exit 0 — the negative control for the case above', () => {
        const dir = makeRepo({
            baseItems: [['56', 'Old']],
            mainSteps: [[['56', 'Old'], ['57', 'Main filed this']]],
            branchItems: [['56', 'Old'], ['58', 'Branch filed this']],
        });
        const r = checkBacklogIds({ base: 'main', repoRoot: dir });
        expect(r.newIds).toEqual(['58']);
        expect(r.collisions).toEqual([]);
        expect(r.reused).toEqual([]);
        expect(run(dir).status).toBe(0);
    });

    test('a number main used and purged is a reuse, even though main no longer has it', () => {
        const dir = makeRepo({
            history: [[['40', 'Closed long ago'], ['41', 'Still open']]],
            baseItems: [['41', 'Still open']],
            branchItems: [['41', 'Still open'], ['40', 'A new item on an old number']],
        });
        const r = checkBacklogIds({ base: 'main', repoRoot: dir });
        expect(r.collisions).toEqual([]);
        expect(r.reused.map((c) => c.id)).toEqual(['40']);
        expect(run(dir).status).toBe(1);
    });

    test('a pre-existing item edited on the branch is not new, so it is never flagged', () => {
        const dir = makeRepo({
            baseItems: [['5', 'Title as filed']],
            mainSteps: [[['5', 'Title as filed']]],
            branchItems: [['5', 'Title reworded on the branch']],
        });
        expect(checkBacklogIds({ base: 'main', repoRoot: dir }).newIds).toEqual([]);
    });

    test('the same item landed on both sides (same title) is not a collision', () => {
        const dir = makeRepo({
            baseItems: [['1', 'A']],
            mainSteps: [[['1', 'A'], ['2', 'Cherry-picked']]],
            branchItems: [['1', 'A'], ['2', 'Cherry-picked']],
        });
        expect(checkBacklogIds({ base: 'main', repoRoot: dir }).collisions).toEqual([]);
    });
});

describe('a check that cannot look never passes', () => {
    test('a shallow clone is UNAVAILABLE and exits 2', () => {
        const src = makeRepo({ baseItems: [['1', 'A']], branchItems: [['1', 'A'], ['2', 'B']] });
        const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-ids-shallow-')); temps.push(shallow);
        git(['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${src}`, shallow], os.tmpdir());
        const r = checkBacklogIds({ base: 'HEAD', repoRoot: shallow });
        expect(r.available).toBe(false);
        expect(formatReport(r)[0]).toMatch(/UNAVAILABLE — nothing was checked/);
        expect(run(shallow, ['--base', 'HEAD']).status).toBe(2);
    });

    test('a ref of an unexpected shape is refused before git sees it', () => {
        const dir = makeRepo({ baseItems: [['1', 'A']], branchItems: [['1', 'A']] });
        for (const bad of ['--upload-pack=x', 'main;rm', '../x', '']) {
            expect(REF_SHAPE.test(bad)).toBe(false);
            expect(checkBacklogIds({ base: bad, repoRoot: dir }).available).toBe(false);
        }
        expect(run(dir, ['--base', '--output=x']).status).toBe(2);
    });

    test('the default fetch failing (no origin) exits 2, never 0', () => {
        const dir = makeRepo({ baseItems: [['1', 'A']], branchItems: [['1', 'A'], ['2', 'B']] });
        const res = run(dir, []);
        expect(res.status).toBe(2);
        expect(res.stderr).toMatch(/git fetch origin main failed/);
    });
});
