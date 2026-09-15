'use strict';

/**
 * lib/agent-frontmatter.js
 *
 * A deliberately tiny YAML-subset codec: the frontmatter block of an agent
 * definition, and nothing else. It knows about scalars, lists of scalars and one
 * level of nested maps. It knows nothing about agents.
 *
 * LOGIC CHANGE 2026-09-15: New file, split from lib/agent-markdown.js on the seam
 * between "how a key/value block is encoded" and "what an agent definition is" —
 * the combined file was 383 lines against this repo's 300-line rule, and the two
 * halves have genuinely different reasons to change.
 *
 * IT REFUSES RATHER THAN GUESSES. Every shape outside the subset throws with a line
 * number. A hand-rolled parser that silently mis-reads a cron expression is worse
 * than one that will not start, and this file is parsed at boot to decide which
 * agents exist.
 *
 * WHY NOT js-yaml: it resolves in a dev checkout only as a transitive dependency of
 * jest. Production installs with `npm ci --omit=dev` (CLAUDE.md, compose `command:`),
 * where it is absent. Adding it as a real dependency to read eleven files of flat
 * key/value pairs is a supply-chain surface this does not need.
 */

/**
 * Parse one scalar value.
 *
 * @param {string} raw - Text after the colon or the dash, already trimmed.
 * @param {number} lineNo - 1-based line number, for the error message.
 * @returns {string|number|boolean|null|Array|object}
 */
function parseScalar(raw, lineNo) {
    if (raw === '' || raw === 'null' || raw === '~') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === '[]') return [];
    if (raw === '{}') return {};

    const quote = raw[0];
    if (quote === '"' || quote === "'") {
        if (raw.length < 2 || raw[raw.length - 1] !== quote) {
            throw new Error(`frontmatter: unterminated quoted value on line ${lineNo}`);
        }
        const inner = raw.slice(1, -1);
        return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
    }

    if (/^-?\d+$/.test(raw) || /^-?\d*\.\d+$/.test(raw)) return Number(raw);
    return raw;
}

/**
 * Parse a frontmatter block into a plain object.
 *
 * Accepted shapes, and nothing else:
 *   key: scalar
 *   key:
 *     - scalar
 *   key:
 *     nested: scalar
 *     nested:
 *       - scalar
 *
 * @param {string[]} lines - Frontmatter lines, without the --- fences.
 * @param {number} offset - File line number of the first of them.
 * @param {object} [options]
 * @param {string[]} [options.forbiddenKeys] - Top-level keys to refuse outright.
 * @returns {object}
 * @throws {Error} On any line the subset above does not cover.
 */
function parseFrontmatter(lines, offset, options = {}) {
    const forbidden = options.forbiddenKeys || [];
    const out = {};
    // Keys opened with an empty value: still undecided between map and list.
    const pending = new Set();
    let topKey = null;
    let nestedKey = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNo = offset + i;
        if (!line.trim() || line.trim().startsWith('#')) continue;

        const indent = line.length - line.trimStart().length;
        const text = line.trim();

        if (indent !== 0 && indent !== 2 && indent !== 4) {
            throw new Error(`frontmatter: unexpected indent ${indent} on line ${lineNo} (only 0, 2 and 4 are understood)`);
        }

        if (text.startsWith('- ') || text === '-') {
            const value = parseScalar(text.slice(1).trim(), lineNo);
            if (indent === 2) {
                if (!topKey) throw new Error(`frontmatter: list item with no key on line ${lineNo}`);
                if (!Array.isArray(out[topKey])) out[topKey] = [];
                out[topKey].push(value);
                pending.delete(topKey);
            } else if (indent === 4) {
                if (!topKey || !nestedKey) throw new Error(`frontmatter: nested list item with no key on line ${lineNo}`);
                if (!Array.isArray(out[topKey][nestedKey])) out[topKey][nestedKey] = [];
                out[topKey][nestedKey].push(value);
            } else {
                throw new Error(`frontmatter: a top-level list is not supported (line ${lineNo})`);
            }
            continue;
        }

        const colon = text.indexOf(':');
        if (colon === -1) {
            throw new Error(`frontmatter: line ${lineNo} is neither "key: value" nor a list item: ${text}`);
        }
        const key = text.slice(0, colon).trim();
        const raw = text.slice(colon + 1).trim();
        if (!key) throw new Error(`frontmatter: empty key on line ${lineNo}`);

        if (indent === 0) {
            if (forbidden.includes(key)) {
                throw new Error(`frontmatter: key "${key}" is not allowed here (line ${lineNo})`);
            }
            topKey = key;
            nestedKey = null;
            if (raw === '') { out[key] = {}; pending.add(key); }
            else out[key] = parseScalar(raw, lineNo);
        } else if (indent === 2) {
            if (!topKey) throw new Error(`frontmatter: nested key with no parent on line ${lineNo}`);
            if (out[topKey] === null || typeof out[topKey] !== 'object' || Array.isArray(out[topKey])) {
                throw new Error(`frontmatter: "${topKey}" has both a value and nested keys (line ${lineNo})`);
            }
            nestedKey = key;
            pending.delete(topKey);
            out[topKey][key] = raw === '' ? {} : parseScalar(raw, lineNo);
        } else {
            throw new Error(`frontmatter: key nested three deep on line ${lineNo}; two levels is the limit`);
        }
    }

    // A key opened with an empty value and never filled reads as "declared, absent".
    for (const key of pending) out[key] = null;
    return out;
}

/**
 * Render one scalar, quoting when bare would be ambiguous to parseScalar.
 *
 * @param {*} value
 * @returns {string}
 */
function formatScalar(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    const s = String(value);
    const ambiguous = s === '' ||
        /^(true|false|null|~)$/.test(s) ||
        /^-?[\d.]/.test(s) ||
        /[:#"']/.test(s) ||
        /^[-[\]{}&*!|>%@`]/.test(s) ||
        s !== s.trim();
    return ambiguous ? `"${s.replace(/([\\"])/g, '\\$1')}"` : s;
}

/**
 * Render an object as a frontmatter block, without the --- fences.
 * The inverse of parseFrontmatter for every shape either understands; the
 * round-trip test is the guard on both halves.
 *
 * @param {object} obj
 * @returns {string[]} Lines.
 */
function formatFrontmatter(obj) {
    const lines = [];
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            if (value.length === 0) { lines.push(`${key}: []`); continue; }
            lines.push(`${key}:`);
            for (const item of value) lines.push(`  - ${formatScalar(item)}`);
        } else if (value && typeof value === 'object') {
            lines.push(`${key}:`);
            for (const [k, v] of Object.entries(value)) {
                if (Array.isArray(v)) {
                    if (v.length === 0) { lines.push(`  ${k}: []`); continue; }
                    lines.push(`  ${k}:`);
                    for (const item of v) lines.push(`    - ${formatScalar(item)}`);
                } else {
                    lines.push(`  ${k}: ${formatScalar(v)}`);
                }
            }
        } else {
            lines.push(`${key}: ${formatScalar(value)}`);
        }
    }
    return lines;
}

module.exports = {
    parseScalar,
    parseFrontmatter,
    formatScalar,
    formatFrontmatter,
};
