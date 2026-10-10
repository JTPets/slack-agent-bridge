/**
 * lib/boot-record.js
 *
 * The commit this process booted on, held for readers that run later in the same
 * process. bridge-agent.js reads it once at startup (lib/repo-history.js
 * loadedCommit(), WORK-TODO #17) and records it here; a reader such as the jester's
 * digest asks for that record instead of reading the working tree again, because a
 * read at query time answers "what is on disk now", which a `git pull` without a
 * restart changes.
 *
 * LOGIC CHANGE 2026-10-10: created. The weekly critique said "Running commit: UNKNOWN,
 * nothing records it" every week after the boot report landed on 2026-10-02, because
 * the digest had no way to reach the value bridge-agent.js already held.
 */

'use strict';

let bootCommit = null;

/**
 * @param {object} commit - lib/repo-history.js loadedCommit() result
 * @returns {object} the same commit, so the call can wrap the read
 */
function recordBootCommit(commit) {
    bootCommit = commit || null;
    return commit;
}

/** @returns {object|null} what recordBootCommit stored, or null when nothing has */
function getBootCommit() {
    return bootCommit;
}

module.exports = { recordBootCommit, getBootCommit };
