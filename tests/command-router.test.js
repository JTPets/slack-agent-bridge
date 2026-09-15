'use strict';

/**
 * tests/command-router.test.js
 *
 * THE guard for the command table: a command that exists in code but not in the
 * table turns this red. That is the assertion the whole file is built around — a
 * hand-maintained command list drifts the first time someone adds a handler and
 * forgets the list, and help is rendered FROM the table, so the drift is invisible
 * in the one place anyone would look.
 *
 * It also guards the boundary with lib/agent-task-catalogue.js: a deterministic task
 * must be either a registered verb or an explicit NOT_COMMANDS entry with a reason.
 * "Neither" is a gap, not a default.
 */

const fs = require('fs');
const path = require('path');
const {
    COMMANDS,
    NOT_COMMANDS,
    DETERMINISTIC_TASKS,
    parseCommand,
    isCommand,
    runCommand,
    listVerbs,
} = require('../lib/command-router');
const { getDeterministicTask, TASK_TEMPLATES } = require('../lib/agent-task-catalogue');

const ROUTER_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-router.js'), 'utf8');

describe('THE guard: a command in code but not in the table is red', () => {
    // Enumerated from the module's own source, not from a list kept beside it.
    const declaredHandlers = [...ROUTER_SRC.matchAll(/^async function (handle\w+)\s*\(/gm)].map(m => m[1]);

    test('the enumeration finds the handlers at all (control for the assertion below)', () => {
        expect(declaredHandlers.length).toBeGreaterThan(0);
        expect(declaredHandlers).toContain('handleHelp');
    });

    test('every handler defined in the module is reachable from the table', () => {
        const wired = new Set(Object.values(COMMANDS).map(c => c.handler.name));
        const orphaned = declaredHandlers.filter(name => !wired.has(name));
        expect(orphaned).toEqual([]);
    });

    test('every table entry names a real function, not a string', () => {
        for (const [verb, entry] of Object.entries(COMMANDS)) {
            expect(typeof entry.handler).toBe('function');
            expect(typeof entry.summary).toBe('string');
            expect(entry.summary.length).toBeGreaterThan(0);
            // LOGIC CHANGE 2026-09-15: 'mutate' added for the activation verbs —
            // the only kind that writes anything.
            expect(['report', 'scheduled', 'mutate']).toContain(entry.kind);
            if (entry.kind === 'scheduled') {
                expect(getDeterministicTask(entry.task)).toBeTruthy();
            }
            expect(verb).toBe(verb.toLowerCase());
        }
    });
});

describe('the table does not become a second registry', () => {
    test('every deterministic task is a registered verb or an explicit non-command', () => {
        const registered = new Set(
            Object.values(COMMANDS).filter(c => c.kind === 'scheduled').map(c => c.task)
        );
        const unaccounted = Object.keys(DETERMINISTIC_TASKS)
            .filter(task => !registered.has(task) && !(task in NOT_COMMANDS));
        expect(unaccounted).toEqual([]);
    });

    test('a scheduled verb delegates to the catalogue rather than redeclaring the work', () => {
        // The table carries a task NAME, never a run function of its own.
        for (const entry of Object.values(COMMANDS)) {
            if (entry.kind === 'scheduled') expect(entry.run).toBeUndefined();
        }
        expect(ROUTER_SRC).toMatch(/getDeterministicTask\(entry\.task\)/);
    });

    test('no LLM prompt template is registered as a verb — those are dispatches', () => {
        for (const templateName of Object.keys(TASK_TEMPLATES)) {
            expect(listVerbs()).not.toContain(templateName);
        }
    });

    test('no verb is named after an agent — WORK-TODO #45', () => {
        const { loadAgents } = require('../lib/agent-registry');
        const agentIds = loadAgents().map(a => a.id);
        for (const verb of listVerbs()) {
            expect(agentIds).not.toContain(verb);
        }
    });
});

describe('help renders the table, not a written list', () => {
    test('every verb appears in help output', async () => {
        const { text } = await COMMANDS.help.handler({});
        for (const verb of listVerbs()) expect(text).toContain(verb);
    });

    test('every summary appears in help output', async () => {
        const { text } = await COMMANDS.help.handler({});
        for (const entry of Object.values(COMMANDS)) expect(text).toContain(entry.summary);
    });

    test('help reports the table\'s own size, not a typed number', async () => {
        const { text } = await COMMANDS.help.handler({});
        expect(text).toContain(`${listVerbs().length} commands`);
    });
});

describe('parseCommand', () => {
    test('recognises a registered verb as the first word', () => {
        expect(parseCommand('help')).toEqual({ verb: 'help', args: '' });
        expect(parseCommand('  STATUS  secretary ')).toEqual({ verb: 'status', args: 'secretary' });
    });

    test('a verb buried in prose is NOT a command — the unanchored-match defect', () => {
        expect(parseCommand('what does status mean here').verb).toBeNull();
        expect(parseCommand('please run help for me').verb).toBeNull();
    });

    test('an unregistered first word is not a command', () => {
        expect(parseCommand('deploy everything').verb).toBeNull();
        expect(parseCommand('').verb).toBeNull();
        expect(parseCommand(null).verb).toBeNull();
    });

    test('a prototype key is not mistaken for a verb', () => {
        expect(parseCommand('constructor').verb).toBeNull();
        expect(parseCommand('toString').verb).toBeNull();
        expect(isCommand('hasOwnProperty')).toBe(false);
    });
});

describe('runCommand', () => {
    test('an unregistered body is not handled — it falls through to the LLM path', async () => {
        expect(await runCommand('summarise yesterday')).toEqual({ handled: false });
    });

    test('status reports provenance for every agent', async () => {
        const r = await runCommand('status');
        expect(r.handled).toBe(true);
        expect(r.ok).toBe(true);
        expect(r.text).toContain('registry:agent.md');
        expect(r.text).toContain('secretary');
    });

    test('status narrows to one agent', async () => {
        const r = await runCommand('status secretary');
        expect(r.text).toContain('secretary');
        expect(r.text).not.toContain('code-sqtools');
    });

    test('status names the known agents when given an unknown one', async () => {
        const r = await runCommand('status not-an-agent');
        expect(r.ok).toBe(false);
        expect(r.text).toContain('secretary');
    });

    test('agents renders the surface table', async () => {
        const r = await runCommand('agents');
        expect(r.ok).toBe(true);
        expect(r.text).toContain('AGENT');
        expect(r.text).toContain('story-bot');
    });

    test('a scheduled verb with no agent refuses rather than guessing a channel', async () => {
        const r = await runCommand('check-inbox', { slack: {}, agent: null });
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/needs an agent with a channel/);
    });

    test('a scheduled verb reports the catalogue handler\'s verdict', async () => {
        jest.resetModules();
        jest.doMock('../lib/email-check', () => ({ runInboxCheck: async () => ({ ok: true, status: 'empty' }) }));
        const router = require('../lib/command-router');
        const r = await router.runCommand('check-inbox', { slack: {}, agent: { id: 'email-monitor', channel: 'C1' } });
        expect(r.ok).toBe(true);
        expect(r.text).toContain('C1');
        jest.dontMock('../lib/email-check');
        jest.resetModules();
    });

    test('a handler that throws is reported, never swallowed into the LLM path', async () => {
        jest.resetModules();
        jest.doMock('../lib/email-check', () => ({ runInboxCheck: async () => { throw new Error('gmail down'); } }));
        const router = require('../lib/command-router');
        const r = await router.runCommand('check-inbox', { slack: {}, agent: { id: 'e', channel: 'C1' } });
        expect(r.handled).toBe(true);
        expect(r.ok).toBe(false);
        expect(r.text).toContain('gmail down');
        jest.dontMock('../lib/email-check');
        jest.resetModules();
    });
});

describe('the guard itself detects what it claims to', () => {
    // Both live assertions above are "this list is empty", which passes against a
    // broken enumerator. These prove the enumeration and the comparison both work.

    test('an unwired handler WOULD be caught', () => {
        const declared = [...'async function handleGhost(' .matchAll(/async function (handle\w+)\s*\(/g)].map(m => m[1]);
        const wired = new Set(Object.values(COMMANDS).map(c => c.handler.name));
        expect(declared.filter(n => !wired.has(n))).toEqual(['handleGhost']);
    });

    test('an unaccounted deterministic task WOULD be caught', () => {
        const fakeCatalogue = { ...DETERMINISTIC_TASKS, 'run-payroll': { run: async () => ({}) } };
        const registered = new Set(
            Object.values(COMMANDS).filter(c => c.kind === 'scheduled').map(c => c.task)
        );
        const unaccounted = Object.keys(fakeCatalogue)
            .filter(t => !registered.has(t) && !(t in NOT_COMMANDS));
        expect(unaccounted).toEqual(['run-payroll']);
    });

    test('an entry declared in NOT_COMMANDS WOULD be accepted', () => {
        const fakeCatalogue = { ...DETERMINISTIC_TASKS, 'run-payroll': {} };
        const fakeNot = { 'run-payroll': 'writes money; never on demand' };
        const registered = new Set(
            Object.values(COMMANDS).filter(c => c.kind === 'scheduled').map(c => c.task)
        );
        expect(Object.keys(fakeCatalogue).filter(t => !registered.has(t) && !(t in fakeNot))).toEqual([]);
    });
});
