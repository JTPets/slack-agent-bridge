/**
 * tests/auto-update-restart.test.js
 *
 * Tests for the exit-based self-update in auto-update.js.
 *
 * The bridge restarts itself by exiting: the `jt-agent` container runs with
 * `restart: unless-stopped`, so process exit re-runs
 * `npm install && node bridge-agent.js`. That is intended. What must never
 * happen is exiting into code that cannot start, because `unless-stopped` turns
 * that into an endless restart loop with no way into the container.
 *
 * These tests assert the EXIT DECISION, not an actual restart - a real container
 * restart cycle is not testable from here, and pretending otherwise would be the
 * more dangerous kind of green.
 *
 * One test per guard, each written so it fails if its guard is removed:
 *   (a) verify before exiting  - bad pull must NOT exit, must revert
 *   (b) save state before exiting
 *   (c) never exit twice for the same commit
 *   (d) post to Slack before exiting
 */

'use strict';

const autoUpdate = require('../auto-update');

const PREV_HEAD = 'aaaaaaa1111111111111111111111111111111aa';
const NEW_HEAD = 'bbbbbbb2222222222222222222222222222222bb';

/**
 * Build a dependency bag whose happy path ends in a restart.
 * Every call is recorded in `calls` so ORDER can be asserted - "state saved
 * before exit" and "posted before exit" are ordering claims, not just
 * "was it called" claims.
 */
function makeDeps(overrides = {}) {
    const calls = [];
    const savedStates = [];
    const posts = [];

    const deps = {
        calls,
        savedStates,
        posts,

        loadState: jest.fn(() => ({
            lastKnownCommit: PREV_HEAD,
            restartedIntoCommit: null,
            failedCommit: null,
        })),
        saveState: jest.fn((state) => {
            calls.push('saveState');
            savedStates.push({ ...state });
            return { success: true };
        }),
        gitFetch: jest.fn(() => ({ success: true })),
        getLocalHead: jest.fn(),
        getRemoteHead: jest.fn(() => NEW_HEAD),
        getCommitMessage: jest.fn(() => 'some commit'),
        gitResetHard: jest.fn(() => {
            calls.push('gitResetHard');
            return { success: true };
        }),
        gitResetTo: jest.fn(() => {
            calls.push('gitResetTo');
            return { success: true };
        }),
        gitPull: jest.fn(() => {
            calls.push('gitPull');
            return { success: true };
        }),
        npmInstall: jest.fn(() => {
            calls.push('npmInstall');
            return { success: true };
        }),
        verifyEntryPoints: jest.fn(() => {
            calls.push('verifyEntryPoints');
            return { ok: true, checked: ['bridge-agent.js'], missing: [], failures: [] };
        }),
        runSmokeTest: jest.fn(() => {
            calls.push('runSmokeTest');
            return { ok: true };
        }),
        planRestart: jest.fn(({ newHead, restartedIntoCommit }) => {
            calls.push('planRestart');
            if (restartedIntoCommit && restartedIntoCommit === newHead) {
                return { exit: false, reason: 'already restarted for this commit' };
            }
            return { exit: true, reason: 'ok' };
        }),
        waitForTaskCompletion: jest.fn(async () => ({ waited: false, attempts: 0 })),
        postToOps: jest.fn(async (msg) => {
            calls.push('postToOps');
            posts.push(msg);
        }),
        exit: jest.fn(async () => {
            calls.push('exit');
        }),
    };

    // HEAD is PREV_HEAD before the pull and NEW_HEAD after it.
    let pulled = false;
    const realPull = deps.gitPull;
    deps.gitPull = jest.fn(() => {
        pulled = true;
        return realPull();
    });
    deps.getLocalHead = jest.fn(() => (pulled ? NEW_HEAD : PREV_HEAD));

    return Object.assign(deps, overrides);
}

// Keep the test output readable - the code under test logs deliberately.
let logSpy;
let warnSpy;
let errorSpy;

beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    jest.clearAllMocks();
});

describe('module shape', () => {
    test('requiring auto-update.js does not start the polling daemon', () => {
        // If main() ran on require, this test file would never finish.
        expect(typeof autoUpdate.checkForUpdates).toBe('function');
        expect(autoUpdate.RESTART_EXIT_CODE).toBe(0);
    });

    test('pm2 is gone from the module surface', () => {
        expect(autoUpdate.restartPM2).toBeUndefined();
        expect(Object.keys(autoUpdate).join(' ')).not.toMatch(/pm2/i);
    });
});

describe('happy path', () => {
    test('a verified update exits 0 to trigger the container restart', async () => {
        const deps = makeDeps();
        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).toHaveBeenCalledTimes(1);
        expect(deps.exit).toHaveBeenCalledWith(autoUpdate.RESTART_EXIT_CODE);
        expect(autoUpdate.RESTART_EXIT_CODE).toBe(0);
    });

    test('nothing happens when local and remote are already the same commit', async () => {
        const deps = makeDeps({
            getRemoteHead: jest.fn(() => PREV_HEAD),
            getLocalHead: jest.fn(() => PREV_HEAD),
        });
        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitPull).not.toHaveBeenCalled();
        expect(deps.exit).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// GUARD (a): verify before exiting
// ---------------------------------------------------------------------------

describe('guard (a): verify before exiting', () => {
    test('a pull whose code does not parse does NOT exit', async () => {
        const deps = makeDeps({
            verifyEntryPoints: jest.fn(() => ({
                ok: false,
                checked: [],
                missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError: Unexpected token' }],
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        // The whole point: the process stays up on code that works.
        expect(deps.exit).not.toHaveBeenCalled();
    });

    test('a bad pull is reverted to the previously running commit', async () => {
        const deps = makeDeps({
            verifyEntryPoints: jest.fn(() => ({
                ok: false,
                checked: [],
                missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError: Unexpected token' }],
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitResetTo).toHaveBeenCalledWith(PREV_HEAD);
    });

    test('a bad pull is reported to #sqtools-ops with the failing file', async () => {
        const deps = makeDeps({
            verifyEntryPoints: jest.fn(() => ({
                ok: false,
                checked: [],
                missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError: Unexpected token' }],
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.posts).toHaveLength(1);
        expect(deps.posts[0]).toMatch(/refusing to restart/i);
        expect(deps.posts[0]).toMatch(/bridge-agent\.js/);
        expect(deps.posts[0]).toMatch(/SyntaxError/);
    });

    test('a failed npm install does NOT exit and reverts', async () => {
        const deps = makeDeps({
            npmInstall: jest.fn(() => ({ success: false, error: 'ERESOLVE could not resolve' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.gitResetTo).toHaveBeenCalledWith(PREV_HEAD);
        expect(deps.posts[0]).toMatch(/npm install failed/i);
    });

    test('verification runs BEFORE npm install, so a typo never touches node_modules', async () => {
        const deps = makeDeps();
        deps.verifyEntryPoints = jest.fn(() => {
            deps.calls.push('verifyEntryPoints');
            return {
                ok: false,
                checked: [],
                missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError' }],
            };
        });

        await autoUpdate.checkForUpdates(deps);

        // npmInstall is still called once - by the revert, to restore deps for
        // the old tree - but never for the bad commit.
        const order = deps.calls.filter(c => c === 'verifyEntryPoints' || c === 'npmInstall' || c === 'gitResetTo');
        expect(order[0]).toBe('verifyEntryPoints');
        expect(order[1]).toBe('gitResetTo');
    });

    test('a commit that failed verification is not retried on the next check', async () => {
        // Without this, a bad commit sitting on main is pulled, reverted and
        // re-announced every CHECK_INTERVAL_MS forever.
        const deps = makeDeps({
            loadState: jest.fn(() => ({
                lastKnownCommit: PREV_HEAD,
                restartedIntoCommit: null,
                failedCommit: NEW_HEAD,
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitPull).not.toHaveBeenCalled();
        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.postToOps).not.toHaveBeenCalled();
    });

    test('a NEWER commit after a failed one is still attempted', async () => {
        const FIXED_HEAD = 'ccccccc3333333333333333333333333333333cc';
        const deps = makeDeps({
            loadState: jest.fn(() => ({
                lastKnownCommit: PREV_HEAD,
                restartedIntoCommit: null,
                failedCommit: NEW_HEAD,
            })),
            getRemoteHead: jest.fn(() => FIXED_HEAD),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitPull).toHaveBeenCalled();
        expect(deps.exit).toHaveBeenCalledTimes(1);
    });

    test('the failed commit is recorded in state so the skip survives a restart', async () => {
        const deps = makeDeps({
            verifyEntryPoints: jest.fn(() => ({
                ok: false, checked: [], missing: [],
                failures: [{ file: 'bridge-agent.js', error: 'SyntaxError' }],
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.savedStates).toHaveLength(1);
        expect(deps.savedStates[0].failedCommit).toBe(NEW_HEAD);
        // lastKnownCommit must NOT advance to a commit that never ran.
        expect(deps.savedStates[0].lastKnownCommit).toBe(PREV_HEAD);
    });
});

// ---------------------------------------------------------------------------
// GUARD (a) part 3: the smoke test is a real load check, not just a parse
// ---------------------------------------------------------------------------

describe('guard (a) part 3: smoke test gates the restart', () => {
    test('a commit whose smoke test fails does NOT exit and is reverted', async () => {
        // The whole reason this guard exists: node --check passes on a commit that
        // deletes a required file or adds a missing dependency. The smoke test is
        // what actually require()s the modules and catches it.
        const deps = makeDeps({
            runSmokeTest: jest.fn(() => ({ ok: false, error: "Cannot find module '../lib/gone'" })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.gitResetTo).toHaveBeenCalledWith(PREV_HEAD);
        expect(deps.posts[0]).toMatch(/smoke test failed/i);
        expect(deps.posts[0]).toMatch(/Cannot find module/);
    });

    test('a smoke test that TIMES OUT is a failure, not a pass', async () => {
        // A wedged test must revert, never restart and never hang the loop.
        const deps = makeDeps({
            runSmokeTest: jest.fn(() => ({ ok: false, timedOut: true, error: 'smoke test did not finish within 120000ms - treated as failure' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.gitResetTo).toHaveBeenCalledWith(PREV_HEAD);
        expect(deps.posts[0]).toMatch(/smoke test timed out/i);
    });

    test('the failed commit is recorded so a red smoke test is not retried every interval', async () => {
        const deps = makeDeps({
            runSmokeTest: jest.fn(() => ({ ok: false, error: 'boom' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.savedStates[0].failedCommit).toBe(NEW_HEAD);
        expect(deps.savedStates[0].lastKnownCommit).toBe(PREV_HEAD);
    });

    test('smoke test runs AFTER npm install (it needs node_modules) and BEFORE the exit', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        const npmIdx = deps.calls.indexOf('npmInstall');
        const smokeIdx = deps.calls.indexOf('runSmokeTest');
        const exitIdx = deps.calls.indexOf('exit');
        expect(npmIdx).toBeGreaterThan(-1);
        expect(smokeIdx).toBeGreaterThan(npmIdx);
        expect(exitIdx).toBeGreaterThan(smokeIdx);
    });

    // MUTATION TRIPWIRE: if someone deletes the `if (!smokeResult.ok)` block, the
    // "does NOT exit" test above would go green on a red smoke result. This asserts
    // the gate is consulted at all on the happy path, so removing it turns red.
    test('the smoke gate is actually invoked on the happy path', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        expect(deps.runSmokeTest).toHaveBeenCalledTimes(1);
        expect(deps.runSmokeTest).toHaveBeenCalledWith(
            expect.objectContaining({ repoDir: expect.any(String) })
        );
        expect(deps.exit).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// GUARD (b): save state before exiting
// ---------------------------------------------------------------------------

describe('guard (b): save state before exiting', () => {
    test('lastKnownCommit is written BEFORE the exit, not after', async () => {
        // This is the exact bug the pm2 path had: it returned before saveState,
        // so the same commit was re-pulled every check interval forever.
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        const saveIdx = deps.calls.indexOf('saveState');
        const exitIdx = deps.calls.indexOf('exit');
        expect(saveIdx).toBeGreaterThan(-1);
        expect(exitIdx).toBeGreaterThan(-1);
        expect(saveIdx).toBeLessThan(exitIdx);
        expect(deps.savedStates[0].lastKnownCommit).toBe(NEW_HEAD);
    });

    test('a state write that fails aborts the restart instead of exiting blind', async () => {
        const deps = makeDeps({
            saveState: jest.fn(() => ({ success: false, error: 'EROFS: read-only file system' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.posts.join('\n')).toMatch(/could not write the state file/i);
    });
});

// ---------------------------------------------------------------------------
// GUARD (c): never exit twice for the same commit
// ---------------------------------------------------------------------------

describe('guard (c): do not re-exit for the same commit', () => {
    test('refuses to exit for a commit it already restarted into', async () => {
        const deps = makeDeps({
            loadState: jest.fn(() => ({
                lastKnownCommit: PREV_HEAD,
                restartedIntoCommit: NEW_HEAD,
                failedCommit: null,
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.planRestart).toHaveBeenCalledWith(
            expect.objectContaining({ newHead: NEW_HEAD, restartedIntoCommit: NEW_HEAD })
        );
        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.posts.join('\n')).toMatch(/not restarting/i);
    });

    test('the commit restarted into is persisted, so the refusal survives the restart', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        expect(deps.savedStates[0].restartedIntoCommit).toBe(NEW_HEAD);
    });

    test('a successful restart clears any earlier failedCommit', async () => {
        const OLDER_BAD = 'ddddddd4444444444444444444444444444444dd';
        const deps = makeDeps({
            loadState: jest.fn(() => ({
                lastKnownCommit: PREV_HEAD,
                restartedIntoCommit: null,
                failedCommit: OLDER_BAD,
            })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.savedStates[0].failedCommit).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// GUARD (d): post before exiting
// ---------------------------------------------------------------------------

describe('guard (d): notify before exiting', () => {
    test('the Slack post happens BEFORE the exit - there is no "after"', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        const postIdx = deps.calls.indexOf('postToOps');
        const exitIdx = deps.calls.indexOf('exit');
        expect(postIdx).toBeGreaterThan(-1);
        expect(postIdx).toBeLessThan(exitIdx);
    });

    test('the post names the commit and says a restart is happening', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        expect(deps.posts).toHaveLength(1);
        expect(deps.posts[0]).toContain(NEW_HEAD.substring(0, 7));
        expect(deps.posts[0]).toMatch(/restart/i);
        expect(deps.posts[0]).not.toMatch(/pm2/i);
    });

    test('the post is awaited, so a slow Slack call cannot be cut off by the exit', async () => {
        const order = [];
        const deps = makeDeps({
            postToOps: jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 20));
                order.push('post-finished');
            }),
            exit: jest.fn(async () => {
                order.push('exit');
            }),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(order).toEqual(['post-finished', 'exit']);
    });
});

// ---------------------------------------------------------------------------
// Pre-existing behaviour that must survive the rewrite
// ---------------------------------------------------------------------------

describe('existing behaviour preserved', () => {
    test('waits for a running task before exiting', async () => {
        const deps = makeDeps();

        await autoUpdate.checkForUpdates(deps);

        expect(deps.waitForTaskCompletion).toHaveBeenCalledTimes(1);
    });

    test('a failed fetch reports and returns without touching the tree', async () => {
        const deps = makeDeps({
            gitFetch: jest.fn(() => ({ success: false, error: 'could not resolve host' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.gitPull).not.toHaveBeenCalled();
        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.posts[0]).toMatch(/git fetch failed/i);
    });

    test('a failed pull reports and does not exit', async () => {
        const deps = makeDeps({
            gitPull: jest.fn(() => ({ success: false, error: 'merge conflict' })),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.posts[0]).toMatch(/git pull failed/i);
    });

    test('an unexpected throw is reported to Slack and never exits', async () => {
        const deps = makeDeps({
            gitResetHard: jest.fn(() => { throw new Error('boom'); }),
        });

        await autoUpdate.checkForUpdates(deps);

        expect(deps.exit).not.toHaveBeenCalled();
        expect(deps.posts.join('\n')).toMatch(/Unexpected error - boom/);
    });
});

// ---------------------------------------------------------------------------
// revertTo
// ---------------------------------------------------------------------------

describe('revertTo', () => {
    test('reinstalls dependencies for the reverted tree', async () => {
        const gitResetTo = jest.fn(() => ({ success: true }));
        const npmInstall = jest.fn(() => ({ success: true }));

        const result = autoUpdate.revertTo(PREV_HEAD, { gitResetTo, npmInstall });

        expect(gitResetTo).toHaveBeenCalledWith(PREV_HEAD);
        expect(npmInstall).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });

    test('reports a failed reset instead of claiming the revert worked', async () => {
        const result = autoUpdate.revertTo(PREV_HEAD, {
            gitResetTo: () => ({ success: false, error: 'unknown revision' }),
            npmInstall: jest.fn(),
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unknown revision/);
    });

    test('a failed npm install on the reverted tree is surfaced, not swallowed', async () => {
        const result = autoUpdate.revertTo(PREV_HEAD, {
            gitResetTo: () => ({ success: true }),
            npmInstall: () => ({ success: false, error: 'network unreachable' }),
        });

        expect(result.success).toBe(true);
        expect(result.npmError).toMatch(/network unreachable/);
    });
});
