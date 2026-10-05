'use strict';

/**
 * lib/python-venv.js
 *
 * WORK-TODO #68, the venv half (B6, 2026-10-04). The `jt-agent` image is Debian 12 with
 * PEP 668 in force (`EXTERNALLY-MANAGED` present, operator probe 2026-09-20), so a
 * system-wide `python3 -m pip install` refuses even where pip exists. A python clone's
 * dependencies therefore install into a virtualenv INSIDE the clone, at `.venv/`.
 *
 * LOGIC CHANGE 2026-10-04: new file, called by lib/dependency-install.js.
 *
 * Two properties this owns:
 *   - `.venv/` is added to the clone's `.git/info/exclude` (local, never committed) before
 *     it is created. Without that, an untracked `.venv/` makes `git status --porcelain`
 *     non-empty and lib/clone-lifecycle.js detectUndeliveredWork would preserve EVERY
 *     python clone as "uncommitted changes".
 *   - A venv that cannot be created is the IMAGE's failure (no `python3`, no `venv`
 *     module, or no `ensurepip` to seed pip - the last is what the 2026-09-20 probe found),
 *     so the caller maps it to INSTALLER_ABSENT, never INSTALL_FAILED.
 *
 * Unverified end to end: the deployed image lacks ensurepip, so on the box today venv
 * creation is EXPECTED to fail and the dispatch to refuse as INSTALLER_ABSENT, which is
 * the correct loud outcome until the image carries python3-venv (the Dockerfile, #70).
 */

const fs = require('fs');
const path = require('path');

const VENV_DIR = '.venv';

/** The interpreter inside a clone's venv. */
function venvPython(repoDir) {
    return path.join(repoDir, VENV_DIR, 'bin', 'python');
}

/** Add `.venv/` to the clone's local exclude file. Returns false when there is no .git dir. */
function excludeVenv(repoDir) {
    const infoDir = path.join(repoDir, '.git', 'info');
    if (!fs.existsSync(path.join(repoDir, '.git'))) return false;
    fs.mkdirSync(infoDir, { recursive: true });
    const exclude = path.join(infoDir, 'exclude');
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!current.split('\n').includes(`/${VENV_DIR}/`)) {
        fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}/${VENV_DIR}/\n`);
    }
    return true;
}

/**
 * Create the venv. Returns { ok: true, python } or { ok: false, timedOut, reason, output }.
 * @param {string} repoDir
 * @param {Function} run - (command, args, cwd, timeoutMs) => spawnSync-shaped result.
 * @param {number} timeoutMs
 */
function createVenv(repoDir, run, timeoutMs) {
    try {
        excludeVenv(repoDir);
    } catch (err) {
        return { ok: false, timedOut: false, reason: `could not write .git/info/exclude: ${err.message}`, output: '' };
    }
    const result = run('python3', ['-m', 'venv', VENV_DIR], repoDir, timeoutMs);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error && result.error.code === 'ETIMEDOUT') {
        return { ok: false, timedOut: true, reason: '`python3 -m venv .venv` timed out', output };
    }
    if (result.error || result.status !== 0) {
        const how = result.error ? (result.error.code || result.error.message) : `exit ${result.status}`;
        return {
            ok: false,
            timedOut: false,
            reason: `\`python3 -m venv .venv\` failed (${how}) — the image cannot create a virtualenv ` +
                '(missing python3, the venv module, or ensurepip; Debian ships the last two as python3-venv)',
            output,
        };
    }
    return { ok: true, python: venvPython(repoDir) };
}

module.exports = { VENV_DIR, venvPython, excludeVenv, createVenv };
