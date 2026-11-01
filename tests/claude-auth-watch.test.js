'use strict';

/**
 * tests/claude-auth-watch.test.js - WORK-TODO #77: a logged-out Claude CLI is reported to
 * #sqtools-ops instead of being found when a scheduled task fails. The probe is run for
 * REAL against stub binaries in a temp dir, because the 2026-11-01 failure was the CLI's
 * own exit code and output, which a mocked spawn would only restate.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    PROBE_PROMPT, classifyFailure, probeClaudeAuth, describeFailure, describeCredentialSource,
    createClaudeAuthWatch,
} = require('../lib/claude-auth-watch');

const silent = { log: () => {}, warn: () => {}, error: () => {} };
let dir;

function stub(name, body) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('probeClaudeAuth against real stub binaries', () => {
    test('the 2026-11-01 failure: "Not logged in" on stdout, exit 1, is not_logged_in', async () => {
        const bin = stub('logged-out', 'cat >/dev/null; echo "Not logged in · Please run /login"; exit 1');
        const r = await probeClaudeAuth({ claudeBin: bin, cwd: dir });
        expect(r).toEqual({ ok: false, kind: 'not_logged_in', detail: 'Not logged in · Please run /login' });
    });

    test('a working CLI answering ok, exit 0, passes - and it was given the probe prompt on stdin', async () => {
        const seen = path.join(dir, 'stdin.txt');
        const bin = stub('ok', `cat > "${seen}"; echo ok`);
        expect(await probeClaudeAuth({ claudeBin: bin, cwd: dir })).toEqual({ ok: true });
        expect(fs.readFileSync(seen, 'utf8')).toBe(PROBE_PROMPT);
    });

    test('a non-auth failure is "failed", with the output carried', async () => {
        const bin = stub('broken', 'cat >/dev/null; echo "API overloaded" >&2; exit 2');
        const r = await probeClaudeAuth({ claudeBin: bin, cwd: dir });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe('failed');
        expect(r.detail).toBe('API overloaded');
    });

    test('silence and a non-zero exit still says something', async () => {
        const bin = stub('mute', 'cat >/dev/null; exit 1');
        expect(await probeClaudeAuth({ claudeBin: bin, cwd: dir }))
            .toEqual({ ok: false, kind: 'failed', detail: 'exit code 1, no output' });
    });

    test('a hung CLI is timed_out, not a pass and not a hang', async () => {
        const bin = stub('hang', 'sleep 30');
        const r = await probeClaudeAuth({ claudeBin: bin, cwd: dir, timeoutMs: 300 });
        expect(r.kind).toBe('timed_out');
    });

    test('a missing binary is spawn_failed and never rejects', async () => {
        const r = await probeClaudeAuth({ claudeBin: path.join(dir, 'nope'), cwd: dir });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe('spawn_failed');
    });

    test('a spawn that throws synchronously is reported, not thrown', async () => {
        const r = await probeClaudeAuth({ claudeBin: 'x', spawnFn: () => { throw new Error('E2BIG'); } });
        expect(r).toEqual({ ok: false, kind: 'spawn_failed', detail: 'E2BIG' });
    });
});

describe('classifyFailure', () => {
    test.each([
        'Not logged in · Please run /login',
        'Invalid API key · Please run /login',
        'OAuth token has expired',
        'API Error: 401 {"type":"authentication_error"}',
    ])('reads %p as a credential problem', (t) => expect(classifyFailure(t)).toBe('not_logged_in'));

    test('negative control: an ordinary failure is not called a login problem', () => {
        expect(classifyFailure('API overloaded, try again')).toBe('failed');
        expect(classifyFailure('')).toBe('failed');
    });
});

describe('the alert text', () => {
    test('names the credential source by NAME and never prints its value', () => {
        const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-SYNTHETIC-not-a-real-token' };
        const text = describeFailure({ kind: 'not_logged_in', detail: 'Not logged in' }, env);
        expect(text).toContain('not logged in');
        expect(text).toContain('CLAUDE_CODE_OAUTH_TOKEN` is set');
        expect(text).toContain('setup-token');
        expect(text).not.toContain('SYNTHETIC');
    });

    test('says when no token is set and the CLI depends on /login', () => {
        expect(describeCredentialSource({})).toContain('is not set');
    });
});

describe('createClaudeAuthWatch', () => {
    function watch(results) {
        const notify = jest.fn(async () => {});
        let i = 0;
        const probe = async () => results[Math.min(i++, results.length - 1)];
        return { w: createClaudeAuthWatch({ probe, notify, logger: silent, env: {} }), notify };
    }
    const OK = { ok: true };
    const OUT = { ok: false, kind: 'not_logged_in', detail: 'Not logged in' };

    test('healthy: nothing posted', async () => {
        const { w, notify } = watch([OK, OK]);
        expect(await w.tick()).toBe('ok');
        expect(await w.tick()).toBe('ok');
        expect(notify).not.toHaveBeenCalled();
    });

    test('failing is posted on every failing tick (daily), and recovery once', async () => {
        const { w, notify } = watch([OUT, OUT, OK, OK]);
        expect(await w.tick()).toBe('reported');
        expect(await w.tick()).toBe('reported');
        expect(await w.tick()).toBe('recovered');
        expect(await w.tick()).toBe('ok');
        expect(notify).toHaveBeenCalledTimes(3);
        expect(notify.mock.calls[2][0]).toContain('working again');
    });

    test('a probe that throws is a reported failure, and a failing notify does not throw', async () => {
        const notify = jest.fn(async () => { throw new Error('slack down'); });
        const w = createClaudeAuthWatch({ probe: async () => { throw new Error('boom'); }, notify, logger: silent, env: {} });
        await expect(w.tick()).resolves.toBe('reported');
        expect(notify).toHaveBeenCalledTimes(1);
    });
});

describe('the bridge-agent.js wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

    test('the watch is created, first run after boot, then on the interval, and never awaited', () => {
        expect(src).toMatch(/createClaudeAuthWatch\(\{[\s\S]*?probeClaudeAuth\(\{ claudeBin: DEFAULT_CLAUDE_BIN/);
        expect(src).toMatch(/setTimeout\(runClaudeAuthWatch, 45000\)\.unref\(\)/);
        expect(src).toMatch(/setInterval\(runClaudeAuthWatch, CLAUDE_AUTH_CHECK_INTERVAL_MS\)\.unref\(\)/);
        expect(src).not.toMatch(/await\s+claudeAuthWatch/);
    });

    test('it posts through postToOps', () => {
        expect(src).toMatch(/createClaudeAuthWatch\(\{[\s\S]{0,200}notify: postToOps/);
    });
});
