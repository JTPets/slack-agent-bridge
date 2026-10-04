'use strict';

/**
 * tests/helpers/live-state-setup.js — jest `globalSetup`.
 *
 * THE enumerating guard for "a test run must not write the files the deployment
 * depends on". It is the durable close WORK-TODO #24 asked for and #50 recorded a
 * live instance of: after a full run on 3c62bb1, `agents/shared/channel-map.json`
 * contained `{"test-channel":"C12345","new-channel":"C99999","my-channel":"C12345"}`
 * — three invented ids written by `tests/slack-client.test.js` into the map the
 * running bridge resolves agent channels from.
 *
 * WHY NOT A SOURCE-SHAPE GUARD. #24's proposed enumerator walks `lib/` for a
 * module-scope writable path with no override seam. That shape is the CAUSE, and it
 * would not have caught this instance: the seam already existed —
 * `lib/bridge-state.js init({ channelMapFile })` took ownership of the map on
 * 2026-09-15 — and the suite simply did not use it. A guard on the cause misses an
 * unused cure. This guard is on the EFFECT, so it holds whatever the module shape is:
 * it enumerates the state files from disk before the run and fails the run if any of
 * them appeared, vanished or changed.
 *
 * It costs one hash per file per run and needs no per-suite bookkeeping, so a suite
 * added next year is covered without anyone remembering this file exists.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Runtime files the code writes under data/ (lib/staff-tasks.js, lib/integrations/square-catalog.js, bots/storefront.js). */
const DATA_STATE_FILES = ['staff-tasks-state.json', 'catalog-cache.json', 'delivery-quotes.json'];

/**
 * Every durable state file the deployment reads, enumerated rather than listed:
 * whatever `agents/shared/` and the repo root hold that is runtime state.
 *
 * `agents/shared/staff.json` and `daily-tasks-template.json` are TRACKED
 * configuration, so they are covered too — a suite rewriting one is the same defect.
 *
 * @returns {string[]} Absolute paths, sorted.
 */
function stateFiles() {
    const found = [];
    const sharedDir = path.join(REPO_ROOT, 'agents', 'shared');
    if (fs.existsSync(sharedDir)) {
        for (const name of fs.readdirSync(sharedDir)) {
            if (name.endsWith('.json')) found.push(path.join(sharedDir, name));
        }
    }
    for (const name of ['.bridge-agent-state.json']) {
        found.push(path.join(REPO_ROOT, name));
    }
    // Named explicitly because it is created on demand and must be caught the run it
    // first appears in, not the run after.
    for (const name of ['channel-map.json', 'agent-activation.json', 'bulletin.json',
        'watercooler-state.json', 'processed-tasks.json', 'approval-queue.json']) {
        const p = path.join(sharedDir, name);
        if (!found.includes(p)) found.push(p);
    }
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #56/#36, B2): `data/` holds runtime state the
    // deployment reads too, and this guard never looked there. It named
    // `staff-tasks-state.json` under agents/shared/, where nothing writes it — the real
    // file is data/staff-tasks-state.json (lib/staff-tasks.js TASKS_STATE_FILE). So
    // tests/staff-tasks.test.js could unlink the live staff task state on every run and
    // the run stayed green. Enumerated from disk like agents/shared/, plus the three
    // files the code writes there named explicitly so a CREATE is caught.
    const dataDir = path.join(REPO_ROOT, 'data');
    if (fs.existsSync(dataDir)) {
        for (const name of fs.readdirSync(dataDir)) {
            if (name.endsWith('.json')) found.push(path.join(dataDir, name));
        }
    }
    for (const name of DATA_STATE_FILES) found.push(path.join(dataDir, name));
    return [...new Set(found)].sort();
}

/**
 * A file's identity: its sha256, or `null` when it does not exist. Absent and
 * present-but-empty must be distinguishable, because "the run created it" is the
 * commonest form of this defect.
 *
 * @param {string} file
 * @returns {string|null}
 */
function fingerprint(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

/**
 * @returns {Object<string,string|null>} path -> fingerprint.
 */
function snapshot() {
    const out = {};
    for (const file of stateFiles()) out[path.relative(REPO_ROOT, file)] = fingerprint(file);
    return out;
}

/**
 * What changed between two snapshots. Pure, so the guard's own logic is testable —
 * a guard whose comparison is only reachable from globalTeardown cannot carry the
 * negative controls this repo requires of an enumerating guard.
 *
 * @param {Object<string,string|null>} before
 * @param {Object<string,string|null>} after
 * @returns {string[]} One line per changed file; empty when nothing moved.
 */
function diff(before, after) {
    const changed = [];
    for (const file of Object.keys({ ...before, ...after }).sort()) {
        const was = before[file] === undefined ? null : before[file];
        const now = after[file] === undefined ? null : after[file];
        if (was === now) continue;
        if (was === null) changed.push(`${file}: CREATED by the test run`);
        else if (now === null) changed.push(`${file}: DELETED by the test run`);
        else changed.push(`${file}: MODIFIED by the test run`);
    }
    return changed;
}

const SNAPSHOT_FILE = path.join(require('os').tmpdir(), 'bridge-live-state-snapshot.json');

module.exports = async function globalSetup() {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot(), null, 2), 'utf8');
};

module.exports.snapshot = snapshot;
module.exports.diff = diff;
module.exports.stateFiles = stateFiles;
module.exports.fingerprint = fingerprint;
module.exports.SNAPSHOT_FILE = SNAPSHOT_FILE;
module.exports.REPO_ROOT = REPO_ROOT;
module.exports.DATA_STATE_FILES = DATA_STATE_FILES;
