'use strict';

/**
 * lib/python-test-command.js
 *
 * WORK-TODO #68, the Phase-3 half: which command runs a python clone's tests.
 *
 * LOGIC CHANGE 2026-11-12: new file. Phase 3 (validateOutput, lib/code-review-pipeline.js)
 * ran only the repo's npm test script, so a python clone's suite was never run: the
 * install step had built `.venv/` (lib/python-venv.js) and then the gate asked npm, which
 * answered "Missing script" (RUNNER_ABSENT) for every python dispatch. This module says
 * what to run instead; the run itself and its classification stay in validateOutput and
 * lib/test-verdict.js, the one classifier.
 *
 * The rule:
 *   - Only when lib/dependency-install.js detectEcosystem says `python`. A repo with a
 *     package.json is node there (it is checked first), so every node repo is unchanged.
 *   - The VENV interpreter, `.venv/bin/python -m pytest`, never system python: the clone's
 *     dependencies (pytest included, when the repo declares it) live only in the venv.
 *     A clone with no venv makes the spawn fail ENOENT, which classifies RUNNER_ABSENT;
 *     a venv without pytest prints "No module named pytest", also RUNNER_ABSENT.
 *   - It must not dirty the clone. lib/clone-lifecycle.js detectUndeliveredWork preserves
 *     a clone whose `git status --porcelain` is non-empty, so `.pytest_cache/` and
 *     `__pycache__/` would turn every delivered python task into a "preserved, undelivered"
 *     alert. `-p no:cacheprovider` stops the first, PYTHONDONTWRITEBYTECODE the second.
 *
 * An argv array, never a shell string (tests/no-shell-execution.test.js).
 */

const { detectEcosystem } = require('./dependency-install');
const { venvPython, VENV_DIR } = require('./python-venv');

const PYTEST_ARGS = ['-m', 'pytest', '-p', 'no:cacheprovider'];

/**
 * The Phase-3 test command for a python clone, or null when the clone is not python.
 *
 * @param {string} repoDir - The scratch clone.
 * @returns {{ command: string, args: string[], display: string, env: object }|null}
 */
function pythonTestCommand(repoDir) {
    let detected;
    try {
        detected = detectEcosystem(repoDir);
    } catch (_) {
        return null;
    }
    if (!detected || detected.ecosystem !== 'python') return null;
    return {
        command: venvPython(repoDir),
        args: [...PYTEST_ARGS],
        display: `${VENV_DIR}/bin/python ${PYTEST_ARGS.join(' ')}`,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    };
}

module.exports = { PYTEST_ARGS, pythonTestCommand };
