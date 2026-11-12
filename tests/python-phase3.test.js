'use strict';

/**
 * tests/python-phase3.test.js
 *
 * WORK-TODO #68, the Phase-3 half: a python clone's tests are RUN and classified honestly.
 * Before 2026-11-12 Phase 3 ran only the npm test script, so a python clone with a
 * working venv was scored RUNNER_ABSENT every time, and lib/test-verdict.js could not
 * read a pytest summary at all (a real pytest pass classified NO_ASSERTIONS).
 *
 * Real python, real venv, real pytest, installed by the REAL install step
 * (lib/dependency-install.js) from a requirements.txt that names pytest, then judged by
 * the REAL validateOutput. That install reaches PyPI. No conditional skip: a machine
 * without `python3 -m venv` or without network fails here and says so, because a skipped
 * real-python test would be a skip-green (same rule as tests/python-venv.test.js).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { installDependencies, OUTCOME: INSTALL } = require('../lib/dependency-install');
const { validateOutput } = require('../lib/code-review-pipeline');
const { pythonTestCommand, PYTEST_ARGS } = require('../lib/python-test-command');
const { classifyTestRun, parseAssertions, OUTCOME } = require('../lib/test-verdict');
const { venvPython } = require('../lib/python-venv');

const made = [];
function gitRepo(files = {}) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'py3-'));
    made.push(d);
    execFileSync('git', ['init', '-q'], { cwd: d });
    writeFiles(d, files);
    commit(d);
    return d;
}
function writeFiles(d, files) {
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
        fs.writeFileSync(path.join(d, f), c);
    }
}
function commit(d) {
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'c'], { cwd: d });
}
function setTests(d, body) {
    fs.rmSync(path.join(d, 'tests'), { recursive: true, force: true });
    writeFiles(d, { 'tests/test_suite.py': body });
    commit(d);
}
const porcelain = (d) => execFileSync('git', ['status', '--porcelain'], { cwd: d }).toString();
afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const PASSING = 'def test_one():\n    assert 1 == 1\n\ndef test_two():\n    assert "a" in "abc"\n';
const FAILING = 'def test_ok():\n    assert True\n\ndef test_broken():\n    assert 1 == 2\n';
const SKIP_ONLY = 'import pytest\n\n@pytest.mark.skip(reason="later")\ndef test_a():\n    assert False\n\n'
    + '@pytest.mark.skip(reason="later")\ndef test_b():\n    assert False\n';
const PLAN = { testScript: 'npm test' };

describe('for real: a python clone with pytest in its venv', () => {
    let repo;

    beforeAll(() => {
        repo = gitRepo({ 'requirements.txt': 'pytest\n', 'tests/test_suite.py': PASSING });
        const install = installDependencies(repo, { timeoutMs: 240000 });
        if (install.outcome !== INSTALL.INSTALLED) {
            throw new Error(`pytest could not be installed into the fixture venv (${install.outcome}): ${install.reason}\n${install.output}`);
        }
    }, 300000);

    test('a passing suite is PASSED with its real count, by the venv pytest', () => {
        setTests(repo, PASSING);
        const v = validateOutput(repo, PLAN);
        expect(v.testCommand).toBe(`.venv/bin/python ${PYTEST_ARGS.join(' ')}`);
        expect(v.testRun.outcome).toBe(OUTCOME.PASSED);
        expect(v.testRun.assertions).toMatchObject({ runner: 'pytest', passed: 2, failed: 0 });
        expect(v.passed).toBe(true);
    }, 120000);

    test('a failing suite is FAILED with the real counts', () => {
        setTests(repo, FAILING);
        const v = validateOutput(repo, PLAN);
        expect(v.testRun.outcome).toBe(OUTCOME.FAILED);
        expect(v.testRun.assertions).toMatchObject({ passed: 1, failed: 1 });
        expect(v.passed).toBe(false);
    }, 120000);

    test('a suite of only skips is NOT a pass', () => {
        setTests(repo, SKIP_ONLY);
        const v = validateOutput(repo, PLAN);
        expect(v.testRun.outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(v.testRun.green).toBe(false);
        expect(v.testRun.assertions).toMatchObject({ skipped: 2, passed: 0 });
    }, 120000);

    test('no tests at all is NOT a pass', () => {
        fs.rmSync(path.join(repo, 'tests'), { recursive: true, force: true });
        commit(repo);
        const v = validateOutput(repo, PLAN);
        expect(v.testRun.outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(v.passed).toBe(false);
    }, 120000);

    test('the run leaves the clone clean, so a delivered task is not preserved as undelivered', () => {
        setTests(repo, PASSING);
        validateOutput(repo, PLAN);
        expect(porcelain(repo)).toBe('');
    }, 120000);

    test('negative control: pytest without the cache flag and the bytecode switch dirties the clone', () => {
        setTests(repo, PASSING);
        spawnSync(venvPython(repo), ['-m', 'pytest'], { cwd: repo, encoding: 'utf8' });
        expect(porcelain(repo)).toMatch(/__pycache__|\.pytest_cache/);
        fs.rmSync(path.join(repo, '.pytest_cache'), { recursive: true, force: true });
        execFileSync('git', ['clean', '-fdxq', '-e', '.venv'], { cwd: repo });
    }, 120000);
});

describe('a python clone that cannot run pytest is RUNNER_ABSENT, never a pass or a failure', () => {
    test('a venv without pytest', () => {
        const repo = gitRepo({ 'requirements.txt': '' });
        expect(installDependencies(repo, { timeoutMs: 120000 }).outcome).toBe(INSTALL.INSTALLED);
        const v = validateOutput(repo, PLAN);
        expect(v.testRun.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        expect(v.testRun.ran).toBe(false);
    }, 180000);

    test('no venv at all (the spawn is ENOENT)', () => {
        const repo = gitRepo({ 'setup.py': '' });
        const v = validateOutput(repo, PLAN);
        expect(v.testCommand).toMatch(/^\.venv\/bin\/python -m pytest/);
        expect(v.testRun.outcome).toBe(OUTCOME.RUNNER_ABSENT);
    });
});

describe('node repos are unchanged', () => {
    test('a repo with package.json (and a python manifest) runs the plan\'s script, not pytest', () => {
        const repo = gitRepo({ 'package.json': '{}', 'requirements.txt': '' });
        expect(pythonTestCommand(repo)).toBeNull();
        const v = validateOutput(repo, { testScript: 'true' });
        expect(v.testCommand).toBe('true');
    });

    test('pythonTestCommand is an argv with the venv interpreter for a python repo', () => {
        const repo = gitRepo({ 'pyproject.toml': '' });
        const cmd = pythonTestCommand(repo);
        expect(cmd.command).toBe(venvPython(repo));
        expect(cmd.args).toEqual(['-m', 'pytest', '-p', 'no:cacheprovider']);
        expect(cmd.env.PYTHONDONTWRITEBYTECODE).toBe('1');
        expect(pythonTestCommand(path.join(os.tmpdir(), 'does-not-exist-py3'))).toBeNull();
    });
});

describe('the pytest summary under the classifier\'s honesty rules', () => {
    const run = (stdout, exitCode) => classifyTestRun({ command: 'pytest', exitCode, stdout });

    test('the shapes pytest prints', () => {
        expect(parseAssertions('===== 3 passed, 1 failed, 2 skipped in 0.12s =====\n'))
            .toMatchObject({ runner: 'pytest', passed: 3, failed: 1, skipped: 2, total: 6 });
        expect(parseAssertions('1 failed, 3 passed in 1.01s\n')).toMatchObject({ passed: 3, failed: 1 });
        expect(parseAssertions('==== 2 passed, 1 warning in 0.01s ====\n')).toMatchObject({ passed: 2, total: 2 });
        expect(parseAssertions('= 1 passed, 2 errors in 0.3s =\n')).toMatchObject({ passed: 1, failed: 2 });
        expect(parseAssertions('no tests ran in 0.01s\n')).toMatchObject({ total: 0 });
    });

    test('a pass is exit 0 with a positive count', () => {
        expect(run('==== 4 passed in 1.02s ====\n', 0).outcome).toBe(OUTCOME.PASSED);
    });

    test('only skips, only expected failures, or nothing collected is not a pass', () => {
        expect(run('5 skipped in 0.01s\n', 0).outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(run('2 xfailed in 0.01s\n', 0).outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(run('no tests ran in 0.01s\n', 5).outcome).toBe(OUTCOME.NO_ASSERTIONS);
    });

    test('a collection error is a failure', () => {
        expect(run('1 error in 0.10s\n', 2).outcome).toBe(OUTCOME.FAILED);
    });

    test('an absent pytest is RUNNER_ABSENT, but a test importing a missing module is not', () => {
        expect(classifyTestRun({ exitCode: 1, stderr: '/c/.venv/bin/python: No module named pytest\n' }).outcome)
            .toBe(OUTCOME.RUNNER_ABSENT);
        const importErr = "E   ModuleNotFoundError: No module named 'requests'\n= 1 error in 0.05s =\n";
        expect(classifyTestRun({ exitCode: 2, stdout: importErr }).outcome).toBe(OUTCOME.FAILED);
    });

    test('jest and mocha output is not read as pytest', () => {
        expect(parseAssertions('Tests:       3 passed, 3 total\n').runner).toBe('jest');
        expect(parseAssertions('  12 passing (30ms)\n').runner).toBe('mocha');
    });
});
