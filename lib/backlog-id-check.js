'use strict';

/**
 * lib/backlog-id-check.js
 *
 * The pre-push check WORK-TODO #67 left open: does this branch file a WORK-TODO.md item
 * under a number that `main` has already used?
 *
 * LOGIC CHANGE 2026-11-08 (WORK-TODO #67): new file. Two branches cut from the same base
 * read the same highest ID and allocate the same numbers. The duplicate-ID command in
 * WORK-TODO.md only fires once both sides are in one tree, which is after the colliding
 * numbers are cited in bodies and commit messages. This check runs against `main` as the
 * remote has it NOW, before the push, so the collision is found while it is still one
 * branch's private problem.
 *
 * What counts:
 *   - an id NEW on the branch (absent at the merge base) that `main` now holds under a
 *     different title is a COLLISION;
 *   - an id new on the branch that `main` holds under the SAME title is the same item
 *     landed on both sides (a cherry-pick), and is fine;
 *   - an id new on the branch that `main`'s history has ever carried, though `main` no
 *     longer does, is a REUSE: the item was closed and purged, and IDs are never reused.
 *
 * What it does not do: decide a numbering scheme. #67's two scheme changes stay
 * undecided; this narrows the window to "main moved between the push and the merge".
 *
 * NO SHELL. Every git call goes through lib/repo-history.js runGit (execFileSync, argv
 * array). The refs are shape-asserted before they reach argv; an id is digits plus an
 * optional letter by construction of the heading pattern.
 */

const { REPO_ROOT, historyAvailable, runGit } = require('./repo-history');
const { BACKLOG, itemTitles } = require('./close-reconcile');

/** HEAD, FETCH_HEAD, a hex object name, or a branch name such as main or origin/main.
 *  It starts alphanumeric (so never a leading '-' that git would read as an option) and
 *  carries no '..'. */
const REF_SHAPE = /^(?!.*\.\.)(?:HEAD|FETCH_HEAD|[A-Za-z0-9][A-Za-z0-9._/-]{0,200})$/;

function textAt(rev, repoRoot) {
    const res = runGit(['show', `${rev}:${BACKLOG}`], repoRoot);
    return res.ok ? res.stdout : '';
}

/**
 * Classify the branch's new ids against `main`. Pure.
 *
 * @param {{ head: Map<string,string>, mergeBase: Map<string,string>,
 *   base: Map<string,string>, everOnBase: (id: string) => string|null }} p
 *   everOnBase returns a short sha of a base commit that touched the id's heading, or null.
 * @returns {{ newIds: string[], collisions: object[], reused: object[] }}
 */
function classifyNewIds({ head, mergeBase, base, everOnBase }) {
    const newIds = [...head.keys()].filter((id) => !mergeBase.has(id));
    const collisions = [];
    const reused = [];
    for (const id of newIds) {
        const titleHead = head.get(id);
        if (base.has(id)) {
            if (base.get(id) !== titleHead) collisions.push({ id, titleHead, titleBase: base.get(id) });
            continue;
        }
        const sha = everOnBase(id);
        if (sha) reused.push({ id, titleHead, sha });
    }
    return { newIds, collisions, reused };
}

/**
 * @param {object} [options]
 * @param {string} [options.head] - the branch tip, default HEAD.
 * @param {string} [options.base] - main as the remote has it, default origin/main.
 * @param {string} [options.repoRoot]
 */
function checkBacklogIds({ head = 'HEAD', base = 'origin/main', repoRoot = REPO_ROOT } = {}) {
    const empty = { head, base, mergeBase: null, newIds: [], collisions: [], reused: [] };
    for (const ref of [head, base]) {
        if (!REF_SHAPE.test(ref)) return { available: false, reason: `refusing a ref of an unexpected shape: ${ref}`, ...empty };
    }
    const gate = historyAvailable(repoRoot);
    if (!gate.available) return { available: false, reason: gate.reason, ...empty };

    const mb = runGit(['merge-base', head, base], repoRoot);
    if (!mb.ok) return { available: false, reason: `no merge base between ${head} and ${base}: ${mb.error}`, ...empty };
    const mergeBase = mb.stdout.trim();

    const everOnBase = (id) => {
        const res = runGit(['log', '--format=%h', `-G^### ${id}\\. `, base, '--', BACKLOG], repoRoot);
        if (!res.ok) return null;
        const shas = res.stdout.split('\n').filter(Boolean);
        return shas.length ? shas[shas.length - 1] : null;
    };
    const verdict = classifyNewIds({
        head: itemTitles(textAt(head, repoRoot)),
        mergeBase: itemTitles(textAt(mergeBase, repoRoot)),
        base: itemTitles(textAt(base, repoRoot)),
        everOnBase,
    });
    return { available: true, reason: null, ...empty, mergeBase, ...verdict };
}

/** Human-readable lines. An unavailable result says so first and claims nothing. */
function formatReport(r) {
    if (!r.available) return [`[backlog-ids] UNAVAILABLE — nothing was checked: ${r.reason}`];
    const lines = [`[backlog-ids] ${r.newIds.length} new id(s) on ${r.head} since ${r.mergeBase.slice(0, 7)}: ` +
        `${r.collisions.length} taken on ${r.base}, ${r.reused.length} reused`];
    for (const c of r.collisions) {
        lines.push(`  ✗ #${c.id} "${c.titleHead}" — ${r.base} already has #${c.id} "${c.titleBase}". Renumber this branch's item.`);
    }
    for (const c of r.reused) {
        lines.push(`  ✗ #${c.id} "${c.titleHead}" — #${c.id} was used on ${r.base} before (${c.sha}) and IDs are never reused.`);
    }
    if (r.collisions.length || r.reused.length) {
        lines.push('  Take the next number after the highest on either side (docs/EXECUTOR-CONTRACT.md, WORK-TODO.md).');
    }
    return lines;
}

module.exports = { REF_SHAPE, classifyNewIds, checkBacklogIds, formatReport };
