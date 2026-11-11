/**
 * tests/auto-update-gate.test.js
 *
 * WORK-TODO #17, the owner's choice of 2026-11-08: a merged commit deploys only after the
 * full suite passes on it. These drive auto-update.js checkForUpdates with an injected
 * gate and assert the decision: red never pulls and is not retried, green lands on
 * EXACTLY the gated sha, a gated commit is not gated twice, a moved main is not judged,
 * the pending marker is not set during a gate run, and in-process work (#71) defers.
 */

'use strict';

const autoUpdate = require('../auto-update');

const PREV = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

function makeDeps({ state = {}, gate = { ok: true, assertions: { passed: 10, skipped: 0 } }, busy = null } = {}) {
    const calls = [];
    const posts = [];
    const saved = [];
    let pulledTo = null;
    const deps = {
        calls, posts, saved,
        loadState: () => ({ lastKnownCommit: PREV, restartedIntoCommit: null, failedCommit: null, ...state }),
        saveState: (s) => { saved.push({ ...s }); calls.push('saveState'); return { success: true }; },
        gitFetch: () => ({ success: true }),
        getLocalHead: () => (pulledTo || PREV),
        getRemoteHead: () => NEXT,
        getCommitMessage: () => 'a merged change',
        gitResetHard: () => { calls.push('reset'); return { success: true }; },
        gitResetTo: () => ({ success: true }),
        gitPull: (commit) => { calls.push(`pull:${commit}`); pulledTo = commit; return { success: true }; },
        npmInstall: () => ({ success: true }),
        verifyEntryPoints: () => ({ ok: true, checked: ['bridge-agent.js'], missing: [], failures: [] }),
        runSmokeTest: () => ({ ok: true }),
        planRestart: () => ({ exit: true, reason: 'ok' }),
        evaluateTaskDeferral: () => ({ defer: false, reason: null, staleVerdicts: [] }),
        markUpdatePending: () => { calls.push('mark'); return { marked: true }; },
        clearUpdatePending: () => { calls.push('clear'); },
        postToOps: async (m) => { posts.push(m); },
        exit: async () => { calls.push('exit'); },
        runGate: jest.fn(async ({ commit }) => { calls.push(`gate:${commit}`); return { durationMs: 60000, ...gate }; }),
        formatGateResult: autoUpdate.DEFAULT_DEPS.formatGateResult,
        inProcessBusy: () => busy,
    };
    return deps;
}

beforeEach(() => {
    for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a green gate deploys exactly the gated commit, after the gate and before the exit', async () => {
    const d = makeDeps();
    await autoUpdate.checkForUpdates(d);
    expect(d.runGate).toHaveBeenCalledWith({ commit: NEXT });
    const order = d.calls.filter((c) => /^(gate|mark|pull|exit)/.test(c));
    expect(order).toEqual([`gate:${NEXT}`, 'mark', `pull:${NEXT}`, 'exit']);
    expect(d.saved.some((s) => s.gatedCommit === NEXT)).toBe(true);
    expect(d.posts.join('\n')).toMatch(/Update gate GREEN for bbbbbbb: 10 passed, 0 skipped/);
});

test('a red gate never pulls, never exits, records the commit as failed and says so', async () => {
    const d = makeDeps({ gate: { ok: false, stage: 'test', reason: 'npm test reported 2 failed, 8 passed' } });
    await autoUpdate.checkForUpdates(d);
    expect(d.calls.some((c) => c.startsWith('pull') || c === 'exit' || c === 'mark')).toBe(false);
    expect(d.saved.at(-1).failedCommit).toBe(NEXT);
    expect(d.posts.join('\n')).toMatch(/Update gate RED for bbbbbbb at the test stage.*2 failed/s);
});

test('a commit that failed the gate is not gated again', async () => {
    const d = makeDeps({ state: { failedCommit: NEXT } });
    await autoUpdate.checkForUpdates(d);
    expect(d.runGate).not.toHaveBeenCalled();
    expect(d.calls).not.toContain('exit');
});

test('a commit already gated green is not gated twice (a deferral retry goes straight to apply)', async () => {
    const d = makeDeps({ state: { gatedCommit: NEXT } });
    await autoUpdate.checkForUpdates(d);
    expect(d.runGate).not.toHaveBeenCalled();
    expect(d.calls).toContain(`pull:${NEXT}`);
});

test('main moving during the gate is not a verdict: nothing is recorded or deployed', async () => {
    const d = makeDeps({ gate: { ok: false, moved: true, stage: 'checkout', reason: 'main is now ccccccc' } });
    await autoUpdate.checkForUpdates(d);
    expect(d.saved.some((s) => s.failedCommit === NEXT || s.gatedCommit === NEXT)).toBe(false);
    expect(d.calls).not.toContain('exit');
});

test('the pending marker is cleared, not set, while the gate runs, so dispatches are not refused through it', async () => {
    const d = makeDeps();
    await autoUpdate.checkForUpdates(d);
    expect(d.calls.indexOf('clear')).toBeLessThan(d.calls.indexOf(`gate:${NEXT}`));
    expect(d.calls.indexOf('mark')).toBeGreaterThan(d.calls.indexOf(`gate:${NEXT}`));
});

test('in-process work (an ASK being answered, #71) defers a gated commit; nothing is pulled', async () => {
    const d = makeDeps({ state: { gatedCommit: NEXT }, busy: 'a task or an answer is in progress' });
    await autoUpdate.checkForUpdates(d);
    expect(d.calls).toContain('mark');
    expect(d.calls.some((c) => c.startsWith('pull') || c === 'exit')).toBe(false);
    expect(d.posts.join('\n')).toMatch(/holding bbbbbbb - a task or an answer is in progress/);
});

test('negative control: without a gate the bare bag still deploys, which is why every real caller passes one', async () => {
    const d = makeDeps();
    d.runGate = null;
    await autoUpdate.checkForUpdates(d);
    expect(d.calls).toContain('exit');
    expect(typeof autoUpdate.gatedDeps().runGate).toBe('function');
});

test('the default fast-forward refuses anything that is not a full sha, before git runs', () => {
    expect(autoUpdate.DEFAULT_DEPS.gitPull('main')).toEqual({ success: false, error: 'no 40-hex commit to fast-forward to' });
});

// LOGIC CHANGE 2026-11-11 (WORK-TODO #10): the default moved to lib/update-config.js with
// the split. A source match on the old line would now pass or fail on spelling; this asks
// the module itself, with LOCAL_REPO_DIR unset, which directory it chose.
test('LOCAL_REPO_DIR defaults to the checkout auto-update.js is in', () => {
    const path = require('path');
    const saved = process.env.LOCAL_REPO_DIR;
    delete process.env.LOCAL_REPO_DIR;
    try {
        jest.isolateModules(() => {
            const cfg = require('../lib/update-config');
            expect(cfg.LOCAL_REPO_DIR).toBe(path.dirname(require.resolve('../auto-update')));
        });
    } finally {
        if (saved !== undefined) process.env.LOCAL_REPO_DIR = saved;
    }
});
