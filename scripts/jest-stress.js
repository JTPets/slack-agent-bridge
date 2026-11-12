#!/usr/bin/env node
'use strict';

const dotenvResult = require('dotenv').config();

/**
 * scripts/jest-stress.js — run the full jest suite N times and keep every failure's
 * message (WORK-TODO #56).
 *
 *   node scripts/jest-stress.js                 # 10 runs
 *   node scripts/jest-stress.js --runs 25
 *   node scripts/jest-stress.js --runs 5 -- --runInBand   # extra args go to jest
 *
 * LOGIC CHANGE 2026-11-12: new file. #56's two failures were lost because the run was
 * piped through `tail`. Here each run's whole output is written to its own file
 * (printed at the end), each run is classified by lib/test-verdict.js (so a skip or an
 * absent runner is never counted green), and any record a global hook appended to
 * `.jest-global-hook-failures.jsonl` during that run (tests/helpers/global-hook-capture.js)
 * is printed with the run it belongs to.
 *
 * The suite runs as a plain `npx jest --silent` would: the values this script's dotenv
 * line loaded from `.env` are removed from the child's environment, so a stress run sees
 * no live credential. Exit 0 only when every run is green with 0 skipped; 1 otherwise;
 * 2 on a usage error or a runner that cannot be found.
 *
 * No shell: spawnSync with an argv array.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyTestRun } = require('../lib/test-verdict');

const REPO_ROOT = path.join(__dirname, '..');
const CAPTURE_FILE = path.join(REPO_ROOT, '.jest-global-hook-failures.jsonl');

/** @returns {{ runs: number, jestArgs: string[] }|{ error: string }} */
function parseArgs(argv) {
    const dash = argv.indexOf('--');
    const own = dash === -1 ? argv : argv.slice(0, dash);
    const jestArgs = dash === -1 ? [] : argv.slice(dash + 1);
    let runs = 10;
    for (let i = 0; i < own.length; i += 1) {
        if (own[i] === '--runs') {
            runs = Number(own[i + 1]);
            i += 1;
        } else {
            return { error: `unknown argument: ${own[i]}` };
        }
    }
    if (!Number.isInteger(runs) || runs < 1 || runs > 500) return { error: '--runs takes a whole number from 1 to 500' };
    return { runs, jestArgs };
}

/** Lines already in the capture file, so a run reports only what it added. */
function captureLines(captureFile = CAPTURE_FILE) {
    try {
        return fs.readFileSync(captureFile, 'utf8').split('\n').filter(Boolean);
    } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
    }
}

/** The jest summary lines, verbatim, or null. */
function summaryLine(output, label) {
    const m = new RegExp(`^${label}:\\s+(.+)$`, 'm').exec(output);
    return m ? m[1].trim() : null;
}

/** The child's environment: ours, minus anything dotenv loaded from .env. */
function childEnv(env = process.env, loaded = (dotenvResult && dotenvResult.parsed) || {}) {
    const out = { ...env };
    for (const key of Object.keys(loaded)) {
        if (out[key] === loaded[key]) delete out[key];
    }
    delete out.JEST_WORKER_ID;
    return out;
}

/**
 * One full run. Never throws for a failing run; it reports one.
 *
 * @returns {{ index: number, exitCode: number|null, green: boolean, outcome: string,
 *   reason: string, suites: string|null, tests: string|null, skipped: number|null,
 *   captures: object[], outputFile: string }}
 */
function runOnce(index, { jestBin, jestArgs, outDir, spawn = spawnSync, captureFile = CAPTURE_FILE }) {
    const before = captureLines(captureFile).length;
    const outputFile = path.join(outDir, `run-${String(index).padStart(3, '0')}.txt`);
    // The child writes straight to a FILE, not a pipe: node's writes to a file are
    // synchronous, so an exiting jest cannot lose its last lines. Observed 2026-11-12:
    // collected over pipes, failing runs' output ended mid-line, summary and error gone.
    const fd = fs.openSync(outputFile, 'w');
    let r;
    try {
        r = spawn(process.execPath, [jestBin, '--silent', ...jestArgs], {
            cwd: REPO_ROOT,
            env: childEnv(),
            stdio: ['ignore', fd, fd],
        });
    } finally {
        fs.closeSync(fd);
    }
    const output = fs.readFileSync(outputFile, 'utf8');
    const verdict = classifyTestRun({ command: 'jest', exitCode: r.status, error: r.error || null, stdout: output });
    const skipped = verdict.assertions ? verdict.assertions.skipped : null;
    const captures = captureLines(captureFile).slice(before).map((line) => {
        try { return JSON.parse(line); } catch (_) { return { unparseable: line.slice(0, 500) }; }
    });
    return {
        index,
        exitCode: r.status,
        green: verdict.green && skipped === 0 && captures.length === 0,
        outcome: verdict.outcome,
        reason: verdict.reason,
        suites: summaryLine(output, 'Test Suites'),
        tests: summaryLine(output, 'Tests'),
        skipped,
        captures,
        outputFile,
    };
}

function formatRun(res, total) {
    const lines = [`run ${res.index}/${total}: exit=${res.exitCode} ${res.green ? 'GREEN' : `RED (${res.outcome})`}` +
        ` | suites: ${res.suites || 'none printed'} | tests: ${res.tests || 'none printed'}`];
    if (!res.green) lines.push(`    ${res.reason}`);
    for (const c of res.captures) {
        lines.push(`    CAPTURED ${c.hook || '?'}: ${c.message || c.unparseable}`);
        if (c.cacheDirectory) lines.push(`      jest ${c.jestVersion} node ${c.nodeVersion} cache ${c.cacheDirectory.path}`);
        if (c.otherJestProcesses) {
            const o = c.otherJestProcesses;
            lines.push(`      other jest processes: ${o.available ? (o.processes.length ? o.processes.map((p) => `${p.pid} (${p.cwd})`).join(', ') : 'none') : `unknown (${o.reason})`}`);
        }
    }
    return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    if (args.error) {
        process.stderr.write(`${args.error}\nusage: node scripts/jest-stress.js [--runs N] [-- <jest args>]\n`);
        return 2;
    }
    let jestBin;
    try {
        jestBin = require.resolve('jest/bin/jest', { paths: [REPO_ROOT] });
    } catch (_) {
        process.stderr.write('jest is not installed here (run npm ci first). A runner that cannot start is a failure, not a pass.\n');
        return 2;
    }
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jest-stress-'));
    process.stdout.write(`jest-stress: ${args.runs} runs, output per run in ${outDir}\n`);
    const results = [];
    for (let i = 1; i <= args.runs; i += 1) {
        const res = runOnce(i, { jestBin, jestArgs: args.jestArgs, outDir });
        results.push(res);
        process.stdout.write(`${formatRun(res, args.runs)}\n`);
    }
    const green = results.filter((r) => r.green).length;
    const captured = results.reduce((n, r) => n + r.captures.length, 0);
    process.stdout.write(`\nSUMMARY: ${green} of ${args.runs} green (0 skipped each), ${args.runs - green} red, ` +
        `${captured} global-hook failure record(s). Exit codes: ${results.map((r) => r.exitCode).join(' ')}\n`);
    return green === args.runs ? 0 : 1;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { parseArgs, summaryLine, childEnv, runOnce, formatRun, main, CAPTURE_FILE };
