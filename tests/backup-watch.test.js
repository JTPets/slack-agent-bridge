'use strict';

/**
 * tests/backup-watch.test.js
 *
 * WORK-TODO #42 (c): the backup age alert. lib/backup-watch.js is exercised against
 * status files written by the REAL scripts/backup-status.sh (run with /bin/sh against
 * temp directories), so the two halves are proved to agree on the format.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateStatus, createBackupWatch, REPEAT_MS } = require('../lib/backup-watch');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backup-status.sh');
const H = 3600000;
const MAX = 26 * H;
let root;
beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-watch-')); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Run the real host script over `dirs`; returns the status text. */
function hostStatus(dirs) {
  const out = path.join(root, `status-${Math.random().toString(36).slice(2)}.json`);
  execFileSync('/bin/sh', [SCRIPT, out, ...dirs]);
  return fs.readFileSync(out, 'utf8');
}
function dirWith(name, ageHours) {
  const d = fs.mkdtempSync(path.join(root, 'b-'));
  if (name) {
    const f = path.join(d, name);
    fs.writeFileSync(f, 'x');
    const t = (Date.now() - ageHours * H) / 1000;
    fs.utimesSync(f, t, t);
  }
  return d;
}

describe('the real host script and the evaluator agree', () => {
  test('a fresh dump: no problems', () => {
    expect(evaluateStatus(hostStatus([dirWith('jtpets_beta.sql.gz', 2)]), Date.now(), MAX)).toEqual([]);
  });

  test('a stale dump is named with its age', () => {
    const [p] = evaluateStatus(hostStatus([dirWith('old.sql.gz', 50)]), Date.now(), MAX);
    expect(p).toMatch(/newest backup old\.sql\.gz is 50h old/);
  });

  test('an empty and a missing directory are each a problem', () => {
    const problems = evaluateStatus(hostStatus([dirWith(null), path.join(root, 'gone')]), Date.now(), MAX);
    expect(problems.join('\n')).toMatch(/directory is empty/);
    expect(problems.join('\n')).toMatch(/directory does not exist/);
  });

  test('THE silent-stoppage case: a fresh dump in a status file the host stopped refreshing', () => {
    const text = hostStatus([dirWith('ok.sql.gz', 1)]);
    const twoDaysLater = Date.now() + 48 * H;
    const problems = evaluateStatus(text, twoDaysLater, MAX);
    expect(problems.join('\n')).toMatch(/host check last ran .* cron entry has probably stopped/);
  });

  test('the script refuses to run without arguments (exit 2)', () => {
    expect(() => execFileSync('/bin/sh', [SCRIPT], { stdio: 'ignore' })).toThrow();
  });
});

describe('evaluateStatus on bad input', () => {
  test('no file, bad JSON, no dirs, unreadable age', () => {
    expect(evaluateStatus(null, 0, MAX)[0]).toMatch(/does not exist/);
    expect(evaluateStatus('{nope', 0, MAX)[0]).toMatch(/not valid JSON/);
    expect(evaluateStatus(JSON.stringify({ checkedAt: 1, dirs: [] }), 1000, MAX)).toContain('the status file lists no backup directories');
    const unknownAge = JSON.stringify({ checkedAt: 1, dirs: [{ path: '/b', newest: 'x.sql', newestMtime: null }] });
    expect(evaluateStatus(unknownAge, 1000, MAX).join()).toMatch(/age of x\.sql could not be read/);
  });
});

describe('createBackupWatch: when it posts', () => {
  function setup(initial) {
    let raw = initial;
    let t = 1_000_000_000_000;
    const notify = jest.fn(async () => {});
    const w = createBackupWatch({ file: '/bridge/.backup-status.json', maxAgeMs: MAX, notify, now: () => t, readFile: () => raw });
    return { w, notify, set: (r) => { raw = r; }, advance: (ms) => { t += ms; }, now: () => t };
  }
  const fresh = (nowMs) => JSON.stringify({ checkedAt: nowMs / 1000, dirs: [{ path: '/b', newest: 'a.sql', newestMtime: nowMs / 1000, count: 1 }] });

  test('healthy posts nothing; a problem posts once, repeats after 24h, and recovery posts once', async () => {
    const s = setup(null);
    s.set(fresh(s.now()));
    expect(await s.w.tick()).toBe('healthy');
    s.set(null);
    expect(await s.w.tick()).toBe('reported');
    expect(await s.w.tick()).toBe('unchanged');
    s.advance(REPEAT_MS + 1);
    expect(await s.w.tick()).toBe('reported');
    s.set(fresh(s.now()));
    expect(await s.w.tick()).toBe('recovered');
    expect(await s.w.tick()).toBe('healthy');
    expect(s.notify).toHaveBeenCalledTimes(3);
    expect(s.notify.mock.calls[0][0]).toMatch(/Backup check: 1 problem/);
  });

  test('a different problem set posts at once, without waiting 24h', async () => {
    const s = setup(null);
    await s.w.tick();
    s.set('{bad');
    expect(await s.w.tick()).toBe('reported');
  });

  test('a notify that rejects does not make tick reject', async () => {
    const w = createBackupWatch({ file: 'f', maxAgeMs: MAX, notify: async () => { throw new Error('down'); }, readFile: () => null, logger: { error: () => {} } });
    await expect(w.tick()).resolves.toBe('reported');
  });
});

test('bridge-agent.js wires it only when BACKUP_STATUS_FILE is set, and says so when not', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
  expect(src).toMatch(/if \(BACKUP_STATUS_FILE\) \{\s*const backupWatch = createBackupWatch\(/);
  expect(src).toMatch(/Backups:\s+NOT watched/);
});
