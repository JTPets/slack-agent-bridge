'use strict';

/**
 * tests/helpers/global-hook-capture.js — make a failing jest global hook leave its
 * message behind (WORK-TODO #56).
 *
 * LOGIC CHANGE 2026-11-12: new file. Twice on 2026-09-16 a full run failed in
 * `runGlobalHook -> ScriptTransformer.requireAndTranspileModule` and the message was
 * lost because the output went through `tail`. This module records any throw from
 * `globalSetup`/`globalTeardown` to a gitignored file in the repo root
 * (`.jest-global-hook-failures.jsonl`, one JSON object per line) AND to stderr, so the
 * next occurrence survives a piped run.
 *
 * WHY IT DOES NOT DEPEND ON THE TRANSFORM. jest loads a global hook through
 * `requireAndTranspileModule` (@jest/transform), which installs a require hook that
 * runs every non-ignored file through babel-jest and its on-disk cache. A wrapper that
 * is itself transformed dies with the thing it is meant to report. So package.json's
 * `transformIgnorePatterns` names this file and both live-state hooks: jest's
 * `shouldTransform()` then returns false for them and node's own loader reads them
 * (tests/global-hook-capture.test.js proves it against the repo's real config, and
 * proves a project whose transform throws on every file still runs its hook).
 *
 * The record also carries what the boring causes need: jest and node versions, the
 * cache directory, and the other jest processes alive at that moment (jest takes no
 * lock on its cache, so "another process held the cache" can only mean "another jest
 * process of the same uid was running").
 *
 * Builtins only at module scope. Never throws from the recording path.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CAPTURE_NAME = '.jest-global-hook-failures.jsonl';

/** @returns {string|null} */
function jestVersion() {
    try {
        return require('jest/package.json').version;
    } catch (_) {
        return null;
    }
}

/** The cache directory this run uses: the config's, else jest's default. */
function cacheDirectoryOf(projectConfig) {
    if (projectConfig && projectConfig.cacheDirectory) {
        return { path: projectConfig.cacheDirectory, source: 'project config' };
    }
    try {
        return { path: require('jest-config').defaults.cacheDirectory, source: 'jest default (no config reached the hook)' };
    } catch (err) {
        return { path: null, source: `unknown: ${err.message}` };
    }
}

/** pid -> ppid for every process /proc shows. */
function parentMap(procDir) {
    const parents = new Map();
    for (const name of fs.readdirSync(procDir)) {
        if (!/^\d+$/.test(name)) continue;
        try {
            const stat = fs.readFileSync(path.join(procDir, name, 'stat'), 'utf8');
            // Field 4 follows the parenthesised command, which may itself hold spaces.
            const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            parents.set(Number(name), Number(rest[1]));
        } catch (_) { /* the process exited while we looked */ }
    }
    return parents;
}

/**
 * Other jest processes alive now, excluding this one, its ancestors (npm, the shell)
 * and its own workers. Linux /proc only; elsewhere `available: false`, never `[]`.
 * Reads cmdline, cwd and uid. Never reads another process's environment.
 *
 * @param {object} [options]
 * @param {string} [options.procDir]
 * @param {number} [options.selfPid]
 */
function otherJestProcesses({ procDir = '/proc', selfPid = process.pid } = {}) {
    if (!fs.existsSync(path.join(procDir, 'self'))) {
        return { available: false, reason: `${procDir} is not readable on this platform`, processes: [] };
    }
    try {
        const parents = parentMap(procDir);
        const related = new Set([selfPid]);
        for (let p = parents.get(selfPid); p && !related.has(p); p = parents.get(p)) related.add(p);
        const descendsFromSelf = (pid) => {
            for (let p = pid, hops = 0; p && hops < 64; p = parents.get(p), hops += 1) {
                if (p === selfPid) return true;
            }
            return false;
        };
        const processes = [];
        for (const pid of parents.keys()) {
            if (related.has(pid) || descendsFromSelf(pid)) continue;
            let cmd;
            try {
                cmd = fs.readFileSync(path.join(procDir, String(pid), 'cmdline'), 'utf8').split('\0').join(' ').trim();
            } catch (_) { continue; }
            if (!/jest/.test(cmd)) continue;
            let cwd = null;
            let uid = null;
            try { cwd = fs.readlinkSync(path.join(procDir, String(pid), 'cwd')); } catch (_) { /* not ours to read */ }
            try {
                const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(path.join(procDir, String(pid), 'status'), 'utf8'));
                uid = m ? Number(m[1]) : null;
            } catch (_) { /* gone */ }
            processes.push({ pid, uid, sameUid: uid === (process.getuid ? process.getuid() : null), cwd, cmd: cmd.slice(0, 200) });
        }
        return { available: true, processes };
    } catch (err) {
        return { available: false, reason: err.message, processes: [] };
    }
}

/**
 * Everything worth keeping about one hook failure.
 *
 * @param {string} hook - 'globalSetup' | 'globalTeardown'
 * @param {*} err
 * @param {object} [projectConfig]
 */
function describeFailure(hook, err, projectConfig) {
    const isErr = err instanceof Error;
    return {
        at: new Date().toISOString(),
        hook,
        message: isErr ? err.message : String(err),
        stack: isErr ? (err.stack || null) : null,
        jestVersion: jestVersion(),
        nodeVersion: process.version,
        pid: process.pid,
        cwd: process.cwd(),
        cacheDirectory: cacheDirectoryOf(projectConfig),
        otherJestProcesses: otherJestProcesses(),
    };
}

/** Where the record goes: the project's root when jest passed one, else this repo's. */
function captureFileFor(projectConfig) {
    const root = (projectConfig && projectConfig.rootDir) || REPO_ROOT;
    return path.join(root, CAPTURE_NAME);
}

/**
 * Append the record to the capture file and print it to stderr. Never throws: a
 * capture that cannot be written says so on stderr and the original error still
 * propagates from guard().
 *
 * @returns {{ record: object, file: string, written: boolean, writeError?: string }}
 */
function recordFailure(hook, err, projectConfig, { stderr = process.stderr } = {}) {
    let record;
    try {
        record = describeFailure(hook, err, projectConfig);
    } catch (describeErr) {
        record = { at: new Date().toISOString(), hook, message: String(err && err.message), describeError: describeErr.message };
    }
    const file = captureFileFor(projectConfig);
    let written = false;
    let writeError;
    try {
        fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
        written = true;
    } catch (e) {
        writeError = e.message;
    }
    try {
        stderr.write(`\n[global-hook-capture] ${hook} FAILED: ${record.message}\n` +
            `[global-hook-capture] jest ${record.jestVersion} node ${record.nodeVersion} ` +
            `cache ${record.cacheDirectory ? record.cacheDirectory.path : 'unknown'}\n` +
            (written ? `[global-hook-capture] full record appended to ${file}\n`
                : `[global-hook-capture] could NOT write ${file}: ${writeError}\n`));
    } catch (_) { /* stderr gone; the file is the record */ }
    return { record, file, written, writeError };
}

/**
 * Wrap a global hook so any throw is recorded, then rethrown unchanged (the run must
 * still fail: a guard that did not run is a red run).
 *
 * @param {string} hook
 * @param {Function} fn - (globalConfig, projectConfig) => Promise
 */
function guard(hook, fn) {
    return async function guardedHook(globalConfig, projectConfig) {
        try {
            return await fn(globalConfig, projectConfig);
        } catch (err) {
            recordFailure(hook, err, projectConfig);
            throw err;
        }
    };
}

module.exports = {
    guard,
    recordFailure,
    describeFailure,
    otherJestProcesses,
    captureFileFor,
    CAPTURE_NAME,
    CAPTURE_FILE: path.join(REPO_ROOT, CAPTURE_NAME),
};
