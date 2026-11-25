'use strict';

/**
 * lib/run-stats-store.js
 *
 * WORK-TODO #86 and the data #59 needs. Every Claude run ends with stats from
 * lib/claude-stream-watch.js (duration, turns, the CLI's estimated cost, longest quiet gap,
 * longest repeat of one tool call, alerts). Until now they were one `[run-stats]` log line
 * and nothing else, so "what does the secretary's briefing cost" or "how long is a normal
 * quiet gap" meant pasting a log grep from the NAS. This keeps one record per run.
 *
 * LOGIC CHANGE 2026-11-25: new file. lib/llm-adapter-claude.js, the one write site, calls
 * recordRunStats() where it used to call console.log; the log line is unchanged.
 *
 * Where: `$WORK_DIR/run-stats.json`. WORK_DIR is a bind mount on the box (WORK-TODO #25),
 * so the record survives a recreate. Not lib/llm-metrics.js: that keeps day SUMS, and a
 * p50/p95 duration needs each run. Bounded: runs older than RETAIN_DAYS, and anything past
 * MAX_RUNS, are dropped on the next write.
 *
 * `costUsd` is the CLI's `total_cost_usd`: what the run WOULD cost at API prices. Billing is
 * subscription usage through CLAUDE_CODE_OAUTH_TOKEN, so it is an estimate, not an invoice.
 *
 * Never throws: a failed write is logged and returned, because keeping a statistic must
 * never fail the run it describes. Under jest the default file is never written (the
 * lib/definition-branch.js precedent): a suite that wants a record calls init({ file }).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(process.env.WORK_DIR || '/tmp/bridge-agent', 'run-stats.json');
const RETAIN_DAYS = 30;
const MAX_RUNS = 5000;
const DAY_MS = 24 * 3600 * 1000;

let file = null;

/** Tests point the store at a temp file; init() with no file returns to the default. */
function init(options = {}) {
    file = options.file || null;
}

function currentFile() {
    return file || DEFAULT_FILE;
}

/** A finite number or null: the record never carries NaN or a string where a number goes. */
function num(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The fields kept for one run. Nothing else from the stats object (no output, no prompt). */
function toRecord(stats, at) {
    return {
        at: at.toISOString(),
        agent_id: typeof stats.agent_id === 'string' && stats.agent_id ? stats.agent_id : 'unknown',
        exit: num(stats.exit),
        signal: typeof stats.signal === 'string' ? stats.signal : null,
        durationMs: num(stats.durationMs),
        numTurns: num(stats.numTurns),
        costUsd: num(stats.costUsd),
        toolCalls: num(stats.toolCalls),
        maxQuietMs: num(stats.maxQuietMs),
        maxRepeat: num(stats.maxRepeat),
        alerts: Array.isArray(stats.alerts) ? stats.alerts.filter((a) => typeof a === 'string') : [],
    };
}

/**
 * Every recorded run. A missing file is no runs; an unreadable one THROWS, because a
 * report built on it would show "no runs" for a file that holds them.
 * @returns {object[]}
 */
function readRuns() {
    let raw;
    try {
        raw = fs.readFileSync(currentFile(), 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.runs)) throw new Error(`${currentFile()} has no runs array`);
    return parsed.runs;
}

/**
 * Log the `[run-stats]` line (unchanged) and keep the run.
 * @param {object} stats - { agent_id, exit, signal, ...createStreamWatch().finish().stats }
 * @param {Date} [now]
 * @returns {{ recorded: boolean, skipped?: string, error?: string }}
 */
function recordRunStats(stats = {}, now = new Date()) {
    console.log(`[run-stats] ${JSON.stringify(stats)}`);
    if (!file && process.env.JEST_WORKER_ID) return { recorded: false, skipped: 'under jest with no init({ file })' };
    try {
        let runs;
        try {
            runs = readRuns();
        } catch (err) {
            // A corrupt file is set aside, not overwritten, so its runs can still be read by hand.
            const aside = `${currentFile()}.corrupt-${now.getTime()}`;
            fs.renameSync(currentFile(), aside);
            console.error(`[run-stats] ${currentFile()} was unreadable (${err.message}); moved to ${aside}`);
            runs = [];
        }
        const keepAfter = now.getTime() - RETAIN_DAYS * DAY_MS;
        runs = runs.filter((r) => Date.parse(r.at) >= keepAfter);
        runs.push(toRecord(stats, now));
        if (runs.length > MAX_RUNS) runs = runs.slice(runs.length - MAX_RUNS);
        const target = currentFile();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, runs }), 'utf8');
        fs.renameSync(tmp, target);
        return { recorded: true };
    } catch (err) {
        console.error(`[run-stats] could not record the run: ${err.message}`);
        return { recorded: false, error: err.message };
    }
}

module.exports = { init, currentFile, readRuns, recordRunStats, toRecord, RETAIN_DAYS, MAX_RUNS, DEFAULT_FILE };
