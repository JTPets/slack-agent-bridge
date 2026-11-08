/**
 * tests/self-deploy.test.js
 *
 * WORK-TODO #17: lib/self-deploy.js runs auto-update.js's gated cycle inside the bridge.
 * Off when SELF_DEPLOY_INTERVAL_MS is 0; off, and said so, when LOCAL_REPO_DIR points at
 * another checkout; one cycle at a time; the in-process `busy` view and the gate reach
 * checkForUpdates; a throwing cycle is reported. Plus the bridge-agent.js wiring.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createSelfDeploy, intervalFromEnv, DEFAULT_INTERVAL_MS } = require('../lib/self-deploy');

const REPO = path.join(__dirname, '..');
function fakeAutoUpdate({ dir = REPO, check } = {}) {
    return {
        LOCAL_REPO_DIR: dir,
        gatedDeps: (extra) => ({ runGate: 'GATE', ...extra }),
        checkForUpdates: jest.fn(check || (async () => {})),
    };
}
const timers = () => ({ setIntervalFn: jest.fn(() => ({ unref() {} })), setTimeoutFn: jest.fn(() => ({ unref() {} })) });

test('interval parsing: unset is 5 min, 0 is off, junk is the default', () => {
    expect(intervalFromEnv({})).toBe(DEFAULT_INTERVAL_MS);
    expect(intervalFromEnv({ SELF_DEPLOY_INTERVAL_MS: '0' })).toBe(0);
    expect(intervalFromEnv({ SELF_DEPLOY_INTERVAL_MS: 'soon' })).toBe(DEFAULT_INTERVAL_MS);
});

test('0 turns it off without loading auto-update', async () => {
    const loadAutoUpdate = jest.fn();
    const sd = createSelfDeploy({ repoDir: REPO, busy: () => null, postToOps: jest.fn(), intervalMs: 0, loadAutoUpdate });
    expect(await sd.start()).toEqual({ started: false, reason: 'SELF_DEPLOY_INTERVAL_MS is 0' });
    expect(loadAutoUpdate).not.toHaveBeenCalled();
});

test('a LOCAL_REPO_DIR naming another checkout keeps it off and tells ops how to fix it', async () => {
    const postToOps = jest.fn(async () => {});
    const au = fakeAutoUpdate({ dir: '/home/jtpets/jt-agent' });
    const sd = createSelfDeploy({ repoDir: REPO, busy: () => null, postToOps, intervalMs: 1000, loadAutoUpdate: () => au, ...timers() });
    const r = await sd.start();
    expect(r.started).toBe(false);
    expect(postToOps.mock.calls[0][0]).toMatch(/Self-deploy is OFF: LOCAL_REPO_DIR is \/home\/jtpets\/jt-agent.*Remove LOCAL_REPO_DIR/);
    expect(await sd.cycle()).toBe(false);
    expect(au.checkForUpdates).not.toHaveBeenCalled();
});

test('started: the cycle passes the gate and the in-process busy view, one at a time', async () => {
    let release;
    const au = fakeAutoUpdate({ check: () => new Promise((r) => { release = r; }) });
    const busy = () => 'a task or an answer is in progress';
    const t = timers();
    const sd = createSelfDeploy({ repoDir: REPO, busy, postToOps: jest.fn(), intervalMs: 1000, loadAutoUpdate: () => au, ...t });
    expect(await sd.start()).toEqual({ started: true, reason: null });
    expect(t.setIntervalFn).toHaveBeenCalledWith(sd.cycle, 1000);
    const first = sd.cycle();
    expect(await sd.cycle()).toBe(false); // a second cycle while one runs does nothing
    expect(sd.inFlight()).toBe(true);
    release();
    expect(await first).toBe(true);
    expect(au.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(au.checkForUpdates.mock.calls[0][0]).toEqual({ runGate: 'GATE', inProcessBusy: busy });
});

test('a throwing cycle is reported and releases the guard', async () => {
    const postToOps = jest.fn(async () => {});
    const au = fakeAutoUpdate({ check: async () => { throw new Error('boom'); } });
    const sd = createSelfDeploy({ repoDir: REPO, busy: () => null, postToOps, intervalMs: 1000, loadAutoUpdate: () => au, ...timers() });
    await sd.start();
    await sd.cycle();
    expect(postToOps.mock.calls.at(-1)[0]).toMatch(/update cycle threw - boom/);
    expect(sd.inFlight()).toBe(false);
});

test('the real auto-update.js defaults to this checkout, so the default configuration starts', () => {
    const au = require('../auto-update');
    if (!process.env.LOCAL_REPO_DIR) expect(path.resolve(au.LOCAL_REPO_DIR)).toBe(path.resolve(REPO));
    expect(typeof au.gatedDeps).toBe('function');
});

describe('the bridge-agent.js wiring', () => {
    const src = fs.readFileSync(path.join(REPO, 'bridge-agent.js'), 'utf8');
    test('self-deploy is created from this checkout with the poll sweep as its busy signal, and started', () => {
        expect(src).toMatch(/createSelfDeploy\(\{\s*repoDir: __dirname,\s*busy: \(\) => \(pollInFlight \? 'a task or an answer is in progress' : null\),/);
        expect(src).toMatch(/selfDeploy\.start\(\)/);
    });
});
