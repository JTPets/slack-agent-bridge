'use strict';

/**
 * tests/turn-budgets.test.js
 *
 * WORK-TODO #20: the turn budgets, each under its own name. Before 2026-10-04 the name
 * MAX_TURNS meant an env-driven default nothing reached, the parser's TURNS: ceiling and
 * lib/weekly-critique.js's one shot, and the conversation path's 10/20 were bare literals
 * in one `Math.min`. This states the conversation clamp somewhere other than that line,
 * and pins bridge-agent.js to the named constants by reading its source (requiring it
 * starts the bridge).
 */

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_TURNS, MIN_TURNS, TURNS_CEILING,
    CONVERSATION_TURNS_DEFAULT, CONVERSATION_TURNS_CEILING, conversationTurns,
} = require('../lib/task-parser');

const BRIDGE_SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
const OLD_CLAMP = /Math\.min\(\s*currentAgent\?\.max_turns\s*\|\|\s*\d+\s*,\s*\d+\s*\)/;
const LITERAL_RETRY_CAP = /currentTurns\s*<\s*100\b|Math\.min\(\s*currentTurns\s*\*\s*2\s*,\s*100\s*\)/;

describe('the named budgets', () => {
    test('task path: default 50, floor 5, ceiling 100', () => {
        expect([DEFAULT_TURNS, MIN_TURNS, TURNS_CEILING]).toEqual([50, 5, 100]);
    });

    test('a code agent declaring max_turns 50 gets 20 on the ASK: path', () => {
        expect(conversationTurns({ max_turns: 50 })).toBe(CONVERSATION_TURNS_CEILING);
        expect(CONVERSATION_TURNS_CEILING).toBe(20);
    });

    test('an agent under the ceiling keeps its own; one declaring none gets the default', () => {
        expect(conversationTurns({ max_turns: 15 })).toBe(15);
        expect(conversationTurns({})).toBe(CONVERSATION_TURNS_DEFAULT);
        expect(conversationTurns(null)).toBe(10);
    });
});

describe('bridge-agent.js uses the names, not literals', () => {
    test('the patterns match the code they replaced (negative controls)', () => {
        expect(OLD_CLAMP.test('const maxTurns = Math.min(currentAgent?.max_turns || 10, 20);')).toBe(true);
        expect(LITERAL_RETRY_CAP.test('if (retryCount === 0 && currentTurns < 100) {')).toBe(true);
        expect(LITERAL_RETRY_CAP.test('const retryTurns = Math.min(currentTurns * 2, 100);')).toBe(true);
    });

    test('the ASK: path takes its budget from conversationTurns()', () => {
        expect(BRIDGE_SRC).toMatch(/const maxTurns = conversationTurns\(currentAgent\);/);
        expect(OLD_CLAMP.test(BRIDGE_SRC)).toBe(false);
    });

    test('the max-turns retry is capped by TURNS_CEILING', () => {
        expect(BRIDGE_SRC).toMatch(/Math\.min\(currentTurns \* 2, TURNS_CEILING\)/);
        expect(LITERAL_RETRY_CAP.test(BRIDGE_SRC)).toBe(false);
    });
});
