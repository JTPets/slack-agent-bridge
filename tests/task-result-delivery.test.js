'use strict';

/**
 * tests/task-result-delivery.test.js
 *
 * WORK-TODO #6, the posting half (split from tests/task-result.test.js for the 300-line
 * gate): the card goes out through lib/slack-web.js postBlocks with its blocks redacted
 * (a REAL createWebClient client, and a plain WebClient as the negative control),
 * notify-owner posts it when given a result and falls back to its text when Slack refuses
 * the card, and processTask runs Phase 3 before the post and hands the result to it.
 */

const fs = require('fs');
const path = require('path');
const { WebClient } = require('@slack/web-api');

const { OUTCOME, buildTaskResult, renderText, renderBlocks, renderTaskResult } = require('../lib/task-result');
const slackWeb = require('../lib/slack-web');
const notifyOwner = require('../lib/notify-owner');
const { TASK, fullResult } = require('./helpers/task-result-fixtures');

describe('the card is posted through lib/slack-web.js and its blocks are redacted', () => {
    const FAKE_ENV_NAME = 'TASK_RESULT_TEST_TOKEN';
    const FAKE_ENV_VALUE = 'env-secret-value-9876543210';
    const SLACK_SHAPED = 'xoxb-1234567890-abcdefghij';
    let apiCall;
    let saved;

    beforeEach(() => {
        saved = process.env[FAKE_ENV_NAME];
        process.env[FAKE_ENV_NAME] = FAKE_ENV_VALUE;
        apiCall = jest.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true });
    });
    afterEach(() => {
        jest.restoreAllMocks();
        if (saved === undefined) delete process.env[FAKE_ENV_NAME];
        else process.env[FAKE_ENV_NAME] = saved;
    });

    // The body is built AFTER the env var is set, so redaction at build time cannot be
    // what hides it: the summary is assigned raw below.
    const leakyCard = () => {
        const r = fullResult();
        r.summary = `stderr: ${FAKE_ENV_VALUE} and ${SLACK_SHAPED}`;
        r.description = `task ${SLACK_SHAPED}`;
        return renderTaskResult(r);
    };

    test('postBlocks on a REAL createWebClient client sends text and blocks redacted', async () => {
        const client = slackWeb.createWebClient('xoxb-not-a-real-token');
        expect(await slackWeb.postBlocks(client, 'C0FIXOPS', leakyCard(), 'test')).toBe(true);
        const [method, sent] = apiCall.mock.calls[0];
        expect(method).toBe('chat.postMessage');
        expect(Array.isArray(sent.blocks)).toBe(true);
        const body = JSON.stringify(sent);
        expect(body).not.toContain(FAKE_ENV_VALUE);
        expect(body).not.toContain(SLACK_SHAPED);
        expect(JSON.stringify(sent.blocks)).toContain(`[REDACTED:${FAKE_ENV_NAME}]`);
    });

    test('postBlocks redacts even through a client not built by createWebClient', async () => {
        const raw = new WebClient('xoxb-not-a-real-token');
        await slackWeb.postBlocks(raw, 'C0FIXOPS', leakyCard());
        expect(JSON.stringify(apiCall.mock.calls[0][1])).not.toContain(FAKE_ENV_VALUE);
    });

    test('negative control: the same card posted raw through a plain WebClient leaks', async () => {
        const raw = new WebClient('xoxb-not-a-real-token');
        await raw.chat.postMessage({ channel: 'C0FIXOPS', ...leakyCard() });
        expect(JSON.stringify(apiCall.mock.calls[0][1].blocks)).toContain(FAKE_ENV_VALUE);
    });

    test('postBlocks never throws and returns false on a Slack error', async () => {
        const client = { chat: { postMessage: jest.fn().mockRejectedValue(new Error('channel_not_found')) } };
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await slackWeb.postBlocks(client, 'C1', { text: 't', blocks: [] })).toBe(false);
    });
});

describe('notify-owner posts the card when given a result', () => {
    let client;
    beforeEach(() => {
        client = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) }, conversations: { open: jest.fn() } };
        notifyOwner.init({ slack: client, ownerId: null, opsChannelId: 'C0FIXOPS' });
    });
    afterAll(() => notifyOwner.init({ slack: null, ownerId: null, opsChannelId: null }));

    test('taskCompleted with a result posts blocks and the fallback text, and returns true', async () => {
        const result = fullResult();
        expect(await notifyOwner.taskCompleted(TASK, 'ignored', { result })).toBe(true);
        const sent = client.chat.postMessage.mock.calls[0][0];
        expect(sent.channel).toBe('C0FIXOPS');
        expect(sent.blocks).toEqual(renderBlocks(result));
        expect(sent.text).toBe(renderText(result));
    });

    test('taskCompleted without a result is the old text post, unchanged', async () => {
        await notifyOwner.taskCompleted(TASK, 'plain output', { elapsed: '3' });
        const sent = client.chat.postMessage.mock.calls[0][0];
        expect(sent.blocks).toBeUndefined();
        expect(sent.text).toMatch(/Task completed\* \(3s\)/);
    });

    test('a card Slack refuses is posted again as its text alone, so the result is not lost', async () => {
        const result = fullResult();
        client.chat.postMessage
            .mockRejectedValueOnce(new Error('invalid_blocks'))
            .mockResolvedValueOnce({ ok: true });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await notifyOwner.taskCompleted(TASK, 'x', { result })).toBe(true);
        console.error.mockRestore();
        expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
        const second = client.chat.postMessage.mock.calls[1][0];
        expect(second.blocks).toBeUndefined();
        expect(second.text).toBe(renderText(result));
    });

    test('a failed card post AND text post is false, so the caller records delivered: false', async () => {
        client.chat.postMessage.mockRejectedValue(new Error('not_in_channel'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await notifyOwner.taskCompleted(TASK, 'x', { result: fullResult() })).toBe(false);
        console.error.mockRestore();
    });

    test('taskFailed with a result posts the failure card to ops', async () => {
        const result = buildTaskResult({ task: TASK, outcome: OUTCOME.FAILED, error: 'boom' });
        const report = await notifyOwner.taskFailed(TASK, new Error('boom'), { result });
        expect(report.opsPosted).toBe(true);
        const sent = client.chat.postMessage.mock.calls[0][0];
        expect(sent.text).toMatch(/Task failed/);
        expect(Array.isArray(sent.blocks)).toBe(true);
    });
});

describe('the bridge-agent.js wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    const fn = src.slice(src.indexOf('async function processTask('), src.indexOf('\n}\n', src.indexOf('async function processTask(')));

    test('Phase 3 runs before the result post, and the result is handed to it', () => {
        const gate = fn.indexOf('validation = validateOutput(taskDir');
        const build = fn.indexOf('const taskResult = buildTaskResult(');
        const post = fn.indexOf('await notifyOwner.taskCompleted(');
        const terminal = fn.indexOf('.complete(queueId');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(build);
        expect(build).toBeLessThan(post);
        expect(post).toBeLessThan(terminal);
        const args = fn.slice(post, fn.indexOf('});', post));
        expect(args).toMatch(/result: taskResult/);
    });

    test('there is one validateOutput call in processTask, not a second run after the post', () => {
        expect(fn.match(/validateOutput\(/g)).toHaveLength(1);
    });

    test('the failure path passes its result card to taskFailed', () => {
        const at = fn.indexOf('await notifyOwner.taskFailed(');
        expect(fn.slice(at, fn.indexOf('});', at))).toMatch(/result: failureResult/);
    });

    test('the interrupted notice is rendered from the same result shape', () => {
        const at = fn.indexOf('if (interrupted) {');
        expect(fn.slice(at, fn.indexOf('.interrupt(', at))).toMatch(/renderText\(buildTaskResult\(/);
    });
});
