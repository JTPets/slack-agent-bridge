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
 *   1. A SOURCE WALK over lib/task-queue.js: every method that writes a terminal
 *      status must call normalizeDelivery(), and every method that writes a null
 *      verdict must write only non-terminal statuses. A new terminal writer that
 *      forgets the verdict turns this red.
 *   2. A REPLAY against a real TaskQueue on a real file: driving every terminal
 *      transition with NO verdict still leaves an object verdict on every row.
 *   3. Negative controls for the walker, because "no violations" is also what a
 *      walker that matches nothing reports.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskQueue, STATUS, deliveryRecorded } = require('../lib/task-queue');

const SOURCE = path.join(__dirname, '..', 'lib', 'task-queue.js');
const TERMINAL = Object.keys(STATUS).filter(k => k !== 'PENDING' && k !== 'RUNNING');

/** Blank comments (strings intact) so prose cannot satisfy or fail a check. Shared scanner: WORK-TODO #36. */
const stripComments = (src) => require('./helpers/source-scan').stripComments(src, { blankStrings: false });

/** Split a class body into { name, body } by its 4-space-indented method headers. */
function methodsOf(src) {
    const lines = stripComments(src).split('\n');
    const header = /^ {4}(?:async +)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/;
    const out = [];
    let cur = null;
    for (const line of lines) {
        const m = line.match(header);
        if (m && !['if', 'for', 'while', 'switch', 'catch'].includes(m[1])) {
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

describe('lib/task-queue.js keeps every terminal row verdict-bearing', () => {
    const src = fs.readFileSync(SOURCE, 'utf8');

    test('the walker finds the real terminal writers (it is not matching nothing)', () => {
        const writers = methodsOf(src)
            .filter(m => statusesWritten(m.body).some(s => TERMINAL.includes(s)))
            .map(m => m.name)
            .sort();
        expect(writers).toEqual(['complete', 'fail', 'interrupt', 'recoverInterrupted']);
    });

    test('the null-verdict writers are exactly the non-terminal ones', () => {
        const nullWriters = methodsOf(src)
            .filter(m => /delivery\s*[:=]\s*null\b/.test(m.body))
            .map(m => m.name)
            .sort();
        expect(nullWriters).toEqual(['_startRunning', 'enqueue']);
    });

    test('no method violates the invariant', () => {
        expect(findViolations(src)).toEqual([]);
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
