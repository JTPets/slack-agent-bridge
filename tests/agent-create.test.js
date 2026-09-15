'use strict';

/**
 * tests/agent-create.test.js
 *
 * Tests for lib/agent-create.js — the `create` verb.
 *
 * Against REAL files in a temp directory: this command's whole job is to leave a file
 * behind, and a mocked fs cannot tell a write that landed from one that was called.
 *
 * THE assertions this file exists for:
 *   - it NEVER creates a Slack channel and never resolves one;
 *   - a created definition is `planned`, with no schedule and no watches, so nothing
 *     it defines acts before a human has read it;
 *   - every field is REJECTED rather than sanitised, and a refusal writes nothing;
 *   - a tracked definition still cannot carry a Slack id;
 *   - the verdict states the durability honestly — the next pull destroys it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const create = require('../lib/agent-create');
const { parseAgentMarkdown } = require('../lib/agent-markdown');
const router = require('../lib/command-router');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-create-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const GOOD = { id: 'inventory', name: 'Inventory Agent', channel_name: 'inventory-desk', llm_provider: 'gemini' };

describe('a created definition is a definition, not a running agent', () => {
    test('it writes agents/<id>/agent.md and the result parses back', () => {
        const result = create.createAgentDefinition(GOOD, { dir, existing: [] });
        expect(result.ok).toBe(true);
        expect(fs.existsSync(result.file)).toBe(true);
        const parsed = parseAgentMarkdown(fs.readFileSync(result.file, 'utf8'));
        expect(parsed.id).toBe('inventory');
        expect(parsed.channel_name).toBe('inventory-desk');
        expect(parsed.llm_provider).toBe('gemini');
    });

    test('it is planned, with no schedule and no watches — nothing acts before a human reads it', () => {
        const { definition } = create.createAgentDefinition(GOOD, { dir, existing: [] });
        expect(definition.default_status).toBe('planned');
        expect(definition.schedule).toBeNull();
        expect(definition.watches).toBeNull();
    });

    test('it takes the next order, so the registry stays deterministically ordered', () => {
        const { definition } = create.createAgentDefinition(GOOD, { dir, existing: [{ id: 'a', order: 4 }, { id: 'b', order: 9 }] });
        expect(definition.order).toBe(10);
    });

    test('nothing in the module can create or resolve a Slack channel', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agent-create.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).not.toMatch(/ensureChannel|createChannel|conversations\.|findChannelByName|resolveAgentChannel/);
    });
});

describe('fields are rejected, never sanitised, and a refusal writes nothing', () => {
    const cases = [
        ['an id with spaces or capitals', { ...GOOD, id: 'My Agent' }, /must be 3-40 lowercase/],
        ['a duplicate id', { ...GOOD, id: 'taken' }, /already defined/],
        ['a missing channel', { ...GOOD, channel_name: '' }, /`channel` is required/],
        ['a channel that is a Slack ID', { ...GOOD, channel_name: 'C0ANZUEJXEJ' }, /must be a NAME, not a Slack id/],
        ['a channel with illegal characters', { ...GOOD, channel_name: 'Not A Channel' }, /must be a Slack channel name/],
        ['an unknown provider', { ...GOOD, llm_provider: 'gpt5' }, /must be one of/],
        ['a malformed repo', { ...GOOD, target_repo: 'not-a-repo' }, /must be `owner\/name`/],
    ];

    test.each(cases)('%s is refused', (_label, fields, pattern) => {
        const result = create.createAgentDefinition(fields, { dir, existing: [{ id: 'taken' }] });
        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toMatch(pattern);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    test('an existing file is never overwritten', () => {
        create.createAgentDefinition(GOOD, { dir, existing: [] });
        const before = fs.readFileSync(path.join(dir, 'inventory', 'agent.md'), 'utf8');
        const second = create.createAgentDefinition(GOOD, { dir, existing: [] });
        expect(second.ok).toBe(false);
        expect(second.errors[0]).toMatch(/already exists/);
        expect(fs.readFileSync(path.join(dir, 'inventory', 'agent.md'), 'utf8')).toBe(before);
    });
});

describe('the argument parser labels every field rather than guessing', () => {
    test('it reads the positional id and the key=value pairs', () => {
        const { fields, errors } = create.parseCreateArgs('inventory channel=inventory-desk provider=gemini repo=jtpets/x');
        expect(errors).toEqual([]);
        expect(fields).toMatchObject({
            id: 'inventory', channel_name: 'inventory-desk', llm_provider: 'gemini', target_repo: 'jtpets/x',
        });
    });

    test('a display name may contain spaces; nothing else may', () => {
        const { fields } = create.parseCreateArgs('inventory channel=c provider=claude name=Inventory Desk Agent');
        expect(fields.name).toBe('Inventory Desk Agent');
    });

    test('an unlabelled value is an error, not a guess — this command writes a file', () => {
        const { errors } = create.parseCreateArgs('inventory inventory-desk gemini');
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.join(' ')).toMatch(/is not a `key=value` pair/);
    });

    test('an unknown field is named rather than ignored', () => {
        const { errors } = create.parseCreateArgs('inventory chanel=x provider=claude');
        expect(errors.join(' ')).toMatch(/unknown field `chanel`/);
    });

    test('a missing display name is derived from the id, not left blank', () => {
        expect(create.parseCreateArgs('story-bot channel=c provider=claude').fields.name).toBe('Story Bot');
    });
});

describe('the verdict is honest about what it did and did not do', () => {
    test('create is registered in the one command table', () => {
        expect(router.listVerbs()).toContain('create');
        expect(router.isCommand('create x')).toBe(true);
    });

    test('with no arguments it explains itself and writes nothing', async () => {
        const result = await create.handleCreate({ args: '  ' });
        expect(result.ok).toBe(false);
        expect(result.text).toMatch(/Usage/);
        expect(result.text).toMatch(/does not create a Slack channel/);
    });

    test('a refusal says nothing was written, and lists every reason', async () => {
        const result = await create.handleCreate({ args: 'Bad Id channel=C0ANZUEJXEJ provider=gpt5' });
        expect(result.ok).toBe(false);
        expect(result.text).toMatch(/Nothing was written/);
        expect(result.text).toMatch(/must be a NAME, not a Slack id/);
        expect(result.text).toMatch(/must be one of/);
    });

    // THE honesty assertion, and the reason this command is allowed to exist at all.
    test('a success states that the next pull destroys the file unless it is committed', async () => {
        const agentsDir = path.join(__dirname, '..', 'agents');
        const id = 'test-create-honesty';
        try {
            const result = await create.handleCreate({ args: `${id} channel=some-channel provider=claude repo=jtpets/x` });
            expect(result.ok).toBe(true);
            expect(result.text).toMatch(/TRACKED/);
            expect(result.text).toMatch(/next pull destroys it unless it is committed/);
            expect(result.text).toMatch(/git reset --hard HEAD/);
            expect(result.text).toMatch(/WORK-TODO #51/);
            // And it says what it did NOT do, in both directions.
            expect(result.text).toMatch(/nothing here creates a channel/);
            expect(result.text).toMatch(/planned/);
            expect(result.text).toMatch(/Do not copy them into the system prompt/);
        } finally {
            fs.rmSync(path.join(agentsDir, id), { recursive: true, force: true });
        }
    });
});
