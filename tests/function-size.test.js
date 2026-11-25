'use strict';

/**
 * tests/function-size.test.js
 *
 * WORK-TODO #10, B34 (2026-11-25): THE trigger for the owner's organization rule (CLAUDE.md ->
 * Code Rules, "Organization"). 300 lines is not a cap; it is the point at which a function is
 * looked at. Every function in every production file, enumerated from disk and parsed with
 * @babel/parser, that runs past MAX_FUNCTION_LINES must be DECLARED below as one of:
 *   - `single-concern`: reviewed, it does one job, and the reason says what that job is; or
 *   - `split-owed`: reviewed, it mixes concerns, and the reason names the concerns and the batch
 *     that splits it (hub and spokes).
 * So a function cannot grow past 300 lines without someone reading it and writing down which.
 * A declaration that no longer describes the code (the function is gone or back under the
 * limit) fails too, so the list cannot rot. A parser that cannot be loaded fails the suite.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles } = require('./helpers/source-scan');

const MAX_FUNCTION_LINES = 300;
const ROOT = path.join(__dirname, '..');

/**
 * `<file>:<name>` -> { verdict: 'single-concern' | 'split-owed', reason }.
 */
// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): empty. bridge-agent.js processTask, the
// last entry (split-owed), is now a ~90-line hub over lib/task-*.js spokes.
const DECLARED = {};


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

describe('every function over 300 lines has been reviewed and declared', () => {
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

    test('every declaration has a verdict and a reason', () => {
        const bad = Object.entries(DECLARED)
            .filter(([, d]) => !['single-concern', 'split-owed'].includes(d.verdict) || !(d.reason || '').trim() ||
                (d.verdict === 'split-owed' && !/\bB\d+\b|#\d+/.test(d.reason)))
            .map(([k]) => k);
        expect(bad).toEqual([]);
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

    test('the live measurement reads the real file: at a lower bar it finds the processTask hub', () => {
        // With nothing declared, the live check above is "this list is empty", which a
        // measurement that parsed nothing would also satisfy.
        const src = fs.readFileSync(path.join(ROOT, 'bridge-agent.js'), 'utf8');
        const names = longFunctions(src, 60).map((f) => f.name);
        expect(names).toEqual(expect.arrayContaining(['processTask']));
        expect(longFunctions(src).map((f) => f.name)).not.toContain('processTask');
    });
});
