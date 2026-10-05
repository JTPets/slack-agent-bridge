'use strict';

/**
 * tests/command-renderers.test.js
 *
 * lib/command-renderers.js was split out of lib/command-router.js on 2026-10-05
 * (WORK-TODO #10, wave 2). tests/command-router.test.js enumerates `async function
 * handle*` across BOTH files and fails on a handler the table cannot reach. This suite
 * proves that enumeration actually reads the second file (a guard that only read the
 * router would pass with every renderer unregistered), and tests renderHelp, which the
 * router's `help` now delegates to.
 */

const fs = require('fs');
const path = require('path');
const { COMMANDS } = require('../lib/command-router');
const renderers = require('../lib/command-renderers');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
const enumerate = (src) => [...src.matchAll(/^async function (handle\w+)\s*\(/gm)].map(m => m[1]);
const wired = () => new Set(Object.values(COMMANDS).map(c => c.handler.name));

describe('the handler enumeration covers the renderers file', () => {
    test('every handler defined in lib/command-renderers.js is reachable from the table', () => {
        const declared = enumerate(read('command-renderers.js'));
        expect(declared.sort()).toEqual(['handleAgents', 'handleChannels', 'handleHolidays', 'handleStatus']);
        expect(declared.filter(n => !wired().has(n))).toEqual([]);
    });

    test('the table holds the SAME function objects the renderers module exports', () => {
        expect(COMMANDS.status.handler).toBe(renderers.handleStatus);
        expect(COMMANDS.agents.handler).toBe(renderers.handleAgents);
        expect(COMMANDS.holidays.handler).toBe(renderers.handleHolidays);
        expect(COMMANDS.channels.handler).toBe(renderers.handleChannels);
    });

    test('negative control: an unregistered renderer WOULD be caught', () => {
        const fake = read('command-renderers.js') + '\nasync function handleGhostReport(ctx) {}\n';
        expect(enumerate(fake).filter(n => !wired().has(n))).toEqual(['handleGhostReport']);
    });

    test('negative control: a guard reading only the router would MISS the renderers', () => {
        const routerOnly = enumerate(read('command-router.js'));
        expect(routerOnly).not.toContain('handleStatus');
    });
});

describe('renderHelp', () => {
    test('renders every verb it is given, sorted, from the table alone', () => {
        const { ok, text } = renderers.renderHelp({
            zeta: { summary: 'last', kind: 'report' },
            alpha: { summary: 'first', kind: 'scheduled' },
        });
        expect(ok).toBe(true);
        expect(text).toContain('alpha  first\nzeta   last');
        expect(text).toContain('2 commands.');
    });

    test('`help` through the router renders the live table', async () => {
        const { text } = await COMMANDS.help.handler({});
        expect(text).toContain(`${Object.keys(COMMANDS).length} commands.`);
    });
});
