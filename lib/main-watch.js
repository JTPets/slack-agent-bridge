'use strict';

/**
 * lib/main-watch.js
 *
 * WORK-TODO #66: nothing watched the repository, so a merge to `main` and the deploy
 * that should follow it were unrelated events and a forgotten deploy was found by a
 * person noticing. This asks the remote what `main` is, on an interval, and compares
 * it with the commit the bridge BOOTED on (lib/repo-history.js loadedCommit(), read
 * once at boot - #17). When they differ it posts to #sqtools-ops ONCE per new `main`
 * sha. Report-only: it pulls, restarts and writes nothing.
 *
 * LOGIC CHANGE 2026-10-04: new file.
 *
 * What it cannot tell, stated: `ls-remote` returns a sha, not history, so "differs"
 * is all it can say - the running commit may be BEHIND main (the usual case: merged,
 * not deployed) or simply not on main (a branch checked out on the box). The post says
 * "differs", never "behind". A remote it cannot read is reported once per process and
 * then logged, so a missing credential is not a post every interval.
 */

const { execFile } = require('child_process');

const SHA = /^[0-9a-f]{40}$/;

/**
 * `git ls-remote -- origin refs/heads/main` in `repoRoot`, async (no event-loop block),
 * argv array, no shell. Resolves { ok, sha } or { ok: false, reason }; never rejects.
 */
function remoteMainSha(repoRoot, execFileFn = execFile) {
    return new Promise((resolve) => {
        execFileFn('git', ['ls-remote', '--', 'origin', 'refs/heads/main'], {
            cwd: repoRoot,
            timeout: 20000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        }, (err, stdout, stderr) => {
            if (err) return resolve({ ok: false, reason: String(stderr || err.message).trim().slice(0, 300) });
            const sha = String(stdout).trim().split(/\s+/)[0] || '';
            if (!SHA.test(sha)) return resolve({ ok: false, reason: `no refs/heads/main sha in ls-remote output (${sha.slice(0, 40) || 'empty'})` });
            return resolve({ ok: true, sha });
        });
    });
}

/** The #sqtools-ops text for a running commit that differs from main. */
function describeDivergence(boot, mainSha) {
    return `:arrow_up: *\`main\` differs from the running bridge.* Running \`${boot.short}\` (${boot.subject}); ` +
        `\`main\` is \`${mainSha.slice(0, 7)}\`.\n` +
        'Usually this means a merge is not deployed yet: merged code reaches the running process only when the ' +
        'container is restarted (`docker compose restart jt-agent`). Posted once per new `main` commit.';
}

/**
 * @param {object} deps
 * @param {object} deps.bootCommit - loadedCommit() result.
 * @param {Function} deps.readMain - async () => { ok, sha } | { ok: false, reason }.
 * @param {Function} deps.notify - async (text) => any. Posts to #sqtools-ops.
 * @returns {{ tick: () => Promise<string> }} tick resolves to what it found:
 *   'boot_unknown' | 'remote_unreadable' | 'current' | 'reported' | 'already_reported'.
 */
function createMainWatch({ bootCommit, readMain, notify, logger = console }) {
    let lastReported = null;
    let unreadableReported = false;
    let bootUnknownLogged = false;

    async function tick() {
        if (!bootCommit || !bootCommit.available || !SHA.test(bootCommit.sha || '')) {
            if (!bootUnknownLogged) {
                logger.warn('[main-watch] The boot commit is unknown, so main cannot be compared with it. Not watching.');
                bootUnknownLogged = true;
            }
            return 'boot_unknown';
        }
        let main;
        try {
            main = await readMain();
        } catch (err) {
            main = { ok: false, reason: err.message };
        }
        if (!main || !main.ok) {
            const reason = (main && main.reason) || 'no result';
            logger.warn(`[main-watch] Could not read origin main: ${reason}`);
            if (!unreadableReported) {
                unreadableReported = true;
                await Promise.resolve(notify(
                    `:warning: *Cannot watch \`main\`* — \`git ls-remote origin\` failed in the deploy checkout: ${reason}\n` +
                    'Whether a merge is deployed has to be checked by hand. Reported once per process.'
                )).catch(() => {});
            }
            return 'remote_unreadable';
        }
        if (main.sha === bootCommit.sha) return 'current';
        if (main.sha === lastReported) return 'already_reported';
        lastReported = main.sha;
        await Promise.resolve(notify(describeDivergence(bootCommit, main.sha))).catch((err) => {
            logger.error(`[main-watch] Could not post the divergence: ${err.message}`);
        });
        return 'reported';
    }

    return { tick };
}

module.exports = { remoteMainSha, describeDivergence, createMainWatch };
