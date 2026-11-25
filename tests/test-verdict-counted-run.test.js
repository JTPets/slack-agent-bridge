'use strict';

/**
 * tests/test-verdict-counted-run.test.js
 *
 * WORK-TODO #84: a run that printed a test count is a run that STARTED, so the count
 * decides its verdict, not a word somewhere in its output. Before the fix,
 * lib/test-verdict.js scored any output containing `ENOENT` as runner_absent, even when
 * jest's own summary said every test passed (seen by B31 on 2026-11-12, and a gate red
 * for that reason told the box to "run `npm ci`"). Split from
 * tests/test-gate-honesty.test.js, which is at the 300-line limit.
 */

const { OUTCOME, classifyTestRun } = require('../lib/test-verdict');

// A suite that logs a caught ENOENT and passes: the shape of a real jest run here.
const PASSING_WITH_ENOENT = [
    "console.error\n    [agent-registry] Could not read agents: ENOENT: no such file or directory, open '/tmp/x/agent.md'",
    'Test Suites: 12 passed, 12 total',
    'Tests:       340 passed, 340 total',
    '',
].join('\n');

describe('a counted run is judged by its count (#84)', () => {
    test('exit 0, every test passed, ENOENT in the log -> PASSED', () => {
        const v = classifyTestRun({ command: 'npm test', exitCode: 0, stdout: PASSING_WITH_ENOENT });
        expect(v.outcome).toBe(OUTCOME.PASSED);
        expect(v.green).toBe(true);
        expect(v.assertions.passed).toBe(340);
    });

    test('a real failure that logs ENOENT is FAILED with its count, not absent', () => {
        const out = 'Error: spawn git ENOENT\nTests:       2 failed, 30 passed, 32 total\n';
        const v = classifyTestRun({ command: 'npm test', exitCode: 1, stderr: out });
        expect(v.outcome).toBe(OUTCOME.FAILED);
        expect(v.assertions.failed).toBe(2);
    });

    test('node --test output with ENOENT and a pass count -> PASSED', () => {
        const out = 'not found: ENOENT (expected)\nℹ tests 4\nℹ pass 4\nℹ fail 0\n';
        expect(classifyTestRun({ exitCode: 0, stdout: out }).outcome).toBe(OUTCOME.PASSED);
    });

    describe('absence is still absence (negative controls)', () => {
        test('ENOENT with no count is still runner_absent', () => {
            const v = classifyTestRun({ exitCode: 1, stderr: 'npm error code ENOENT\nnpm error syscall open\n' });
            expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        });

        test('a spawn error ENOENT is absent whatever the output says', () => {
            const v = classifyTestRun({
                exitCode: null,
                error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }),
                stdout: 'Tests:       1 passed, 1 total\n',
            });
            expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        });

        test('"jest: not found" with exit 127 and no count is still absent', () => {
            const v = classifyTestRun({ exitCode: 127, stderr: 'sh: 1: jest: not found\n' });
            expect(v.outcome).toBe(OUTCOME.RUNNER_ABSENT);
        });

        test('a fully skipped suite with ENOENT is still not a pass', () => {
            const v = classifyTestRun({ exitCode: 0, stdout: 'ENOENT\nTests:       5 skipped, 5 total\n' });
            expect(v.green).toBe(false);
        });
    });
});
