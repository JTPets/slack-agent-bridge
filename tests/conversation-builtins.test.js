'use strict';

/**
 * tests/conversation-builtins.test.js
 *
 * WORK-TODO #10, B35: the hub (answerBuiltin) and its spokes, each tested on its own with a
 * fake ctx. The hub keeps processConversation's old order and channel rule; every reply
 * goes through ctx.reply.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { answerBuiltin, BUILTINS } = require('../lib/conversation-builtins');
const approvalQueue = require('../lib/approval-queue');
const botTaskLedger = require('../lib/bot-task-ledger');
const bulletinBoard = require('../lib/bulletin-board');

function fakeCtx(overrides = {}) {
    const replies = [];
    const posts = [];
    const ctx = {
        replies,
        posts,
        reply: async (text) => { replies.push(text); },
        inBridgeChannel: true,
        agentId: 'bridge',
        msgTs: '1700000000.000100',
        userId: 'U_OWNER',
        slack: {
            chat: {
                postMessage: async (args) => {
                    posts.push(args);
                    return { ok: true, ts: `1700000001.00010${posts.length}`, channel: args.channel };
                },
            },
        },
        slackClient: { ensureChannel: async () => { throw new Error('not expected'); } },
        storeTasksChannel: null,
        postToOps: async () => {},
        resolveMergeStates: async () => new Map(),
        formatStatusResponse: () => 'STATUS',
        ...overrides,
    };
    return ctx;
}

let tmp;
beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'builtins-'));
    approvalQueue.init({ queueFile: path.join(tmp, 'approval-queue.json') });
    botTaskLedger.init({ file: path.join(tmp, 'bot-task-posts.json') });
    bulletinBoard.init({ bulletinFile: path.join(tmp, 'bulletin.json') });
});
afterEach(() => {
    botTaskLedger.init();
    bulletinBoard.init();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the hub', () => {
    test('text that names no built-in returns false and replies nothing', async () => {
        const ctx = fakeCtx();
        expect(await answerBuiltin('what is the weather like', ctx)).toBe(false);
        expect(ctx.replies).toEqual([]);
    });

    test('the order is the one processConversation used', () => {
        expect(BUILTINS.map((b) => b.name)).toEqual([
            'status', 'owner tasks', 'create channel', 'staff task', 'bulletins',
            'standup', 'approval queue', 'approve', 'reject', 'show task',
        ]);
        expect(BUILTINS.filter((b) => b.bridgeOnly).map((b) => b.name))
            .toEqual(['status', 'owner tasks', 'create channel']);
    });

    test('a bridge-only built-in is not answered in an agent channel', async () => {
        const ctx = fakeCtx({ inBridgeChannel: false });
        expect(await answerBuiltin("what's queued", ctx)).toBe(false);
        expect(ctx.replies).toEqual([]);
    });
});

describe('status', () => {
    test('replies with the status built from the merge states', async () => {
        const states = new Map([['x', 'merged']]);
        let seen;
        const ctx = fakeCtx({
            resolveMergeStates: async () => states,
            formatStatusResponse: (s) => { seen = s; return 'STATUS'; },
        });
        expect(await answerBuiltin("what's queued", ctx)).toBe(true);
        expect(seen).toBe(states);
        expect(ctx.replies).toEqual(['STATUS']);
    });

    test('a failing merge-state resolver costs the merge column, never the reply', async () => {
        let seen;
        const ctx = fakeCtx({
            resolveMergeStates: async () => { throw new Error('fetch failed'); },
            formatStatusResponse: (s) => { seen = s; return 'STATUS'; },
        });
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await answerBuiltin('task status', ctx)).toBe(true);
        err.mockRestore();
        expect(seen).toBeInstanceOf(Map);
        expect(seen.size).toBe(0);
        expect(ctx.replies).toEqual(['STATUS']);
    });
});

describe('create channel', () => {
    test('a created channel is replied with its id', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const ctx = fakeCtx({ slackClient: { ensureChannel: async () => ({ created: true, channelId: 'C0NEW', name: 'new-room' }) } });
        expect(await answerBuiltin('create channel #new-room', ctx)).toBe(true);
        log.mockRestore();
        expect(ctx.replies[0]).toMatch(/Created channel <#C0NEW\|new-room>/);
    });

    test('a Slack failure is replied, not thrown', async () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        const ctx = fakeCtx({ slackClient: { ensureChannel: async () => { throw new Error('missing_scope'); } } });
        expect(await answerBuiltin('create channel #new-room', ctx)).toBe(true);
        err.mockRestore();
        expect(ctx.replies[0]).toMatch(/Failed to create channel: missing_scope/);
    });
});

describe('bulletins', () => {
    test('answers in any channel', async () => {
        const ctx = fakeCtx({ inBridgeChannel: false });
        expect(await answerBuiltin('bulletins', ctx)).toBe(true);
        expect(ctx.replies).toHaveLength(1);
    });
});

describe('approval queue', () => {
    function queueOne() {
        const { id } = approvalQueue.queueTask({
            source: 'security-followup',
            taskMessage: 'TASK: fix it\nINSTRUCTIONS: do it',
            targetChannel: 'C0FIXSEC',
            targetAgent: 'code-bridge',
            metadata: {},
        });
        return id;
    }

    test('approve <id> posts the task through the ledger, so the poll loop will run it', async () => {
        const id = queueOne();
        const ctx = fakeCtx();
        expect(await answerBuiltin(`approve ${id}`, ctx)).toBe(true);
        expect(ctx.posts).toHaveLength(1);
        expect(ctx.posts[0]).toMatchObject({ channel: 'C0FIXSEC', text: 'TASK: fix it\nINSTRUCTIONS: do it' });
        expect(botTaskLedger.lookup('C0FIXSEC', '1700000001.000101').posted).toBe(true);
        expect(ctx.replies[0]).toMatch(/Approved task/);
    });

    test('approve all with nothing pending posts nothing', async () => {
        const ctx = fakeCtx();
        expect(await answerBuiltin('approve all', ctx)).toBe(true);
        expect(ctx.posts).toEqual([]);
        expect(ctx.replies[0]).toMatch(/No pending tasks to approve/);
    });

    test('an unknown id is replied as an error and posts nothing', async () => {
        const ctx = fakeCtx();
        expect(await answerBuiltin('approve nope123', ctx)).toBe(true);
        expect(ctx.posts).toEqual([]);
        expect(ctx.replies[0]).toMatch(/^:x: /);
    });

    test('reject <id> removes it without posting', async () => {
        const id = queueOne();
        const ctx = fakeCtx();
        expect(await answerBuiltin(`reject ${id} not now`, ctx)).toBe(true);
        expect(ctx.posts).toEqual([]);
        expect(ctx.replies[0]).toMatch(/Rejected task/);
        expect(approvalQueue.getPendingTasks()).toEqual([]);
    });
});
