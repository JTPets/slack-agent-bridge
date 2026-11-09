'use strict';

/**
 * lib/definition-branch.js
 *
 * WORK-TODO #51, the owner's answer of 2026-11-08 (shape c): a command that changes a
 * TRACKED file — a new agent definition, a provider switch — does not write it into the
 * running checkout. It pushes the change as a NEW BRANCH of the bridge's own repository;
 * the owner merges it; the merged commit then deploys like any other (the update gate,
 * WORK-TODO #17). Nothing changes on the box until then.
 *
 * LOGIC CHANGE 2026-11-09: new file.
 *
 * Why not write the file into the checkout, as `create` used to. Three reasons, the
 * third found while building this: the next update's `git reset --hard` discarded it;
 * nobody reviewed it; and an UNTRACKED agents/<id>/agent.md in the deploy tree makes
 * the self-deploy's `git merge --ff-only` refuse the very commit that adds that file
 * ("untracked working tree files would be overwritten"), stalling every deploy.
 *
 * How. A scratch clone of `main` (lib/clone-lifecycle.js cloneRepo, which configures
 * the deploy key for pushing), the files written, one commit, `git push origin
 * HEAD:refs/heads/<branch>`, then `git ls-remote` to confirm the remote holds exactly
 * that commit. A push to an existing branch name is refused by git (no force). The
 * clone is removed in `finally`. No shell: execFileSync with argv arrays; the branch is
 * validated by lib/git-identifiers.js and every path must stay under agents/.
 *
 * Never throws: returns { ok, branch, sha, reason }.
 *
 * LOGIC CHANGE 2026-11-09: a test run can never push to the real repository. On
 * 2026-11-09 a jest run whose create test passed no `push` reached the real
 * pushDefinitionBranch and pushed agents/test-create-honesty to GitHub (merged as PR
 * #90). Under jest (JEST_WORKER_ID set) the default clone, the one that speaks to
 * GitHub with the deploy key, is refused; a test injects `clone` against a local
 * origin. This also covers the update gate, which runs the full suite on the box
 * where the deploy key exists.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { assertValidBranch } = require('./git-identifiers');

const BRIDGE_REPO = process.env.BRIDGE_REPO || 'jtpets/slack-agent-bridge';
const AUTHOR = ['-c', 'user.name=JT Pets bridge', '-c', 'user.email=bridge-agent@users.noreply.github.com', '-c', 'commit.gpgsign=false'];

/** A path a command may change: a relative path under agents/, no `..`. */
function isAllowedPath(rel) {
    return typeof rel === 'string' && /^agents\/[a-z0-9][a-z0-9._/-]*$/.test(rel) && !rel.split('/').includes('..');
}

/** `<prefix>/<slug>-<YYYYMMDDHHmmss>` in UTC; only used as a unique name. */
function branchName(prefix, slug, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `${prefix}/${slug}-${stamp}`;
}

/**
 * @param {object} p
 * @param {Array<{path: string, content: string}>} p.files - relative to the repo root
 * @param {string} p.branch - the new branch
 * @param {string} p.message - the commit message
 * @param {string} [p.repo] - owner/name; default BRIDGE_REPO
 * @param {Function} [p.clone] - (repo, branch, dir) => void; default cloneRepo (tests inject)
 * @returns {Promise<{ ok: boolean, branch: string, sha?: string, reason?: string }>}
 */
async function pushDefinitionBranch({ files, branch, message, repo = BRIDGE_REPO, clone }) {
    let dir = null;
    try {
        assertValidBranch(branch);
        if (!Array.isArray(files) || !files.length) return { ok: false, branch, reason: 'nothing to change' };
        const bad = files.find(f => !isAllowedPath(f.path) || typeof f.content !== 'string');
        if (bad) return { ok: false, branch, reason: `refused path ${JSON.stringify(bad.path)}: only files under agents/ may change` };

        if (!clone && process.env.JEST_WORKER_ID) {
            return { ok: false, branch, reason: 'refused under jest: a test must inject `clone` (or `push`), never reach the real repository' };
        }
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'definition-branch-'));
        const checkout = path.join(dir, 'repo');
        (clone || require('./clone-lifecycle').cloneRepo)(repo, 'main', checkout);
        const git = (args) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 60000 }).trim();

        for (const f of files) {
            const target = path.join(checkout, f.path);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, f.content, 'utf8');
        }
        git(['add', '--', ...files.map(f => f.path)]);
        if (!git(['status', '--porcelain'])) return { ok: false, branch, reason: 'the files already say this on main; nothing to push' };
        git([...AUTHOR, 'commit', '-q', '-m', message]);
        const sha = git(['rev-parse', 'HEAD']);
        git(['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
        const remote = git(['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0];
        if (remote !== sha) return { ok: false, branch, sha, reason: `the push reported success but the remote branch is at ${remote || 'nothing'}` };
        return { ok: true, branch, sha };
    } catch (err) {
        const detail = String((err.stderr && err.stderr.toString()) || err.message).trim().split('\n')
            .filter(l => l.trim() && !l.startsWith('hint:')).slice(-3).join(' ');
        return { ok: false, branch, reason: detail };
    } finally {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
}

/** The common verdict tail: what the owner does next, and what has NOT happened. */
function describePushed(r, repo = BRIDGE_REPO) {
    return `Pushed branch \`${r.branch}\` (${r.sha.slice(0, 7)}) to \`${repo}\`: ` +
        `https://github.com/${repo}/compare/main...${r.branch}\n` +
        'Nothing has changed on the box yet. Merge it, and the update gate runs the full suite on main and deploys it on green.';
}

module.exports = { pushDefinitionBranch, describePushed, branchName, isAllowedPath, BRIDGE_REPO };
