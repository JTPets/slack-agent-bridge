'use strict';

/**
 * tests/task-queue-delivery-invariant.test.js
 *
 * THE GUARD for WORK-TODO #74: no TaskQueue writer leaves a TERMINAL row without a
 * delivery verdict.
 *
 * auto-update.js's checkTaskQueue() defers an update for a terminal row whose
 * `delivery` is null. At HEAD 71d2112 no production writer could produce one: every
 * terminal status write in lib/task-queue.js is paired, in the same method, with
 * `normalizeDelivery()`, which never returns null. So the gate's branch was
 * unreachable by accident, and the only test of it (tests/auto-update-defer.test.js)
 * hand-writes the null row. This suite turns the accident into an invariant:
 *
 *   1. A SOURCE WALK over every file TaskQueue is assembled from: every function
 *      that writes a terminal status must call normalizeDelivery(), and every function
 *      that writes a null verdict must write only non-terminal statuses. A new terminal
 *      writer that forgets the verdict turns this red.
 *   2. A REPLAY against a real TaskQueue on a real file: driving every terminal
 *      transition with NO verdict still leaves an object verdict on every row.
 *   3. Negative controls for the walker, because "no violations" is also what a
 *      walker that matches nothing reports.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): lib/task-queue.js is split (readers in
 * lib/task-queue-view.js, the verdict helpers in lib/task-queue-delivery.js). Reading
 * that one file would now prove nothing about a writer that lives anywhere else, so the
 * walk runs twice, over two independent enumerations (tests/helpers/task-queue-sources.js):
 *   - every lib/task-queue*.js file on disk, function by function, at any indentation
 *     (class methods, object-literal methods, module-level functions, arrow consts);
 *   - every method on TaskQueue.prototype by its own source text, wherever defined.
 * and asserts that every prototype method is found in one of those files. The negative
 * controls put a verdict-less terminal writer in a SECOND file and in a mixed-in method.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskQueue, STATUS, deliveryRecorded } = require('../lib/task-queue');
const { assemblyFiles, methodSources, unlocated } = require('./helpers/task-queue-sources');

const TERMINAL = Object.keys(STATUS).filter(k => k !== 'PENDING' && k !== 'RUNNING');

/** Blank comments (strings intact) so prose cannot satisfy or fail a check. Shared scanner: WORK-TODO #36. */
const stripComments = (src) => require('./helpers/source-scan').stripComments(src, { blankStrings: false });

// A function header at any indentation: a class or object-literal method, a
// `function` declaration, or an arrow/function expression bound to a const/let/var.
const HEADERS = [
    /^\s*(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
    /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*)?\([^)]*\)\s*(?:=>\s*)?\{\s*$/,
];
const NOT_A_NAME = ['if', 'for', 'while', 'switch', 'catch', 'function'];

/** Split source into { name, body } at every function header it contains. */
function methodsOf(src) {
    const lines = stripComments(src).split('\n');
    const out = [];
    let cur = null;
    for (const line of lines) {
        const m = HEADERS.map((re) => line.match(re)).find(Boolean);
        if (m && !NOT_A_NAME.includes(m[1])) {
            if (cur) out.push(cur);
            cur = { name: m[1], body: '' };
        } else if (cur) {
            cur.body += line + '\n';
        }
    }
    if (cur) out.push(cur);
    return out;
}

/** Status keys a method body writes, by assignment or object literal. */
function statusesWritten(body) {
    const found = new Set();
    const re = /status\s*[:=]\s*STATUS\.([A-Z_]+)/g;
    let m;
    while ((m = re.exec(body)) !== null) found.add(m[1]);
    return [...found];
}

/** Violations of the invariant in a source string. */
function findViolations(src, terminal = TERMINAL) {
    const violations = [];
    for (const { name, body } of methodsOf(src)) {
        const written = statusesWritten(body);
        const writesTerminal = written.filter(s => terminal.includes(s));
        const callsNormalize = /normalizeDelivery\s*\(/.test(body);
        const writesNull = /delivery\s*[:=]\s*null\b/.test(body);
        if (writesTerminal.length && !callsNormalize) {
            violations.push(`${name} writes ${writesTerminal.join(',')} without normalizeDelivery()`);
        }
        if (writesNull && writesTerminal.length) {
            violations.push(`${name} writes a null delivery beside ${writesTerminal.join(',')}`);
        }
    }
    return violations;
}

/** Violations across files, each prefixed with the file it is in. */
function fileViolations(files, terminal = TERMINAL) {
    return files.flatMap((f) => findViolations(f.source, terminal).map((v) => `${f.rel}: ${v}`));
}

/** Violations across a class's prototype, read from each method's own source. */
function prototypeViolations(Klass, terminal = TERMINAL) {
    return methodSources(Klass).flatMap((m) => findViolations(m.source, terminal));
}

/** Names of prototype methods that write a terminal status / a null verdict. */
const terminalWriters = (Klass) => methodSources(Klass)
    .filter((m) => methodsOf(m.source).some((f) => statusesWritten(f.body).some((x) => TERMINAL.includes(x))))
    .map((m) => m.name);
const nullWriters = (Klass) => methodSources(Klass)
    .filter((m) => /delivery\s*[:=]\s*null\b/.test(stripComments(m.source)))
    .map((m) => m.name);

describe('the walker detects what it claims to (negative controls)', () => {
    test('a terminal writer with no verdict is reported', () => {
        const src = [
            'class Q {',
            '    finish(id) {',
            '        task.status = STATUS.COMPLETED;',
            '        this._save(queue);',
            '    }',
            '}',
        ].join('\n');
        expect(findViolations(src, ['COMPLETED'])).toEqual(['finish writes COMPLETED without normalizeDelivery()']);
    });

    test('a null verdict beside a terminal status is reported', () => {
        const src = [
            'class Q {',
            '    bad(id) {',
            '        task.status = STATUS.FAILED;',
            '        task.delivery = normalizeDelivery(x);',
            '        other.delivery = null;',
            '    }',
            '}',
        ].join('\n');
        expect(findViolations(src, ['FAILED'])).toEqual(['bad writes a null delivery beside FAILED']);
    });

    test('a comment naming normalizeDelivery does not satisfy the check', () => {
        const src = [
            'class Q {',
            '    finish(id) {',
            '        // normalizeDelivery() is called elsewhere',
            '        task.status = STATUS.INTERRUPTED;',
            '    }',
            '}',
        ].join('\n');
        expect(findViolations(src, ['INTERRUPTED'])).toHaveLength(1);
    });
});

describe('a terminal writer in ANOTHER file is still caught (negative controls for the split)', () => {
    let dir;
    afterEach(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    test('the file walk reports a verdict-less writer in a second task-queue-*.js file', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-parts-'));
        fs.writeFileSync(path.join(dir, 'task-queue.js'), 'class Q {\n    ok() {\n        return 1;\n    }\n}\n');
        fs.writeFileSync(path.join(dir, 'task-queue-extra.js'), [
            'function finish(task) {',
            '    task.status = STATUS.FAILED;',
            '}',
            'const later = (task) => {',
            '    task.status = STATUS.INTERRUPTED;',
            '};',
            '',
        ].join('\n'));
        const files = assemblyFiles(dir);
        expect(files.map((f) => f.rel)).toEqual(['lib/task-queue-extra.js', 'lib/task-queue.js']);
        expect(fileViolations(files)).toEqual([
            'lib/task-queue-extra.js: finish writes FAILED without normalizeDelivery()',
            'lib/task-queue-extra.js: later writes INTERRUPTED without normalizeDelivery()',
        ]);
    });

    test('the prototype walk reports a verdict-less writer mixed in from elsewhere', () => {
        class Fake {}
        const mixin = {
            finish(task) {
                task.status = STATUS.COMPLETED;
            },
        };
        Object.defineProperty(Fake.prototype, 'finish', { value: mixin.finish, enumerable: false });
        expect(prototypeViolations(Fake)).toEqual(['finish writes COMPLETED without normalizeDelivery()']);
        expect(terminalWriters(Fake)).toEqual(['finish']);
    });

    test('a prototype method defined outside the assembly files is reported as unlocated', () => {
        class Fake {}
        Fake.prototype.complete = TaskQueue.prototype.complete;
        Fake.prototype.stray = function stray() { return 'defined in this test file'; };
        expect(unlocated(methodSources(Fake), assemblyFiles())).toEqual(['stray']);
    });
});

describe('TaskQueue keeps every terminal row verdict-bearing, in every file it is assembled from', () => {
    const files = assemblyFiles();

    test('the file enumeration finds the facade and its parts', () => {
        expect(files.map((f) => f.rel)).toEqual(expect.arrayContaining([
            'lib/task-queue.js', 'lib/task-queue-view.js', 'lib/task-queue-delivery.js', 'lib/task-queue-status.js',
        ]));
    });

    test('every method TaskQueue runs is defined in one of those files', () => {
        expect(methodSources(TaskQueue).length).toBeGreaterThan(15);
        expect(unlocated(methodSources(TaskQueue), files)).toEqual([]);
    });

    test('the walker finds the real terminal writers (it is not matching nothing)', () => {
        expect(terminalWriters(TaskQueue)).toEqual(['complete', 'fail', 'interrupt', 'recoverInterrupted']);
        const inFiles = files.flatMap((f) => methodsOf(f.source)
            .filter((m) => statusesWritten(m.body).some((x) => TERMINAL.includes(x))).map((m) => m.name)).sort();
        expect(inFiles).toEqual(['complete', 'fail', 'interrupt', 'recoverInterrupted']);
    });

    test('the null-verdict writers are exactly the non-terminal ones', () => {
        expect(nullWriters(TaskQueue)).toEqual(['_startRunning', 'enqueue']);
    });

    test('no function in any file, and no method on the prototype, violates the invariant', () => {
        expect(fileViolations(files)).toEqual([]);
        expect(prototypeViolations(TaskQueue)).toEqual([]);
    });
});

describe('replayed against a real TaskQueue', () => {
    let dir;
    afterEach(() => {
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
        dir = null;
    });

    test('every terminal transition driven with NO verdict still records one', () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tq-invariant-'));
        const q = new TaskQueue(path.join(dir, 'task-queue.json'));
        const start = (ts) => {
            const t = q.enqueue({ msgTs: ts, channelId: 'C1', text: 'TASK: x', description: `t${ts}` });
            q.markRunning(t.id);
            return t.id;
        };
        q.complete(start('1'));
        q.fail(start('2'), 'boom');
        q.interrupt(start('3'), 'killed');
        start('4');
        expect(q.recoverInterrupted()).toBe(1);

        const rows = JSON.parse(fs.readFileSync(path.join(dir, 'task-queue.json'), 'utf8'));
        expect(Array.isArray(rows)).toBe(true);
        const terminal = rows.filter(t => t.status !== STATUS.PENDING && t.status !== STATUS.RUNNING);
        expect(terminal).toHaveLength(4);
        for (const t of terminal) {
            expect(t.delivery).toEqual(expect.objectContaining({ delivered: false }));
            expect(deliveryRecorded(t)).toBe(true);
        }
    });
});
