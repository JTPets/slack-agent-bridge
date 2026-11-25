'use strict';

/**
 * tests/slack-channel-parts.test.js
 *
 * WORK-TODO #10, B34 (2026-11-25): the parts createSlackClient was split into are each
 * testable on their own, the point of the split (owner: "testable code, fixable code").
 * No wrapper, no token: the name rules are pure, and every operation takes the client
 * first, so a plain object stands in for Slack.
 */

const names = require('../lib/slack-channel-names');
const ops = require('../lib/slack-channel-ops');
const ensure = require('../lib/slack-channel-ensure');

function slackError(code) {
    const err = new Error(code);
    err.data = { error: code };
    return err;
}

describe('lib/slack-channel-names.js is pure', () => {
    test('normalises and validates without any client', () => {
        expect(names.normalizeChannelName('#Team Standup!')).toBe('team-standup');
        expect(names.validateChannelName('team-standup')).toEqual({ valid: true });
        expect(names.validateChannelName('Bad Name').valid).toBe(false);
    });
});

describe('lib/slack-channel-ops.js takes the client first', () => {
    test('findChannelByName pages through conversations.list on the client it is given', async () => {
        const pages = [
            { channels: [{ id: 'C1', name: 'other' }], response_metadata: { next_cursor: 'n' } },
            { channels: [{ id: 'C2', name: 'wanted' }] },
        ];
        const client = { conversations: { list: jest.fn(async () => pages.shift()) } };
        await expect(ops.findChannelByName(client, '#Wanted')).resolves.toEqual({ channelId: 'C2', name: 'wanted' });
        expect(client.conversations.list).toHaveBeenCalledTimes(2);
    });

    test('inviteBotToChannel treats already_in_channel as success', async () => {
        const client = {
            auth: { test: async () => ({ user_id: 'UBOT' }) },
            conversations: { join: async () => { throw slackError('already_in_channel'); } },
        };
        await expect(ops.inviteBotToChannel(client, 'C1')).resolves.toEqual({ success: true });
    });

    test('createChannel names the missing scope', async () => {
        const client = { conversations: { create: async () => { throw slackError('missing_scope'); } } };
        await expect(ops.createChannel(client, 'new-one')).rejects.toThrow(/Missing Slack scope: channels:manage/);
    });
});

describe('throwIfMissingScope: the one missing_scope report', () => {
    test('names the scope Slack asked for, else the fallback; ignoreNeeded keeps the fallback', () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const needed = Object.assign(slackError('missing_scope'), {});
            needed.data.needed = 'groups:read';
            expect(() => ops.throwIfMissingScope(needed, 'channels:read')).toThrow('Missing Slack scope: groups:read.');
            expect(() => ops.throwIfMissingScope(needed, 'channels:read', { ignoreNeeded: true }))
                .toThrow('Missing Slack scope: channels:read.');
            expect(() => ops.throwIfMissingScope(slackError('missing_scope'), 'channels:join'))
                .toThrow('Missing Slack scope: channels:join.');
            expect(ops.throwIfMissingScope(slackError('channel_not_found'), 'channels:join')).toBeUndefined();
        } finally {
            err.mockRestore();
        }
    });
});

describe('lib/slack-channel-ensure.js takes the client first', () => {
    test('joinAgentChannels counts joins and failures on the given client', async () => {
        const client = {
            conversations: {
                join: async ({ channel }) => {
                    if (channel === 'CBAD') throw slackError('channel_not_found');
                    return { ok: true };
                },
            },
        };
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            await expect(ensure.joinAgentChannels(client, [
                { channelId: 'C1', agentId: 'a' }, { channelId: 'CBAD', agentId: 'b' }, { agentId: 'none' },
            ])).resolves.toEqual({ joined: 1, failed: 1, total: 2 });
        } finally {
            log.mockRestore();
            err.mockRestore();
        }
    });
});
