'use strict';

/**
 * tests/global-hook-capture.test.js — WORK-TODO #56.
 *
 * LOGIC CHANGE 2026-11-12: new file, with tests/helpers/global-hook-capture.js.
 *
 * Four properties, each run for real rather than asserted from prose:
 *  1. A globalSetup that throws leaves its message in the capture file (a real jest
 *     run in a throwaway project), and a passing one leaves nothing.
 *  2. The capture does not depend on the transform: in a project whose transform
 *     throws on EVERY file, the ignored hook still runs and records its own message;
 *     the negative control (hook not ignored) dies in the transform with nothing
 *     recorded, which is the 2026-09-16 shape.
 *  3. This repository's own config really sends its global hooks around the transform
 *     (the real jest-config and @jest/transform, not a regex over package.json).
 *  4. Two jest runs at once no longer share one snapshot file: a run that finishes
 *     first cannot delete the snapshot another run's teardown needs.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const capture = require('./helpers/global-hook-capture');

const REPO_ROOT = path.join(__dirname, '..');
const JEST_BIN = require.resolve('jest/bin/jest');
const CAPTURE_MODULE = path.join(REPO_ROOT, 'tests', 'helpers', 'global-hook-capture.js');
const SETUP = path.join(REPO_ROOT, 'tests', 'helpers', 'live-state-setup.js');
const TEARDOWN = path.join(REPO_ROOT, 'tests', 'helpers', 'live-state-teardown.js');

jest.setTimeout(120000);

function childEnv() {
    const env = { ...process.env };
    delete env.JEST_WORKER_ID;
    return env;
}

/** A throwaway jest project. Returns its dir; the caller removes it. */
function makeProject({ hookBody, ignoreHook = true, throwingTransform = false }) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hook-capture-')));
    fs.writeFileSync(path.join(dir, 'hook.js'),
        `module.exports = require(${JSON.stringify(CAPTURE_MODULE)}).guard('globalSetup', async () => { ${hookBody} });\n`);
    fs.writeFileSync(path.join(dir, 'a.test.js'), "test('runs', () => { expect(1).toBe(1); });\n");
    const config = {
        rootDir: dir,
        globalSetup: '<rootDir>/hook.js',
        cacheDirectory: path.join(dir, '.cache'),
        transformIgnorePatterns: ['/node_modules/', 'global-hook-capture\\.js$', ...(ignoreHook ? ['/hook\\.js$'] : [])],
    };
    if (throwingTransform) {
        fs.writeFileSync(path.join(dir, 'boom-transform.js'),
            "module.exports = { process() { throw new Error('TRANSFORM-EXPLODED'); } };\n");
        config.transform = { '\\.js$': path.join(dir, 'boom-transform.js') };
    }
    fs.writeFileSync(path.join(dir, 'jest.config.json'), JSON.stringify(config));
    return dir;
}

function runJest(dir) {
    const r = spawnSync(process.execPath, [JEST_BIN, '--config', path.join(dir, 'jest.config.json')], {
        cwd: dir, env: childEnv(), encoding: 'utf8', timeout: 90000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function readCaptures(dir) {
    const file = path.join(dir, capture.CAPTURE_NAME);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('a failing global hook leaves its message behind', () => {
    let dir;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

    test('a globalSetup that throws writes the message, versions and cache dir to the capture file', () => {
        dir = makeProject({ hookBody: "throw new Error('SENTINEL-SETUP-56');" });
        const r = runJest(dir);
        expect(r.status).not.toBe(0);
        expect(r.output).toContain('SENTINEL-SETUP-56');
        expect(r.output).toContain('[global-hook-capture] globalSetup FAILED');
        // A throw from the hook's BODY prints the 2026-09-16 signature: the stack runs
        // through requireAndTranspileModule into runGlobalHook. So that signature does not
        // by itself mean the module failed to load.
        expect(r.output).toMatch(/requireAndTranspileModule[\s\S]*runGlobalHook/);
        const records = readCaptures(dir);
        expect(records).toHaveLength(1);
        const [rec] = records;
        expect(rec.hook).toBe('globalSetup');
        expect(rec.message).toContain('SENTINEL-SETUP-56');
        expect(rec.stack).toContain('SENTINEL-SETUP-56');
        expect(rec.jestVersion).toBe(require('jest/package.json').version);
        expect(rec.nodeVersion).toBe(process.version);
        expect(rec.cacheDirectory).toEqual({ path: path.join(dir, '.cache'), source: 'project config' });
        expect(typeof rec.otherJestProcesses.available).toBe('boolean');
    });

    test('NEGATIVE CONTROL: a globalSetup that passes writes nothing', () => {
        dir = makeProject({ hookBody: 'return undefined;' });
        const r = runJest(dir);
        expect(r.status).toBe(0);
        expect(readCaptures(dir)).toBeNull();
    });

    test('the capture survives a transform that throws on every file, because the hook is not transformed', () => {
        dir = makeProject({ hookBody: "throw new Error('SENTINEL-UNTRANSFORMED');", throwingTransform: true });
        const r = runJest(dir);
        expect(r.status).not.toBe(0);
        expect(r.output).not.toContain('TRANSFORM-EXPLODED');
        expect(readCaptures(dir).map((x) => x.message).join('\n')).toContain('SENTINEL-UNTRANSFORMED');
    });

    test('NEGATIVE CONTROL: a transformed hook dies in the transform and records nothing (the 2026-09-16 shape)', () => {
        dir = makeProject({ hookBody: "throw new Error('NEVER-REACHED');", throwingTransform: true, ignoreHook: false });
        const r = runJest(dir);
        expect(r.status).not.toBe(0);
        expect(r.output).toContain('TRANSFORM-EXPLODED');
        expect(readCaptures(dir)).toBeNull();
        // The stack a load/transform failure prints is cut (node's 10-frame limit) inside
        // the module loader: it never reaches runGlobalHook. Contrast the first test.
        expect(r.output).not.toContain('runGlobalHook');
    });
});

describe("this repository's global hooks are loaded without the transform", () => {
    test('the real config makes shouldTransform() false for the hooks and true for a suite', async () => {
        const { readConfig } = require('jest-config');
        const { createScriptTransformer } = require('@jest/transform');
        const { projectConfig } = await readConfig({}, REPO_ROOT);
        expect(projectConfig.globalSetup).toBe(SETUP);
        expect(projectConfig.globalTeardown).toBe(TEARDOWN);
        const transformer = await createScriptTransformer(projectConfig);
        for (const hook of [SETUP, TEARDOWN, CAPTURE_MODULE]) {
            expect(transformer.shouldTransform(hook)).toBe(false);
        }
        // Negative control: everything else is still transformed (jest.mock hoisting).
        expect(transformer.shouldTransform(__filename)).toBe(true);
        expect(transformer.shouldTransform(path.join(REPO_ROOT, 'tests', 'helpers', 'workspace-fixture.js'))).toBe(true);
    });
});

describe('two jest runs at once do not share a snapshot', () => {
    // Child A runs globalSetup, waits, then globalTeardown. Child B runs both in
    // between. Before 2026-11-12 both used <tmpdir>/bridge-live-state-snapshot.json, so
    // B's teardown deleted the file A's teardown needed and A failed "unreadable".
    const script = [
        'const [setup, teardown, mode] = process.argv.slice(1);',
        'const s = require(setup); const t = require(teardown);',
        '(async () => {',
        '  await s();',
        "  if (mode === 'wait') { process.stdout.write('ready\\n');",
        "    await new Promise((r) => { process.stdin.on('end', r); process.stdin.resume(); }); }",
        '  await t();',
        "})().then(() => process.exit(0), (e) => { process.stderr.write(e.message); process.exit(1); });",
    ].join('\n');

    test('a run that finishes first leaves the other run its snapshot', async () => {
        const a = spawn(process.execPath, ['-e', script, SETUP, TEARDOWN, 'wait'], { env: childEnv() });
        let aErr = '';
        a.stderr.on('data', (c) => { aErr += c; });
        await new Promise((resolve, reject) => {
            a.stdout.on('data', (c) => { if (String(c).includes('ready')) resolve(); });
            a.on('exit', (code) => reject(new Error(`A exited early (${code}): ${aErr}`)));
        });
        const b = spawnSync(process.execPath, ['-e', script, SETUP, TEARDOWN, 'now'], { env: childEnv(), encoding: 'utf8' });
        expect(b.stderr).toBe('');
        expect(b.status).toBe(0);
        const aCode = await new Promise((resolve) => { a.on('exit', resolve); a.stdin.end(); });
        expect(aErr).toBe('');
        expect(aCode).toBe(0);
    });

    test('the snapshot path names the process, and each pid gets its own', () => {
        const setup = require('./helpers/live-state-setup');
        expect(setup.snapshotFileFor(1)).not.toBe(setup.snapshotFileFor(2));
        expect(setup.SNAPSHOT_FILE).toBe(setup.snapshotFileFor(process.pid));
    });
});

describe('the recording path', () => {
    test('a capture file that cannot be written is reported on stderr and never throws', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-capture-ro-'));
        try {
            const missingRoot = path.join(dir, 'does', 'not', 'exist');
            let printed = '';
            const out = capture.recordFailure('globalTeardown', new Error('X'), { rootDir: missingRoot },
                { stderr: { write: (s) => { printed += s; } } });
            expect(out.written).toBe(false);
            expect(printed).toContain('could NOT write');
            expect(printed).toContain('globalTeardown FAILED: X');
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('guard() rethrows the original error unchanged after recording it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-capture-g-'));
        const write = process.stderr.write;
        process.stderr.write = () => true;
        try {
            const original = new Error('ORIGINAL');
            const hook = capture.guard('globalSetup', async () => { throw original; });
            await expect(hook({}, { rootDir: dir })).rejects.toBe(original);
            expect(readCaptures(dir)[0].message).toBe('ORIGINAL');
        } finally {
            process.stderr.write = write;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('a non-Error throw is still recorded', () => {
        const rec = capture.describeFailure('globalSetup', 'just a string', undefined);
        expect(rec.message).toBe('just a string');
        expect(rec.stack).toBeNull();
        expect(rec.cacheDirectory.source).toMatch(/jest default/);
    });
});

describe('other jest processes are found, and this run and its family are not', () => {
    let proc;
    const add = (pid, ppid, cmd, uid = 0) => {
        const d = path.join(proc, String(pid));
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'stat'), `${pid} (node x) S ${ppid} 1 1`);
        fs.writeFileSync(path.join(d, 'cmdline'), cmd.split(' ').join('\0'));
        fs.writeFileSync(path.join(d, 'status'), `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    };
    beforeEach(() => {
        proc = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
        fs.mkdirSync(path.join(proc, 'self'));
    });
    afterEach(() => fs.rmSync(proc, { recursive: true, force: true }));

    test('only an unrelated jest process is reported', () => {
        add(50, 1, 'npm test jest');                         // our parent (npm)
        add(100, 50, 'node node_modules/.bin/jest');          // us
        add(101, 100, 'node jest-worker/build/processChild.js'); // our worker
        add(200, 1, 'node /work/update-gate/node_modules/.bin/jest --ci');
        add(300, 1, 'bash');
        const r = capture.otherJestProcesses({ procDir: proc, selfPid: 100 });
        expect(r.available).toBe(true);
        expect(r.processes.map((p) => p.pid)).toEqual([200]);
        expect(r.processes[0].cmd).toContain('update-gate');
    });

    test('no /proc is "not available", never an empty list that reads as "none running"', () => {
        const r = capture.otherJestProcesses({ procDir: path.join(proc, 'absent') });
        expect(r.available).toBe(false);
        expect(r.reason).toMatch(/not readable/);
    });
});
