/**
 * tests/update-gate.test.js
 *
 * WORK-TODO #17: lib/update-gate.js against REAL git. A temp "deploy tree" whose
 * refs/remotes/origin/main points at a commit stands in for /bridge; the gate checks that
 * commit out in its own directory. npm is injected (a real `npm ci` + full suite is what
 * the gate runs on the box and is too slow to nest here); git is real throughout.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runGate, formatGateResult, runCommand, scrubbedEnv } = require('../lib/update-gate');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root, deploy, sha1, sha2;

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'update-gate-test-'));
    deploy = path.join(root, 'deploy');
    git(root, ['init', '-q', '-b', 'main', deploy]);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(deploy, ['config', k, v]);
    fs.writeFileSync(path.join(deploy, 'package.json'), '{"name":"x","scripts":{"test":"jest"}}\n');
    git(deploy, ['add', '-A']); git(deploy, ['commit', '-q', '-m', 'one']);
    sha1 = git(deploy, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(deploy, 'b.js'), 'module.exports = 2;\n');
    git(deploy, ['add', '-A']); git(deploy, ['commit', '-q', '-m', 'two']);
    sha2 = git(deploy, ['rev-parse', 'HEAD']);
    git(deploy, ['update-ref', 'refs/remotes/origin/main', sha2]);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const JEST_GREEN = 'Test Suites: 3 passed, 3 total\nTests:       12 passed, 12 total\n';

/** Real git, scripted npm. Records every npm call with the env it was given. */
function runner(npmResults) {
    const npm = [];
    const run = async (cmd, args, opts) => {
        if (cmd !== 'npm') return runCommand(cmd, args, opts);
        npm.push({ args, env: opts.env, cwd: opts.cwd });
        return npmResults[args[0]] || { status: 0, stdout: '', stderr: '' };
    };
    return { run, npm };
}
const gateDir = () => fs.mkdtempSync(path.join(root, 'gate-'));

test('green: the exact commit is checked out in the gate dir and the suite passes with 0 skipped', async () => {
    const r = runner({ test: { status: 0, stdout: '', stderr: JEST_GREEN } });
    const dir = gateDir();
    const out = await runGate({ repoDir: deploy, commit: sha2, gateDir: dir, run: r.run });
    expect(out).toMatchObject({ ok: true, stage: 'test' });
    expect(out.assertions).toMatchObject({ passed: 12, skipped: 0 });
    expect(git(dir, ['rev-parse', 'HEAD'])).toBe(sha2);
    expect(fs.existsSync(path.join(dir, 'b.js'))).toBe(true);
    expect(r.npm.map((c) => c.args[0])).toEqual(['ci', 'test']);
    expect(r.npm[0].args).toContain('--ignore-scripts');
    expect(r.npm[1].args).toEqual(['test', '--', '--ci', '--maxWorkers=2']);
    expect(git(deploy, ['rev-parse', 'HEAD'])).toBe(sha2); // the deploy tree is untouched
});

test('a green that skipped anything is not a green', async () => {
    const r = runner({ test: { status: 0, stdout: '', stderr: 'Tests:       2 skipped, 10 passed, 12 total\n' } });
    const out = await runGate({ repoDir: deploy, commit: sha2, gateDir: gateDir(), run: r.run });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/skipped 2; a green with skips is not a green/);
});

test('a failing suite, an absent runner and a failed install are each red, at their stage', async () => {
    const failed = await runGate({ repoDir: deploy, commit: sha2, gateDir: gateDir(),
        run: runner({ test: { status: 1, stdout: '', stderr: 'Tests:       1 failed, 11 passed, 12 total\n' } }).run });
    expect(failed).toMatchObject({ ok: false, stage: 'test' });
    expect(failed.reason).toMatch(/1 failed, 11 passed/);
    const absent = await runGate({ repoDir: deploy, commit: sha2, gateDir: gateDir(),
        run: runner({ test: { status: 127, stdout: '', stderr: 'sh: 1: jest: not found\n' } }).run });
    expect(absent).toMatchObject({ ok: false, stage: 'test' });
    expect(absent.reason).toMatch(/could not be started/);
    const install = await runGate({ repoDir: deploy, commit: sha2, gateDir: gateDir(),
        run: runner({ ci: { status: 1, stdout: '', stderr: 'npm ERR! lockfile out of sync' } }).run });
    expect(install).toMatchObject({ ok: false, stage: 'install' });
    expect(install.reason).toMatch(/lockfile out of sync/);
});

test('main moved: a commit that is not origin/main is reported as moved and never judged', async () => {
    const r = runner({});
    const out = await runGate({ repoDir: deploy, commit: sha1, gateDir: gateDir(), run: r.run });
    expect(out).toMatchObject({ ok: false, moved: true });
    expect(r.npm).toEqual([]);
});

test('the suite gets a scrubbed environment: no token, and a WORK_DIR that is not the live one', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-must-not-reach-the-gate';
    try {
        const r = runner({ test: { status: 0, stdout: '', stderr: JEST_GREEN } });
        await runGate({ repoDir: deploy, commit: sha2, gateDir: gateDir(), run: r.run });
        for (const call of r.npm) {
            expect(Object.keys(call.env).sort()).toEqual(['CI', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH', 'WORK_DIR']);
            expect(JSON.stringify(call.env)).not.toMatch(/xoxb/);
            expect(call.env.WORK_DIR.startsWith(os.tmpdir())).toBe(true);
        }
    } finally {
        delete process.env.SLACK_BOT_TOKEN;
    }
    expect(Object.keys(scrubbedEnv('/s'))).not.toContain('SLACK_BOT_TOKEN');
});

test('a non-hex commit or a relative path never reaches git', async () => {
    const calls = [];
    const run = async (...a) => { calls.push(a); return { status: 0, stdout: '', stderr: '' }; };
    expect((await runGate({ repoDir: deploy, commit: '--upload-pack=x', gateDir: gateDir(), run })).stage).toBe('input');
    expect((await runGate({ repoDir: 'rel', commit: sha2, gateDir: gateDir(), run })).stage).toBe('input');
    expect(calls).toEqual([]);
});

test('a timed-out command is killed and reported, never a hang', async () => {
    const out = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: root, env: process.env, timeoutMs: 200 });
    expect(out.error && out.error.code).toBe('ETIMEDOUT');
});

test('formatGateResult wording', () => {
    expect(formatGateResult(sha2, { ok: true, assertions: { passed: 5 }, durationMs: 120000 })).toMatch(/GREEN for .{7}: 5 passed, 0 skipped, in 2m/);
    expect(formatGateResult(sha2, { ok: false, moved: true, reason: 'main is now x' })).toMatch(/skipped .{7}: main is now x/);
    expect(formatGateResult(sha2, { ok: false, stage: 'install', reason: 'boom', durationMs: 0 })).toMatch(/RED for .{7} at the install stage.*Not deploying/s);
});
