'use strict';

/**
 * tests/update-state.test.js
 *
 * lib/update-state.js against a REAL state file. Every other auto-update suite injects
 * its own loadState, which is how a key the cycle saved (gatedCommit, 2026-11-08) could
 * be dropped by the real loadState on the next read with every suite green.
 *
 * Two halves:
 *   - an enumeration: every `state.<key> =` the cycle writes, read from the source of
 *     the files that write it, is in STATE_KEYS and survives a save/load round trip;
 *   - the behaviour that broke: a green commit held back by a running task is not gated
 *     again on the next cycle, run through the real checkForUpdates with the real
 *     loadState/saveState and only the side effects faked.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const WRITERS = ['auto-update.js', 'lib/update-apply.js', 'lib/update-deferral.js'];

let dir;
let savedStateFile;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-state-'));
    savedStateFile = process.env.STATE_FILE;
    process.env.STATE_FILE = path.join(dir, 'state.json');
});

afterEach(() => {
    if (savedStateFile === undefined) delete process.env.STATE_FILE;
    else process.env.STATE_FILE = savedStateFile;
    fs.rmSync(dir, { recursive: true, force: true });
});

/** Fresh modules, so STATE_FILE (read at load) is this test's temp file. */
function fresh(fn) {
    let out;
    jest.isolateModules(() => { out = fn(); });
    return out;
}

/** Every `state.<key> =` assignment in a file's source (not `===`). */
function writtenKeys(src) {
    const keys = new Set();
    for (const m of src.matchAll(/\bstate\.([A-Za-z_]\w*)\s*=(?!=)/g)) keys.add(m[1]);
    return keys;
}

describe('the keys the cycle writes', () => {
    const written = new Set();
    for (const rel of WRITERS) {
        for (const k of writtenKeys(fs.readFileSync(path.join(REPO, rel), 'utf8'))) written.add(k);
    }

    test('the enumeration finds the keys it is meant to find (a scan that found none would pass)', () => {
        expect([...written]).toEqual(expect.arrayContaining([
            'failedCommit', 'gatedCommit', 'lastKnownCommit', 'restartedIntoCommit', 'deferringCommit',
        ]));
    });

    test('negative control: the scan sees an assignment and ignores a comparison', () => {
        expect([...writtenKeys('state.alpha = 1; if (state.beta === 2) {}')]).toEqual(['alpha']);
    });

    test('every written key is a STATE_KEY, so loadState reads back what saveState wrote', () => {
        const { STATE_KEYS } = fresh(() => require('../lib/update-state'));
        expect([...written].filter((k) => !STATE_KEYS.includes(k))).toEqual([]);
    });

    test('every STATE_KEY survives a real save and load', () => {
        const st = fresh(() => require('../lib/update-state'));
        const value = {};
        st.STATE_KEYS.forEach((k, i) => { value[k] = `v${i}`; });
        expect(st.saveState(value)).toEqual({ success: true });
        expect(st.loadState()).toEqual(value);
    });

    test('a missing or unreadable file loads as every key null', () => {
        const st = fresh(() => require('../lib/update-state'));
        const empty = Object.fromEntries(st.STATE_KEYS.map((k) => [k, null]));
        expect(st.loadState()).toEqual(empty);
        fs.writeFileSync(process.env.STATE_FILE, '{not json');
        expect(st.loadState()).toEqual(empty);
    });
});

describe('a green commit held back by a running task is gated once', () => {
    const PREV = 'a'.repeat(40);
    const NEXT = 'b'.repeat(40);

    test('the second cycle does not re-run the gate (it did before gatedCommit was read back)', async () => {
        const au = fresh(() => require('../auto-update'));
        const gateRuns = [];
        const posts = [];
        const deps = {
            gitFetch: () => ({ success: true }),
            getLocalHead: () => PREV,
            getRemoteHead: () => NEXT,
            getCommitMessage: () => 'next',
            runGate: async ({ commit }) => { gateRuns.push(commit); return { ok: true }; },
            formatGateResult: () => 'gate green',
            markUpdatePending: () => ({ marked: true }),
            clearUpdatePending: () => ({}),
            evaluateTaskDeferral: () => ({ defer: false, reason: null, staleVerdicts: [] }),
            inProcessBusy: () => 'a task is running',
            postToOps: async (t) => { posts.push(t); },
            exit: async () => { throw new Error('must not exit while deferred'); },
            // loadState and saveState are the REAL ones from the facade's bag.
        };
        await au.checkForUpdates(deps);
        await au.checkForUpdates(deps);
        expect(gateRuns).toEqual([NEXT]);
        expect(JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8')).gatedCommit).toBe(NEXT);
        expect(posts.filter((p) => p.includes('Update gate: running'))).toHaveLength(1);
    });
});
