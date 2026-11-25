'use strict';

/**
 * tests/function-size.test.js
 *
 * WORK-TODO #10, B34 (2026-11-25): THE enumerating guard for the owner's rule that the
 * 300-line limit is per function. Every function in every production file, enumerated
 * from disk and parsed with @babel/parser, is at most MAX_FUNCTION_LINES lines, counted
 * from its first line to its last. The only functions allowed over it are DECLARED below
 * with a reason, and a declaration that no longer describes the code (the function is
 * gone or is back under the limit) fails too, so the list cannot rot.
 *
 * The file-level limit stays where it is (lib/file-size-gate.js); this is the function
 * half. A parser that cannot be loaded fails the suite: a guard that stops guarding must
 * not read as green.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles } = require('./helpers/source-scan');

const MAX_FUNCTION_LINES = 300;
const ROOT = path.join(__dirname, '..');

/**
 * `<file>:<name>` -> why it is still over the limit. Each is a split owed by WORK-TODO #10.
 */
const DECLARED = {
    'bridge-agent.js:processTask':
        'The TASK: path: clone, install, prompt, run, retry, Phase 3, delivery, cleanup. Its split ' +
        'waits for the secretary-briefing branch, which also edits bridge-agent.js (WORK-TODO #10).',
    'bridge-agent.js:processConversation':
        'The ASK: path: every built-in verb before the model call. Same sequencing as processTask ' +
        '(WORK-TODO #10).',
};

function loadParser() {
    try {
        const parser = require('@babel/parser');
        const traverseModule = require('@babel/traverse');
        return { parser, traverse: traverseModule.default || traverseModule };
    } catch (err) {
        throw new Error(`@babel/parser/@babel/traverse could not be loaded; this guard must not stop guarding: ${err.message}`);
    }
}

function functionName(p) {
    const n = p.node;
    if (n.id && n.id.name) return n.id.name;
    const parent = p.parent;
    if (parent.type === 'VariableDeclarator' && parent.id.name) return parent.id.name;
    if ((parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') && parent.key) {
        return parent.key.name || String(parent.key.value);
    }
    if (n.type === 'ObjectMethod' || n.type === 'ClassMethod') return n.key.name || String(n.key.value);
    return `<anonymous@${n.loc.start.line}>`;
}

/** Every function in `source` longer than `max` lines: [{ name, line, lines }]. */
function longFunctions(source, max = MAX_FUNCTION_LINES) {
    const { parser, traverse } = loadParser();
    const ast = parser.parse(source, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        allowHashBang: true,
    });
    const found = [];
    traverse(ast, {
        Function(p) {
            const lines = p.node.loc.end.line - p.node.loc.start.line + 1;
            if (lines > max) found.push({ name: functionName(p), line: p.node.loc.start.line, lines });
        },
    });
    return found;
}

function measureRepo() {
    const over = {};
    for (const file of listSourceFiles()) {
        const rel = path.relative(ROOT, file).split(path.sep).join('/');
        for (const f of longFunctions(fs.readFileSync(file, 'utf8'))) {
            over[`${rel}:${f.name}`] = f;
        }
    }
    return over;
}

describe('no production function is longer than 300 lines', () => {
    const over = measureRepo();

    test('every function over the limit is declared', () => {
        const undeclared = Object.keys(over)
            .filter((k) => !DECLARED[k])
            .map((k) => `${k} (line ${over[k].line}, ${over[k].lines} lines)`);
        expect(undeclared).toEqual([]);
    });

    test('every declaration still describes a function over the limit', () => {
        const stale = Object.keys(DECLARED).filter((k) => !over[k]);
        expect(stale).toEqual([]);
    });

    test('every declaration carries a reason', () => {
        for (const [k, reason] of Object.entries(DECLARED)) {
            expect(`${k}: ${reason.trim().length > 20}`).toBe(`${k}: true`);
        }
    });
});

describe('negative controls: the measurement sees what it forbids', () => {
    const body = (n) => Array.from({ length: n - 2 }, (_, i) => `  x += ${i};`).join('\n');

    test('a 301-line declaration is caught by name; a 300-line one is not', () => {
        expect(longFunctions(`function big() {\n${body(301)}\n}`)).toEqual([{ name: 'big', line: 1, lines: 301 }]);
        expect(longFunctions(`function ok() {\n${body(300)}\n}`)).toEqual([]);
    });

    test('arrow functions, methods and nested functions are each measured', () => {
        const src = [
            `const arrow = () => {\n${body(305)}\n};`,
            `const o = { method() {\n${body(310)}\n} };`,
            `function outer() {\n  function inner() {\n${body(302)}\n  }\n}`,
        ].join('\n');
        const names = longFunctions(src).map((f) => f.name).sort();
        expect(names).toEqual(['arrow', 'inner', 'method', 'outer']);
    });

    test('the live measurement is not empty-handed: it finds the declared bridge-agent.js functions', () => {
        const src = fs.readFileSync(path.join(ROOT, 'bridge-agent.js'), 'utf8');
        const names = longFunctions(src).map((f) => f.name);
        expect(names).toEqual(expect.arrayContaining(['processTask', 'processConversation']));
    });
});
