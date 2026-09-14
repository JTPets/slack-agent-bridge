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

// LOGIC CHANGE 2026-09-14: The previous cloneRepo tests lifted the function's
// source with `new Function` and injected a fake execSync. That technique cannot
// survive the security fix (cloneRepo now closes over a module-level require), and
// it asserted on shell command STRINGS — the very thing being removed. These tests
// mock child_process instead, so they assert on the argv arrays that reach git.
describe('cloneRepo command execution', () => {
  const REAL_KEY_ENV = process.env.DEPLOY_KEY_PATH;

  beforeEach(() => {
    jest.resetModules();
    // A deploy key path that does not exist keeps the run on the read-only branch:
    // the clone happens, the push configuration is skipped, nothing throws.
    process.env.DEPLOY_KEY_PATH = '/no/such/deploy/key';
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (REAL_KEY_ENV === undefined) delete process.env.DEPLOY_KEY_PATH;
    else process.env.DEPLOY_KEY_PATH = REAL_KEY_ENV;
  });

  // Loads lib/clone-lifecycle.js with child_process mocked, and hands back both
  // the module and the two exec spies so a test can assert which one ran.
  const loadWithMockedExec = (execFileImpl = () => Buffer.from('')) => {
    let mod;
    let execFileSync;
    let execSync;
    jest.isolateModules(() => {
      jest.doMock('child_process', () => ({
        execFileSync: jest.fn(execFileImpl),
        execSync: jest.fn(() => {
          throw new Error('execSync must not be used by cloneRepo');
        }),
      }));
      // eslint-disable-next-line global-require
      const childProcess = require('child_process');
      execFileSync = childProcess.execFileSync;
      execSync = childProcess.execSync;
      // eslint-disable-next-line global-require
      mod = require('../lib/clone-lifecycle');
    });
    return { mod, execFileSync, execSync };
  };

  test('a legitimate repo and branch still clone, via an argv array and not a shell', () => {
    const { mod, execFileSync, execSync } = loadWithMockedExec();

    mod.cloneRepo('JTPets/slack-agent-bridge', 'feature/my-work', '/tmp/scratch-clone');

    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);

    const [bin, args] = execFileSync.mock.calls[0];
    expect(bin).toBe('git');
    expect(Array.isArray(args)).toBe(true);
    // Each value is its own argv element — nothing is concatenated into a string
    // that a shell could reparse.
    expect(args).toEqual([
      'clone',
      '--depth',
      '1',
      '--branch',
      'feature/my-work',
      'https://github.com/JTPets/slack-agent-bridge.git',
      '/tmp/scratch-clone',
    ]);
  });

  // Injection vector 1: the REPO: field. The payload is inert — it is a metacharacter
  // string, not a runnable command — and the assertion is that git is never invoked.
  test('rejects a crafted REPO value without invoking git at all', () => {
    const { mod, execFileSync, execSync } = loadWithMockedExec();
    const CRAFTED_REPO = 'jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND';

    expect(() => mod.cloneRepo(CRAFTED_REPO, 'main', '/tmp/scratch-clone')).toThrow(
      /Rejected REPO value/
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  test.each([
    ['semicolon', 'jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND'],
    ['command substitution', 'jtpets/repo$(INERT_PAYLOAD_NOT_A_COMMAND)'],
    ['backtick', 'jtpets/repo`INERT_PAYLOAD_NOT_A_COMMAND`'],
    ['pipe', 'jtpets/repo|INERT_PAYLOAD_NOT_A_COMMAND'],
    ['whitespace split', 'jtpets/runWithFallback had'],
    ['path traversal', 'jtpets/../../etc'],
  ])('rejects a REPO carrying %s', (_label, craftedRepo) => {
    const { mod, execFileSync } = loadWithMockedExec();
    expect(() => mod.cloneRepo(craftedRepo, 'main', '/tmp/scratch-clone')).toThrow(
      /Rejected REPO value/
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  // Injection vector 2: the BRANCH: field.
  test('rejects a crafted BRANCH value without invoking git at all', () => {
    const { mod, execFileSync, execSync } = loadWithMockedExec();
    const CRAFTED_BRANCH = 'main;INERT_PAYLOAD_NOT_A_COMMAND';

    expect(() => mod.cloneRepo('jtpets/repo', CRAFTED_BRANCH, '/tmp/scratch-clone')).toThrow(
      /Rejected BRANCH value/
    );
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
  });

  test.each([
    ['semicolon', 'main;INERT_PAYLOAD_NOT_A_COMMAND'],
    ['command substitution', 'main$(INERT_PAYLOAD_NOT_A_COMMAND)'],
    ['newline', 'main\nINERT_PAYLOAD_NOT_A_COMMAND'],
    ['ref traversal', 'feature/../../main'],
    ['option injection', '--upload-pack=INERT_PAYLOAD_NOT_A_COMMAND'],
  ])('rejects a BRANCH carrying %s', (_label, craftedBranch) => {
    const { mod, execFileSync } = loadWithMockedExec();
    expect(() => mod.cloneRepo('jtpets/repo', craftedBranch, '/tmp/scratch-clone')).toThrow(
      /Rejected BRANCH value/
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('rejects an empty target directory', () => {
    const { mod, execFileSync } = loadWithMockedExec();
    expect(() => mod.cloneRepo('jtpets/repo', 'main', '')).toThrow(
      /Rejected clone target directory/
    );
    expect(execFileSync).not.toHaveBeenCalled();
  });

  test('rethrows a clone failure when the requested branch is already main', () => {
    const { mod } = loadWithMockedExec(() => {
      throw new Error('fatal: repository not found');
    });
    expect(() => mod.cloneRepo('jtpets/nope', 'main', '/tmp/scratch-clone')).toThrow(
      /not found/
    );
  });

  test('falls back to main when the requested branch is missing', () => {
    let attempts = 0;
    const { mod, execFileSync } = loadWithMockedExec((bin, args) => {
      if (args[0] === 'clone') {
        attempts += 1;
        if (attempts === 1) throw new Error('Remote branch not found');
      }
      return Buffer.from('');
    });

    expect(() =>
      mod.cloneRepo('jtpets/repo', 'feature/x', '/tmp/scratch-clone')
    ).not.toThrow();

    const cloneCalls = execFileSync.mock.calls.filter((c) => c[1][0] === 'clone');
    expect(cloneCalls).toHaveLength(2);
    expect(cloneCalls[0][1]).toContain('feature/x');
    // The fallback asks for main as its own argv element.
    expect(cloneCalls[1][1][3]).toBe('--branch');
    expect(cloneCalls[1][1][4]).toBe('main');
  });
});

// This is the executable form of the "no shell-string execution remains in
// cloneRepo" claim: it reads the function body out of the source and fails if a
// shell-executing call reappears there, so the guarantee cannot silently regress.
describe('cloneRepo contains no shell-string execution', () => {
  const clonePath = path.join(__dirname, '..', 'lib', 'clone-lifecycle.js');
  const source = fs.readFileSync(clonePath, 'utf8');

  const cloneRepoBody = () => {
    const start = source.indexOf('function cloneRepo(repo, branch, targetDir) {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\nfunction cleanupDir(', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  test('uses execFileSync and never execSync, exec or spawn with a shell', () => {
    const body = cloneRepoBody();
    expect(body).toContain('execFileSync(');
    expect(body).not.toMatch(/\bexecSync\s*\(/);
    expect(body).not.toMatch(/\bexec\s*\(/);
    expect(body).not.toMatch(/shell\s*:\s*true/);
  });

  test('validates repo and branch before running anything', () => {
    const body = cloneRepoBody();
    expect(body).toMatch(/assertValidRepo\(repo\)/);
    expect(body).toMatch(/assertValidBranch\(branch\)/);
  });
});
