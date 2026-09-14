'use strict';

/**
 * lib/test-verdict.js
 *
 * Classify the result of running a repository's test command, honestly.
 *
 * LOGIC CHANGE 2026-09-14: New module. Part three of the autonomous-loop
 * prerequisites (docs/AUTONOMOUS-LOOP-DESIGN.md section 4). Decision D1 makes a
 * green suite half the merge gate, so the suite has to be incapable of reporting
 * a pass it did not earn.
 *
 * THE OBSERVED FAILURE. The post-task review ran under an install that omitted
 * development dependencies. `jest` was therefore not on PATH, `npm test` printed
 * "sh: 1: jest: not found" and exited 127, and ZERO assertions executed. The old
 * code branched on `exitCode !== 0` and reported "Tests failed (1 failed, 0
 * passed)" — indistinguishable from one genuinely failing assertion, and read by
 * everyone who saw it as a tooling hiccup rather than a failed gate. Reproduce it
 * in any checkout with no node_modules: `npm test; echo $?` -> 127.
 *
 * THE WORSE HALF, which the old code scored as a PASS. A test command that exits 0
 * without running anything — `--passWithNoTests`, a `test` script of `echo ok`, a
 * jest invocation whose pattern matched no file — produced exitCode 0, no parsable
 * count, `passed: true` and `testsPassed: 0`. Its caller
 * (bridge-agent.js) then posted nothing at all, because it only announces a pass
 * when the count is above zero. A silent green with no assertions behind it.
 *
 * THE RULE, from docs/EXECUTOR-CONTRACT.md section 4: if you cannot say which
 * assertions ran, none did. So a pass requires BOTH exit 0 AND a positive,
 * parsed assertion count. An unrecognised output format is not a pass; it is
 * UNKNOWN_COUNT, and that is deliberate rather than an omission — the alternative
 * is trusting an exit code that the observed failure proves is not trustworthy.
 */

const { makeFinding } = require('./review-findings');

/** How a test run ended. Exactly one of these is true of any run. */
const OUTCOME = {
    PASSED: 'passed',                 // exit 0 AND assertions were counted AND none failed
    FAILED: 'failed',                 // the runner ran and reported failures
    RUNNER_ABSENT: 'runner_absent',   // the command could not start; nothing executed
    NO_ASSERTIONS: 'no_assertions',   // exited 0 having run nothing, or nothing countable
    TIMED_OUT: 'timed_out',           // killed before it finished
    NOT_RUN: 'not_run',               // no test script to run at all
};

/** Outcome -> the rule id it reports as. PASSED reports nothing. */
const OUTCOME_RULE = {
    [OUTCOME.FAILED]: 'TEST_SUITE_FAILED',
    [OUTCOME.RUNNER_ABSENT]: 'TEST_RUNNER_ABSENT',
    [OUTCOME.NO_ASSERTIONS]: 'TEST_SUITE_NO_ASSERTIONS',
    [OUTCOME.TIMED_OUT]: 'TEST_SUITE_TIMED_OUT',
    [OUTCOME.NOT_RUN]: 'TEST_RUNNER_ABSENT',
};

/**
 * Assertion-count patterns, by runner. Each must yield a TOTAL that is a count of
 * assertions/tests actually executed, not of files or suites.
 *
 * Deliberately a short list. A runner not on it produces `null`, which classifies
 * as NO_ASSERTIONS rather than as a pass — see the module header.
 */
const COUNT_PATTERNS = [
    // jest:  "Tests:       2 failed, 3 passed, 5 total"
    {
        runner: 'jest',
        line: /^\s*Tests:\s+(.+)$/m,
        parse: (m) => ({
            failed: num(m[1], /(\d+)\s+failed/),
            passed: num(m[1], /(\d+)\s+passed/),
            skipped: num(m[1], /(\d+)\s+(?:skipped|todo|pending)/),
            total: num(m[1], /(\d+)\s+total/),
        }),
    },
    // mocha: "12 passing" / "2 failing"
    {
        runner: 'mocha',
        line: /^\s*(\d+)\s+passing\b/m,
        parse: (m, out) => {
            const passed = parseInt(m[1], 10);
            const failed = num(out, /(\d+)\s+failing/) || 0;
            const skipped = num(out, /(\d+)\s+pending/) || 0;
            return { failed, passed, skipped, total: passed + failed + skipped };
        },
    },
    // node --test (TAP summary): "# pass 12" / "# fail 0"
    {
        runner: 'node:test',
        line: /^#\s*pass\s+(\d+)\s*$/m,
        parse: (m, out) => {
            const passed = parseInt(m[1], 10);
            const failed = num(out, /^#\s*fail\s+(\d+)\s*$/m) || 0;
            const skipped = num(out, /^#\s*skipped\s+(\d+)\s*$/m) || 0;
            return { failed, passed, skipped, total: passed + failed + skipped };
        },
    },
];

/**
 * First capture group of `pattern` in `text` as an integer, or 0.
 *
 * @param {string} text
 * @param {RegExp} pattern
 * @returns {number}
 */
function num(text, pattern) {
    const m = String(text || '').match(pattern);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * Parse an assertion count out of runner output.
 *
 * @param {string} output - stdout + stderr
 * @returns {{ runner: string, passed: number, failed: number, total: number }|null}
 */
function parseAssertions(output) {
    const text = String(output || '');
    for (const spec of COUNT_PATTERNS) {
        const m = text.match(spec.line);
        if (!m) continue;
        const counts = spec.parse(m, text);
        if (!Number.isFinite(counts.total)) continue;
        return { runner: spec.runner, ...counts };
    }
    return null;
}

/** Signals that the command itself could not be started. */
const ABSENT_PATTERNS = [
    /\bcommand not found\b/i,
    /:\s*not found\b/i,                 // "sh: 1: jest: not found" — the observed case
    /\bis not recognized as an internal or external command\b/i,
    /\bMissing script\b/i,              // npm: the repo declares no such script
    /\bENOENT\b/,
];

/**
 * Did this run fail to start, as opposed to running and failing?
 *
 * @param {object} run
 * @returns {boolean}
 */
function looksAbsent({ exitCode, output, error }) {
    if (error && error.code === 'ENOENT') return true;
    if (ABSENT_PATTERNS.some((p) => p.test(output))) return true;
    // 127 is the shell's "command not found". On its own it is strong evidence, and
    // it is what `npm test` returns when the runner binary is missing.
    return exitCode === 127;
}

/**
 * Classify one test-command run.
 *
 * Every test invocation in this repository goes through this function. A caller
 * that branches on a raw exit code is the defect this module exists to remove.
 *
 * @param {object} run
 * @param {string} [run.command] - What was run, for the reason string
 * @param {number|null} run.exitCode - spawnSync status (null when killed / not spawned)
 * @param {Error|null} [run.error] - spawnSync error (ENOENT, ETIMEDOUT)
 * @param {string} [run.stdout]
 * @param {string} [run.stderr]
 * @returns {{ outcome: string, ran: boolean, green: boolean,
 *   assertions: {runner:string,passed:number,failed:number,total:number}|null,
 *   ruleId: string|null, reason: string, output: string }}
 */
function classifyTestRun({ command = 'the test command', exitCode = null, error = null, stdout = '', stderr = '' } = {}) {
    const output = `${stdout || ''}${stderr || ''}`;

    const done = (outcome, reason, assertions = null) => ({
        outcome,
        ran: outcome === OUTCOME.PASSED || outcome === OUTCOME.FAILED,
        green: outcome === OUTCOME.PASSED,
        assertions,
        ruleId: OUTCOME_RULE[outcome] || null,
        reason,
        output,
    });

    // 1. Killed before finishing. A run that will not finish is never a pass, and it
    //    is not a test failure either — no verdict was reached.
    if (error && error.code === 'ETIMEDOUT') {
        return done(OUTCOME.TIMED_OUT, `${command} did not finish — it was killed, so no verdict was reached`);
    }

    // 2. Could not start. THE observed case. Reported as absence, never as "1 failed".
    if (looksAbsent({ exitCode, output, error })) {
        const how = error ? (error.code || error.message) : `exit ${exitCode}`;
        return done(
            OUTCOME.RUNNER_ABSENT,
            `${command} could not be started (${how}) — zero assertions executed. ` +
            'This is a failed gate, not a tooling hiccup: run `npm ci` and re-run.'
        );
    }

    // 3. Other spawn-level error.
    if (error) {
        return done(OUTCOME.RUNNER_ABSENT, `${command} could not be run (${error.code || error.message})`);
    }

    const assertions = parseAssertions(output);

    // 4. Non-zero exit with a parsed count: a real suite that really failed.
    if (exitCode !== 0) {
        if (assertions && assertions.total > 0) {
            return done(
                OUTCOME.FAILED,
                `${command} reported ${assertions.failed} failed, ${assertions.passed} passed`,
                assertions
            );
        }
        // Non-zero, nothing countable. Not "1 failed" — we do not know that.
        return done(
            OUTCOME.NO_ASSERTIONS,
            `${command} exited ${exitCode} without a readable assertion count — ` +
            'no assertion is known to have run'
        );
    }

    // 5. Exit 0. A pass has to be earned: assertions must have been counted, and
    //    the count must be above zero.
    if (!assertions) {
        return done(
            OUTCOME.NO_ASSERTIONS,
            `${command} exited 0 but printed no assertion count this module can read — ` +
            'if you cannot say which assertions ran, none did'
        );
    }
    if (assertions.total === 0) {
        return done(OUTCOME.NO_ASSERTIONS, `${command} exited 0 having run 0 tests`, assertions);
    }
    // A suite where everything was skipped has a positive total and executed nothing.
    // jest exits 0 for it, so the exit code says "green" and the count says "no
    // evidence". The count wins.
    if (assertions.passed === 0 && assertions.failed === 0) {
        return done(
            OUTCOME.NO_ASSERTIONS,
            `${command} exited 0 with ${assertions.total} tests collected and 0 executed` +
            `${assertions.skipped ? ` (${assertions.skipped} skipped)` : ''} — a fully skipped suite is not a pass`,
            assertions
        );
    }
    if (assertions.failed > 0) {
        // Exit 0 with failures counted: the runner and its exit code disagree. Trust
        // the count.
        return done(
            OUTCOME.FAILED,
            `${command} exited 0 but reported ${assertions.failed} failed — trusting the count, not the exit code`,
            assertions
        );
    }

    return done(OUTCOME.PASSED, `${command}: ${assertions.passed} assertions passed`, assertions);
}

/**
 * The finding a non-green run produces, or null when it is green.
 *
 * @param {object} verdict - From classifyTestRun()
 * @returns {object|null}
 */
function findingFor(verdict) {
    if (!verdict || verdict.green || !verdict.ruleId) return null;
    return makeFinding({ ruleId: verdict.ruleId, detail: verdict.reason });
}

module.exports = {
    OUTCOME,
    OUTCOME_RULE,
    classifyTestRun,
    parseAssertions,
    findingFor,
};
