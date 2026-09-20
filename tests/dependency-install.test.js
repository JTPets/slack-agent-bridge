'use strict';

/**
 * tests/dependency-install.test.js
 *
 * Tests for lib/dependency-install.js — the scratch-clone dependency install that
 * makes Phase-3 verification real (WORK-TODO #61).
 *
 * THE THREE OUTCOMES this exists to keep distinct (task decision 4) are each proven by a
 * test that PRODUCES it, against a real installer and a real test runner where it matters:
 *   - install failed         -> HARNESS failure (a real out-of-sync `npm ci`)
 *   - tests ran and failed   -> CODE failure    (a real `npm ci` then a failing `node --test`)
 *   - tests ran and passed   -> pass            (a real `npm ci` then a passing `node --test`)
 * The spawn-level failures that cannot be produced offline without flakiness
 * (installer-absent, timeout) are produced deterministically through the injected runner,
 * the same pattern lib/update-verifier.js uses for its smoke runner.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    OUTCOME,
    INSTALL_TIMEOUT_MS,
    detectEcosystem,
    installDependencies,
    defaultRun,
} = require('../lib/dependency-install');
const { validateOutput } = require('../lib/code-review-pipeline');

/** A temp directory removed after each test that registers it. */
function tempRepos() {
    const dirs = [];
    return {
        make() {
            const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-install-'));
            dirs.push(d);
            return d;
        },
        cleanup() {
            for (const d of dirs) {
                try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
            }
            dirs.length = 0;
        },
    };
}

// A fake spawnSync return for the injected runner.
const fakeRun = (ret) => () => ({ status: null, error: null, stdout: '', stderr: '', ...ret });

describe('detectEcosystem', () => {
    const repos = tempRepos();
    afterEach(() => repos.cleanup());

    test('package.json + lockfile -> node, npm ci', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'package.json'), '{}');
        fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
        const e = detectEcosystem(d);
        expect(e.ecosystem).toBe('node');
        expect(e.command).toBe('npm');
        expect(e.args[0]).toBe('ci');
    });

    test('package.json without a lockfile -> node, npm install', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'package.json'), '{}');
        const e = detectEcosystem(d);
        expect(e.ecosystem).toBe('node');
        expect(e.args[0]).toBe('install');
    });

    test('npm-shrinkwrap.json counts as a lockfile -> npm ci', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'package.json'), '{}');
        fs.writeFileSync(path.join(d, 'npm-shrinkwrap.json'), '{}');
        expect(detectEcosystem(d).args[0]).toBe('ci');
    });

    test('requirements.txt -> python, python3 -m pip install -r', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'requirements.txt'), 'pytest\n');
        const e = detectEcosystem(d);
        expect(e.ecosystem).toBe('python');
        expect(e.command).toBe('python3');
        expect(e.display).toBe('python3 -m pip install -r requirements.txt');
    });

    test('pyproject.toml -> python, pip install .', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname="x"\n');
        const e = detectEcosystem(d);
        expect(e.ecosystem).toBe('python');
        expect(e.display).toBe('python3 -m pip install .');
    });

    test('node wins over python when both manifests exist', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'package.json'), '{}');
        fs.writeFileSync(path.join(d, 'requirements.txt'), 'pytest\n');
        expect(detectEcosystem(d).ecosystem).toBe('node');
    });

    test('no recognised manifest -> none', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'README.md'), '# docs only\n');
        expect(detectEcosystem(d).ecosystem).toBe('none');
    });
});

describe('installDependencies classification (deterministic, injected runner)', () => {
    const repos = tempRepos();
    afterEach(() => repos.cleanup());

    function nodeRepo() {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x","version":"1.0.0"}');
        fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
        return d;
    }

    test('a repo with no manifest is NOT a failure — nothing to install, task proceeds', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'README.md'), '# docs\n');
        const r = installDependencies(d, { run: fakeRun({ status: 0 }) });
        expect(r.outcome).toBe(OUTCOME.NO_MANIFEST);
        expect(r.ok).toBe(true);
        expect(r.ran).toBe(false);
        expect(r.harnessFailure).toBe(false);
    });

    test('exit 0 -> INSTALLED (ran, ok, not a harness failure)', () => {
        const r = installDependencies(nodeRepo(), { run: fakeRun({ status: 0, stdout: 'up to date' }) });
        expect(r.outcome).toBe(OUTCOME.INSTALLED);
        expect(r.ran).toBe(true);
        expect(r.ok).toBe(true);
        expect(r.harnessFailure).toBe(false);
    });

    test('exit non-zero -> INSTALL_FAILED, a HARNESS failure that ran', () => {
        const r = installDependencies(nodeRepo(), { run: fakeRun({ status: 1, stderr: 'ERESOLVE' }) });
        expect(r.outcome).toBe(OUTCOME.INSTALL_FAILED);
        expect(r.ran).toBe(true);
        expect(r.ok).toBe(false);
        expect(r.harnessFailure).toBe(true);
    });

    test('ENOENT -> INSTALLER_ABSENT, a HARNESS failure that did not run', () => {
        const r = installDependencies(nodeRepo(), {
            run: fakeRun({ status: null, error: { code: 'ENOENT' } }),
        });
        expect(r.outcome).toBe(OUTCOME.INSTALLER_ABSENT);
        expect(r.ran).toBe(false);
        expect(r.ok).toBe(false);
        expect(r.harnessFailure).toBe(true);
    });

    test('python with no pip module -> INSTALLER_ABSENT (a clear refusal, not INSTALL_FAILED)', () => {
        const d = repos.make();
        fs.writeFileSync(path.join(d, 'requirements.txt'), 'pytest\n');
        const r = installDependencies(d, {
            run: fakeRun({ status: 1, stderr: '/usr/bin/python3: No module named pip\n' }),
        });
        expect(r.outcome).toBe(OUTCOME.INSTALLER_ABSENT);
        expect(r.harnessFailure).toBe(true);
        expect(r.ecosystem).toBe('python');
    });

    test('ETIMEDOUT -> TIMED_OUT, its own HARNESS outcome, distinct from a failed install', () => {
        const r = installDependencies(nodeRepo(), {
            run: fakeRun({ status: null, error: { code: 'ETIMEDOUT' } }),
            timeoutMs: 1000,
        });
        expect(r.outcome).toBe(OUTCOME.TIMED_OUT);
        expect(r.harnessFailure).toBe(true);
        expect(r.reason).toMatch(/INSTALL_TIMEOUT_MS/);
    });

    test('INSTALL_TIMEOUT_MS default is 5 minutes', () => {
        expect(INSTALL_TIMEOUT_MS).toBe(300000);
    });
});

// The three outcomes, produced for real. These run a real npm ci and, for two of them, a
// real node --test suite (no dependencies, so it is offline and fast). node 20's test
// runner emits TAP when stdout is not a TTY, which lib/test-verdict.js parses.
describe('the three outcomes, produced against a real installer and runner', () => {
    const repos = tempRepos();
    afterEach(() => repos.cleanup());
    jest.setTimeout(90000);

    // A node repo whose deps really install offline (zero dependencies, valid lockfile).
    function installableRepo(testFileBody) {
        const d = repos.make();
        fs.writeFileSync(
            path.join(d, 'package.json'),
            JSON.stringify({ name: 'probe', version: '1.0.0', scripts: { test: 'node --test' } })
        );
        // Create a lockfile that is IN SYNC by asking npm to write one (offline, no deps).
        defaultRun('npm', ['install', '--no-audit', '--no-fund', '--package-lock-only'], d, 60000);
        if (testFileBody) fs.writeFileSync(path.join(d, 'thing.test.js'), testFileBody);
        return d;
    }

    const PASSING_SUITE =
        "const test=require('node:test');const a=require('node:assert');\n" +
        "test('one plus one', () => { a.strictEqual(1 + 1, 2); });\n";
    const FAILING_SUITE =
        "const test=require('node:test');const a=require('node:assert');\n" +
        "test('deliberately wrong', () => { a.strictEqual(1 + 1, 3); });\n";

    test('HARNESS: a real out-of-sync `npm ci` fails and is classified INSTALL_FAILED', () => {
        const d = repos.make();
        // A dependency in package.json that the lockfile does not describe -> `npm ci`
        // refuses, offline, exactly as a broken clone would.
        fs.writeFileSync(
            path.join(d, 'package.json'),
            '{"name":"c","version":"1.0.0","dependencies":{"left-pad":"^1.0.0"}}'
        );
        fs.writeFileSync(
            path.join(d, 'package-lock.json'),
            '{"name":"c","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"c","version":"1.0.0"}}}'
        );
        const r = installDependencies(d);
        expect(r.outcome).toBe(OUTCOME.INSTALL_FAILED);
        expect(r.harnessFailure).toBe(true);
        expect(r.command).toBe('npm ci');
    });

    test('PASS: a real install then a passing `node --test` -> validateOutput passes', () => {
        const d = installableRepo(PASSING_SUITE);
        const install = installDependencies(d);
        expect(install.outcome).toBe(OUTCOME.INSTALLED);

        const validation = validateOutput(d, { testScript: 'node --test' });
        expect(validation.testRun.outcome).toBe('passed');
        expect(validation.passed).toBe(true);
        expect(validation.testsPassed).toBeGreaterThan(0);
    });

    test('CODE: a passing install then a failing `node --test` -> validateOutput fails on the CODE', () => {
        const d = installableRepo(FAILING_SUITE);
        const install = installDependencies(d);
        expect(install.outcome).toBe(OUTCOME.INSTALLED);
        expect(install.harnessFailure).toBe(false);

        const validation = validateOutput(d, { testScript: 'node --test' });
        expect(validation.testRun.outcome).toBe('failed');
        expect(validation.passed).toBe(false);
        expect(validation.testsFailed).toBeGreaterThan(0);
    });
});
