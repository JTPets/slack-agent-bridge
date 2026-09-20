'use strict';

/**
 * lib/dependency-install.js
 *
 * Install a scratch clone's OWN dependencies before the task runs against it.
 *
 * LOGIC CHANGE 2026-09-20: New module (WORK-TODO #61). Nothing in the scratch-clone
 * lifecycle ever installed dependencies. `cloneRepo` (lib/clone-lifecycle.js) clones
 * `--depth 1` and configures the push remote; it runs no package manager. So Phase 3's
 * test command (`validateOutput`, lib/code-review-pipeline.js) ran in a clone with no
 * `node_modules`: `npm test` exited 127 with `jest: not found`, lib/test-verdict.js
 * classified it `runner_absent`, and the gate could ONLY EVER report that. Every repo
 * dispatch's verification was vacuous — not a wrong answer, an absent one.
 *
 * WHY THE TARGET REPO'S DEPS ARE NOT BAKED INTO THE IMAGE. The bridge's OWN tooling
 * (node, npm, jest via `npm ci`, the Claude CLI) is installed once at container start
 * (docker-compose.example.yml `command:`), so it is pinned and paid for once. A target
 * repo's dependencies cannot be baked: the bridge dispatches to ARBITRARY repos, each
 * with its own lockfile that changes per branch. They belong to that clone and install
 * into it.
 *
 * WHY AN INSTALL FAILURE IS A HARNESS FAILURE, NOT A CODE FAILURE. An agent that cannot
 * install can still write a branch of code it cannot verify, and a branch produced that
 * way puts the operator back to merging on a claim — the exact thing Phase 3 exists to
 * prevent. So the caller runs this BEFORE the LLM and stops the dispatch on failure:
 * fail at minute one rather than after a hundred turns of unverifiable work. The three
 * outcomes must never collapse into one (see OUTCOME):
 *   - install failed / installer absent / timed out  -> HARNESS failure. The bridge is broken.
 *   - tests ran and failed                           -> CODE failure. The branch is broken.
 *   - tests ran and passed                           -> pass.
 * The first is this module's job; the other two are lib/test-verdict.js's.
 *
 * NO SHELL. Every install runs through spawnSync with an argv array — no shell parses
 * the arguments, so this module is not a special case in tests/no-shell-execution.test.js.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The install timeout, separate from TASK_TIMEOUT_MS by design. A hung install must
// not eat the LLM turn allowance; too short a budget turns a slow network into a false
// harness failure, and a harness that cries wolf is the defect this module exists to
// remove. 5 minutes: `npm ci` for this repo takes tens of seconds against the network,
// so 5x that is generous headroom for a large tree over the NAS link, while still being
// bounded well under a runaway. It is caught before the LLM starts, so it cannot consume
// turns. Override with INSTALL_TIMEOUT_MS.
const INSTALL_TIMEOUT_MS = parseInt(process.env.INSTALL_TIMEOUT_MS, 10) || 300000;

/**
 * How an install attempt ended. Exactly one is true of any attempt.
 *
 * Only INSTALLED and NO_MANIFEST are non-failures. The three failure outcomes are all
 * HARNESS failures (isHarnessFailure) — the caller stops the dispatch on any of them.
 */
const OUTCOME = {
    INSTALLED: 'installed',             // the installer ran and exited 0
    NO_MANIFEST: 'no_manifest',         // no recognised dependency manifest; nothing to install
    INSTALL_FAILED: 'install_failed',   // the installer ran and exited non-zero
    INSTALLER_ABSENT: 'installer_absent', // the installer binary could not be started
    TIMED_OUT: 'timed_out',             // killed before it finished
};

/** Outcomes that mean the harness (the bridge), not the code under review, is broken. */
const HARNESS_OUTCOMES = new Set([
    OUTCOME.INSTALL_FAILED,
    OUTCOME.INSTALLER_ABSENT,
    OUTCOME.TIMED_OUT,
]);

// Signals that the installer binary itself could not be started, as opposed to running
// and reporting an error. `python3 -m pip` with no pip module prints "No module named
// pip" and exits non-zero without ever installing anything — that is absence, not an
// install failure, and must read as "this bridge image cannot do python", never as
// "the repo's requirements are broken".
const ABSENT_PATTERNS = [
    /\bcommand not found\b/i,
    /:\s*not found\b/i,
    /\bis not recognized as an internal or external command\b/i,
    /\bNo module named pip\b/i,
    /\bENOENT\b/,
];

/**
 * Decide what dependency ecosystem a clone is, and how to install it.
 *
 * Node is checked first: a repo carrying both a package.json and a requirements.txt is a
 * node repo with a helper script, and its test command is a node one.
 *
 * `npm ci` requires a lockfile and fails hard when it is absent or out of sync; not every
 * arbitrary REPOS entry has one, so a repo with a package.json but no lockfile falls back
 * to `npm install`, which always works and pins nothing. This repo has a lockfile as of
 * 2026-09-13, so its own dispatches get the reproducible path.
 *
 * @param {string} repoDir - Absolute path to the cloned repository
 * @returns {{ ecosystem: 'node'|'python'|'none', command?: string, args?: string[],
 *   display?: string, manifest?: string }}
 */
function detectEcosystem(repoDir) {
    const has = (f) => {
        try {
            return fs.existsSync(path.join(repoDir, f));
        } catch (_) {
            return false;
        }
    };

    if (has('package.json')) {
        const hasLock = has('package-lock.json') || has('npm-shrinkwrap.json');
        const args = hasLock
            ? ['ci', '--no-audit', '--no-fund']
            : ['install', '--no-audit', '--no-fund'];
        return {
            ecosystem: 'node',
            command: 'npm',
            args,
            display: `npm ${args[0]}`,
            manifest: 'package.json',
        };
    }

    if (has('requirements.txt')) {
        // python3 -m pip, not bare `pip`/`pip3`: it uses whichever interpreter is on
        // PATH and, when pip is absent, fails with a message ABSENT_PATTERNS recognises
        // so the outcome is INSTALLER_ABSENT (a clear refusal) rather than INSTALL_FAILED.
        const args = ['-m', 'pip', 'install', '-r', 'requirements.txt'];
        return {
            ecosystem: 'python',
            command: 'python3',
            args,
            display: 'python3 -m pip install -r requirements.txt',
            manifest: 'requirements.txt',
        };
    }

    if (has('pyproject.toml') || has('setup.py')) {
        const args = ['-m', 'pip', 'install', '.'];
        return {
            ecosystem: 'python',
            command: 'python3',
            args,
            display: 'python3 -m pip install .',
            manifest: has('pyproject.toml') ? 'pyproject.toml' : 'setup.py',
        };
    }

    return { ecosystem: 'none' };
}

/**
 * Default installer runner: spawnSync with an argv array (no shell).
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {import('child_process').SpawnSyncReturns<string>}
 */
function defaultRun(command, args, cwd, timeoutMs) {
    return spawnSync(command, args, {
        cwd,
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: timeoutMs,
        // CI keeps npm non-interactive; GIT_TERMINAL_PROMPT stops a private transitive
        // git dependency from blocking on a credential prompt for the whole timeout.
        env: { ...process.env, CI: 'true', GIT_TERMINAL_PROMPT: '0' },
    });
}

/**
 * Install a scratch clone's dependencies.
 *
 * Returns a classification; it never throws for an install failure — the caller decides
 * what a failure means (it stops the dispatch). It also never throws for a repo with no
 * manifest: that is not a failure, it is "nothing to install", the research/audit and
 * no-dependency case, and the task proceeds.
 *
 * @param {string} repoDir - Absolute path to the cloned repository
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Defaults to INSTALL_TIMEOUT_MS
 * @param {function} [options.run] - Injectable runner (for tests)
 * @returns {{ ecosystem: string, outcome: string, ran: boolean, ok: boolean,
 *   harnessFailure: boolean, command: string|null, reason: string, output: string }}
 */
function installDependencies(repoDir, options = {}) {
    const { timeoutMs = INSTALL_TIMEOUT_MS, run = defaultRun } = options;

    const done = (outcome, { ecosystem, command = null, reason, output = '' }) => ({
        ecosystem,
        outcome,
        ran: outcome === OUTCOME.INSTALLED || outcome === OUTCOME.INSTALL_FAILED,
        ok: outcome === OUTCOME.INSTALLED || outcome === OUTCOME.NO_MANIFEST,
        harnessFailure: HARNESS_OUTCOMES.has(outcome),
        command,
        reason,
        output,
    });

    const detected = detectEcosystem(repoDir);

    if (detected.ecosystem === 'none') {
        return done(OUTCOME.NO_MANIFEST, {
            ecosystem: 'none',
            reason: 'no recognised dependency manifest (package.json, requirements.txt, ' +
                'pyproject.toml or setup.py) — nothing to install',
        });
    }

    const { ecosystem, command, args, display } = detected;
    const result = run(command, args, repoDir, timeoutMs);
    const output = `${result.stdout || ''}${result.stderr || ''}`;

    // 1. Killed before finishing. Its own outcome: a value too short cannot be told from
    //    a genuinely broken install without this.
    if (result.error && result.error.code === 'ETIMEDOUT') {
        return done(OUTCOME.TIMED_OUT, {
            ecosystem,
            command: display,
            reason: `\`${display}\` did not finish within ${Math.round(timeoutMs / 1000)}s ` +
                'and was killed — treat as a harness failure, not a broken repo. ' +
                'Raise INSTALL_TIMEOUT_MS if this is a slow network rather than a hang.',
            output,
        });
    }

    // 2. The binary could not be started (ENOENT), or ran but reports its own absence
    //    (no pip module). This is the clear refusal for an ecosystem the image cannot
    //    build — never a silent skip.
    if ((result.error && result.error.code === 'ENOENT') || ABSENT_PATTERNS.some((p) => p.test(output))) {
        const how = result.error ? (result.error.code || result.error.message) : `exit ${result.status}`;
        return done(OUTCOME.INSTALLER_ABSENT, {
            ecosystem,
            command: display,
            reason: `\`${display}\` could not be started (${how}) — the bridge image lacks the ` +
                `installer for a ${ecosystem} repo. This is a harness failure: the bridge cannot ` +
                'verify this repo until its image carries the toolchain.',
            output,
        });
    }

    // 3. Any other spawn-level error.
    if (result.error) {
        return done(OUTCOME.INSTALLER_ABSENT, {
            ecosystem,
            command: display,
            reason: `\`${display}\` could not be run (${result.error.code || result.error.message})`,
            output,
        });
    }

    // 4. Ran and exited non-zero: a real install that really failed.
    if (result.status !== 0) {
        return done(OUTCOME.INSTALL_FAILED, {
            ecosystem,
            command: display,
            reason: `\`${display}\` exited ${result.status} — dependency install failed. ` +
                'This is a harness failure (the bridge could not prepare the clone), ' +
                'distinct from the repo\'s own tests failing.',
            output,
        });
    }

    return done(OUTCOME.INSTALLED, {
        ecosystem,
        command: display,
        reason: `\`${display}\` completed for a ${ecosystem} repo`,
        output,
    });
}

module.exports = {
    INSTALL_TIMEOUT_MS,
    OUTCOME,
    HARNESS_OUTCOMES,
    detectEcosystem,
    installDependencies,
    defaultRun,
};
