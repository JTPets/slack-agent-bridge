'use strict';

/**
 * lib/critique-digest.js
 *
 * THE material the jester is given. Not a transcript — a digest of computed facts.
 *
 * LOGIC CHANGE 2026-09-16: New file (docs/JESTER-DESIGN.md, WORK-TODO #53).
 *
 * WHY NOT A TRANSCRIPT. Reading raw conversation produces remarks about wording. The
 * material worth reading is the GAP BETWEEN WHAT WAS CLAIMED AND WHAT HAPPENED, and
 * most of that is computable with no model at all. The rule this file is built on:
 * **where a signal is computable, compute it.** A model is never asked to notice
 * something a `grep` can prove, because a model that is asked will sometimes say it
 * noticed when it did not.
 *
 * Six signals, five of them computed and one of them conversational:
 *
 *   1. BACKLOG DEFERRAL — items with a Filed date, still open, how old, and how many
 *      times the backlog was edited while they stayed open (lib/backlog-report.js +
 *      lib/repo-history.js). #53 named this as the sharpest thing he has.
 *   2. CLAIMED VS DONE — `Closes <ID>` against `Addresses <ID>` in commit bodies, and
 *      items claimed partially done MORE THAN ONCE (lib/repo-history.js).
 *   3. TASK OUTCOMES — failures, re-attempts and duration outliers from the task
 *      queue, WITH the queue's 24-hour coverage window stated beside them.
 *   4. MERGED VS RUNNING — what landed, and the fact that nothing can say what is
 *      running (WORK-TODO #17). The ABSENCE is the finding; it is reported, not
 *      omitted.
 *   5. OUTPUT THAT REACHES NOBODY — `findOrphans(buildSurface())`, already computed by
 *      lib/agent-surface.js and already printed by scripts/agent-surface.js. Reused,
 *      not re-derived.
 *   6. BULLETINS — the only conversational input, deliberately capped small.
 *
 * EVERY SIGNAL REPORTS ITS OWN AVAILABILITY. A signal that could not be gathered is
 * `available: false` with a reason, never an empty list. "Nothing failed this week"
 * and "I could not read the queue" are opposite findings and the digest never collapses
 * them — the same discipline `lib/test-verdict.js` enforces for test runs.
 *
 * PURE-ISH: it reads files and runs `git log`; it posts nothing, writes nothing, and
 * calls no model. Assembling the digest and acting on it are different jobs
 * (lib/weekly-critique.js does the second).
 */

const backlogReport = require('./backlog-report');
const repoHistory = require('./repo-history');
const bulletinBoard = require('./bulletin-board');
const { buildSurface, findOrphans } = require('./agent-surface');
const {
    DEFAULT_WINDOW_DAYS,
    STALE_DAYS,
    LIMITS,
    backlogSignal,
    historySignal,
    taskSignal,
    bulletinSignal,
    orphanSignal,
} = require('./critique-signals');

/**
 * Build the digest.
 *
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.windowDays=7]
 * @param {object} [options.deps] - Injectable sources (tests).
 * @returns {object} The digest. See docs/JESTER-DESIGN.md section 3.
 */
function buildDigest(options = {}) {
    const now = options.now || new Date();
    const windowDays = Number.isFinite(options.windowDays) ? options.windowDays : DEFAULT_WINDOW_DAYS;
    const since = new Date(now.getTime() - windowDays * 86400000);

    const injected = options.deps || {};
    const deps = {
        backlog: backlogReport,
        history: repoHistory,
        bulletins: bulletinBoard,
        surface: { buildSurface, findOrphans },
        ...injected,
        // Resolved LAST and only when not injected: `getQueue()` constructs the real
        // queue, which mkdir's WORK_DIR. A test that injects a queue must not touch
        // the deployment's directories to do it.
        queue: injected.queue || require('./task-queue').getQueue(),
    };

    const backlog = backlogSignal(now, since, deps);
    const history = historySignal(since, deps);
    const tasks = taskSignal(deps);
    const bulletins = bulletinSignal(since, deps);
    const orphans = orphanSignal(deps);

    // Signal 4's other half. This is NOT a lookup that failed — it is a capability that
    // does not exist, and saying so is the finding. WORK-TODO #17.
    const deploy = {
        runningCommit: null,
        reason: 'nothing records which commit the running process loaded — WORK-TODO #17. '
            + '"merged" and "deployed" are unrelated facts here and no one is told when they diverge.',
    };

    return {
        generatedAt: now.toISOString(),
        windowDays,
        windowSince: since.toISOString(),
        backlog,
        history,
        tasks,
        bulletins,
        orphans,
        deploy,
        thin: isThin({ history, tasks, bulletins }),
    };
}

/**
 * Did anything actually HAPPEN in the window?
 *
 * Thinness is judged on the WINDOWED signals only — commits, terminal tasks, bulletins.
 * The standing backlog is deliberately excluded: an item that has been open for eleven
 * days is not news on the twelfth, and counting it would make every week look eventful
 * and guarantee a padded post. A week in which nothing happened must be able to produce
 * a short honest post saying so, which is only possible if "nothing happened" is
 * computable.
 *
 * An UNAVAILABLE signal does not count as quiet — it counts as unknown, and unknown is
 * not thin. A digest that went quiet because git was missing would otherwise produce
 * "nothing to report" about a week nobody measured.
 *
 * @param {{ history: object, tasks: object, bulletins: object }} signals
 * @returns {boolean}
 */
function isThin({ history, tasks, bulletins }) {
    const quiet = (sig, count) => sig.available && count === 0;
    const tasksTerminal = tasks.available && tasks.counts
        ? tasks.counts.completed + tasks.counts.failed + tasks.counts.interrupted
        : 0;
    return quiet(history, history.commits)
        && quiet(tasks, tasksTerminal)
        && quiet(bulletins, bulletins.items.length);
}


/**
 * Render the digest as the text the model is given.
 *
 * It is a FACT SHEET, not prose: every line is a computed value with its provenance,
 * and nothing in it is an opinion. Availability is rendered explicitly — a signal that
 * could not be gathered prints as "UNAVAILABLE: <reason>" so the model is told the
 * difference between a quiet week and a broken sensor, and can say which.
 *
 * @param {object} d - From buildDigest.
 * @returns {string}
 */
function formatDigestForPrompt(d) {
    const L = [];
    const unavailable = (sig, label) => {
        L.push(`${label}: UNAVAILABLE — ${sig.reason}. Do not report this as "nothing to report".`);
    };

    L.push(`DIGEST — the ${d.windowDays} days ending ${d.generatedAt} (window opens ${d.windowSince}).`);
    L.push('Every figure below was computed from a file or from `git log`. None of it is an opinion.');
    L.push('');

    // 1. Backlog
    if (!d.backlog.available) unavailable(d.backlog, 'BACKLOG');
    else {
        L.push(`BACKLOG: ${d.backlog.open} open items (P1 ${d.backlog.tiers.P1} / P2 ${d.backlog.tiers.P2} / P3 ${d.backlog.tiers.P3}).`);
        L.push(`  ${d.backlog.undated} of them carry NO filed date, so their age is unknown and every age below is a floor.`);
        if (d.backlog.revisions !== null) {
            L.push(`  WORK-TODO.md was edited ${d.backlog.revisions} times in this window. Each edit is an occasion on which every open item was in front of someone and not closed.`);
        } else {
            L.push(`  Backlog revision count UNAVAILABLE — ${d.backlog.revisionsReason}.`);
        }
        L.push(`  ${d.backlog.overThreshold} item(s) have been open ${d.backlog.staleThresholdDays}+ days. Oldest open items:`);
        for (const i of d.backlog.stale) L.push(`    #${i.id} [${i.tier}] ${i.ageDays}d — ${i.title}`);
    }
    L.push('');

    // 2. Claimed vs done
    if (!d.history.available) unavailable(d.history, 'CLAIMS');
    else {
        L.push(`CLAIMED VS DONE: ${d.history.commits} commits in the window. ${d.history.closes.length} "Closes" claim(s), ${d.history.addresses.length} "Addresses" claim(s).`);
        L.push('  "Addresses" means the author judged the item NOT finished. An item addressed repeatedly is work that keeps being touched and keeps not finishing:');
        if (d.history.repeatedlyAddressed.length) {
            for (const r of d.history.repeatedlyAddressed) L.push(`    #${r.id} addressed ${r.count}x and still open — ${r.shas.join(', ')}`);
        } else {
            L.push('    none — no item was addressed more than once in this window.');
        }
    }
    L.push('');

    // 3. Tasks
    if (!d.tasks.available) unavailable(d.tasks, 'TASKS');
    else {
        L.push(`TASKS: the queue retains ${d.tasks.retentionHours} hours, so this covers AT MOST the last day of a ${d.windowDays}-day window. ${d.tasks.rows} terminal row(s) visible.`);
        L.push(`  completed ${d.tasks.counts.completed} / failed ${d.tasks.counts.failed} / interrupted ${d.tasks.counts.interrupted}. Median run ${d.tasks.medianMinutes === null ? 'n/a' : d.tasks.medianMinutes + ' min'}.`);
        for (const f of d.tasks.failures) L.push(`    ${f.status}: ${f.description} (attempt ${f.attempts}) — ${f.error || 'no reason recorded'}`);
        for (const r of d.tasks.reattempted) L.push(`    re-run ${r.attempts}x after ${r.previousStatus || 'an earlier attempt'}: ${r.description}`);
        for (const s2 of d.tasks.slow) L.push(`    outlier (${d.tasks.outlierRule}): ${s2.minutes} min — ${s2.description}`);
        if (!d.tasks.rows) L.push('    No terminal rows. Given the retention above this means "nothing finished in the last day", NOT "nothing failed this week".');
    }
    L.push('');

    // 4. Merged vs running
    L.push('MERGED VS RUNNING:');
    if (d.history.available && d.history.merged.length) {
        for (const c of d.history.merged) L.push(`    ${c.sha} ${c.subject}`);
    }
    L.push(`    Running commit: UNKNOWN. ${d.deploy.reason}`);

    // 5. Output with no reader
    L.push('');
    if (!d.orphans.available) unavailable(d.orphans, 'OUTPUT THAT REACHES NOBODY');
    else if (d.orphans.items.length) {
        L.push(`OUTPUT THAT REACHES NOBODY (${d.orphans.items.length}), from \`node scripts/agent-surface.js\`:`);
        for (const o of d.orphans.items) L.push(`    ${o.id} — ${o.problem}`);
    } else {
        L.push('OUTPUT THAT REACHES NOBODY: none. Every declared agent output has a reader.');
    }

    // 6. Bulletins — the only conversational input, and the smallest
    L.push('');
    if (!d.bulletins.available) unavailable(d.bulletins, 'BULLETINS');
    else if (d.bulletins.items.length) {
        L.push(`BULLETINS in the window (up to ${LIMITS.bulletins}; 7-day retention, so this is not a complete record):`);
        for (const b of d.bulletins.items) L.push(`    [${b.type}] ${b.agentId}: ${b.summary}`);
    } else {
        L.push('BULLETINS: none posted in the window.');
    }

    return L.join('\n');
}

/**
 * One line naming what was checked, for a post that turns out to have little to say.
 *
 * A short post has to be distinguishable from a broken job. This is what makes it so:
 * it states the sensors that ran and found nothing, so silence is evidence rather than
 * an absence of evidence.
 *
 * @param {object} d - From buildDigest.
 * @returns {string}
 */
function formatCoverage(d) {
    const checked = [];
    const note = (sig, label) => checked.push(sig.available ? label : `${label} (UNAVAILABLE: ${sig.reason})`);
    note(d.history, 'commits');
    note(d.tasks, 'task outcomes');
    note(d.bulletins, 'bulletins');
    note(d.backlog, 'backlog ages');
    note(d.orphans, 'unread agent output');
    return `Checked: ${checked.join(', ')} over the ${d.windowDays} days since ${d.windowSince.slice(0, 10)}.`;
}

module.exports = {
    buildDigest,
    formatDigestForPrompt,
    formatCoverage,
    isThin,
    // Re-exported from lib/critique-signals.js so callers and tests have one import.
    DEFAULT_WINDOW_DAYS,
    STALE_DAYS,
    LIMITS,
};
