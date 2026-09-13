/**
 * tests/bridge-agent-scope.test.js
 *
 * Regression test for the 2026-09-12 "agentId is not defined" defect.
 *
 * What broke: bridge-agent.js referenced `agentId` inside processTask's runLLM
 * options object, but no binding for it existed in that scope. The two bindings
 * that did exist were in sibling scopes (processConversation and the poll loop),
 * which JS scoping does not reach. Node threw ReferenceError at the moment the
 * object literal was evaluated - before the LLM was ever spawned. Every TASK:
 * message failed in zero seconds, including the scheduled check-inbox job that
 * runs every 30 minutes.
 *
 * Why a scope test and not a unit test: bridge-agent.js exports nothing and starts
 * a polling loop on require, so processTask cannot be called directly. The 1374
 * tests that existed when this shipped all passed - none of them executed that
 * line. A ReferenceError for a free variable is decidable statically, so this
 * test decides it, and generalizes to the next one anywhere in the file.
 *
 * NOTE: @babel/parser and @babel/traverse arrive as transitive dependencies of
 * jest's default babel transform. If they ever stop resolving, this test FAILS
 * loudly rather than skipping - a guard that quietly stops guarding is the same
 * class of defect as the one it was written to catch.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Identifiers that are legitimately free in a CommonJS module: Node globals and
// standard built-ins. Anything referenced outside this set and not bound in an
// enclosing scope is a ReferenceError waiting to be thrown at runtime.
const NODE_AND_STANDARD_GLOBALS = new Set([
    // CommonJS module scope
    'require', 'module', 'exports', '__dirname', '__filename',
    // Node globals
    'process', 'console', 'Buffer', 'globalThis', 'fetch',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone',
    'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
    'TextEncoder', 'TextDecoder',
    // ECMAScript built-ins
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Function', 'Promise', 'JSON', 'Math', 'Date', 'RegExp', 'Intl', 'Reflect',
    'Proxy', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError',
    'ReferenceError', 'URIError', 'AggregateError',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
    'undefined', 'NaN', 'Infinity',
]);

/**
 * Find every identifier referenced in a source file that is not bound in any
 * enclosing scope and is not a known global.
 *
 * @param {string} filePath - Absolute path to the JS file
 * @returns {Array<{ name: string, line: number }>}
 */
function findUnboundReferences(filePath) {
    let parser;
    let traverse;
    try {
        parser = require('@babel/parser');
        const traverseModule = require('@babel/traverse');
        traverse = traverseModule.default || traverseModule;
    } catch (err) {
        throw new Error(
            'Scope analysis is unavailable because @babel/parser/@babel/traverse ' +
            'could not be resolved. This guard must not silently stop guarding - ' +
            'add them as devDependencies rather than deleting this test. ' +
            `Original error: ${err.message}`
        );
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const ast = parser.parse(source, {
        sourceType: 'script',
        allowReturnOutsideFunction: true,
    });

    const unbound = [];
    traverse(ast, {
        ReferencedIdentifier(nodePath) {
            const name = nodePath.node.name;
            if (NODE_AND_STANDARD_GLOBALS.has(name)) return;
            // hasBinding(name, true) walks every enclosing scope including the program.
            if (nodePath.scope.hasBinding(name, true)) return;
            unbound.push({ name, line: nodePath.node.loc.start.line });
        },
    });
    return unbound;
}

describe('bridge-agent.js scope integrity', () => {
    const bridgeAgentPath = path.join(__dirname, '..', 'bridge-agent.js');

    test('every identifier referenced in bridge-agent.js is bound in an enclosing scope', () => {
        const unbound = findUnboundReferences(bridgeAgentPath);

        const detail = unbound
            .map(ref => `  ${ref.name} (bridge-agent.js:${ref.line})`)
            .join('\n');

        expect(unbound.length === 0 ? '' : `Unbound identifiers:\n${detail}`).toBe('');
    });

    test('the scope analyser actually detects an unbound identifier (guard is live)', () => {
        // Prove the check above can fail. Without this, a broken analyser would
        // report a clean file forever and the guard would be decorative.
        const fixture = path.join(__dirname, '..', 'node_modules', '.cache', 'scope-fixture.js');
        fs.mkdirSync(path.dirname(fixture), { recursive: true });
        fs.writeFileSync(
            fixture,
            'function processTaskFixture() {\n  return { agentId };\n}\nmodule.exports = processTaskFixture;\n',
            'utf8'
        );
        try {
            const unbound = findUnboundReferences(fixture);
            expect(unbound).toEqual([{ name: 'agentId', line: 2 }]);
        } finally {
            fs.rmSync(fixture, { force: true });
        }
    });

    test('processTask binds agentId before passing it to the LLM runner', () => {
        // The specific defect, pinned by name: processTask always executes as the
        // bridge agent, so agentId must come from the agent record - not a literal.
        const source = fs.readFileSync(bridgeAgentPath, 'utf8');
        const processTaskBody = source.slice(
            source.indexOf('async function processTask('),
            source.indexOf('// ---- Status query handling ----')
        );

        expect(processTaskBody).toContain('async function processTask(');
        expect(processTaskBody).toMatch(/const agentId = agentConfig\?\.id \|\| 'bridge';/);
        // The binding must precede the use, or hoisting rules still throw (TDZ).
        expect(processTaskBody.indexOf('const agentId =')).toBeLessThan(
            processTaskBody.indexOf('agentId,')
        );
    });
});
