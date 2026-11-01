'use strict';

/**
 * lib/claude-auth-watch.js
 *
 * WORK-TODO #77: on 2026-11-01 the Claude CLI in the jt-agent container was logged out
 * ("Not logged in · Please run /login"). Every Claude task failed in under 3 seconds and
 * the first anyone heard of it was the secretary's 7am briefing failing. The bridge
 * checked Gemini at boot and never checked Claude.
 *
 * This makes one tiny real call ("Reply with the word ok", one turn) at boot and on an
 * interval, and posts to #sqtools-ops when it fails: once when it starts failing, on every
 * failing tick after that (daily at the default interval), and once on recovery.
 * Report-only: it gates, retries and restarts nothing.
 *
 * Why a real call and not a status subcommand: the question is "can a task run", and the
 * only check that answers it is the thing a task does. It costs two one-turn calls a day.
 *
 * LOGIC CHANGE 2026-11-01: new file.
 */

const os = require('os');
const { spawn } = require('child_process');

const PROBE_PROMPT = 'Reply with the word ok';
const PROBE_TIMEOUT_MS = 60000;
const OUTPUT_TAIL = 300;

// Text the CLI prints when its credential is missing, expired or refused. A match makes
// the alert say "log in again"; anything else is reported as a plain failure.
const AUTH_PATTERNS = [
    /not logged in/i,
    /please run \/login/i,
    /invalid api key/i,
    /oauth token (has )?expired/i,
    /authentication[_ ]error/i,
    /\b401\b/,
];

/** 'not_logged_in' when the output reads as a credential problem, else 'failed'. */
function classifyFailure(text) {
    return AUTH_PATTERNS.some(p => p.test(text || '')) ? 'not_logged_in' : 'failed';
}

/**
 * Run the probe. Resolves { ok: true } or { ok: false, kind, detail }; never rejects.
 * kind: 'not_logged_in' | 'failed' | 'timed_out' | 'spawn_failed'.
 */
function probeClaudeAuth({ claudeBin, cwd = os.tmpdir(), timeoutMs = PROBE_TIMEOUT_MS, spawnFn = spawn } = {}) {
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        let child;
        try {
            child = spawnFn(claudeBin, ['-p', '--max-turns', '1', '--output-format', 'text'], {
                cwd,
                env: { ...process.env, HOME: os.homedir() },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (err) {
            return finish({ ok: false, kind: 'spawn_failed', detail: err.message });
        }
        let out = '';
        const keep = (chunk) => { out = (out + chunk).slice(-4096); };
        timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
            // A grandchild can hold the pipes open after the kill; let go of them.
            for (const s of [child.stdin, child.stdout, child.stderr]) { if (s) s.destroy(); }
            finish({ ok: false, kind: 'timed_out', detail: `no answer within ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        if (timer.unref) timer.unref();
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        child.on('error', err => finish({ ok: false, kind: 'spawn_failed', detail: err.message }));
        child.on('close', (code) => {
            const tail = out.trim().slice(-OUTPUT_TAIL);
            if (code === 0) return finish({ ok: true });
            finish({ ok: false, kind: classifyFailure(tail), detail: tail || `exit code ${code}, no output` });
        });
        child.stdin.on('error', () => { /* the child may exit before reading */ });
        child.stdin.end(PROBE_PROMPT);
    });
}

/** Where the CLI's credential comes from, by NAME only - never a value. */
function describeCredentialSource(env = process.env) {
    return env.CLAUDE_CODE_OAUTH_TOKEN
        ? '`CLAUDE_CODE_OAUTH_TOKEN` is set in the environment'
        : '`CLAUDE_CODE_OAUTH_TOKEN` is not set, so the CLI relies on its `/login` credential under `HOME`';
}

/** The #sqtools-ops text for a failing probe. */
function describeFailure(result, env = process.env) {
    const head = result.kind === 'not_logged_in'
        ? ':key: *The Claude CLI is not logged in.* Every Claude task will fail until it is.'
        : ':warning: *The Claude CLI health check failed.* Claude tasks may be failing.';
    const fix = result.kind === 'not_logged_in'
        ? 'Fix: `docker exec -it -w /tmp/bridge-agent jt-agent /bridge/.npm-global/bin/claude setup-token`, ' +
          'put the token in `.env` as `CLAUDE_CODE_OAUTH_TOKEN`, then ' +
          '`docker compose up -d --force-recreate bridge`.'
        : 'Run the same call by hand inside the container to see the full output.';
    return `${head}\nWhat it said: \`${result.detail}\`\n${describeCredentialSource(env)}.\n${fix}`;
}

/**
 * @param {object} deps
 * @param {Function} deps.probe  - async () => probeClaudeAuth() result.
 * @param {Function} deps.notify - async (text) => any. Posts to #sqtools-ops.
 * @returns {{ tick: () => Promise<string> }} resolves to 'ok' | 'recovered' | 'reported'.
 */
function createClaudeAuthWatch({ probe, notify, logger = console, env = process.env }) {
    let failing = false;

    const post = (text) => Promise.resolve(notify(text)).catch((err) => {
        logger.error(`[claude-auth] Could not post to ops: ${err.message}`);
    });

    async function tick() {
        let result;
        try {
            result = await probe();
        } catch (err) {
            result = { ok: false, kind: 'failed', detail: err.message };
        }
        if (result && result.ok) {
            logger.log('[claude-auth] Claude CLI check PASSED');
            if (!failing) return 'ok';
            failing = false;
            await post(':white_check_mark: *The Claude CLI is working again.* Claude tasks can run.');
            return 'recovered';
        }
        failing = true;
        logger.warn(`[claude-auth] Claude CLI check FAILED (${result.kind}): ${result.detail}`);
        await post(describeFailure(result, env));
        return 'reported';
    }

    return { tick };
}

module.exports = {
    PROBE_PROMPT,
    classifyFailure,
    probeClaudeAuth,
    describeCredentialSource,
    describeFailure,
    createClaudeAuthWatch,
};
