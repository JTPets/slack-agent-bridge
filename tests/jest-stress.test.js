'use strict';

/**
 * tests/jest-stress.test.js — scripts/jest-stress.js (WORK-TODO #56).
 *
 * LOGIC CHANGE 2026-11-12: new file. The script's own logic, with the jest spawn
 * injected: a run is green only when lib/test-verdict.js says so AND 0 were skipped AND
 * no global hook recorded a failure; a hook record appended during a run is attributed
 * to that run; the child never sees a value dotenv loaded from .env.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const stress = require('../scripts/jest-stress');

const PASS = 'Test Suites: 3 passed, 3 total\nTests:       12 passed, 12 total\n';

describe('scripts/jest-stress.js', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-stress-t-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = (spawnResult, { appendCapture } = {}) => {
        const captureFile = path.join(dir, 'captures.jsonl');
        fs.writeFileSync(captureFile, `${JSON.stringify({ hook: 'globalSetup', message: 'OLD' })}\n`);
        let argv;
        const spawn = (cmd, args, opts) => {
            argv = [cmd, ...args];
            // The child's stdout/stderr is a file descriptor, as for the real jest.
            fs.writeSync(opts.stdio[1], `${spawnResult.stdout || ''}${spawnResult.stderr || ''}`);
            if (appendCapture) fs.appendFileSync(captureFile, `${JSON.stringify(appendCapture)}\n`);
            return { status: spawnResult.status, error: spawnResult.error };
        };
        const res = stress.runOnce(1, { jestBin: '/x/jest', jestArgs: ['--runInBand'], outDir: dir, spawn, captureFile });
        return { res, argv };
    };

    test('a clean run is green, runs jest --silent with the extra args, and keeps its whole output', () => {
        const { res, argv } = run({ status: 0, stdout: PASS, stderr: 'noise' });
        expect(argv).toEqual([process.execPath, '/x/jest', '--silent', '--runInBand']);
        expect(res.green).toBe(true);
        expect(res.suites).toBe('3 passed, 3 total');
        expect(res.tests).toBe('12 passed, 12 total');
        expect(res.captures).toEqual([]);
        expect(fs.readFileSync(res.outputFile, 'utf8')).toBe(`${PASS}noise`);
    });

    test('a run with skips is NOT green', () => {
        const { res } = run({ status: 0, stdout: 'Test Suites: 3 passed, 3 total\nTests:       2 skipped, 10 passed, 12 total\n', stderr: '' });
        expect(res.skipped).toBe(2);
        expect(res.green).toBe(false);
    });

    test('a globalSetup failure is red and its captured record is attributed to the run', () => {
        const { res } = run({ status: 1, stdout: '', stderr: 'Error: Jest: Got error running globalSetup' },
            { appendCapture: { hook: 'globalSetup', message: 'NEW-FAILURE' } });
        expect(res.green).toBe(false);
        expect(res.captures.map((c) => c.message)).toEqual(['NEW-FAILURE']);
        expect(stress.formatRun(res, 10)).toContain('CAPTURED globalSetup: NEW-FAILURE');
    });

    test('a capture during an otherwise green run still makes it red', () => {
        const { res } = run({ status: 0, stdout: PASS, stderr: '' },
            { appendCapture: { hook: 'globalTeardown', message: 'late' } });
        expect(res.green).toBe(false);
    });

    test('an absent runner is red, not green', () => {
        const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        const { res } = run({ status: null, stdout: '', stderr: '', error: err });
        expect(res.green).toBe(false);
        expect(res.outcome).toBe('runner_absent');
    });

    test('values dotenv loaded are removed from the child env; others are kept', () => {
        const env = stress.childEnv({ PATH: '/bin', FROM_ENV_FILE: 'secret', JEST_WORKER_ID: '3' }, { FROM_ENV_FILE: 'secret' });
        expect(env).toEqual({ PATH: '/bin' });
    });

    test('argument parsing', () => {
        expect(stress.parseArgs([])).toEqual({ runs: 10, jestArgs: [] });
        expect(stress.parseArgs(['--runs', '3', '--', '-i'])).toEqual({ runs: 3, jestArgs: ['-i'] });
        expect(stress.parseArgs(['--runs', '0']).error).toMatch(/whole number/);
        expect(stress.parseArgs(['--what']).error).toMatch(/unknown argument/);
    });
});
