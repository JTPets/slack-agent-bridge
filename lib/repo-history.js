'use strict';

/**
 * lib/repo-history.js
 *
 * Git-derived signals about THIS repository, read from the checkout the bridge process
 * is running out of.
 *
 * LOGIC CHANGE 2026-09-16: New file, for the jester's weekly critique
 * (docs/JESTER-DESIGN.md, WORK-TODO #53). It answers "what was claimed, and what
 * happened" from commit bodies — `Closes <ID>` versus `Addresses <ID>` — which #53
 * named as one of the three computable signals worth more than a transcript.
 *
 * WHY IT READS THE BRIDGE'S OWN CHECKOUT AND NOT A SCRATCH CLONE. A task's scratch
 * clone is created with `--depth 1` (`lib/clone-lifecycle.js:139`), so it contains
 * exactly one commit and can answer none of this. The bridge's own checkout is the
 * only place in the deployment with history. See docs/JESTER-DESIGN.md section 1.4.
 *
 * NO SHELL, EVER. Every call is `execFileSync` with an argv array, per CLAUDE.md's
 * Critical Rules and `tests/no-shell-execution.test.js`. A `--` separator precedes
 * pathspecs; it is deliberately NOT used before revisions, because after `git log` a
 * `--` begins a pathspec rather than ending option parsing (docs/EXECUTOR-CONTRACT.md
 * section 5). The only value that reaches argv from outside is an ISO timestamp this
 * module generates and shape-asserts; nothing here is reachable from Slack.
 *
 * EVERY FAILURE IS "UNAVAILABLE", NEVER "NOTHING FOUND". A checkout with no `.git`, a
 * shallow clone, or a `git` that is not installed each return `available: false` with
 * a reason. A digest that reported "no partial work this week" because it could not
 * run `git log` would be the false-green this repository files as its worst class of
 * defect.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

/** Record separator / field separator — bytes that cannot occur in a commit subject. */
const RS = '\x1e';
const FS = '\x1f';

/**
 * A commit-body line that makes a claim about a backlog item: it STARTS with `Closes`
 * or `Addresses` (the two words docs/EXECUTOR-CONTRACT.md section 4 defines) and names
 * at least one `#<id>`.
 *
 * THE `#` IS MANDATORY, and that is a correction rather than a preference. The first
 * version of this matched an optional `#` followed by digits, which read
 * `Closes WORK-TODO P1 #18.` — a real commit body in this repository, `6454fb0` — as a
 * claim about item **#1**, because `P1` supplies a digit before `#18` does. A parser
 * that invents a citation is worse than one that finds nothing, because the invented
 * one is repeated to a human as a fact. Every `Closes`/`Addresses` line in this
 * repository's history uses `#<id>`; a line with no `#` (`Addresses the dispatch.`,
 * `Addresses nothing yet`) names no item and is correctly ignored.
 *
 * Regenerate the corpus this was checked against:
 *   git log --format='%H%n%b' --since="14 days ago" | grep -iE "^\s*(closes|addresses)\b"
 */
const CLAIM_LINE = /^[ \t]*(closes|addresses)\b([^\n]*)$/gim;
/** Every `#<id>` on such a line. `4b`-style suffixed ids are real (WORK-TODO #4b). */
const ITEM_REF = /#([0-9]+[a-z]?)\b/g;

/** An ISO-8601 instant, which is the only externally-shaped value reaching argv. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Run one git command. Never throws; returns `{ ok, stdout, error }`.
 *
 * @param {string[]} args - argv AFTER the program name. No shell is involved.
 * @param {string} cwd - Repository root.
 * @returns {{ ok: boolean, stdout: string, error: string|null }}
 */
function git(args, cwd) {
    try {
        const stdout = execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            timeout: 15000,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { ok: true, stdout, error: null };
    } catch (err) {
        return { ok: false, stdout: '', error: (err.stderr || err.message || String(err)).trim() };
    }
}

/**
 * Can this checkout answer history questions at all?
 *
 * A SHALLOW repository is reported as unavailable rather than as a short history: a
 * `--depth 1` clone would report "one commit this week" and be believed.
 *
 * @param {string} [repoRoot]
 * @returns {{ available: boolean, reason: string|null, shallow: boolean }}
 */
function historyAvailable(repoRoot = REPO_ROOT) {
    const inTree = git(['rev-parse', '--is-inside-work-tree'], repoRoot);
    if (!inTree.ok) return { available: false, reason: `no usable git checkout: ${inTree.error}`, shallow: false };
    if (inTree.stdout.trim() !== 'true') return { available: false, reason: 'not inside a git work tree', shallow: false };

    const shallow = git(['rev-parse', '--is-shallow-repository'], repoRoot);
    if (shallow.ok && shallow.stdout.trim() === 'true') {
        return { available: false, reason: 'the checkout is a shallow clone — history is truncated and any count from it would be wrong', shallow: true };
    }
    return { available: true, reason: null, shallow: false };
}

/**
 * Commits reachable from HEAD since an instant, newest first.
 *
 * @param {Date} since
 * @param {string} [repoRoot]
 * @returns {{ available: boolean, reason: string|null, commits: object[] }}
 */
function commitsSince(since, repoRoot = REPO_ROOT) {
    const sinceISO = since.toISOString();
    // Shape-asserted rather than trusted: this is the one value that reaches argv, and
    // a positional beginning with `-` is read by git as a flag however it arrived.
    if (!ISO_INSTANT.test(sinceISO)) {
        return { available: false, reason: `refusing a malformed since value: ${sinceISO}`, commits: [] };
    }

    const gate = historyAvailable(repoRoot);
    if (!gate.available) return { available: false, reason: gate.reason, commits: [] };

    const res = git(['log', `--since=${sinceISO}`, `--format=%H${FS}%aI${FS}%s${FS}%b${RS}`], repoRoot);
    if (!res.ok) return { available: false, reason: `git log failed: ${res.error}`, commits: [] };

    const commits = res.stdout
        .split(RS)
        .map(chunk => chunk.replace(/^\n/, ''))
        .filter(chunk => chunk.trim())
        .map(chunk => {
            const [sha, date, subject, ...rest] = chunk.split(FS);
            return { sha: (sha || '').trim(), shortSha: (sha || '').trim().slice(0, 7), date, subject, body: rest.join(FS) || '' };
        })
        .filter(c => c.sha);

    return { available: true, reason: null, commits };
}

/**
 * Pull every `Closes <ID>` / `Addresses <ID>` claim out of a set of commits.
 *
 * `repeatedlyAddressed` is the signal worth having: an item claimed *partially* done
 * more than once is work that keeps being touched and keeps not finishing. That is a
 * fact about the log, not an opinion about the work.
 *
 * @param {object[]} commits - From commitsSince.
 * @returns {{ closes: object[], addresses: object[], repeatedlyAddressed: object[] }}
 */
function claimsFrom(commits) {
    const closes = [];
    const addresses = [];

    for (const c of commits || []) {
        const text = `${c.subject}\n${c.body}`;
        for (const line of text.matchAll(CLAIM_LINE)) {
            const kind = line[1].toLowerCase();
            const bucket = kind === 'closes' ? closes : addresses;
            // Deduplicated per line: `Addresses #41 (… the DoD of #41 is …)` is one
            // claim about one item, not two.
            const seen = new Set();
            for (const ref of line[2].matchAll(ITEM_REF)) {
                if (seen.has(ref[1])) continue;
                seen.add(ref[1]);
                bucket.push({ id: ref[1], sha: c.shortSha, subject: c.subject });
            }
        }
    }

    const byId = new Map();
    for (const a of addresses) {
        if (!byId.has(a.id)) byId.set(a.id, []);
        byId.get(a.id).push(a.sha);
    }
    const repeatedlyAddressed = [...byId.entries()]
        .filter(([, shas]) => shas.length > 1)
        .map(([id, shas]) => ({ id, count: shas.length, shas }))
        .sort((a, b) => b.count - a.count);

    return { closes, addresses, repeatedlyAddressed };
}

/**
 * How many commits touched one path since an instant.
 *
 * Used to answer "how many times was the backlog edited while this item stayed open" —
 * each edit is an occasion on which the item was in front of someone and not closed.
 * A count of occasions is a fact; "repeatedly deferred" is what that fact means.
 *
 * @param {string} relPath - Repo-relative path. Passed after `--` as a pathspec.
 * @param {Date} since
 * @param {string} [repoRoot]
 * @returns {{ available: boolean, reason: string|null, count: number }}
 */
function revisionsSince(relPath, since, repoRoot = REPO_ROOT) {
    const sinceISO = since.toISOString();
    if (!ISO_INSTANT.test(sinceISO)) {
        return { available: false, reason: `refusing a malformed since value: ${sinceISO}`, count: 0 };
    }
    const gate = historyAvailable(repoRoot);
    if (!gate.available) return { available: false, reason: gate.reason, count: 0 };

    const res = git(['log', `--since=${sinceISO}`, '--format=%H', '--', relPath], repoRoot);
    if (!res.ok) return { available: false, reason: `git log failed: ${res.error}`, count: 0 };
    return { available: true, reason: null, count: res.stdout.split('\n').filter(Boolean).length };
}

module.exports = {
    REPO_ROOT,
    historyAvailable,
    commitsSince,
    claimsFrom,
    revisionsSince,
};
