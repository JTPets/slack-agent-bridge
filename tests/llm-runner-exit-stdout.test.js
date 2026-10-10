'use strict';

/**
 * tests/llm-runner-exit-stdout.test.js
 *
 * Regression test for the 2026-10-10 07:00 morning briefing, reported as only
 * "Exit code 1 (no stderr output)". `claude -p --output-format text` prints its own
 * failure (an auth, credit or usage-limit message) on STDOUT and exits 1 with stderr
 * empty; run against the real CLI with an invalid key it printed
 * "Invalid API key · Fix external API key" on stdout and nothing on stderr. The adapter
 * dropped stdout on a failed exit, so the cause reached nobody.
 *
 * Real spawn against a stub binary that behaves the same way, plus the pure formatter.
 * Fails against the pre-fix adapter: the message carries no stdout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runClaudeAdapter, describeClaudeExit } = require('../lib/llm-runner');

const CLI_MESSAGE = 'Invalid API key · Fix external API key';

let dir;
let failsOnStdout;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-exit-stdout-'));
    failsOnStdout = path.join(dir, 'fails-on-stdout');
    fs.writeFileSync(
        failsOnStdout,
        `#!${process.execPath}\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stdout.write(${JSON.stringify(CLI_MESSAGE + '\n')}); process.exit(1); });\n`,
        { mode: 0o755 }
    );
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('a CLI that fails on stdout with empty stderr reports what it printed', async () => {
    const err = await runClaudeAdapter('prompt', { claudeBin: failsOnStdout, cwd: dir }).then(
        () => { throw new Error('expected a rejection'); },
        (e) => e
    );
    expect(err.message).toMatch(/^Exit code 1/);
    expect(err.message).toContain('(no stderr output)');
    expect(err.message).toContain(CLI_MESSAGE);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe('');
    expect(err.stdout).toBe(CLI_MESSAGE);
}, 15000);

describe('describeClaudeExit with stdout', () => {
    test('appends the stdout tail, keeping the stderr statement', () => {
        const msg = describeClaudeExit(1, null, '', CLI_MESSAGE);
        expect(msg).toBe(`Exit code 1\n(no stderr output)\nstdout (last 2000 chars):\n${CLI_MESSAGE}`);
    });

    test('keeps the END of a long stdout, where a failure is', () => {
        const msg = describeClaudeExit(1, null, '', 'x'.repeat(5000) + 'THE-CAUSE');
        expect(msg).toContain('THE-CAUSE');
        expect(msg.length).toBeLessThan(2100);
    });

    test('adds nothing when stdout is empty (negative control)', () => {
        expect(describeClaudeExit(1, null, '')).toBe('Exit code 1\n(no stderr output)');
        expect(describeClaudeExit(1, null, 'boom', '   ')).toBe('Exit code 1\nboom');
    });
});
