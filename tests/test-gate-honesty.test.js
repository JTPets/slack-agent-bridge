'use strict';

/**
 * tests/test-gate-honesty.test.js
 *
 * THE enumerating guard for the class "a test invocation that can report a pass
 * without running assertions". Cite this file — not a count, not a grep run once —
 * when claiming the class is closed.
 *
 * LOGIC CHANGE 2026-09-14: New file. Part three of the autonomous-loop
 * prerequisites (docs/AUTONOMOUS-LOOP-DESIGN.md section 4).
 *
 * THE FAILURE IT EXISTS FOR, observed and reproducible: the post-task review ran
 * under an install that omitted development dependencies. `npm test` printed
 * "sh: 1: jest: not found" and exited 127 having executed ZERO assertions, and the
 * reviewer reported "Tests failed (1 failed, 0 passed)" — a sentence describing a
 * failing assertion that does not exist. Everyone who read it read a tooling
 * hiccup. Reproduce in any checkout with no node_modules: `npm test; echo $?`.
 *
 * TWO DIRECTIONS, because either alone is half a guard:
 *   1. CLASSIFICATION — lib/test-verdict.js distinguishes an absent runner, a
 *      non-zero exit before any assertion, a fully skipped suite, a timeout and a
 *      genuine pass. Asserted case by case below, each with the real runner output.
 *   2. ENUMERATION — every non-test .js file in the repo that invokes a test
 *      command routes its result through that classifier. Enumerated from disk, so
 *      a new invocation site is covered when it is added, not when somebody
 *      remembers to list it here.
 *
 * Comments are stripped before scanning; string literals are NOT, because the
 * command being invoked IS a string literal. That is the opposite choice from
 * tests/no-shell-execution.test.js's call-site scan, and it is deliberate — see
 * docs/CANONICAL-HELPERS.md, which records that the two scanners are separate.
 */

const fs = require('fs');
const path = require('path');

const { OUTCOME, classifyTestRun, parseAssertions, findingFor } = require('../lib/test-verdict');

const REPO_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'coverage', 'public', '.claude-home']);

/** Files allowed to invoke a test command. Each must route through the classifier. */
const CLASSIFIER = path.join('lib', 'test-verdict.js');

/** Does this source require lib/test-verdict.js directly? */
const IMPORTS_CLASSIFIER = /require\(['"][./]*[\w/.-]*test-verdict['"]\)/;

/**
 * Modules that route a test run through the classifier: the classifier itself, and
 * anything requiring it directly.
 *
 * One hop, deliberately. A file that invokes a test command satisfies the rule by
 * classifying the result itself OR by handing the run to a module that does -
 * bridge-agent.js names the script and delegates the run to validateOutput(). A
 * second hop would make the rule mean almost nothing; zero hops would force every
 * caller to import a module it does not use.
 *
 * @param {string[]} files - Repo-relative paths
 * @returns {Set<string>} Module basenames without .js
 */
function classifyingModules(files) {
    const names = new Set(['test-verdict']);
    for (const rel of files) {
        const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        if (IMPORTS_CLASSIFIER.test(stripComments(src))) {
            names.add(path.basename(rel, '.js'));
        }
    }
    return names;
}

/**
 * Does this source reach the classifier, directly or through one module that does?
 *
 * @param {string} code - Comment-stripped source
 * @param {Set<string>} classifiers
 * @returns {boolean}
 */
function reachesClassifier(code, classifiers) {
    if (IMPORTS_CLASSIFIER.test(code)) return true;
    for (const name of classifiers) {
        if (new RegExp(`require\\(['"][./]*[\\w/.-]*${name}['"]\\)`).test(code)) return true;
    }
    return false;
}

/**
 * Every non-test .js file in the repo, enumerated from disk.
 *
 * Reproduce from the shell with:
 *   find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*' \
 *          -not -path './tests/*' -not -path './coverage/*' | sort
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @returns {string[]} Repo-relative paths.
 */
function listSourceFiles(dir = REPO_ROOT, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            listSourceFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            out.push(path.relative(REPO_ROOT, full));
        }
    }
    return out;
}

/**
 * Blank out comments, preserving line structure so a reported line still points at
 * real code. String literals are left intact on purpose (see the module header).
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    const out = Array.from(src);
    const blank = (from, to) => {
        for (let k = from; k < to && k < out.length; k += 1) {
            if (out[k] !== '\n') out[k] = ' ';
        }
    };
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            const end = src.indexOf('\n', i);
            blank(i, end === -1 ? src.length : end);
            i = end === -1 ? src.length : end;
            continue;
        }
        if (c === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            const stop = end === -1 ? src.length : end + 2;
            blank(i, stop);
            i = stop;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            // Skip over the literal without blanking it.
            let k = i + 1;
            while (k < src.length) {
                if (src[k] === '\\') { k += 2; continue; }
                if (src[k] === c) break;
                k += 1;
            }
            i = k + 1;
            continue;
        }
        i += 1;
    }
    return out.join('');
}

/**
 * Does this source invoke a test command?
 *
 * Matches the shapes a test command actually takes here: an `npm test` / `npm run
 * test*` string, a bare runner name in an argv array, or a `testScript` value.
 *
 * @param {string} code - Comment-stripped source
 * @returns {string[]} The matched fragments (empty when none).
 */
function testInvocations(code) {
    const patterns = [
        /['"`]npm (?:run )?test[a-z:-]*['"`]/g,
        /['"`]test:smoke['"`]/g,
        /['"`](?:jest|mocha|vitest|ava)['"`]/g,
        // An argv array: spawnSync('npm', ['test']) / ('npm', ['run', 'test:smoke'])
        /['"`]npm['"`]\s*,\s*\[[^\]]*['"`](?:run['"`]\s*,\s*['"`])?test/g,
        /testScript/g,
    ];
    const hits = [];
    for (const p of patterns) {
        for (const m of code.matchAll(p)) hits.push(m[0]);
    }
    return hits;
}

describe('the classifier tells apart every way a test run can end', () => {
    test('an absent runner is absence, not a failing assertion', () => {
        // The observed case, verbatim.
        const v = classifyTestRun({ command: 'npm test', exitCode: 127, stderr: 'sh: 1: jest: not found\n' });
        expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        expect(v.green).toBe(false);
        expect(v.ran).toBe(false);
        expect(v.assertions).toBeNull();
        // It must NOT claim a failed test count it cannot know.
        expect(v.reason).not.toMatch(/1 failed/);
    });

    test('a spawn ENOENT is absence', () => {
        const v = classifyTestRun({ exitCode: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
        expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        expect(v.ran).toBe(false);
    });

    test('npm with no such script is absence', () => {
        const v = classifyTestRun({ exitCode: 1, stderr: 'npm error Missing script: "test"\n' });
        expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        expect(v.ran).toBe(false);
    });

    test('a non-zero exit BEFORE any assertion is not a test failure', () => {
        // A config error, a module that will not load: the runner started and died.
        const v = classifyTestRun({ exitCode: 1, stderr: 'Cannot find module "./missing"\n' });
        expect(v.outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(v.ran).toBe(false);
        expect(v.green).toBe(false);
    });

    test('exit 0 with no assertion count is not a pass', () => {
        expect(classifyTestRun({ exitCode: 0, stdout: '' }).outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(classifyTestRun({ exitCode: 0, stdout: 'No tests found, exiting with code 0\n' }).outcome)
            .toBe(OUTCOME.NO_ASSERTIONS);
        // `true`, the shell builtin, is the smallest possible dishonest green.
        expect(classifyTestRun({ command: 'true', exitCode: 0, stdout: '' }).green).toBe(false);
    });

    test('a suite that skipped everything is not a pass', () => {
        const v = classifyTestRun({ exitCode: 0, stdout: 'Tests:       5 skipped, 5 total\n' });
        expect(v.outcome).toBe(OUTCOME.NO_ASSERTIONS);
        expect(v.green).toBe(false);
        expect(v.reason).toMatch(/skipped/);
    });

    test('a suite with some skipped and some run IS a pass', () => {
        const v = classifyTestRun({ exitCode: 0, stdout: 'Tests:       2 skipped, 3 passed, 5 total\n' });
        expect(v.outcome).toBe(OUTCOME.PASSED);
        expect(v.assertions.passed).toBe(3);
    });

    test('a timeout is a failure with no verdict, not a pass and not a failure count', () => {
        const v = classifyTestRun({ exitCode: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
        expect(v.outcome).toBe(OUTCOME.TIMED_OUT);
        expect(v.green).toBe(false);
        expect(v.ran).toBe(false);
    });

    test('a genuine failure is a genuine failure, with the real counts', () => {
        const v = classifyTestRun({ exitCode: 1, stdout: 'Tests:       2 failed, 3 passed, 5 total\n' });
        expect(v.outcome).toBe(OUTCOME.FAILED);
        expect(v.ran).toBe(true);
        expect(v.assertions).toMatchObject({ failed: 2, passed: 3, total: 5 });
    });

    test('a genuine pass is the only green, and it names its count', () => {
        const v = classifyTestRun({ exitCode: 0, stdout: 'Tests:       1840 passed, 1840 total\n' });
        expect(v.outcome).toBe(OUTCOME.PASSED);
        expect(v.green).toBe(true);
        expect(v.assertions.passed).toBe(1840);
    });

    test('exit 0 with failures counted trusts the count, not the exit code', () => {
        const v = classifyTestRun({ exitCode: 0, stdout: 'Tests:       1 failed, 1 passed, 2 total\n' });
        expect(v.outcome).toBe(OUTCOME.FAILED);
    });

    test('every non-green outcome produces a finding with a stable rule id', () => {
        const nonGreen = [
            classifyTestRun({ exitCode: 127, stderr: 'jest: not found' }),
            classifyTestRun({ exitCode: 0, stdout: '' }),
            classifyTestRun({ exitCode: 1, stdout: 'Tests:       1 failed, 0 passed, 1 total\n' }),
            classifyTestRun({ exitCode: null, error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }),
        ];
        for (const v of nonGreen) {
            const finding = findingFor(v);
            expect(finding).not.toBeNull();
            expect(finding.ruleId).toMatch(/^TEST_/);
            expect(finding.severity).toBe('blocking');
        }
        expect(findingFor(classifyTestRun({ exitCode: 0, stdout: 'Tests: 1 passed, 1 total\n' }))).toBeNull();
    });

    test('mocha and node --test formats are recognised too', () => {
        expect(parseAssertions('  12 passing (30ms)\n').passed).toBe(12);
        expect(parseAssertions('# pass 7\n# fail 0\n').passed).toBe(7);
    });
});

describe('every test invocation in the repo routes through the classifier', () => {
    test('the walk found the files it is supposed to cover', () => {
        const files = listSourceFiles();
        expect(files).toEqual(expect.arrayContaining([
            'bridge-agent.js',
            path.join('lib', 'code-review-pipeline.js'),
            path.join('lib', 'update-verifier.js'),
        ]));
        expect(files.length).toBeGreaterThan(30);
    });

    test('no file invokes a test command without routing it through lib/test-verdict.js', () => {
        const files = listSourceFiles();
        const classifiers = classifyingModules(files);
        const offenders = [];
        for (const rel of files) {
            if (rel === CLASSIFIER) continue;
            const code = stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
            const hits = testInvocations(code);
            if (hits.length === 0) continue;
            if (!reachesClassifier(code, classifiers)) {
                offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('the classifying modules are the two that actually run a suite', () => {
        // Anchors the one-hop rule: if this set grows, a new module started running
        // tests and the enumeration above must be re-read, not assumed.
        const names = [...classifyingModules(listSourceFiles())].sort();
        expect(names).toEqual(['code-review-pipeline', 'test-verdict', 'update-verifier']);
    });

    test('the known invocation sites are still the known invocation sites', () => {
        // Anchors the check above: if this list shrinks to nothing the guard is
        // scanning for a pattern that no longer occurs, and would pass vacuously.
        const sites = listSourceFiles().filter((rel) => {
            if (rel === CLASSIFIER) return false;
            return testInvocations(stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'))).length > 0;
        }).sort();
        expect(sites).toEqual([
            'bridge-agent.js',
            path.join('lib', 'code-review-pipeline.js'),
            path.join('lib', 'update-verifier.js'),
        ]);
    });
});

describe('the guard itself detects what it claims to', () => {
    // Negative controls. Without these the two checks above could be green because
    // they compared empty sets — the exact failure this whole file is about.

    test('a file that invokes a test command without the classifier IS reported', () => {
        const code = stripComments("const { spawnSync } = require('child_process');\nspawnSync('npm', ['test']);\n");
        expect(testInvocations(code).length).toBeGreaterThan(0);
        expect(reachesClassifier(code, new Set(['test-verdict']))).toBe(false);
    });

    test('a file that invokes one AND imports the classifier is NOT reported', () => {
        const code = stripComments("const { classifyTestRun } = require('./test-verdict');\nspawnSync('npm', ['run', 'test:smoke']);\n");
        expect(testInvocations(code).length).toBeGreaterThan(0);
        expect(reachesClassifier(code, new Set(['test-verdict']))).toBe(true);
    });

    test('one hop counts: delegating to a classifying module is NOT reported', () => {
        const code = stripComments("const { validateOutput } = require('./lib/code-review-pipeline');\nvalidateOutput(d, { testScript: 'npm test' });\n");
        expect(testInvocations(code).length).toBeGreaterThan(0);
        expect(reachesClassifier(code, new Set(['test-verdict', 'code-review-pipeline']))).toBe(true);
    });

    test('two hops do NOT count — the rule is not vacuous', () => {
        const code = stripComments("const x = require('./some-unrelated-module');\nspawnSync('npm', ['test']);\n");
        expect(reachesClassifier(code, new Set(['test-verdict', 'code-review-pipeline']))).toBe(false);
    });

    test('prose in a comment naming a test command does not trip the scan', () => {
        const code = stripComments("// we used to run 'npm test' and 'jest' here\nconst x = 1;\n");
        expect(testInvocations(code)).toEqual([]);
    });

    test('a string literal naming the command DOES trip it — strings are not blanked', () => {
        const code = stripComments("const cmd = 'npm test';\n");
        expect(testInvocations(code)).toEqual(["'npm test'"]);
    });
});
