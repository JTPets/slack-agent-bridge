'use strict';

/**
 * tests/bulletin-types.test.js
 *
 * THE enumerating guard for the bulletin stream's type vocabulary.
 *
 * Three vocabularies have to agree and nothing compared them:
 *   BULLETIN_TYPES        what `postBulletin` will accept (lib/bulletin-board.js)
 *   watches.bulletin_types what agents ask to be notified about (agents/<id>/agent.md)
 *   the types code posts   the literals passed to postBulletin across the repo
 *
 * When they disagree nothing fails — `postBulletin` returns `{ success: false }`
 * rather than throwing, and a watch for a type nobody can post simply never fires.
 * Both had already happened: `customer_interaction` was watched by two agents and is
 * not a valid type, so those watches could never fire.
 *
 * Each set is enumerated FROM DISK, so a definition or a call site added later is
 * covered without anyone remembering to add it here.
 */

const fs = require('fs');
const path = require('path');
const { BULLETIN_TYPES, postBulletin, formatBulletinData, formatBulletinsForContext } = require('../lib/bulletin-board');
const { loadAgents } = require('../lib/agent-registry');

const REPO_ROOT = path.join(__dirname, '..');

/** Every non-test .js file, enumerated from disk. */
function sourceFiles() {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
                entry.name === 'tests' || entry.name === 'coverage') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
    };
    walk(REPO_ROOT);
    return out;
}

describe('the three bulletin vocabularies agree', () => {
    test('every type an agent watches is one postBulletin will accept', () => {
        const dead = [];
        for (const agent of loadAgents()) {
            for (const type of (agent.watches && agent.watches.bulletin_types) || []) {
                if (!BULLETIN_TYPES.includes(type)) dead.push(`${agent.id} watches "${type}"`);
            }
        }
        expect(dead).toEqual([]);
    });

    test('every bulletin type posted as a literal in the repo is a valid type', () => {
        const invalid = [];
        for (const file of sourceFiles()) {
            const src = fs.readFileSync(file, 'utf8');
            // postBulletin('agent', 'type', ...) — literal second argument only. A
            // variable second argument cannot be checked here and is covered by the
            // runtime rejection log in lib/integrations/email-categorizer.js.
            for (const m of src.matchAll(/postBulletin\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g)) {
                if (!BULLETIN_TYPES.includes(m[1])) {
                    invalid.push(`${path.relative(REPO_ROOT, file)}: "${m[1]}"`);
                }
            }
        }
        expect(invalid).toEqual([]);
    });

    test('at least one agent watches each of the types production code actually posts', () => {
        // Not every valid TYPE needs a watcher — a type nobody posts and nobody
        // watches is unused vocabulary, not a defect. But a type code DOES post with
        // no watcher at all means that work reaches the stream and no agent is told.
        const posted = new Set();
        for (const file of sourceFiles()) {
            const src = fs.readFileSync(file, 'utf8');
            for (const m of src.matchAll(/postBulletin\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g)) posted.add(m[1]);
        }
        const watched = new Set();
        for (const agent of loadAgents()) {
            for (const t of (agent.watches && agent.watches.bulletin_types) || []) watched.add(t);
        }
        expect([...posted].length).toBeGreaterThan(0);
        // Reported, not asserted empty: an unwatched type is still readable in the
        // stream by every agent. This names them so the list is visible when it grows.
        const unwatched = [...posted].filter(t => !watched.has(t));
        expect(unwatched).toEqual([]);
    });
});

describe('the stream carries enough to be worth reading', () => {
    test('a payload with none of description/title/message still renders its fields', () => {
        // The pushToSecretary payload shape exactly: from/subject/isTrustedVendor.
        const rendered = formatBulletinData({
            from: 'sales@vendor.example',
            subject: 'Kibble back in stock',
            isTrustedVendor: true,
        });
        expect(rendered).toContain('from=sales@vendor.example');
        expect(rendered).toContain('subject=Kibble back in stock');
        expect(rendered).toContain('isTrustedVendor=true');
    });

    test('one long field is capped without crowding out the others', () => {
        const rendered = formatBulletinData({ description: 'x'.repeat(5000), severity: 'HIGH' });
        expect(rendered).toContain('severity=HIGH');
        expect(rendered.length).toBeLessThan(400);
    });

    test('empty and nullish fields are omitted rather than rendered as noise', () => {
        expect(formatBulletinData({ a: 1, b: null, c: '', d: undefined })).toBe('a=1');
    });

    test('a nested object is named, not flattened or truncated into JSON', () => {
        expect(formatBulletinData({ nested: { a: 1 } })).toBe('nested=<object>');
        expect(formatBulletinData({ list: [1, 2, 3] })).toBe('list=<3 items>');
    });

});

describe('the guard itself detects what it claims to', () => {
    test('postBulletin really does reject an unknown type without throwing', () => {
        const result = postBulletin('test-agent', 'not_a_real_type', { a: 1 });
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/Invalid type/);
    });

    test('the literal scan finds a type in a postBulletin call', () => {
        const sample = "bulletinBoard.postBulletin('security', 'security_finding', {});";
        const found = [...sample.matchAll(/postBulletin\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
        expect(found).toEqual(['security_finding']);
    });

    test('the watch scan would catch a dead watch', () => {
        const agents = [{ id: 'ghost', watches: { bulletin_types: ['no_such_type'] } }];
        const dead = agents.flatMap(a => (a.watches.bulletin_types || [])
            .filter(t => !BULLETIN_TYPES.includes(t))
            .map(t => `${a.id} watches "${t}"`));
        expect(dead).toEqual(['ghost watches "no_such_type"']);
    });
});
