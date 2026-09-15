'use strict';

/**
 * Tests for lib/slack-client.js
 *
 * LOGIC CHANGE 2026-03-26: Initial test suite for Slack channel management functions.
 * LOGIC CHANGE 2026-03-28: Added tests for joinAgentChannels(), loadChannelMap(), saveChannelMap().
 *
 * LOGIC CHANGE 2026-09-15: this suite no longer writes the LIVE channel map.
 * `ensureChannel()` caches every resolution through `saveChannelMap()`, so the
 * ensureChannel tests below were writing `test-channel`, `new-channel` and
 * `my-channel` — three invented ids — into `agents/shared/channel-map.json`, the file
 * the running bridge resolves agent channels from. That is WORK-TODO #24's shape with
 * a twist worth naming: the override seam ALREADY existed (ownership of the map moved
 * to `lib/bridge-state.js init({ channelMapFile })` on 2026-09-15) and this suite
 * simply never used it, which is why #24's proposed source-shape enumerator would not
 * have caught it. The whole-run guard that does is jest `globalSetup`/`globalTeardown`
 * (`tests/helpers/live-state-*.js`).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createSlackClient, loadChannelMap, saveChannelMap, CHANNEL_NAME_MAX_LENGTH, CHANNEL_NAME_PATTERN } = require('../lib/slack-client');
const bridgeState = require('../lib/bridge-state');

// Every channel-map read and write in this file lands in a temp directory. Set up
// once for the whole file rather than per-describe: `loadChannelMap`/`saveChannelMap`
// are re-exports of bridge-state's, so ONE unscoped path anywhere in the file is
// enough to write the live map.
let mapWorkspace;
beforeEach(() => {
    mapWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-client-map-'));
    bridgeState.init({
        channelMapFile: path.join(mapWorkspace, 'channel-map.json'),
        activationFile: path.join(mapWorkspace, 'agent-activation.json'),
        stateFile: path.join(mapWorkspace, 'state.json'),
        processedTasksFile: path.join(mapWorkspace, 'processed-tasks.json'),
    });
});
afterEach(() => {
    if (mapWorkspace) fs.rmSync(mapWorkspace, { recursive: true, force: true });
    mapWorkspace = null;
});

// Mock @slack/web-api
jest.mock('@slack/web-api', () => ({
    WebClient: jest.fn().mockImplementation(() => ({
        conversations: {
            create: jest.fn(),
            join: jest.fn(),
            setTopic: jest.fn(),
            list: jest.fn(),
        },
        auth: {
            test: jest.fn().mockResolvedValue({ user_id: 'U12345' }),
        },
    })),
}));

describe('slack-client', () => {
    let slackClient;
    let mockWebClient;

    // LOGIC CHANGE 2026-03-28: Suppress expected console.error output from missing_scope
    // and other error-path tests. These are deliberate error tests, not real failures.
    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        slackClient = createSlackClient('xoxb-test-token');
        mockWebClient = slackClient.client;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('createSlackClient', () => {
        it('should create a client with valid token', () => {
            const client = createSlackClient('xoxb-test');
            expect(client).toBeDefined();
            expect(client.client).toBeDefined();
        });

        it('should throw error without token', () => {
            expect(() => createSlackClient()).toThrow('SLACK_BOT_TOKEN is required');
            expect(() => createSlackClient('')).toThrow('SLACK_BOT_TOKEN is required');
            expect(() => createSlackClient(null)).toThrow('SLACK_BOT_TOKEN is required');
        });
    });

    describe('normalizeChannelName', () => {
        it('should lowercase channel names', () => {
            expect(slackClient.normalizeChannelName('MyChannel')).toBe('mychannel');
            expect(slackClient.normalizeChannelName('TEST-CHANNEL')).toBe('test-channel');
        });

        it('should remove leading #', () => {
            expect(slackClient.normalizeChannelName('#my-channel')).toBe('my-channel');
            expect(slackClient.normalizeChannelName('##double-hash')).toBe('double-hash');
        });

        it('should replace spaces with hyphens', () => {
            expect(slackClient.normalizeChannelName('my channel')).toBe('my-channel');
            expect(slackClient.normalizeChannelName('my   channel')).toBe('my-channel');
        });

        it('should remove invalid characters', () => {
            expect(slackClient.normalizeChannelName('my@channel!')).toBe('mychannel');
            expect(slackClient.normalizeChannelName('test&channel*')).toBe('testchannel');
        });

        it('should ensure name starts with alphanumeric', () => {
            expect(slackClient.normalizeChannelName('-my-channel')).toBe('my-channel');
            expect(slackClient.normalizeChannelName('_test_channel')).toBe('test_channel');
        });

        it('should truncate to max length', () => {
            const longName = 'a'.repeat(100);
            expect(slackClient.normalizeChannelName(longName).length).toBe(CHANNEL_NAME_MAX_LENGTH);
        });

        it('should return empty string for empty input', () => {
            expect(slackClient.normalizeChannelName('')).toBe('');
            expect(slackClient.normalizeChannelName(null)).toBe('');
            expect(slackClient.normalizeChannelName(undefined)).toBe('');
        });
    });

    describe('validateChannelName', () => {
        it('should accept valid channel names', () => {
            expect(slackClient.validateChannelName('my-channel')).toEqual({ valid: true });
            expect(slackClient.validateChannelName('test_channel')).toEqual({ valid: true });
            expect(slackClient.validateChannelName('channel123')).toEqual({ valid: true });
            expect(slackClient.validateChannelName('123channel')).toEqual({ valid: true });
        });

        it('should reject empty names', () => {
            const result = slackClient.validateChannelName('');
            expect(result.valid).toBe(false);
            expect(result.error).toContain('required');
        });

        it('should reject names exceeding max length', () => {
            const longName = 'a'.repeat(81);
            const result = slackClient.validateChannelName(longName);
            expect(result.valid).toBe(false);
            expect(result.error).toContain('80 characters');
        });

        it('should reject names with invalid characters', () => {
            const result = slackClient.validateChannelName('my@channel');
            expect(result.valid).toBe(false);
        });

        it('should reject names starting with invalid characters', () => {
            const result = slackClient.validateChannelName('-my-channel');
            expect(result.valid).toBe(false);
        });
    });

    describe('createChannel', () => {
        it('should create a channel and return channel info', async () => {
            mockWebClient.conversations.create.mockResolvedValue({
                channel: { id: 'C12345', name: 'test-channel' },
            });

            const result = await slackClient.createChannel('test-channel');

            expect(result.channelId).toBe('C12345');
            expect(result.name).toBe('test-channel');
            expect(result.created).toBe(true);
            expect(mockWebClient.conversations.create).toHaveBeenCalledWith({
                name: 'test-channel',
                is_private: false,
            });
        });

        it('should normalize channel name before creating', async () => {
            mockWebClient.conversations.create.mockResolvedValue({
                channel: { id: 'C12345', name: 'my-channel' },
            });

            await slackClient.createChannel('#My Channel');

            expect(mockWebClient.conversations.create).toHaveBeenCalledWith({
                name: 'my-channel',
                is_private: false,
            });
        });

        it('should throw error for invalid channel name', async () => {
            await expect(slackClient.createChannel('')).rejects.toThrow('required');
        });

        it('should handle missing_scope error', async () => {
            const error = new Error('missing_scope');
            error.data = { error: 'missing_scope', needed: 'channels:manage' };
            mockWebClient.conversations.create.mockRejectedValue(error);

            await expect(slackClient.createChannel('test')).rejects.toThrow(
                'Missing Slack scope: channels:manage'
            );
        });

        it('should handle name_taken error', async () => {
            const error = new Error('name_taken');
            error.data = { error: 'name_taken' };
            mockWebClient.conversations.create.mockRejectedValue(error);

            await expect(slackClient.createChannel('test')).rejects.toThrow(
                "Channel name 'test' is already taken"
            );
        });
    });

    describe('inviteBotToChannel', () => {
        it('should join the channel successfully', async () => {
            mockWebClient.conversations.join.mockResolvedValue({});

            const result = await slackClient.inviteBotToChannel('C12345');

            expect(result.success).toBe(true);
            expect(mockWebClient.conversations.join).toHaveBeenCalledWith({
                channel: 'C12345',
            });
        });

        it('should handle already_in_channel as success', async () => {
            const error = new Error('already_in_channel');
            error.data = { error: 'already_in_channel' };
            mockWebClient.conversations.join.mockRejectedValue(error);

            const result = await slackClient.inviteBotToChannel('C12345');

            expect(result.success).toBe(true);
        });

        it('should throw error for missing channel ID', async () => {
            await expect(slackClient.inviteBotToChannel('')).rejects.toThrow('required');
            await expect(slackClient.inviteBotToChannel(null)).rejects.toThrow('required');
        });

        it('should handle missing_scope error', async () => {
            const error = new Error('missing_scope');
            error.data = { error: 'missing_scope', needed: 'channels:join' };
            mockWebClient.conversations.join.mockRejectedValue(error);

            await expect(slackClient.inviteBotToChannel('C12345')).rejects.toThrow(
                'Missing Slack scope: channels:join'
            );
        });
    });

    describe('setChannelTopic', () => {
        it('should set channel topic successfully', async () => {
            mockWebClient.conversations.setTopic.mockResolvedValue({
                channel: { topic: { value: 'New topic' } },
            });

            const result = await slackClient.setChannelTopic('C12345', 'New topic');

            expect(result.success).toBe(true);
            expect(result.topic).toBe('New topic');
            expect(mockWebClient.conversations.setTopic).toHaveBeenCalledWith({
                channel: 'C12345',
                topic: 'New topic',
            });
        });

        it('should handle empty topic', async () => {
            mockWebClient.conversations.setTopic.mockResolvedValue({
                channel: { topic: { value: '' } },
            });

            const result = await slackClient.setChannelTopic('C12345', '');

            expect(result.success).toBe(true);
        });

        it('should throw error for missing channel ID', async () => {
            await expect(slackClient.setChannelTopic('', 'topic')).rejects.toThrow('required');
        });

        it('should handle missing_scope error', async () => {
            const error = new Error('missing_scope');
            error.data = { error: 'missing_scope', needed: 'channels:manage' };
            mockWebClient.conversations.setTopic.mockRejectedValue(error);

            await expect(slackClient.setChannelTopic('C12345', 'topic')).rejects.toThrow(
                'Missing Slack scope: channels:manage'
            );
        });
    });

    describe('findChannelByName', () => {
        it('should find existing channel', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [
                    { id: 'C11111', name: 'other-channel' },
                    { id: 'C22222', name: 'test-channel' },
                ],
                response_metadata: {},
            });

            const result = await slackClient.findChannelByName('test-channel');

            expect(result).toEqual({
                channelId: 'C22222',
                name: 'test-channel',
            });
        });

        it('should return null for non-existent channel', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [{ id: 'C11111', name: 'other-channel' }],
                response_metadata: {},
            });

            const result = await slackClient.findChannelByName('test-channel');

            expect(result).toBeNull();
        });

        it('should normalize channel name before searching', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [{ id: 'C12345', name: 'my-channel' }],
                response_metadata: {},
            });

            const result = await slackClient.findChannelByName('#My Channel');

            expect(result).toEqual({
                channelId: 'C12345',
                name: 'my-channel',
            });
        });

        it('should return null for empty input', async () => {
            const result = await slackClient.findChannelByName('');
            expect(result).toBeNull();
        });

        it('should handle pagination', async () => {
            mockWebClient.conversations.list
                .mockResolvedValueOnce({
                    channels: [{ id: 'C11111', name: 'other-channel' }],
                    response_metadata: { next_cursor: 'cursor123' },
                })
                .mockResolvedValueOnce({
                    channels: [{ id: 'C22222', name: 'test-channel' }],
                    response_metadata: {},
                });

            const result = await slackClient.findChannelByName('test-channel');

            expect(result).toEqual({
                channelId: 'C22222',
                name: 'test-channel',
            });
            expect(mockWebClient.conversations.list).toHaveBeenCalledTimes(2);
        });
    });

    describe('ensureChannel', () => {
        it('should return existing channel without creating', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [{ id: 'C12345', name: 'test-channel' }],
                response_metadata: {},
            });
            mockWebClient.conversations.join.mockResolvedValue({});

            const result = await slackClient.ensureChannel('test-channel');

            expect(result.channelId).toBe('C12345');
            expect(result.name).toBe('test-channel');
            expect(result.created).toBe(false);
            expect(mockWebClient.conversations.create).not.toHaveBeenCalled();
        });

        it('should create channel if it does not exist', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [],
                response_metadata: {},
            });
            mockWebClient.conversations.create.mockResolvedValue({
                channel: { id: 'C99999', name: 'new-channel' },
            });

            const result = await slackClient.ensureChannel('new-channel');

            expect(result.channelId).toBe('C99999');
            expect(result.name).toBe('new-channel');
            expect(result.created).toBe(true);
            expect(mockWebClient.conversations.create).toHaveBeenCalled();
        });

        it('should set topic on existing channel if provided', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [{ id: 'C12345', name: 'test-channel' }],
                response_metadata: {},
            });
            mockWebClient.conversations.join.mockResolvedValue({});
            mockWebClient.conversations.setTopic.mockResolvedValue({
                channel: { topic: { value: 'New topic' } },
            });

            await slackClient.ensureChannel('test-channel', 'New topic');

            expect(mockWebClient.conversations.setTopic).toHaveBeenCalledWith({
                channel: 'C12345',
                topic: 'New topic',
            });
        });

        it('should set topic on new channel if provided', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [],
                response_metadata: {},
            });
            mockWebClient.conversations.create.mockResolvedValue({
                channel: { id: 'C99999', name: 'new-channel' },
            });
            mockWebClient.conversations.setTopic.mockResolvedValue({
                channel: { topic: { value: 'New topic' } },
            });

            await slackClient.ensureChannel('new-channel', 'New topic');

            expect(mockWebClient.conversations.setTopic).toHaveBeenCalled();
        });

        it('should throw error for invalid channel name', async () => {
            await expect(slackClient.ensureChannel('')).rejects.toThrow('required');
        });

        it('should normalize channel name', async () => {
            mockWebClient.conversations.list.mockResolvedValue({
                channels: [{ id: 'C12345', name: 'my-channel' }],
                response_metadata: {},
            });
            mockWebClient.conversations.join.mockResolvedValue({});

            const result = await slackClient.ensureChannel('#My Channel');

            expect(result.channelId).toBe('C12345');
        });
    });

    describe('constants', () => {
        it('should export CHANNEL_NAME_MAX_LENGTH', () => {
            expect(CHANNEL_NAME_MAX_LENGTH).toBe(80);
        });

        it('should export valid CHANNEL_NAME_PATTERN', () => {
            expect(CHANNEL_NAME_PATTERN.test('my-channel')).toBe(true);
            expect(CHANNEL_NAME_PATTERN.test('test_channel')).toBe(true);
            expect(CHANNEL_NAME_PATTERN.test('123channel')).toBe(true);
            expect(CHANNEL_NAME_PATTERN.test('-invalid')).toBe(false);
            expect(CHANNEL_NAME_PATTERN.test('_invalid')).toBe(false);
        });
    });

    // LOGIC CHANGE 2026-03-28: Tests for joinAgentChannels().
    describe('joinAgentChannels', () => {
        it('should join all channels and report success', async () => {
            mockWebClient.conversations.join.mockResolvedValue({});

            const channels = [
                { channelId: 'C11111', agentId: 'bridge' },
                { channelId: 'C22222', agentId: 'secretary' },
            ];

            const result = await slackClient.joinAgentChannels(channels);

            expect(result.joined).toBe(2);
            expect(result.failed).toBe(0);
            expect(result.total).toBe(2);
            expect(mockWebClient.conversations.join).toHaveBeenCalledTimes(2);
        });

        it('should count already_in_channel as success', async () => {
            const alreadyErr = new Error('already_in_channel');
            alreadyErr.data = { error: 'already_in_channel' };
            mockWebClient.conversations.join.mockRejectedValue(alreadyErr);

            const channels = [{ channelId: 'C11111', agentId: 'bridge' }];
            const result = await slackClient.joinAgentChannels(channels);

            expect(result.joined).toBe(1);
            expect(result.failed).toBe(0);
        });

        it('should count method_not_supported as success', async () => {
            const err = new Error('method_not_supported_for_channel_type');
            err.data = { error: 'method_not_supported_for_channel_type' };
            mockWebClient.conversations.join.mockRejectedValue(err);

            const channels = [{ channelId: 'C11111', agentId: 'bridge' }];
            const result = await slackClient.joinAgentChannels(channels);

            expect(result.joined).toBe(1);
            expect(result.failed).toBe(0);
        });

        it('should count missing_scope as failed', async () => {
            const err = new Error('missing_scope');
            err.data = { error: 'missing_scope', needed: 'channels:join' };
            mockWebClient.conversations.join.mockRejectedValue(err);

            const channels = [{ channelId: 'C11111', agentId: 'bridge' }];
            const result = await slackClient.joinAgentChannels(channels);

            expect(result.joined).toBe(0);
            expect(result.failed).toBe(1);
        });

        it('should skip channels without channelId', async () => {
            const channels = [
                { channelId: null, agentId: 'planned-agent' },
                { channelId: 'C22222', agentId: 'secretary' },
            ];
            mockWebClient.conversations.join.mockResolvedValue({});

            const result = await slackClient.joinAgentChannels(channels);

            expect(result.total).toBe(1);
            expect(result.joined).toBe(1);
        });

        it('should return zeros for empty channel list', async () => {
            const result = await slackClient.joinAgentChannels([]);
            expect(result.joined).toBe(0);
            expect(result.failed).toBe(0);
            expect(result.total).toBe(0);
        });

        it('should continue after individual channel failure', async () => {
            mockWebClient.conversations.join
                .mockRejectedValueOnce(new Error('some error'))
                .mockResolvedValueOnce({});

            const channels = [
                { channelId: 'C11111', agentId: 'bridge' },
                { channelId: 'C22222', agentId: 'secretary' },
            ];

            const result = await slackClient.joinAgentChannels(channels);

            expect(result.joined).toBe(1);
            expect(result.failed).toBe(1);
        });
    });
});

// LOGIC CHANGE 2026-03-28: Tests for loadChannelMap() and saveChannelMap() module exports.
describe('channel-map functions', () => {
    let tempDir;
    let originalChannelMapFile;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-map-test-'));
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch { /* ignore */ }
    });

    it('loadChannelMap should return {} when file does not exist', () => {
        // LOGIC CHANGE 2026-09-15: this used to read the REAL project map and assert
        // only its type, with a tempDir built beside it that the module ignored. It
        // now reads the temp map this file owns, so "does not exist" is a fact rather
        // than a hope.
        expect(loadChannelMap()).toEqual({});
    });

    it('saveChannelMap writes where the override points, never the project file', () => {
        saveChannelMap({ 'a-channel': 'C_TEMP_ONLY' });
        expect(loadChannelMap()).toEqual({ 'a-channel': 'C_TEMP_ONLY' });
        expect(fs.existsSync(path.join(mapWorkspace, 'channel-map.json'))).toBe(true);
        // Deliberately NOT asserted here: that the project's own map is absent. In a
        // real workspace it legitimately exists, so that assertion would be a fact
        // about the checkout. "This run did not write it" is a whole-run property and
        // belongs to the globalTeardown guard, which owns it.
    });

    it('saveChannelMap and loadChannelMap should be exported functions', () => {
        expect(typeof loadChannelMap).toBe('function');
        expect(typeof saveChannelMap).toBe('function');
    });
});
