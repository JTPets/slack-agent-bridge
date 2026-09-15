'use strict';

/**
 * lib/agent-markdown.js
 *
 * THE reader and writer of a tracked agent definition: `agents/<id>/agent.md`,
 * frontmatter for the structured fields (via lib/agent-frontmatter.js) and markdown
 * body sections for the prose.
 *
 * LOGIC CHANGE 2026-09-15: New file. Agent definitions moved out of the single
 * `agents/agents.json` blob into one markdown file per agent, so a definition is
 * reviewable in a diff, portable to another workspace, and deletable by anyone who
 * takes this repository. The record shape produced here is IDENTICAL to the one
 * agents.json produced, which is what makes the move a one-file change:
 * `lib/agent-registry.js` is the only reader either way.
 *
 * THE RULE THIS FILE ENFORCES: no workspace identifier in a tracked definition. A
 * definition declares the channel NAME it belongs in (`channel_name`); a `channel:`
 * key, or any frontmatter value shaped like a Slack id, is REFUSED — not stripped,
 * not warned about. The id a name resolves to is per-workspace state and lives in
 * the local store (`lib/bridge-state.js`). `tests/agent-markdown.test.js` walks
 * every tracked definition and fails if one carries an id.
 */

const fs = require('fs');
const path = require('path');
const { parseFrontmatter, formatFrontmatter } = require('./agent-frontmatter');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');
const DEFINITION_FILENAME = 'agent.md';

// Slack conversation ids: C (public), G (private), D (DM). Used only to REFUSE one.
const SLACK_ID_PATTERN = /^[CGD][A-Z0-9]{8,}$/;

// Frontmatter keys that may never appear: each would hold a workspace-resolved value.
const FORBIDDEN_KEYS = ['channel', 'channel_id', 'channelId'];

// Body sections that become record fields. Heading text (lowercased) -> record key.
const BODY_SECTIONS = {
    'role': 'role',
    'personality': 'personality',
    'system prompt': 'system_prompt',
    'note': 'note',
};

/**
 * Split the markdown body into its `## Heading` sections. A heading this module does
 * not recognise is ignored along with its content, deliberately: a definition is a
 * document for humans first, so extra prose must be free to exist.
 *
 * @param {string[]} lines - Body lines (everything after the frontmatter).
 * @returns {object} Record fields contributed by the body.
 */
function parseBody(lines) {
    const out = {};
    let current = null;
    let buffer = [];

    const flush = () => {
        if (current) {
            const text = buffer.join('\n').trim();
            if (text) out[current] = text;
        }
        buffer = [];
    };

    for (const line of lines) {
        const heading = /^##\s+(.+?)\s*$/.exec(line);
        if (heading) {
            flush();
            current = BODY_SECTIONS[heading[1].toLowerCase()] || null;
            continue;
        }
        if (current) buffer.push(line);
    }
    flush();
    return out;
}

/**
 * Parse a complete `agent.md` into a registry record.
 *
 * @param {string} text - File contents.
 * @param {object} [options]
 * @param {string} [options.source] - Path, used in error messages only.
 * @returns {object} Registry record. `channel` is NOT set here — it is per-workspace.
 * @throws {Error} If there is no frontmatter, the subset is broken, there is no id,
 *                 or any value is shaped like a Slack id.
 */
function parseAgentMarkdown(text, options = {}) {
    const where = options.source ? ` (${options.source})` : '';
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');

    if (lines[0].trim() !== '---') {
        throw new Error(`agent-markdown: no frontmatter${where} — the file must start with a --- fence`);
    }
    const end = lines.indexOf('---', 1);
    if (end === -1) {
        throw new Error(`agent-markdown: unterminated frontmatter${where} — no closing --- fence`);
    }

    let record;
    try {
        record = parseFrontmatter(lines.slice(1, end), 2, { forbiddenKeys: FORBIDDEN_KEYS });
    } catch (err) {
        const hint = FORBIDDEN_KEYS.some(k => err.message.includes(`"${k}"`))
            ? ' A definition declares channel_name; the resolved id is per-workspace local state.'
            : '';
        throw new Error(`${err.message}${where}.${hint}`);
    }

    for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string' && SLACK_ID_PATTERN.test(value)) {
            throw new Error(
                `agent-markdown: "${key}" looks like a Slack id (${value})${where}. ` +
                'A tracked definition may not carry a workspace identifier.'
            );
        }
    }

    if (!record.id) throw new Error(`agent-markdown: definition has no id${where}`);

    return { ...record, ...parseBody(lines.slice(end + 1)) };
}

/**
 * Render a registry record back to `agent.md`. The inverse of parseAgentMarkdown for
 * every field either understands — asserted by the round-trip test, which is the real
 * guard on both halves.
 *
 * @param {object} record
 * @returns {string}
 */
function serializeAgent(record) {
    const bodyKeys = Object.values(BODY_SECTIONS);
    const front = {};
    const body = {};
    for (const [key, value] of Object.entries(record)) {
        if (bodyKeys.includes(key)) body[key] = value;
        else if (value !== undefined) front[key] = value;
    }

    const lines = ['---', ...formatFrontmatter(front), '---', ''];
    lines.push(`# ${record.name || record.id}`, '');

    for (const [heading, key] of Object.entries(BODY_SECTIONS)) {
        if (!body[key]) continue;
        const title = heading.replace(/\b\w/g, c => c.toUpperCase());
        lines.push(`## ${title}`, '', String(body[key]).trim(), '');
    }
    return lines.join('\n');
}

/**
 * Load every tracked definition from `agents/<id>/agent.md`.
 *
 * Deterministic order: by the `order` frontmatter key, then by id. Order is declared
 * rather than left to the filesystem because the surface table and the poll list are
 * both rendered in registry order.
 *
 * NEVER THROWS. A directory it cannot read returns []; a single unparseable
 * definition is skipped. But a skipped definition is logged loudly, because an agent
 * that silently stops existing is the failure this change exists to make impossible.
 *
 * @param {object} [options]
 * @param {string} [options.dir] - Agents directory; defaults to `agents/`.
 * @returns {object[]} Records, without `channel` and without a resolved `status`.
 */
function loadDefinitions(options = {}) {
    const dir = options.dir || AGENTS_DIR;
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    // Under a mocked fs (tests/agent-registry.test.js) this is not an array; treating
    // that as "no definitions" is what lets the legacy JSON path stay exercised.
    if (!Array.isArray(entries)) return [];

    const records = [];
    for (const entry of entries) {
        if (!entry || typeof entry.isDirectory !== 'function' || !entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, DEFINITION_FILENAME);
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        if (typeof text !== 'string' || !text.trim()) continue;
        try {
            records.push(parseAgentMarkdown(text, { source: file }));
        } catch (err) {
            console.error(`[agent-markdown] REFUSED ${file}: ${err.message} That agent does not exist this boot.`);
        }
    }

    records.sort((a, b) => {
        const ao = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
        const bo = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
        return ao - bo || String(a.id).localeCompare(String(b.id));
    });
    return records;
}

module.exports = {
    parseAgentMarkdown,
    parseBody,
    serializeAgent,
    loadDefinitions,
    AGENTS_DIR,
    DEFINITION_FILENAME,
    BODY_SECTIONS,
    FORBIDDEN_KEYS,
    SLACK_ID_PATTERN,
};
