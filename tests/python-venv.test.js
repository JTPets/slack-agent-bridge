'use strict';

/**
 * tests/python-venv.test.js
 *
 * WORK-TODO #68, the venv half: a python clone installs into `.venv/` inside the clone,
 * never system-wide (PEP 668), `.venv/` is excluded locally so the clone does not read as
 * holding uncommitted work, and a venv that cannot be created is INSTALLER_ABSENT.
 * The real-python test needs `python3 -m venv` on the machine running the suite (the
 * deployed image lacks ensurepip, which is exactly the INSTALLER_ABSENT case below).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createVenv, excludeVenv, venvPython } = require('../lib/python-venv');
const { installDependencies, OUTCOME } = require('../lib/dependency-install');

const made = [];
function gitRepo(files = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-'));
  made.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
  execFileSync('git', ['add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: d });
  return d;
}
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const ok = { status: 0, stdout: '', stderr: '' };

describe('the venv is excluded locally', () => {
  test('excludeVenv writes /.venv/ once, keeping existing lines', () => {
    const d = gitRepo();
    fs.writeFileSync(path.join(d, '.git', 'info', 'exclude'), '# existing');
    excludeVenv(d);
    excludeVenv(d);
    const text = fs.readFileSync(path.join(d, '.git', 'info', 'exclude'), 'utf8');
    expect(text.split('\n').filter((l) => l === '/.venv/')).toHaveLength(1);
    expect(text).toMatch(/^# existing\n/);
  });

  test('negative control: without the exclude an untracked .venv makes the clone look dirty', () => {
    const d = gitRepo();
    fs.mkdirSync(path.join(d, '.venv'));
    fs.writeFileSync(path.join(d, '.venv', 'x'), '');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: d }).toString()).toMatch(/\.venv/);
    excludeVenv(d);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: d }).toString()).toBe('');
  });
});

describe('installDependencies for a python clone', () => {
  test('creates the venv first, then runs pip with the VENV interpreter, never system python3 -m pip', () => {
    const d = gitRepo({ 'requirements.txt': 'pytest\n' });
    const calls = [];
    const r = installDependencies(d, { run: (cmd, args) => { calls.push([cmd, ...args]); return ok; } });
    expect(r.outcome).toBe(OUTCOME.INSTALLED);
    expect(calls[0]).toEqual(['python3', '-m', 'venv', '.venv']);
    expect(calls[1]).toEqual([venvPython(d), '-m', 'pip', 'install', '-r', 'requirements.txt']);
    expect(calls.some((c) => c[0] === 'python3' && c[2] === 'pip')).toBe(false);
  });

  test('a venv that cannot be created (no ensurepip) is INSTALLER_ABSENT, and pip is never run', () => {
    const d = gitRepo({ 'setup.py': '' });
    const calls = [];
    const r = installDependencies(d, {
      run: (cmd, args) => {
        calls.push(cmd);
        return { status: 1, stdout: '', stderr: 'The virtual environment was not created successfully because ensurepip is not available.' };
      },
    });
    expect(r.outcome).toBe(OUTCOME.INSTALLER_ABSENT);
    expect(r.harnessFailure).toBe(true);
    expect(r.reason).toMatch(/python3-venv/);
    expect(calls).toEqual(['python3']);
  });

  test('a venv creation that times out is TIMED_OUT', () => {
    const d = gitRepo({ 'requirements.txt': '' });
    const r = installDependencies(d, { run: () => ({ status: null, error: { code: 'ETIMEDOUT' } }) });
    expect(r.outcome).toBe(OUTCOME.TIMED_OUT);
  });

  test('a pip failure inside a created venv is still INSTALL_FAILED (the repo, not the image)', () => {
    const d = gitRepo({ 'requirements.txt': 'nope\n' });
    let n = 0;
    const r = installDependencies(d, { run: () => (n++ === 0 ? ok : { status: 1, stdout: '', stderr: 'ERROR: No matching distribution found for nope' }) });
    expect(r.outcome).toBe(OUTCOME.INSTALL_FAILED);
  });
});

// No conditional skip: a skipped real-python test would be a skip-green. A machine
// without `python3 -m venv` fails here, which says so.
test('for real: an empty requirements.txt installs into .venv and the clone stays clean', () => {
  const d = gitRepo({ 'requirements.txt': '' });
  const r = installDependencies(d, { timeoutMs: 120000 });
  expect(r.outcome).toBe(OUTCOME.INSTALLED);
  expect(fs.existsSync(venvPython(d))).toBe(true);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: d }).toString()).toBe('');
}, 180000);

test('createVenv with no .git dir still creates (nothing to exclude) and reports the interpreter', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'venv-nogit-'));
  made.push(d);
  expect(createVenv(d, () => ok, 1000)).toEqual({ ok: true, python: venvPython(d) });
});
