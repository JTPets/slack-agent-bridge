/**
 * tests/update-verifier.test.js
 *
 * Tests for lib/update-verifier.js - the pre-restart gate that stands between a
 * bad merge to main and a container that restarts into failure forever.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    ENTRY_POINTS,
    defaultRunSyntaxCheck,
    verifyEntryPoints,
    planRestart,
} = require('../lib/update-verifier');

describe('ENTRY_POINTS', () => {
    test('bridge-agent.js and auto-update.js are required', () => {
        const required = ENTRY_POINTS.filter(e => e.required).map(e => e.file);
        expect(required).toEqual(expect.arrayContaining(['bridge-agent.js', 'auto-update.js']));
    });

    test('every listed entry point exists in this repo and parses', () => {
        // If this fails, either a file was renamed without updating ENTRY_POINTS
        // (so the gate silently stopped checking it) or main is broken.
        const repoDir = path.join(__dirname, '..');
        const result = verifyEntryPoints({ repoDir });
        expect(result.failures).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.missing).toEqual([]);
    });
});

describe('defaultRunSyntaxCheck', () => {
    let tmpDir;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-test-'));
    });

    afterAll(() => {
        if (tmpDir) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('accepts a file that parses', () => {
        const file = path.join(tmpDir, 'good.js');
        fs.writeFileSync(file, 'const a = 1;\nmodule.exports = a;\n', 'utf8');
        expect(defaultRunSyntaxCheck(file).ok).toBe(true);
    });

    test('rejects a file with a syntax error and names the cause', () => {
        const file = path.join(tmpDir, 'bad.js');
        fs.writeFileSync(file, 'const a = ;\n', 'utf8');
        const result = defaultRunSyntaxCheck(file);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/SyntaxError/);
    });

    test('rejects a file that does not exist rather than reporting success', () => {
        const result = defaultRunSyntaxCheck(path.join(tmpDir, 'nope.js'));
        expect(result.ok).toBe(false);
    });
});

describe('verifyEntryPoints', () => {
    const entryPoints = [
        { file: 'bridge-agent.js', required: true },
        { file: 'optional.js', required: false },
    ];

    test('ok when every present entry point parses', () => {
        const result = verifyEntryPoints({
            repoDir: '/repo',
            entryPoints,
            exists: () => true,
            runSyntaxCheck: () => ({ ok: true }),
        });
        expect(result.ok).toBe(true);
        expect(result.checked).toEqual(['bridge-agent.js', 'optional.js']);
        expect(result.failures).toEqual([]);
    });

    test('not ok when an entry point fails to parse, and the file is named', () => {
        const result = verifyEntryPoints({
            repoDir: '/repo',
            entryPoints,
            exists: () => true,
            runSyntaxCheck: (p) =>
                p.endsWith('bridge-agent.js')
                    ? { ok: false, error: 'SyntaxError: Unexpected token' }
                    : { ok: true },
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].file).toBe('bridge-agent.js');
        expect(result.failures[0].error).toMatch(/SyntaxError/);
    });

    test('a MISSING required entry point is a failure, not a pass', () => {
        // A commit that deletes bridge-agent.js parses vacuously. Treating "no
        // file, nothing to check" as ok is exactly how a brick gets waved through.
        const result = verifyEntryPoints({
            repoDir: '/repo',
            entryPoints,
            exists: (p) => !p.endsWith('bridge-agent.js'),
            runSyntaxCheck: () => ({ ok: true }),
        });
        expect(result.ok).toBe(false);
        expect(result.failures[0].file).toBe('bridge-agent.js');
        expect(result.failures[0].error).toMatch(/missing/i);
    });

    test('a missing OPTIONAL entry point is reported but does not block the update', () => {
        const result = verifyEntryPoints({
            repoDir: '/repo',
            entryPoints,
            exists: (p) => !p.endsWith('optional.js'),
            runSyntaxCheck: () => ({ ok: true }),
        });
        expect(result.ok).toBe(true);
        expect(result.missing).toEqual(['optional.js']);
        expect(result.checked).toEqual(['bridge-agent.js']);
    });

    test('a spawn-level failure is surfaced, not swallowed as success', () => {
        const result = verifyEntryPoints({
            repoDir: '/repo',
            entryPoints,
            exists: () => true,
            runSyntaxCheck: () => ({ ok: false, error: 'could not run node --check (ENOENT)' }),
        });
        expect(result.ok).toBe(false);
        expect(result.failures).toHaveLength(2);
    });
});

describe('planRestart (guard c)', () => {
    test('allows a restart into a commit never restarted into before', () => {
        const plan = planRestart({ newHead: 'aaa111', restartedIntoCommit: 'bbb222' });
        expect(plan.exit).toBe(true);
    });

    test('allows a restart when no prior restart is recorded', () => {
        expect(planRestart({ newHead: 'aaa111' }).exit).toBe(true);
        expect(planRestart({ newHead: 'aaa111', restartedIntoCommit: null }).exit).toBe(true);
    });

    test('REFUSES a second restart for the same commit', () => {
        const plan = planRestart({ newHead: 'aaa111', restartedIntoCommit: 'aaa111' });
        expect(plan.exit).toBe(false);
        expect(plan.reason).toMatch(/already restarted/i);
    });

    test('refuses when there is no commit hash to restart into', () => {
        expect(planRestart({ newHead: null }).exit).toBe(false);
        expect(planRestart({}).exit).toBe(false);
    });
});
