'use strict';

/**
 * lib/close-reconcile.js
 *
 * THE join WORK-TODO #69 asked for: does every `Closes #N` commit reachable from a ref
 * leave #N purged from WORK-TODO.md at that ref?
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #69): new file. The backlog's convention has two
 * halves — closed items are purged, and the `Closes <ID>` commit body is the record — and
 * nothing joined them. `723dfed` said `Closes WORK-TODO #61.` and never touched the file,
 * so #61 stayed open for four days and two later passes counted it. The two parsers this
 * needs already existed and are reused, not re-derived: `claimsFrom()` in
 * lib/repo-history.js reads the claims, `parseBacklog()` in lib/backlog-report.js reads the
 * open items.
 *
 * THE ID-REUSE TRAP (#67). `3d7ad70` says `Closes #43` about the getRecentCompleted
 * ordering; a different item now holds #43. A check that only asked "is #43 still in the
 * file?" would false-alarm on it forever. So each claim is compared by TITLE: the heading
 * #N carried in the file at the closing commit's parent (the item the commit closed) against
 * the heading #N carries now. Same title still present -> still open, a violation.
 * Different title -> the number was reused, reported but not a violation. No heading at the
 * parent -> the claim cannot be checked (an item filed and closed in one commit, or a
 * pre-flat-format file), reported as unverifiable, never as purged.
 *
 * THE SHALLOW-CLONE TRAP. Every scratch clone a dispatch runs in is `--depth 1`
 * (lib/clone-lifecycle.js). A naive version reads one commit, finds no claims, and passes.
 * Here a shallow checkout is `available: false` with a reason (repo-history's
 * historyAvailable()), and the CLI exits 2 on it, never 0.
 *
 * NO SHELL. Every git call goes through repo-history's runGit (execFileSync, argv array).
 * The one externally supplied value, the ref, is shape-asserted before it reaches argv.
 */

const { REPO_ROOT, historyAvailable, claimsFrom, runGit } = require('./repo-history');
const { parseBacklog } = require('./backlog-report');

const BACKLOG = 'WORK-TODO.md';
const RS = '\x1e';
const FS = '\x1f';

/** `HEAD` or a 7-40 character hex object name. Nothing else reaches argv. */
const REF_SHAPE = /^(?:HEAD|[0-9a-f]{7,40})$/;

/**
 * Classify one claim. Pure.
 *
 * @param {{ id: string, titleBefore: string|null, itemsNow: Map<string,string> }} p
 * @returns {'purged'|'still_open'|'id_reused'|'unverifiable'}
 */
function classifyClaim({ id, titleBefore, itemsNow }) {
    if (!titleBefore) return 'unverifiable';
    if (!itemsNow.has(id)) return 'purged';
    return itemsNow.get(id) === titleBefore ? 'still_open' : 'id_reused';
}

/** Map of id -> title for the items in one copy of the backlog. */
function itemTitles(text) {
    return new Map(parseBacklog(text).items.map((it) => [it.id, it.title]));
}

/** The backlog's text at `rev`, or null when the file does not exist there. */
function backlogAt(rev, repoRoot) {
    const res = runGit(['show', `${rev}:${BACKLOG}`], repoRoot);
    return res.ok ? res.stdout : null;
}

/**
 * Reconcile every `Closes` claim reachable from `at` against the backlog at `at`.
 *
 * @param {object} [options]
 * @param {string} [options.at] - `HEAD` or a commit id.
 * @param {string} [options.repoRoot]
 * @returns {{ available: boolean, reason: string|null, at: string, checked: number,
 *   still_open: object[], id_reused: object[], unverifiable: object[], purged: object[] }}
 */
function reconcile({ at = 'HEAD', repoRoot = REPO_ROOT } = {}) {
    const empty = { at, checked: 0, still_open: [], id_reused: [], unverifiable: [], purged: [] };
    if (!REF_SHAPE.test(at)) {
        return { available: false, reason: `refusing a ref that is not HEAD or a hex commit id: ${at}`, ...empty };
    }
    const gate = historyAvailable(repoRoot);
    if (!gate.available) return { available: false, reason: gate.reason, ...empty };

    const log = runGit(['log', `--format=%H${FS}%s${FS}%b${RS}`, at], repoRoot);
    if (!log.ok) return { available: false, reason: `git log failed: ${log.error}`, ...empty };
    const now = backlogAt(at, repoRoot);
    if (now === null) return { available: false, reason: `${BACKLOG} does not exist at ${at}`, ...empty };

    const commits = log.stdout.split(RS).map((c) => c.replace(/^\n/, '')).filter((c) => c.trim()).map((c) => {
        const [sha, subject, ...rest] = c.split(FS);
        return { sha: sha.trim(), shortSha: sha.trim().slice(0, 7), subject, body: rest.join(FS) };
    });
    const { closes } = claimsFrom(commits);
    const itemsNow = itemTitles(now);
    const result = { available: true, reason: null, ...empty, checked: closes.length };

    for (const claim of closes) {
        const before = backlogAt(`${claim.sha}^`, repoRoot);
        const titleBefore = before === null ? null : (itemTitles(before).get(claim.id) || null);
        const verdict = classifyClaim({ id: claim.id, titleBefore, itemsNow });
        result[verdict].push({ id: claim.id, sha: claim.sha, subject: claim.subject, titleBefore, titleNow: itemsNow.get(claim.id) || null });
    }
    return result;
}

/**
 * Human-readable lines. An unavailable result says so first and claims nothing.
 *
 * @param {ReturnType<typeof reconcile>} r
 * @returns {string[]}
 */
function formatReport(r) {
    if (!r.available) {
        return [`[close-reconcile] UNAVAILABLE — nothing was checked: ${r.reason}`];
    }
    const lines = [`[close-reconcile] ${r.checked} Closes claim(s) reachable from ${r.at}: ` +
        `${r.purged.length} purged, ${r.still_open.length} still open, ` +
        `${r.id_reused.length} on a reused id, ${r.unverifiable.length} unverifiable`];
    for (const c of r.still_open) {
        lines.push(`  ✗ ${c.sha} says Closes #${c.id}, and #${c.id} "${c.titleNow}" is still in ${BACKLOG}`);
    }
    for (const c of r.id_reused) {
        lines.push(`  · ${c.sha} closed #${c.id} "${c.titleBefore}"; #${c.id} is now "${c.titleNow}" (id reused, WORK-TODO #67)`);
    }
    for (const c of r.unverifiable) {
        lines.push(`  ? ${c.sha} says Closes #${c.id}, but ${BACKLOG} at its parent has no #${c.id} heading to compare`);
    }
    return lines;
}

module.exports = { BACKLOG, REF_SHAPE, classifyClaim, reconcile, formatReport, itemTitles };
