'use strict';

/**
 * lib/clone-target.js
 *
 * The boundary check for a scratch clone's directory (assertValidTargetDir): both
 * the clone (lib/clone-lifecycle.js cloneRepo) and the delivery check
 * (lib/clone-delivery.js detectUndeliveredWork) refuse a path it rejects. Moved
 * unchanged out of lib/clone-lifecycle.js (WORK-TODO #10, B28, 2026-11-12), which
 * re-exports it as the same object.
 */

const path = require('path');

/**
 * Boundary check for a clone target directory. Reject, never sanitise — the same
 * rule lib/git-identifiers.js applies to REPO and BRANCH, and for the same reason:
 * rewriting a path silently clones into somewhere other than the caller asked for.
 *
 * LOGIC CHANGE 2026-09-14: cloneRepo previously checked targetDir only for
 * "non-empty string". That is not enough for two reasons:
 *
 *   - argv arrays defeat shells, not git's option parsing. `git clone ... <dir>`
 *     with a dir of "--upload-pack=..." is read by git as an OPTION, not a path.
 *     The `--` separator cloneRepo now passes closes that for the positional
 *     arguments; this check closes it for the value itself, so neither stands alone.
 *   - targetDir is the one cloneRepo argument with no validated provenance. Its only
 *     caller today builds it as path.join(WORK_DIR, `task-${msg.ts...}`) — WORK_DIR
 *     is an unvalidated environment variable and msg.ts an unvalidated Slack API
 *     field. Neither is operator-typed Slack text today, and NOTHING PREVENTS A
 *     FUTURE CALLER FROM MAKING IT SO: the function is exported, the parameter is
 *     documented as "a path", and a dirName built from task.description or
 *     task.branch would read as an obvious convenience. An absolute, non-flag path
 *     is the invariant every current caller already satisfies, so asserting it costs
 *     nothing and removes the standing invitation.
 *
 * @param {*} targetDir
 * @returns {string} The validated path.
 * @throws {Error} If the value is not an absolute, non-flag, NUL-free path.
 */
function assertValidTargetDir(targetDir) {
  const reject = (why) => {
    throw new Error(`Rejected clone target directory: ${why}`);
  };
  if (typeof targetDir !== 'string' || targetDir.trim() === '') {
    reject('expected a non-empty path');
  }
  if (targetDir.includes('\0')) {
    reject('path contains a NUL byte');
  }
  if (targetDir.startsWith('-')) {
    // git reads a leading "-" as an option even through an argv array.
    reject('path starts with "-", which git would read as an option');
  }
  if (!path.isAbsolute(targetDir)) {
    reject(`expected an absolute path, got a relative one`);
  }
  return targetDir;
}

module.exports = { assertValidTargetDir };
