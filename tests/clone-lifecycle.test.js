/**
 * tests/clone-lifecycle.test.js
 *
 * Unit tests for lib/clone-lifecycle.js — the git/clone lifecycle helpers
 * extracted from bridge-agent.js (seam A, docs/WIRING-AND-SEAMS.md).
 *
 * detectUndeliveredWork's branching classification is covered exhaustively by
 * tests/undelivered-work.test.js (which lifts it against an injected execSync).
 * This file covers the other two exported functions — cloneRepo and cleanupDir —
 * so every exported function has at least one test per the no-new-function rule,
 * and pins the module's export surface after the move.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const cloneLifecycle = require('../lib/clone-lifecycle');

describe('module export surface', () => {
  test('exports the three seam-A helpers as functions', () => {
    expect(typeof cloneLifecycle.cloneRepo).toBe('function');
    expect(typeof cloneLifecycle.cleanupDir).toBe('function');
    expect(typeof cloneLifecycle.detectUndeliveredWork).toBe('function');
  });
});

describe('cleanupDir', () => {
  let logSpy;
  let errSpy;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('removes an existing directory and its contents', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-lifecycle-'));
    fs.writeFileSync(path.join(dir, 'file.txt'), 'work');
    expect(fs.existsSync(dir)).toBe(true);

    cloneLifecycle.cleanupDir(dir);

    expect(fs.existsSync(dir)).toBe(false);
  });

  test('is a no-op (does not throw) for a non-existent directory', () => {
    const dir = path.join(os.tmpdir(), 'clone-lifecycle-does-not-exist-12345');
    expect(fs.existsSync(dir)).toBe(false);
    expect(() => cloneLifecycle.cleanupDir(dir)).not.toThrow();
  });
});

describe('cloneRepo', () => {
  // cloneRepo shells out to real `git clone`, so this test exercises only the
  // deterministic, offline-observable behaviour: the initial-branch clone failing
  // when the branch IS already 'main' must rethrow (no fallback path to try). A
  // fake execSync stands in for git so no network is touched.
  const clonePath = path.join(__dirname, '..', 'lib', 'clone-lifecycle.js');
  const source = fs.readFileSync(clonePath, 'utf8');

  const makeCloneRepo = (execSync, processStub) => {
    const start = source.indexOf('function cloneRepo(repo, branch, targetDir) {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start) + 3;
    const body = source.slice(start, end);
    // Inject execSync, fs (real, for existsSync on the deploy key), console, process.
    // eslint-disable-next-line no-new-func
    return new Function(
      'execSync',
      'fs',
      'console',
      'process',
      `${body}\nreturn cloneRepo;`
    )(execSync, fs, { log() {}, warn() {}, error() {} }, processStub);
  };

  test('rethrows a clone failure when the requested branch is already main', () => {
    const execSync = () => {
      throw new Error('fatal: repository not found');
    };
    const cloneRepo = makeCloneRepo(execSync, { env: {} });
    expect(() => cloneRepo('jtpets/nope', 'main', '/tmp/x')).toThrow(/not found/);
  });

  test('falls back to main and configures push when the branch is missing', () => {
    const calls = [];
    let cloneAttempts = 0;
    const execSync = (cmd) => {
      calls.push(cmd);
      if (cmd.includes('git clone')) {
        cloneAttempts += 1;
        // First attempt (feature branch) fails; the fallback clone of main succeeds.
        if (cloneAttempts === 1) throw new Error('Remote branch not found');
        return Buffer.from('');
      }
      return Buffer.from('');
    };
    // No deploy key present → read-only warning path, no throw.
    const cloneRepo = makeCloneRepo(execSync, { env: { DEPLOY_KEY_PATH: '/no/such/key' } });
    expect(() => cloneRepo('jtpets/repo', 'feature/x', '/tmp/x')).not.toThrow();
    // Two clone attempts: the requested branch, then the main fallback.
    expect(calls.filter((c) => c.includes('git clone')).length).toBe(2);
    expect(calls.some((c) => c.includes('--branch main'))).toBe(true);
  });
});
