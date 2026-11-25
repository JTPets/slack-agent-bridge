'use strict';

/**
 * lib/review-validate.js
 *
 * Phase 3 of the code-review pipeline: after the model has run, run the clone's tests
 * and check the files it changed. validateOutput is the hub; its steps are runTestGate
 * (the test command, classified by lib/test-verdict.js), changedFilesOf (what changed)
 * and checkChangedFile (the per-file rules). Every check produces a structured finding
 * (lib/review-findings.js), and the result's prose is generated from the findings.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved out of lib/code-review-pipeline.js,
 * which re-exports validateOutput. The single body was cut into the steps above; the
 * result object, the findings and their order are unchanged.
 */

const fs = require('fs');
const path = require('path');
const { makeFinding, buildVerdict } = require('./review-findings');
const { classifyTestRun, findingFor } = require('./test-verdict');
const { pythonTestCommand } = require('./python-test-command');
const { runCommand } = require('./pipeline-command');

// The test command's limit: five minutes.
const TEST_TIMEOUT_MS = 300000;

// The test command when the repo's package.json names none. One constant, read by
// createExecutionPlan (lib/review-context.js) and by runTestGate's fallback, which
// were two copies of the literal before B37.
const DEFAULT_TEST_SCRIPT = 'npm test';

/**
 * Run the repo's test command and classify the run.
 *
 * LOGIC CHANGE 2026-09-14: the outcome is classified by lib/test-verdict.js
 * instead of being branched on here. The old code read `exitCode !== 0` as "the
 * suite failed" and `exitCode === 0` as "the suite passed", and both readings
 * are wrong in the cases that matter: a missing runner exits 127 having run
 * nothing and was reported as "1 failed", while a command that exits 0 without
 * running anything was reported as a pass with zero tests. A pass now requires
 * exit 0 AND a positive parsed assertion count.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #68, Phase-3 half): a python clone runs its
 * venv's pytest instead (lib/python-test-command.js), classified by the same
 * classifier. Before, it ran the npm script and every python task was RUNNER_ABSENT.
 * A node clone is never python there, so its command is unchanged.
 *
 * @param {string} repoDir
 * @param {Object} plan
 * @returns {{ testCommand: string, testOutput: string, testRun: Object }}
 */
function runTestGate(repoDir, plan) {
    const py = pythonTestCommand(repoDir);
    const testScript = py ? py.display : (plan?.testScript || DEFAULT_TEST_SCRIPT);
    const [testCmd, ...testArgs] = py ? [py.command, ...py.args] : testScript.split(' ');
    const testResult = runCommand(testCmd, testArgs, repoDir, TEST_TIMEOUT_MS, py ? py.env : undefined);

    const testRun = classifyTestRun({
        command: testScript,
        exitCode: testResult.exitCode,
        error: testResult.error,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
    });
    return {
        testCommand: testScript,
        testOutput: (testResult.stdout + testResult.stderr).slice(-3000),
        testRun,
    };
}

/**
 * Files modified since the last commit, or, when the tree is clean (the task may have
 * committed), the files the last commit changed.
 *
 * @param {string} repoDir
 * @returns {string[]}
 */
function changedFilesOf(repoDir) {
    const diffResult = runCommand('git', ['diff', '--name-only', 'HEAD'], repoDir);
    if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        return diffResult.stdout.trim().split('\n').filter(Boolean);
    }
    const lastCommit = runCommand('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], repoDir);
    if (lastCommit.exitCode === 0 && lastCommit.stdout.trim()) {
        return lastCommit.stdout.trim().split('\n').filter(Boolean);
    }
    return [];
}

/** A changed non-test JS file: the only kind the per-file rules read. */
function isCheckedSource(file) {
    return file.endsWith('.js') && !file.includes('test') && !file.includes('.test.');
}

/**
 * The findings for one changed file: no LOGIC CHANGE comment, a console.log, a
 * process.env read. A file that is gone or unreadable gives none.
 *
 * @param {string} repoDir
 * @param {string} file - Path relative to the clone
 * @returns {Object[]}
 */
function checkChangedFile(repoDir, file) {
    const findings = [];
    const filePath = path.join(repoDir, file);
    try {
        if (!fs.existsSync(filePath)) return findings;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        if (!content.includes('LOGIC CHANGE')) {
            // line stays null: the finding is about the whole file, and inventing
            // a line number to satisfy a field shape would be a lie a reader acts on.
            findings.push(makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file }));
        }

        const debugLine = firstMatchingLine(lines, /console\.log\s*\(/);
        if (debugLine !== null) {
            findings.push(makeFinding({
                ruleId: 'DEBUG_LOGGING_PRESENT',
                file,
                line: debugLine,
                detail: 'remove debug logging before shipping',
            }));
        }

        // LOGIC CHANGE 2026-09-14: was one aggregate warning naming no file; a
        // finding that cannot say where it is cannot become a fix task (D4).
        const envLine = firstMatchingLine(lines, /process\.env\.[A-Z0-9_]+/);
        if (envLine !== null) {
            findings.push(makeFinding({
                ruleId: 'ENV_VAR_POSSIBLY_UNDOCUMENTED',
                file,
                line: envLine,
                detail: 'verify CLAUDE.md and README.md document it',
            }));
        }
    } catch (readErr) {
        // Ignore individual file read errors
    }
    return findings;
}

/**
 * Phase 3: Validate output after task execution.
 * Runs the test suite (npm, or a python clone's venv pytest), checks changed files for LOGIC CHANGE comments and debug logs.
 * Should be called after the LLM finishes but before reporting success.
 *
 * LOGIC CHANGE 2026-09-14: The result now carries `findings` (structured, each with
 * a stable ruleId from lib/review-findings.js, a file, a line and a severity) and a
 * `verdict` summarising them. `issues` and `warnings` are kept for every existing
 * caller, but they are now GENERATED from the findings rather than typed at the site
 * that detects the problem - so the sentence a human reads and the data a spawner
 * compares cannot drift apart. See docs/AUTONOMOUS-LOOP-DESIGN.md decision D6: "the
 * same finding recurred" is a stop condition, and it is unanswerable from prose.
 *
 * @param {string} repoDir - Absolute path to repo directory
 * @param {Object} plan - Execution plan from createExecutionPlan()
 * @returns {Object} Validation result, including `findings` and `verdict`
 */
function validateOutput(repoDir, plan) {
    const { testCommand, testOutput, testRun } = runTestGate(repoDir, plan);
    const changedFiles = changedFilesOf(repoDir);

    const findings = [];
    const testFinding = findingFor(testRun);
    if (testFinding) findings.push(testFinding);
    for (const file of changedFiles.filter(isCheckedSource)) {
        findings.push(...checkChangedFile(repoDir, file));
    }

    // Verdict, and the human-readable arrays generated from it. Every existing caller
    // reads `issues`/`warnings`/`passed`; none of them has to change, but the strings
    // they read are now rendered from the findings rather than written beside them.
    const verdict = buildVerdict(findings);
    return {
        // Any blocking finding fails the gate, not only a test one. Today every blocking
        // rule is a test rule, so this is equivalent to the test gate (green only when
        // assertions ran); it is written this way so that adding a blocking rule cannot
        // leave `passed` true beside it.
        passed: verdict.blocking.length === 0,
        testsPassed: testRun.assertions ? testRun.assertions.passed : 0,
        testsFailed: testRun.assertions ? testRun.assertions.failed : 0,
        issues: verdict.blocking.map(f => f.message),
        warnings: verdict.advisory.map(f => f.message),
        changedFiles,
        testOutput,
        testRun,
        testCommand,
        findings,
        verdict,
    };
}

/**
 * 1-based line number of the first line matching `pattern`, or null.
 *
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {number|null}
 */
function firstMatchingLine(lines, pattern) {
    for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) return i + 1;
    }
    return null;
}

module.exports = {
    validateOutput,
    DEFAULT_TEST_SCRIPT,
    runTestGate,
    changedFilesOf,
    checkChangedFile,
    firstMatchingLine,
};
