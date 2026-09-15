'use strict';

/**
 * tests/live-state-guard.test.js
 *
 * The negative controls for the whole-run guard in `tests/helpers/live-state-setup.js`
 * and `-teardown.js`, which are wired as jest `globalSetup`/`globalTeardown` and
 * therefore run OUTSIDE any suite. Without this file the guard's only evidence that it
 * works would be that the run is green, which is exactly what a guard that compares
 * nothing also produces.
 *
 * LOGIC CHANGE 2026-09-15: New file, with the module it guards. It exists because the
 * defect it prevents was live and undetected: after a full run on `3c62bb1`,
 * `agents/shared/channel-map.json` held three invented ids written by
 * `tests/slack-client.test.js` into the file the deployment resolves agent channels
 * from (WORK-TODO #50's second finding, WORK-TODO #24's `lib/slack-client.js` row).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const guard = require('./helpers/live-state-setup');

describe('the guard enumerates from disk rather than from a list', () => {
    test('it covers every .json in agents/shared/, found by reading the directory', () => {
        const files = guard.stateFiles().map(f => path.relative(guard.REPO_ROOT, f));
        for (const name of fs.readdirSync(path.join(guard.REPO_ROOT, 'agents', 'shared'))) {
            if (!name.endsWith('.json')) continue;
            expect(files).toContain(path.join('agents', 'shared', name));
        }
    });

    test('it covers the runtime files that may not exist yet, so a CREATE is caught', () => {
        const files = guard.stateFiles().map(f => path.basename(f));
        for (const name of ['channel-map.json', 'agent-activation.json', 'bulletin.json',
            'watercooler-state.json', 'processed-tasks.json', 'approval-queue.json']) {
            expect(files).toContain(name);
        }
        expect(files).toContain('.bridge-agent-state.json');
    });

    test('a snapshot distinguishes absent from present, which is the whole CREATE case', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-fp-'));
        try {
            const file = path.join(dir, 'x.json');
            expect(guard.fingerprint(file)).toBeNull();
            fs.writeFileSync(file, '{}', 'utf8');
            expect(typeof guard.fingerprint(file)).toBe('string');
            // Empty content is not absence.
            fs.writeFileSync(file, '', 'utf8');
            expect(guard.fingerprint(file)).not.toBeNull();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the guard itself detects what it claims to', () => {
    // Both directions against synthetic snapshots, so the live run being green cannot
    // be the only evidence the comparison works.

    test('an unchanged snapshot reports nothing', () => {
        const snap = { 'a.json': 'aaa', 'b.json': null };
        expect(guard.diff(snap, { ...snap })).toEqual([]);
    });

    test('a file the run created is reported', () => {
        expect(guard.diff({ 'a.json': null }, { 'a.json': 'aaa' }))
            .toEqual(['a.json: CREATED by the test run']);
    });

    test('a file the run rewrote is reported', () => {
        expect(guard.diff({ 'a.json': 'aaa' }, { 'a.json': 'bbb' }))
            .toEqual(['a.json: MODIFIED by the test run']);
    });

    test('a file the run deleted is reported', () => {
        expect(guard.diff({ 'a.json': 'aaa' }, { 'a.json': null }))
            .toEqual(['a.json: DELETED by the test run']);
    });

    test('a key present in only one snapshot is treated as absent, not as unchanged', () => {
        expect(guard.diff({}, { 'a.json': 'aaa' })).toEqual(['a.json: CREATED by the test run']);
        expect(guard.diff({ 'a.json': 'aaa' }, {})).toEqual(['a.json: DELETED by the test run']);
    });
});
