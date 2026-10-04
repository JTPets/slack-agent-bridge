'use strict';

/**
 * tests/slack-redaction.test.js
 *
 * THE enumerating guard for WORK-TODO #30: nothing reaches Slack unredacted. Redaction
 * lives in the client (lib/slack-web.js createWebClient), so the class is closed by two
 * facts proved here together:
 *   1. a client from createWebClient redacts text, blocks and attachments on every
 *      chat.* posting method, against the real @slack/web-api client;
 *   2. no production file constructs a client any other way, or bypasses the chat.*
 *      methods with a raw apiCall.
 * Each pattern carries a negative control, because "this list is empty" is also what a
 * blind pattern produces.
 *
 * Also the #21 logger: `already_in_channel` is dropped, every other SDK warning is not.
 */

const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');

const { listSourceFiles, stripComments, REPO_ROOT } = require('./helpers/source-scan');
const slackWeb = require('../lib/slack-web');

const OWNER = path.join('lib', 'slack-web.js');
const CONSTRUCTS = /\bnew\s+WebClient\s*\(/;
const REQUIRES_SDK = /require\s*\(\s*['"]@slack\/web-api['"]\s*\)/;
const RAW_CHAT_CALL = /\.apiCall\s*\(\s*['"`]chat\./;

const FAKE_ENV_NAME = 'SLACK_REDACTION_TEST_TOKEN';
const FAKE_ENV_VALUE = 'env-secret-value-0123456789';
const SLACK_SHAPED = 'xoxb-1234567890-abcdefghij';

function productionSources() {
    return listSourceFiles().map((abs) => ({
        rel: path.relative(REPO_ROOT, abs),
        code: stripComments(fs.readFileSync(abs, 'utf8')),
    }));
}

describe('the patterns detect what they forbid (negative controls)', () => {
    test('construction, SDK require and raw chat apiCall are each matched', () => {
        expect(CONSTRUCTS.test('const c = new WebClient(token);')).toBe(true);
        expect(REQUIRES_SDK.test("const { WebClient } = require('@slack/web-api');")).toBe(true);
        expect(RAW_CHAT_CALL.test("client.apiCall('chat.postMessage', args)")).toBe(true);
        expect(CONSTRUCTS.test('const c = createWebClient(token);')).toBe(false);
        expect(RAW_CHAT_CALL.test("client.apiCall('conversations.join', args)")).toBe(false);
    });
});

describe('every Slack client in production comes from lib/slack-web.js', () => {
    const files = productionSources();

    test('the walk found the owner and the entry points', () => {
        const rels = files.map((f) => f.rel);
        for (const f of [OWNER, 'bridge-agent.js', 'auto-update.js', 'security-review.js', 'morning-digest.js']) {
            expect(rels).toContain(f);
        }
    });

    test('new WebClient( appears only in lib/slack-web.js', () => {
        expect(files.filter((f) => f.rel !== OWNER && CONSTRUCTS.test(f.code)).map((f) => f.rel)).toEqual([]);
        expect(CONSTRUCTS.test(files.find((f) => f.rel === OWNER).code)).toBe(true);
    });

    test('@slack/web-api is required only by lib/slack-web.js', () => {
        expect(files.filter((f) => f.rel !== OWNER && REQUIRES_SDK.test(f.code)).map((f) => f.rel)).toEqual([]);
    });

    test('nothing posts through a raw apiCall that would skip the redacting wrappers', () => {
        expect(files.filter((f) => RAW_CHAT_CALL.test(f.code)).map((f) => f.rel)).toEqual([]);
    });
});

describe('a client from createWebClient redacts every chat.* post (real @slack/web-api)', () => {
    let apiCall;
    let saved;

    beforeEach(() => {
        saved = process.env[FAKE_ENV_NAME];
        process.env[FAKE_ENV_NAME] = FAKE_ENV_VALUE;
        // chat.* methods bind apiCall at construction, so spy before constructing.
        apiCall = jest.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (saved === undefined) delete process.env[FAKE_ENV_NAME];
        else process.env[FAKE_ENV_NAME] = saved;
    });

    const leaky = () => ({
        channel: 'C0FIXOPS',
        text: `stderr: ${FAKE_ENV_VALUE} and ${SLACK_SHAPED}`,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `token ${SLACK_SHAPED}` } }],
        attachments: [{ fields: [{ value: FAKE_ENV_VALUE }] }],
    });

    test.each(slackWeb.REDACTED_METHODS)('chat.%s', async (method) => {
        const client = slackWeb.createWebClient('xoxb-not-a-real-token');
        await client.chat[method](leaky());
        expect(apiCall).toHaveBeenCalledTimes(1);
        const [apiMethod, sent] = apiCall.mock.calls[0];
        expect(apiMethod).toBe(`chat.${method}`);
        const body = JSON.stringify(sent);
        expect(body).not.toContain(FAKE_ENV_VALUE);
        expect(body).not.toContain(SLACK_SHAPED);
        expect(sent.text).toContain(`[REDACTED:${FAKE_ENV_NAME}]`);
        expect(sent.channel).toBe('C0FIXOPS');
    });

    test('a plain WebClient sends the same arguments unredacted (negative control)', async () => {
        const raw = new WebClient('xoxb-not-a-real-token');
        await raw.chat.postMessage(leaky());
        expect(JSON.stringify(apiCall.mock.calls[0][1])).toContain(FAKE_ENV_VALUE);
    });

    test('the client gets the repo logger at level warn', () => {
        expect(slackWeb.createWebClient('xoxb-not-a-real-token').logger.getLevel()).toBe('warn');
    });
});

describe('the logger drops already_in_channel and nothing else (WORK-TODO #21)', () => {
    afterEach(() => jest.restoreAllMocks());

    test('the SDK calls warn(warning, index, array); only the expected warning is dropped', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const logger = slackWeb.createLogger();
        ['already_in_channel', 'missing_charset'].forEach(logger.warn.bind(logger));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toContain('missing_charset');
    });

    test('debug (which the SDK uses to dump full API results) is off by default', () => {
        const debug = jest.spyOn(console, 'debug').mockImplementation(() => {});
        slackWeb.createLogger().debug('http request result: {...}');
        expect(debug).not.toHaveBeenCalled();
    });
});

describe('postText and sendDM never throw and report whether the message landed', () => {
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    test('postText redacts even through a client not built by createWebClient', async () => {
        const postMessage = jest.fn().mockResolvedValue({ ok: true });
        expect(await slackWeb.postText({ chat: { postMessage } }, 'C1', `x ${SLACK_SHAPED}`)).toBe(true);
        expect(postMessage.mock.calls[0][0]).toEqual({ channel: 'C1', text: 'x [REDACTED:SLACK_TOKEN]', unfurl_links: false });
    });

    test('postText returns false on a Slack error', async () => {
        const postMessage = jest.fn().mockRejectedValue(new Error('channel_not_found'));
        expect(await slackWeb.postText({ chat: { postMessage } }, 'C1', 'hi')).toBe(false);
    });

    test('sendDM opens the DM and posts into it', async () => {
        const client = {
            conversations: { open: jest.fn().mockResolvedValue({ channel: { id: 'D1' } }) },
            chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) },
        };
        expect(await slackWeb.sendDM(client, 'U1', 'hello')).toBe(true);
        expect(client.chat.postMessage.mock.calls[0][0].channel).toBe('D1');
    });

    test('sendDM returns false when the DM cannot be opened, and posts nothing', async () => {
        const client = {
            conversations: { open: jest.fn().mockRejectedValue(new Error('user_not_found')) },
            chat: { postMessage: jest.fn() },
        };
        expect(await slackWeb.sendDM(client, 'U1', 'hello')).toBe(false);
        expect(client.chat.postMessage).not.toHaveBeenCalled();
    });
});
