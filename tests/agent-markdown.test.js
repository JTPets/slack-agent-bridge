'use strict';

/**
 * tests/agent-markdown.test.js
 *
 * THE enumerating guard for the rule that makes a tracked agent definition
 * portable: no workspace identifier in a tracked file.
 *
 * It walks every `agents/<id>/agent.md` from DISK — not a fixture list — so a
 * definition added later is covered without anyone remembering to add it here. The
 * live assertions are "no definition carries a Slack id" and "every definition
 * parses"; both are "expect this list to be empty", so the negative controls at the
 * bottom prove the guard still detects what it claims to. That is the pattern from
 * tests/no-shell-execution.test.js.
 */

const fs = require('fs');
const path = require('path');
const {
    parseAgentMarkdown,
    serializeAgent,
    loadDefinitions,
    SLACK_ID_PATTERN,
    FORBIDDEN_KEYS,
} = require('../lib/agent-markdown');
const { parseFrontmatter, formatFrontmatter, formatScalar } = require('../lib/agent-frontmatter');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/** @returns {Array<{ id: string, file: string, text: string }>} */
function trackedDefinitions() {
    return fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ id: e.name, file: path.join(AGENTS_DIR, e.name, 'agent.md') }))
        .filter(d => fs.existsSync(d.file))
        .map(d => ({ ...d, text: fs.readFileSync(d.file, 'utf8') }));
}

describe('every tracked agent definition', () => {
    const definitions = trackedDefinitions();

    test('there are definitions to check at all (the walk is not silently empty)', () => {
        expect(definitions.length).toBeGreaterThan(5);
    });

    // THE live assertion. A Slack id in a tracked file is unportable: it means
    // nothing in anyone else's workspace, and it is the reason the ids moved to
    // agents/shared/channel-map.json.
    test('carries no Slack channel id anywhere in its text', () => {
        const offenders = [];
        for (const def of definitions) {
            const hits = def.text.match(/\b[CGD][A-Z0-9]{8,}\b/g);
            if (hits) offenders.push(`${def.id}: ${[...new Set(hits)].join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });

    test('declares no forbidden key', () => {
        const offenders = [];
        for (const def of definitions) {
            for (const key of FORBIDDEN_KEYS) {
                if (new RegExp(`^${key}\\s*:`, 'm').test(def.text)) offenders.push(`${def.id}: ${key}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('parses, and declares an id matching its directory', () => {
        const offenders = [];
        for (const def of definitions) {
            try {
                const record = parseAgentMarkdown(def.text, { source: def.file });
                if (record.id !== def.id) offenders.push(`${def.id}: declares id "${record.id}"`);
            } catch (err) {
                offenders.push(`${def.id}: ${err.message}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    test('declares a channel_name and a default_status', () => {
        const offenders = [];
        for (const def of definitions) {
            const record = parseAgentMarkdown(def.text, { source: def.file });
            if (!record.channel_name) offenders.push(`${def.id}: no channel_name`);
            if (!['active', 'planned'].includes(record.default_status)) {
                offenders.push(`${def.id}: default_status is ${JSON.stringify(record.default_status)}`);
            }
        }
        expect(offenders).toEqual([]);
    });

    // A definition that loses a field when written back is a definition an editor
    // would silently damage. This is the guard on BOTH halves of the codec.
    test('survives a serialize/parse round trip with no field lost or changed', () => {
        const offenders = [];
        for (const def of definitions) {
            const original = parseAgentMarkdown(def.text, { source: def.file });
            const reparsed = parseAgentMarkdown(serializeAgent(original), { source: `${def.file} (round trip)` });
            if (JSON.stringify(reparsed) !== JSON.stringify(original)) {
                for (const key of new Set([...Object.keys(original), ...Object.keys(reparsed)])) {
                    if (JSON.stringify(original[key]) !== JSON.stringify(reparsed[key])) {
                        offenders.push(`${def.id}.${key}`);
                    }
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    test('loadDefinitions returns one record per file, in declared order', () => {
        const loaded = loadDefinitions();
        expect(loaded.length).toBe(definitions.length);
        const orders = loaded.map(r => r.order);
        expect([...orders].sort((a, b) => a - b)).toEqual(orders);
    });
});

describe('the frontmatter codec', () => {
    test('reads scalars, lists and one level of nesting', () => {
        const parsed = parseFrontmatter([
            'id: secretary',
            'max_turns: 20',
            'production: false',
            'watches:',
            '  bulletin_types:',
            '    - task_completed',
            'schedule:',
            '  cron: "0 7 * * *"',
            'denied: []',
            'empty:',
        ], 1);
        expect(parsed).toEqual({
            id: 'secretary',
            max_turns: 20,
            production: false,
            watches: { bulletin_types: ['task_completed'] },
            schedule: { cron: '0 7 * * *' },
            denied: [],
            empty: null,
        });
    });

    test('a cron expression survives quoting in both directions', () => {
        // The reason quoting is not optional: `0 7 * * *` bare is fine, but
        // `*/30 9-21 * * *` starts with a character the parser would have to guess at.
        for (const cron of ['0 7 * * *', '*/30 9-21 * * *', '0 9 * * 1,3,5']) {
            const round = parseFrontmatter(formatFrontmatter({ c: cron }), 1);
            expect(round.c).toBe(cron);
        }
    });

    test('quotes a value that would otherwise re-read as a number, bool or null', () => {
        for (const value of ['true', 'false', 'null', '20', '1.5', '', ' padded ', 'a: b', '- dash']) {
            expect(parseFrontmatter([`k: ${formatScalar(value)}`], 1).k).toBe(value);
        }
    });
});

describe('the guard itself detects what it claims to', () => {
    // Negative controls: every refusal above is asserted to fire on synthetic input,
    // because a parser that accepted everything would make all the live assertions
    // above pass vacuously.

    test('a channel id in a value is refused', () => {
        expect(() => parseAgentMarkdown('---\nid: x\nchannel_name: C0ANZUEJXEJ\n---\n'))
            .toThrow(/looks like a Slack id/);
    });

    test.each(FORBIDDEN_KEYS)('the key "%s" is refused outright', (key) => {
        expect(() => parseAgentMarkdown(`---\nid: x\n${key}: anything\n---\n`))
            .toThrow(new RegExp(`"${key}" is not allowed`));
    });

    test('a definition with no id is refused', () => {
        expect(() => parseAgentMarkdown('---\nname: Nameless\n---\n')).toThrow(/no id/);
    });

    test('a missing or unterminated frontmatter fence is refused', () => {
        expect(() => parseAgentMarkdown('# No frontmatter\n')).toThrow(/no frontmatter/);
        expect(() => parseAgentMarkdown('---\nid: x\n')).toThrow(/unterminated frontmatter/);
    });

    test('a shape outside the subset throws with a line number rather than guessing', () => {
        expect(() => parseFrontmatter(['a: 1', 'bare line'], 1)).toThrow(/line 2/);
        expect(() => parseFrontmatter(['a: 1', '   b: 2'], 1)).toThrow(/unexpected indent 3/);
        expect(() => parseFrontmatter(['a: 1', '  b: 2'], 1)).toThrow(/has both a value and nested keys/);
        expect(() => parseFrontmatter(['a: "unclosed'], 1)).toThrow(/unterminated quoted value/);
    });

    test('the Slack id pattern matches a real id and not an agent id', () => {
        expect(SLACK_ID_PATTERN.test('C0ANZUEJXEJ')).toBe(true);
        expect(SLACK_ID_PATTERN.test('code-bridge')).toBe(false);
        expect(SLACK_ID_PATTERN.test('CODE')).toBe(false);
    });

    test('loadDefinitions skips an unparseable file rather than throwing, and says so', () => {
        const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'agent-md-'));
        fs.mkdirSync(path.join(tmp, 'broken'));
        fs.writeFileSync(path.join(tmp, 'broken', 'agent.md'), 'no frontmatter here\n');
        fs.mkdirSync(path.join(tmp, 'fine'));
        fs.writeFileSync(path.join(tmp, 'fine', 'agent.md'), '---\nid: fine\n---\n');

        const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const loaded = loadDefinitions({ dir: tmp });
        expect(loaded.map(r => r.id)).toEqual(['fine']);
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('REFUSED'));
        spy.mockRestore();
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
