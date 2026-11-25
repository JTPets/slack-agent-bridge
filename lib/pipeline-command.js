'use strict';

/**
 * lib/pipeline-command.js
 *
 * runCommand: the one way the code-review pipeline runs a command in a scratch clone,
 * synchronously, with an argv array (spawnSync, no shell). Used by Phase 1
 * (lib/review-context.js) and Phase 3 (lib/review-validate.js).
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/code-review-pipeline.js, which re-exports it.
 */

const { spawnSync } = require('child_process');

/**
 * Run a command synchronously and return stdout/stderr.
 * Uses spawnSync (not exec) per security rules.
 *
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {string} cwd - Working directory
 * @param {number} [timeoutMs] - Timeout in ms (default 30000)
 * @returns {{ stdout: string, stderr: string, exitCode: number|null, error: Error|null }}
 */
function runCommand(cmd, args, cwd, timeoutMs = 30000, env = undefined) {
    // LOGIC CHANGE 2026-11-12 (#68): optional env, for the pytest run's
    // PYTHONDONTWRITEBYTECODE (lib/python-test-command.js). Undefined inherits, as before.
    const result = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: 'pipe',
        ...(env ? { env } : {}),
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status,
        error: result.error || null,
    };
}

module.exports = { runCommand };
