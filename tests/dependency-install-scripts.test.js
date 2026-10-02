'use strict';

/**
 * tests/dependency-install-scripts.test.js
 *
 * THE guard that a scratch clone's npm install runs NO lifecycle script — proven against
 * the REAL lib/dependency-install.js and REAL npm, not a stub.
 *
 * LOGIC CHANGE 2026-10-02: New file. Split from tests/dependency-install.test.js, which
 * this describe would have taken past the 300-line gate (lib/file-size-gate.js). The
 * temp-dir helper below duplicates that file's `tempRepos` (ten lines, identical shape);
 * duplication acknowledged and deferred to WORK-TODO #36's tests/helpers/ question.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { OUTCOME, installDependencies, defaultRun } = require('../lib/dependency-install');

function tempRepos() {
    const dirs = [];
    return {
        make() {
            const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-scripts-'));
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

// LOGIC CHANGE 2026-10-02: install scripts are OFF in a scratch clone. Proven against
// the REAL module and REAL npm: a package whose postinstall writes a marker file. Before
// the change both paths ran it (this describe failed 2 of 2); the marker must not exist.
// Temp dirs live under os.tmpdir(), never inside the repo (the walker intermittent in
// WORK-TODO #56/#36), and are removed in afterEach.
describe('a branch\'s install scripts do not run (real npm, real module)', () => {
    const repos = tempRepos();
    afterEach(() => repos.cleanup());
    jest.setTimeout(90000);

    const MARKER = 'postinstall-ran';

    function scriptedRepo() {
        const d = repos.make();
        const script = `node -e "require('fs').writeFileSync('${MARKER}','x')"`;
        fs.writeFileSync(
            path.join(d, 'package.json'),
            JSON.stringify({
                name: 'scripted',
                version: '1.0.0',
                scripts: { preinstall: script, install: script, postinstall: script, prepare: script },
            })
        );
        return d;
    }

    test('no lockfile -> `npm install --ignore-scripts`: installed, and the postinstall did not run', () => {
        const d = scriptedRepo();
        const r = installDependencies(d);
        expect(r.outcome).toBe(OUTCOME.INSTALLED);
        expect(r.command).toBe('npm install --ignore-scripts');
        expect(fs.existsSync(path.join(d, MARKER))).toBe(false);
    });

    test('lockfile -> `npm ci --ignore-scripts`: installed, and the postinstall did not run', () => {
        const d = scriptedRepo();
        // --package-lock-only alone still runs the root's lifecycle scripts (observed on
        // npm 10.9), so the lockfile is written with scripts off too.
        defaultRun('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], d, 60000);
        expect(fs.existsSync(path.join(d, 'package-lock.json'))).toBe(true);
        expect(fs.existsSync(path.join(d, MARKER))).toBe(false);

        const r = installDependencies(d);
        expect(r.outcome).toBe(OUTCOME.INSTALLED);
        expect(r.command).toBe('npm ci --ignore-scripts');
        expect(fs.existsSync(path.join(d, MARKER))).toBe(false);
    });

    test('NEGATIVE CONTROL: the same package WITHOUT the flag does write the marker', () => {
        // Proves the fixture's script really runs under npm here, so the two tests above
        // are not passing because the script was never runnable.
        const d = scriptedRepo();
        const r = defaultRun('npm', ['install', '--no-audit', '--no-fund'], d, 60000);
        expect(r.status).toBe(0);
        expect(fs.existsSync(path.join(d, MARKER))).toBe(true);
    });
});
