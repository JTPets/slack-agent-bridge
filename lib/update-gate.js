'use strict';

/**
 * lib/update-gate.js
 *
 * WORK-TODO #17, the owner's choice of 2026-11-08: "once merged, it should run a gate
 * check of our testing and if it passes it can auto deploy." This is the gate. It runs
 * the repository's FULL test suite against one exact commit of `main`, in a checkout of
 * its own, and says whether that commit may be deployed.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * Why a separate checkout. The running bridge is the deploy tree, and a test run in it
 * would change files under a live process. The gate checks the candidate out under
 * $WORK_DIR/update-gate (a bind mount, so node_modules survives a recreate), fetching
 * from the deploy tree's own `refs/remotes/origin/main`, so it needs no network and no
 * credential of its own. The deploy tree is moved only after a green, and only to the
 * commit the gate judged (auto-update.js fast-forwards to that sha).
 *
 * What "green" means. lib/test-verdict.js decides passed vs everything else, and then
 * this module adds the owner's standing rule: a green that skipped anything is not a
 * green. A commit that is not the one asked about (main moved between the fetch and the
 * gate) is `moved`, never judged.
 *
 * The suite runs with a SCRUBBED environment: a built PATH and a temp HOME and WORK_DIR only.
 * It inherits no token, so no test can reach Slack, Google or GitHub with a real
 * credential, and nothing it writes lands in the live WORK_DIR (the task lock and the
 * queue live there). `--maxWorkers=2` leaves cores for production on the 4-core NAS.
 *
 * NO SHELL. spawn with argv arrays; the commit is hex-asserted before it reaches argv.
 * Never rejects.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { classifyTestRun } = require('./test-verdict');

const SHA = /^[0-9a-f]{40}$/;
const CANDIDATE_REF = 'refs/heads/gate-candidate';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.UPDATE_GATE_TIMEOUT_MS, 10) || 45 * 60 * 1000;
const OUTPUT_KEEP = 200000;

/** Resolves { status, stdout, stderr, error }; never rejects. */
function runCommand(cmd, args, { cwd, env, timeoutMs }) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let error = null;
        let child;
        try {
            child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ status: null, stdout, stderr, error: err });
            return;
        }
        const keep = (s, chunk) => (s + chunk).slice(-OUTPUT_KEEP);
        child.stdout.on('data', (c) => { stdout = keep(stdout, c.toString()); });
        child.stderr.on('data', (c) => { stderr = keep(stderr, c.toString()); });
        const timer = setTimeout(() => {
            error = Object.assign(new Error(`${cmd} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
            try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
        child.on('error', (err) => { error = error || err; });
        child.on('close', (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr, error });
        });
    });
}

/** The only environment the gate's commands see. npm's cache sits beside the gate
 *  checkout (on the WORK_DIR mount), so a run does not download every package again. */
function scrubbedEnv(scratch, npmCache = path.join(scratch, 'npm-cache')) {
    return {
        npm_config_cache: npmCache,
        // Built, not inherited: node's own directory (npm sits beside it) and the
        // system bins where git lives.
        PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
        HOME: scratch,
        WORK_DIR: path.join(scratch, 'work'),
        CI: 'true',
        GIT_TERMINAL_PROMPT: '0',
    };
}

const tail = (r) => `${r.stdout || ''}${r.stderr || ''}`.trim().slice(-800);

/**
 * Gate one commit.
 *
 * @param {object} options
 * @param {string} options.repoDir - the deploy tree; its refs/remotes/origin/main is the source
 * @param {string} options.commit - the 40-hex sha to judge
 * @param {string} options.gateDir - the gate's own checkout
 * @param {number} [options.timeoutMs] - per command
 * @param {Function} [options.run] - injectable runCommand (tests)
 * @returns {Promise<{ ok: boolean, moved?: boolean, stage: string, reason: string,
 *   assertions?: object, output?: string, durationMs: number }>}
 */
async function runGate({ repoDir, commit, gateDir, timeoutMs = DEFAULT_TIMEOUT_MS, run = runCommand } = {}) {
    const started = Date.now();
    const done = (fields) => ({ ok: false, durationMs: Date.now() - started, ...fields });
    let scratch = null;
    try {
        if (!SHA.test(commit || '')) return done({ stage: 'input', reason: 'no 40-hex commit to gate' });
        if (!path.isAbsolute(repoDir || '') || !path.isAbsolute(gateDir || '')) {
            return done({ stage: 'input', reason: 'repoDir and gateDir must be absolute paths' });
        }
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'update-gate-'));
        const env = scrubbedEnv(scratch, path.join(path.dirname(gateDir), 'update-gate-npm-cache'));
        fs.mkdirSync(env.WORK_DIR, { recursive: true });
        const git = (args) => run('git', ['-c', `safe.directory=${gateDir}`, '-c', `safe.directory=${repoDir}`, ...args],
            { cwd: gateDir, env, timeoutMs: 120000 });

        fs.mkdirSync(gateDir, { recursive: true });
        if (!fs.existsSync(path.join(gateDir, '.git'))) {
            const init = await git(['init', '-q', '--', gateDir]);
            if (init.status !== 0) return done({ stage: 'checkout', reason: `git init failed: ${tail(init)}` });
        }
        const fetched = await git(['fetch', '--quiet', '--no-tags', '--', repoDir, `+refs/remotes/origin/main:${CANDIDATE_REF}`]);
        if (fetched.status !== 0) return done({ stage: 'checkout', reason: `fetch from the deploy tree failed: ${tail(fetched)}` });
        const head = await git(['rev-parse', CANDIDATE_REF]);
        const got = (head.stdout || '').trim();
        if (got !== commit) {
            return done({ moved: true, stage: 'checkout', reason: `main is now ${got.slice(0, 7) || 'unreadable'}, not ${commit.slice(0, 7)}` });
        }
        const co = await git(['checkout', '-q', '--force', '--detach', commit]);
        if (co.status !== 0) return done({ stage: 'checkout', reason: `checkout failed: ${tail(co)}` });
        const clean = await git(['clean', '-q', '-fdx', '-e', 'node_modules']);
        if (clean.status !== 0) return done({ stage: 'checkout', reason: `git clean failed: ${tail(clean)}` });

        const install = await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: gateDir, env, timeoutMs });
        if (install.status !== 0) {
            return done({ stage: 'install', reason: `npm ci failed${install.error ? ` (${install.error.code || install.error.message})` : ''}: ${tail(install)}` });
        }

        const tests = await run('npm', ['test', '--', '--ci', '--maxWorkers=2'], { cwd: gateDir, env, timeoutMs });
        const verdict = classifyTestRun({
            command: 'npm test', exitCode: tests.status, error: tests.error, stdout: tests.stdout, stderr: tests.stderr,
        });
        const a = verdict.assertions;
        if (!verdict.green) {
            return done({ stage: 'test', reason: verdict.reason, assertions: a, output: tail(tests) });
        }
        if (a && a.skipped > 0) {
            return done({ stage: 'test', reason: `npm test passed ${a.passed} but skipped ${a.skipped}; a green with skips is not a green`, assertions: a, output: tail(tests) });
        }
        return { ok: true, stage: 'test', reason: verdict.reason, assertions: a, durationMs: Date.now() - started };
    } catch (err) {
        return done({ stage: 'internal', reason: `the gate threw: ${err.message}` });
    } finally {
        if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    }
}

/** One #sqtools-ops line for a gate result. */
function formatGateResult(commit, r) {
    const short = String(commit || '').slice(0, 7);
    const mins = Math.round((r.durationMs || 0) / 60000);
    if (r.ok) {
        const a = r.assertions || {};
        return `:white_check_mark: Update gate GREEN for ${short}: ${a.passed} passed, 0 skipped, in ${mins}m. Deploying it once nothing is running.`;
    }
    if (r.moved) return `:arrows_counterclockwise: Update gate skipped ${short}: ${r.reason}. The next check gates the new commit.`;
    return `:x: Update gate RED for ${short} at the ${r.stage} stage (${mins}m): ${r.reason}` +
        `${r.output ? `\n\`\`\`${r.output}\`\`\`` : ''}\nNot deploying ${short}. The next commit on main is gated normally.`;
}

module.exports = { runGate, formatGateResult, runCommand, scrubbedEnv, CANDIDATE_REF, DEFAULT_TIMEOUT_MS };
