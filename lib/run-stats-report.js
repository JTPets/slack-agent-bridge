'use strict';

/**
 * lib/run-stats-report.js
 *
 * WORK-TODO #86 and #59: `ASK: runs [days]`. Per agent over the last n Toronto days (default
 * 7, max 30, from lib/run-stats-store.js's record): runs, failed runs, estimated cost, turns,
 * p50/p95 duration, the longest and p95 quiet gap, the longest repeat of one tool call, and
 * how many stall or loop alerts fired; then the estimated cost per day. It replaces the
 * `docker logs ... | grep "[run-stats]"` paste. Report only: it sets no threshold.
 *
 * LOGIC CHANGE 2026-11-25: new file. Read-only; posts nothing (the router's caller does).
 */

const { dayKey, addDays, STORE_TIME_ZONE } = require('./time-format');

const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;

/**
 * Nearest-rank percentile of a list of numbers (p in 0-100); null for an empty list.
 * Not lib/critique-signals.js median(): that averages the two middle values, this picks a
 * value that a run actually had, which is what a threshold is set from.
 */
function percentile(values, p) {
    const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

const failed = (r) => r.signal !== null || (r.exit !== null && r.exit !== 0);
const known = (runs, key) => runs.map((r) => r[key]).filter((v) => typeof v === 'number');
const sum = (values) => values.reduce((a, b) => a + b, 0);

/**
 * Group the runs inside the window. Pure.
 * @param {object[]} runs - Store records.
 * @param {{ days: number, now?: Date }} opts
 * @returns {{ from: string, to: string, agents: object[], perDay: object[], total: number }}
 */
function summarizeRuns(runs, { days, now = new Date() }) {
    const to = dayKey(now, STORE_TIME_ZONE);
    const from = addDays(to, -(days - 1));
    const inWindow = runs
        .map((r) => ({ ...r, day: dayKey(new Date(r.at), STORE_TIME_ZONE) }))
        .filter((r) => r.day >= from && r.day <= to);

    const byAgent = new Map();
    const byDay = new Map();
    for (const r of inWindow) {
        if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
        byAgent.get(r.agent_id).push(r);
        if (!byDay.has(r.day)) byDay.set(r.day, []);
        byDay.get(r.day).push(r);
    }

    const agents = [...byAgent.entries()].map(([agentId, list]) => {
        const costs = known(list, 'costUsd');
        return {
            agentId,
            runs: list.length,
            failed: list.filter(failed).length,
            costUsd: costs.length ? sum(costs) : null,
            costKnown: costs.length,
            turns: sum(known(list, 'numTurns')),
            p50DurationMs: percentile(known(list, 'durationMs'), 50),
            p95DurationMs: percentile(known(list, 'durationMs'), 95),
            maxQuietMs: known(list, 'maxQuietMs').length ? Math.max(...known(list, 'maxQuietMs')) : null,
            p95QuietMs: percentile(known(list, 'maxQuietMs'), 95),
            maxRepeat: known(list, 'maxRepeat').length ? Math.max(...known(list, 'maxRepeat')) : null,
            stallAlerts: list.filter((r) => (r.alerts || []).includes('stall')).length,
            loopAlerts: list.filter((r) => (r.alerts || []).includes('loop')).length,
        };
    }).sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0) || a.agentId.localeCompare(b.agentId));

    const perDay = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, list]) => {
        const costs = known(list, 'costUsd');
        return { day, runs: list.length, costUsd: costs.length ? sum(costs) : null };
    });

    return { from, to, agents, perDay, total: inWindow.length };
}

const usd = (v) => (v === null ? 'n/a' : `$${v.toFixed(2)}`);
function dur(ms) {
    if (ms === null) return 'n/a';
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
}

/** The Slack text. */
function formatRunsReport(summary, days) {
    const window = days === 1 ? `today (${summary.to})` : `the last ${days} days (${summary.from} to ${summary.to}, Toronto)`;
    if (!summary.total) {
        return `No Claude runs are recorded for ${window}. Runs are recorded from the commit that added \`runs\`; earlier runs exist only in the container log.`;
    }
    const lines = [`*Claude runs, ${window}: ${summary.total} run(s)*`];
    for (const a of summary.agents) {
        const cost = a.costKnown < a.runs ? `${usd(a.costUsd)} (${a.costKnown} of ${a.runs} reported a cost)` : usd(a.costUsd);
        lines.push(
            `• *${a.agentId}*: ${a.runs} run(s)${a.failed ? `, ${a.failed} failed` : ''}, est. ${cost}, ${a.turns} turn(s)\n` +
            `   duration p50 ${dur(a.p50DurationMs)} / p95 ${dur(a.p95DurationMs)}; quiet gap longest ${dur(a.maxQuietMs)} / p95 ${dur(a.p95QuietMs)}; ` +
            `longest repeat ${a.maxRepeat === null ? 'n/a' : a.maxRepeat}` +
            (a.stallAlerts || a.loopAlerts ? `; alerts: ${a.stallAlerts} stall, ${a.loopAlerts} loop` : '')
        );
    }
    lines.push(`*Per day:* ${summary.perDay.map((d) => `${d.day} ${d.runs} run(s) ${usd(d.costUsd)}`).join(' | ')}`);
    lines.push('_Cost is the Claude CLI\'s estimate at API prices. Runs are billed as subscription usage (CLAUDE_CODE_OAUTH_TOKEN), so it is not an invoice._');
    return lines.join('\n');
}

/**
 * The verb handler.
 * @param {object} ctx - { args }
 * @param {object} [deps] - { readRuns, now } for tests; defaults to lib/run-stats-store.js.
 * @returns {Promise<{ok: boolean, text: string}>}
 */
async function handleRuns(ctx = {}, deps = {}) {
    const raw = String(ctx.args || '').trim();
    let days = DEFAULT_DAYS;
    if (raw) {
        if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1) {
            return { ok: false, text: `:x: Usage: \`runs [days]\` - days is a number, 1-${MAX_DAYS}. Got \`${raw.slice(0, 40)}\`.` };
        }
        days = Math.min(parseInt(raw, 10), MAX_DAYS);
    }
    const readRuns = deps.readRuns || (() => require('./run-stats-store').readRuns());
    let runs;
    try {
        runs = readRuns();
    } catch (err) {
        return { ok: false, text: `:x: Could not read the run record: ${err.message}. This is a failure, not an empty week.` };
    }
    return { ok: true, text: formatRunsReport(summarizeRuns(runs, { days, now: deps.now || new Date() }), days) };
}

module.exports = { handleRuns, summarizeRuns, formatRunsReport, percentile, DEFAULT_DAYS, MAX_DAYS };
