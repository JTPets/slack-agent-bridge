'use strict';

/**
 * tests/task-parser-parts.test.js
 *
 * WORK-TODO #10, B37 (2026-11-25): each part lib/task-parser.js was split into, tested
 * on its own (the facade's behaviour is tests/task-parser.test.js and
 * tests/message-detection.test.js, unchanged). Every part is pure, so no setup.
 */

const fields = require('../lib/task-fields');
const turns = require('../lib/task-turns');
const message = require('../lib/task-message');
const kind = require('../lib/message-kind');
const ask = require('../lib/ask-commands');

describe('lib/task-fields.js: one rule per field, value or error or nothing', () => {
    test('REPO is normalised then validated', () => {
        expect(fields.parseRepoField('https://github.com/jtpets/app.git', 'jtpets')).toEqual({ value: 'jtpets/app' });
        expect(fields.parseRepoField('app', 'acme')).toEqual({ value: 'acme/app' });
        expect(fields.parseRepoField('my;repo', 'jtpets').error).toMatch(/^REPO: rejected/);
    });

    test('BRANCH keeps the default for empty or "none", refuses a bad ref', () => {
        expect(fields.parseBranchField('none')).toEqual({});
        expect(fields.parseBranchField('  ')).toEqual({});
        expect(fields.parseBranchField('feature/x')).toEqual({ value: 'feature/x' });
        expect(fields.parseBranchField('..bad').error).toMatch(/^BRANCH: rejected/);
    });

    test('TURNS clamps to the floor and ceiling and ignores a non-number', () => {
        expect(fields.parseTurnsField('3')).toEqual({ value: turns.MIN_TURNS });
        expect(fields.parseTurnsField('500')).toEqual({ value: turns.TURNS_CEILING });
        expect(fields.parseTurnsField('abc')).toEqual({});
    });

    test('SKILL is lowercased and must be one path segment', () => {
        expect(fields.parseSkillField('Deploy_Check')).toEqual({ value: 'deploy_check' });
        expect(fields.parseSkillField('../etc').error).toMatch(/^SKILL: rejected/);
    });
});

describe('lib/task-turns.js', () => {
    test('conversationTurns uses the default, honours a declared budget, never passes the ceiling', () => {
        expect(turns.conversationTurns(null)).toBe(turns.CONVERSATION_TURNS_DEFAULT);
        expect(turns.conversationTurns({ max_turns: 7 })).toBe(7);
        expect(turns.conversationTurns({ max_turns: 50 })).toBe(turns.CONVERSATION_TURNS_CEILING);
    });
});

describe('lib/task-message.js: the hub applies each rule and collects every refusal', () => {
    test('one message with two bad fields reports both, in field order', () => {
        const task = message.parseTask('TASK: t\nREPO: my;repo\nSKILL: ../x\nINSTRUCTIONS: go');
        expect(task.errors.map((e) => e.split(':')[0])).toEqual(['REPO', 'SKILL']);
        expect(task.repo).toBe('');
    });

    test('findUnclaimedLines reports body text below the header and nothing after INSTRUCTIONS', () => {
        expect(message.findUnclaimedLines('banner\nTASK: t\nlost line\nINSTRUCTIONS: x\nkept')).toEqual([
            { line: 3, text: 'lost line' },
        ]);
    });
});

describe('lib/message-kind.js', () => {
    test('classifies TASK, ASK and natural messages; a bot post is never natural', () => {
        expect(kind.isTaskMessage({ text: 'TASK: x' })).toBe(true);
        expect(kind.isConversationMessage({ text: 'ASK: x' })).toBe(true);
        expect(kind.isNaturalConversationMessage({ text: 'hello' })).toBe(true);
        expect(kind.isNaturalConversationMessage({ text: 'hello', bot_id: 'B1' })).toBe(false);
        expect(kind.alreadyProcessed({ reactions: [{ name: kind.EMOJI_DONE }] })).toBe(true);
    });
});

describe('lib/ask-commands.js', () => {
    test('recognises and parses the approval and channel commands', () => {
        expect(ask.isStatusQuery("what's queued")).toBe(true);
        expect(ask.parseCreateChannelCommand('create channel #Team-X')).toBe('team-x');
        expect(ask.parseApproveCommand('approve all')).toEqual({ all: true });
        expect(ask.parseRejectCommand('reject abc-1 spam')).toEqual({ all: false, id: 'abc-1', reason: 'spam' });
        expect(ask.parseShowTaskCommand('show task abc-1')).toBe('abc-1');
    });
});
