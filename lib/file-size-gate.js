/**
 * lib/file-size-gate.js
 *
 * THE rule engine for the 300-line-per-file limit. `npm run validate` runs it,
 * `tests/file-size-gate.test.js` guards it, and `lib/validate-exceptions.json` is its
 * source of truth for what is allowed to be over the limit and why.
 *
 * LOGIC CHANGE 2026-09-15: New file. The size check used to live inline in
 * lib/validate.js and to fail on every over-limit file unconditionally — 65 of them.
 * A gate that is always red is not a gate: a NEW violation could not be told apart
 * from the standing ones without diffing path lists by hand, which is how two of them
 * went unnoticed in the week of 2026-09-08. The exceptions had never been examined.
 *
 * The rule is now declaration-driven, in the shape the other enumerating guards in this
 * repository use (tests/no-shell-execution.test.js, tests/architecture-tree.test.js):
 * the declared list is the source of truth, and BOTH directions fail.
 *
 *   1. UNDECLARED — a file over the limit with no entry. The new violation.
 *   2. STALE — an entry whose file is gone, or is no longer over the limit. Without
 *      this half the list rots into a permanent amnesty and stops describing reality.
 *   3. UNREASONED — an entry with a blank reason. The cost of an exception is writing
 *      down why; an entry that skips that is not an exception, it is a silenced check.
 *   4. DUPLICATE — the same path declared twice. Two reasons for one file means one of
 *      them is being ignored and nobody is told which.
 *
 * `evaluate()` is pure and takes its inputs, so the guard can drive it with synthetic
 * data and prove it still detects what it claims to. `measure()` is the disk walk.
 *
 * Whether this rule should reach tests/ at all, and whether it should count code lines
 * rather than raw lines, are open questions argued on both sides in WORK-TODO #44.
 * Neither is decided here.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const MAX_LINES = 300;
const EXCEPTIONS_FILE = path.join(__dirname, 'validate-exceptions.json');

/**
 * Every .js file in the repository, as repo-relative POSIX paths with their line
 * counts. This walk IS the regeneration command for every figure about file sizes.
 *
 * Line semantics are `split('\n').length`, unchanged from the original check — one
 * higher than `wc -l` on a newline-terminated file. Kept identical on purpose so the
 * declared numbers and the historical ones mean the same thing.
 *
 * @param {string} [root] - Directory to walk. Defaults to the repository root.
 * @returns {{ path: string, lines: number }[]}
 */
function measure(root = REPO_ROOT) {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            // Same exclusions the original check used: node_modules and anything hidden.
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.js')) {
                const lines = fs.readFileSync(full, 'utf8').split('\n').length;
                files.push({ path: path.relative(root, full).split(path.sep).join('/'), lines });
            }
        }
    };
    walk(root);
    return files;
}

/**
 * Read the declared exceptions.
 *
 * A missing or unparseable file throws rather than defaulting to "no exceptions": a
 * silently empty declaration list would turn every recorded justification into a fresh
 * violation, and a gate that can fail open on a typo is the failure mode this module
 * exists to remove.
 *
 * @param {string} [file] - Path to the exceptions JSON.
 * @returns {{ path: string, reason: string }[]}
 */
function loadExceptions(file = EXCEPTIONS_FILE) {
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    if (!Array.isArray(doc.exceptions)) {
        throw new Error(`${file}: expected an "exceptions" array`);
    }
    return doc.exceptions;
}

/**
 * Apply the rule. Pure: no disk access, no repository knowledge.
 *
 * @param {object} input
 * @param {{ path: string, lines: number }[]} input.files - Every .js file considered.
 * @param {{ path: string, reason: string }[]} input.exceptions - The declared list.
 * @param {number} [input.maxLines] - The limit.
 * @returns {{ ok: boolean, oversized: object[], undeclared: object[], stale: object[],
 *            unreasoned: object[], duplicates: string[], declared: object[] }}
 */
function evaluate({ files, exceptions, maxLines = MAX_LINES }) {
    const byPath = new Map(files.map((f) => [f.path, f.lines]));
    const oversized = files.filter((f) => f.lines > maxLines).sort((a, b) => b.lines - a.lines);

    const seen = new Set();
    const duplicates = [];
    for (const e of exceptions) {
        if (seen.has(e.path)) duplicates.push(e.path);
        seen.add(e.path);
    }

    const unreasoned = exceptions.filter(
        (e) => typeof e.reason !== 'string' || e.reason.trim().length === 0
    );

    const stale = exceptions
        .filter((e) => !byPath.has(e.path) || byPath.get(e.path) <= maxLines)
        .map((e) => ({
            path: e.path,
            reason: byPath.has(e.path)
                ? `now ${byPath.get(e.path)} lines, under the ${maxLines}-line limit — delete this entry`
                : 'file does not exist — delete this entry',
        }));

    const undeclared = oversized.filter((f) => !seen.has(f.path));
    const declared = oversized.filter((f) => seen.has(f.path));

    return {
        ok: undeclared.length === 0 && stale.length === 0 && unreasoned.length === 0 && duplicates.length === 0,
        oversized,
        declared,
        undeclared,
        stale,
        unreasoned,
        duplicates,
    };
}

/**
 * Run the gate against the real tree and the real declaration file.
 *
 * @param {object} [options]
 * @param {string} [options.root] - Repository root to walk.
 * @param {string} [options.exceptionsFile] - Declaration file to read.
 * @param {number} [options.maxLines] - The limit.
 * @returns {object} The `evaluate()` result.
 */
function check({ root = REPO_ROOT, exceptionsFile = EXCEPTIONS_FILE, maxLines = MAX_LINES } = {}) {
    return evaluate({ files: measure(root), exceptions: loadExceptions(exceptionsFile), maxLines });
}

/**
 * Human-readable lines for a result. Returned rather than printed so the caller owns
 * stdout and the guard can assert on the text.
 *
 * @param {object} result - An `evaluate()` result.
 * @param {number} [maxLines]
 * @returns {string[]}
 */
function formatReport(result, maxLines = MAX_LINES) {
    const out = [];
    if (result.undeclared.length > 0) {
        out.push(`[validate] ❌ Files over ${maxLines} lines with no recorded justification:`);
        for (const f of result.undeclared) out.push(`  - ${f.path}: ${f.lines} lines`);
        out.push('[validate]    Split it, or add an entry with a reason to lib/validate-exceptions.json');
        out.push('[validate]    in this same change. The cost of an exception is writing down why.');
    }
    if (result.stale.length > 0) {
        out.push('[validate] ❌ Stale entries in lib/validate-exceptions.json:');
        for (const e of result.stale) out.push(`  - ${e.path}: ${e.reason}`);
    }
    if (result.unreasoned.length > 0) {
        out.push('[validate] ❌ Exception entries with no reason:');
        for (const e of result.unreasoned) out.push(`  - ${e.path}`);
    }
    if (result.duplicates.length > 0) {
        out.push('[validate] ❌ Paths declared more than once:');
        for (const p of result.duplicates) out.push(`  - ${p}`);
    }
    if (result.ok) {
        out.push(
            `[validate] ✓ No undeclared file over ${maxLines} lines ` +
            `(${result.declared.length} declared exceptions, each with a recorded reason)`
        );
    }
    return out;
}

module.exports = {
    MAX_LINES,
    EXCEPTIONS_FILE,
    REPO_ROOT,
    measure,
    loadExceptions,
    evaluate,
    check,
    formatReport,
};
