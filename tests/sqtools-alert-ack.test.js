/**
 * tests/sqtools-alert-ack.test.js
 *
 * WORK-TODO #78, item 1 (the verb half): the owner acknowledges a SqTools alert with
 * `ASK: ack <id> silence|nag|close`. Real lib/sqtools-alert-intake.js and real state
 * files in a temp dir; only Slack is a double.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('../lib/sqtools-alert-intake');
const ack = require('../lib/sqtools-alert-ack');
const router = require('../lib/command-router');

const FROM = 'JT Pets - SqTools Alerts <jtpets@jtpets.ca>';
// 14:00 UTC = 09:00 Toronto, Mon 2026-11-02.
const NOW = new Date('2026-11-02T14:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(NOW.getTime() + h * HOUR);

const WEBHOOK = '18f3a2c4d5e6b7a1';
const SQUARE = '18f3b9e0c1d2a3f4';
const ROUTINE = '27aa00bb11cc22dd';

function alert(id, subject) {
    return { id, from: FROM, subject, body: '', date: '2026-11-02T13:00:00Z' };
}
function slackDouble() {
    const posts = [];
    return { posts, chat: { postMessage: async (args) => { posts.push(args); return { ok: true }; } } };
}

let dir;
let stateFile;
let slack;
const check = (now, emails = []) => intake.processSqToolsAlerts({ emails, slack, channelId: 'C_SEC', now, stateFile });
const verb = (args, now = NOW) => ack.handleAck({ args, now, stateFile, userId: 'U_OWNER' });

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqtools-ack-'));
    stateFile = path.join(dir, 'sqtools-alerts.json');
    slack = slackDouble();
    await check(NOW, [
        alert(WEBHOOK, '[SqTools] ALERT: Webhook dead: x'),
        alert(SQUARE, '[SqTools] ALERT: Square connection needs attention'),
        alert(ROUTINE, '[SqTools] ALERT: Min Stock Auto-Adjustment: 0 reduced, 2 increased — JT Pets'),
    ]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the alert post tells the owner how to acknowledge', () => {
    test('each alert that needs the owner carries its short id, and the post names the verb', () => {
        const text = slack.posts[0].text;
        expect(text).toContain(`\`${WEBHOOK.slice(0, 6)}\``);
        expect(text).toContain('`ASK: ack <id> silence|nag|close`');
        expect(text).not.toContain('Acknowledge buttons are not built yet');
        expect(text).not.toContain(`\`${ROUTINE.slice(0, 6)}\``);
    });
});

describe('ASK: ack', () => {
    test('with no arguments lists what waits on the owner', async () => {
        const v = await verb('');
        expect(v.ok).toBe(true);
        expect(v.text).toContain('waiting on you:* 2');
        expect(v.text).toContain('not acknowledged');
    });

    test('silence records the decision and drops the alert from the list', async () => {
        const v = await verb(`${WEBHOOK.slice(0, 6)} silence`);
        expect(v).toMatchObject({ ok: true });
        const rec = intake.readState(stateFile).recent.find((r) => r.id === WEBHOOK);
        expect(rec.ack).toMatchObject({ state: 'silenced', nag: false, by: 'U_OWNER' });
        expect((await verb('')).text).toContain('waiting on you:* 1');
    });

    test('an ambiguous prefix, an unknown id, a routine alert and an unknown action are refused, nothing written', async () => {
        const before = fs.readFileSync(stateFile, 'utf8');
        expect((await verb('18f3 nag')).text).toMatch(/matches 2 alerts/);
        expect((await verb('ffffff nag')).text).toMatch(/No recorded SqTools alert/);
        expect((await verb(`${ROUTINE.slice(0, 6)} nag`)).text).toMatch(/routine and needs no acknowledgement/);
        expect((await verb(`${WEBHOOK.slice(0, 6)} snooze`)).text).toMatch(/Unknown acknowledgement/);
        expect((await verb(`${WEBHOOK.slice(0, 6)}`)).text).toMatch(/Usage/);
        expect(fs.readFileSync(stateFile, 'utf8')).toBe(before);
    });
});

describe('nag and close for the day', () => {
    test('a nagged alert is re-posted on a check, at most once per interval', async () => {
        await verb(`${WEBHOOK.slice(0, 6)} nag`);
        await check(at(0.5));
        expect(slack.posts).toHaveLength(2);
        expect(slack.posts[1].text).toContain('Still open (you asked to be nagged):* 1');
        expect(slack.posts[1].text).toContain('Webhook');
        await check(at(1));                 // inside the 2 h default interval
        expect(slack.posts).toHaveLength(2);
        await check(at(2.6));
        expect(slack.posts).toHaveLength(3);
    });

    test('an alert nobody acknowledged is never reminded (the stated reading)', async () => {
        await check(at(3));
        await check(at(6));
        expect(slack.posts).toHaveLength(1);
    });

    test('close stops today and nagging resumes the next Toronto day', async () => {
        await verb(`${WEBHOOK.slice(0, 6)} nag`);
        await verb(`${WEBHOOK.slice(0, 6)} close`, at(0.1));
        await check(at(3));
        await check(at(8));                 // 17:00 Toronto, same day
        expect(slack.posts).toHaveLength(1);
        await check(at(24));                // 09:00 Toronto, next day
        expect(slack.posts).toHaveLength(2);
        expect(slack.posts[1].text).toContain('Still open');
    });

    test('silence after nag stops the reminders for good', async () => {
        await verb(`${WEBHOOK.slice(0, 6)} nag`);
        await verb(`${WEBHOOK.slice(0, 6)} silence`);
        await check(at(3));
        await check(at(30));
        expect(slack.posts).toHaveLength(1);
    });

    test('a failed reminder post is not stamped, so the next check retries it', async () => {
        await verb(`${WEBHOOK.slice(0, 6)} nag`);
        const failing = { chat: { postMessage: async () => { throw new Error('ratelimited'); } } };
        const v = await intake.processSqToolsAlerts({ emails: [], slack: failing, channelId: 'C_SEC', now: at(0.5), stateFile });
        expect(v.ok).toBe(false);
        await check(at(0.6));
        expect(slack.posts).toHaveLength(2);
    });

    test('an acknowledgement written while a post is in flight is not overwritten', async () => {
        const racing = {
            chat: {
                postMessage: async (args) => {
                    await verb(`${SQUARE.slice(0, 6)} silence`); // the owner acks mid-post
                    slack.posts.push(args);
                    return { ok: true };
                },
            },
        };
        await verb(`${WEBHOOK.slice(0, 6)} nag`);
        await intake.processSqToolsAlerts({ emails: [], slack: racing, channelId: 'C_SEC', now: at(0.5), stateFile });
        const rec = intake.readState(stateFile).recent.find((r) => r.id === SQUARE);
        expect(rec.ack && rec.ack.state).toBe('silenced');
    });
});

describe('the command table', () => {
    test('ack is a registered mutate verb and runs through runCommand', async () => {
        expect(router.COMMANDS.ack.kind).toBe('mutate');
        const v = await router.runCommand('ack', { stateFile });
        expect(v).toMatchObject({ handled: true, verb: 'ack', ok: true });
    });

    test('`ack <id> <action>` typed in an agent channel is refused, not answered by the model', () => {
        expect(router.isBareCommand(`ack ${WEBHOOK.slice(0, 6)} silence`)).toBe(true);
        expect(router.isBareCommand('ack the vendor about the late order')).toBe(false);
    });
});
