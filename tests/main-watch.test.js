'use strict';

/**
 * tests/main-watch.test.js - WORK-TODO #66: main compared with the commit the bridge
 * booted on, reported once per new main sha. Includes a real `git ls-remote` against
 * a temp origin, because the parse is only worth anything against git's own output.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMainWatch, remoteMainSha, describeDivergence } = require('../lib/main-watch');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const BOOT = { available: true, sha: A, short: 'aaaaaaa', subject: 'B4: records' };

function watch(readMain, bootCommit = BOOT) {
  const notify = jest.fn(async () => {});
  return { w: createMainWatch({ bootCommit, readMain, notify, logger: silent }), notify };
}

describe('createMainWatch', () => {
  test('main equal to the boot commit: nothing posted', async () => {
    const { w, notify } = watch(async () => ({ ok: true, sha: A }));
    expect(await w.tick()).toBe('current');
    expect(notify).not.toHaveBeenCalled();
  });

  test('main moved: posted ONCE per new main sha, and again when main moves again', async () => {
    let main = B;
    const { w, notify } = watch(async () => ({ ok: true, sha: main }));
    expect(await w.tick()).toBe('reported');
    expect(await w.tick()).toBe('already_reported');
    main = C;
    expect(await w.tick()).toBe('reported');
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('the post says "differs", names both commits and the restart, and never claims "behind"', () => {
    const text = describeDivergence(BOOT, B);
    expect(text).toMatch(/differs/);
    expect(text).toMatch(/aaaaaaa/);
    expect(text).toMatch(/bbbbbbb/);
    expect(text).toMatch(/docker compose restart jt-agent/);
    expect(text).not.toMatch(/behind/i);
  });

  test('an unreadable remote is reported once per process, not every interval', async () => {
    const { w, notify } = watch(async () => ({ ok: false, reason: 'Permission denied (publickey)' }));
    expect(await w.tick()).toBe('remote_unreadable');
    expect(await w.tick()).toBe('remote_unreadable');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/Cannot watch/);
  });

  test('an unknown boot commit means no comparison and no post (the boot post already said UNKNOWN)', async () => {
    const readMain = jest.fn();
    const { w, notify } = watch(readMain, { available: false, reason: 'dubious ownership' });
    expect(await w.tick()).toBe('boot_unknown');
    expect(readMain).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('a notify that rejects does not make tick reject', async () => {
    const w = createMainWatch({ bootCommit: BOOT, readMain: async () => ({ ok: true, sha: B }), notify: async () => { throw new Error('slack down'); }, logger: silent });
    await expect(w.tick()).resolves.toBe('reported');
  });
});

describe('remoteMainSha against real git', () => {
  let dir;
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-watch-'));
    const origin = path.join(dir, 'origin');
    fs.mkdirSync(origin);
    git(['init', '-q', '-b', 'main'], origin);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one'], origin);
    git(['clone', '-q', `file://${origin}`, path.join(dir, 'deploy')], dir);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("returns origin main's sha", async () => {
    const expected = git(['rev-parse', 'HEAD'], path.join(dir, 'origin'));
    await expect(remoteMainSha(path.join(dir, 'deploy'))).resolves.toEqual({ ok: true, sha: expected });
  });

  test('a checkout with no reachable origin is { ok: false }, never a throw', async () => {
    const lone = path.join(dir, 'lone');
    fs.mkdirSync(lone);
    git(['init', '-q'], lone);
    const r = await remoteMainSha(lone);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

test('bridge-agent.js wires it after the boot commit, with an off switch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
  const boot = src.indexOf('const BOOT_COMMIT = ');
  const wired = src.indexOf('createMainWatch({');
  expect(boot).toBeGreaterThan(0);
  expect(wired).toBeGreaterThan(boot);
  expect(src).toMatch(/if \(MAIN_WATCH_INTERVAL_MS > 0\)/);
});
