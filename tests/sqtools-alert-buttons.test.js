/**
 * tests/sqtools-alert-buttons.test.js
 *
 * WORK-TODO #78, item 1 (the button half): Silence / Nag / Close today buttons on a
 * SqTools alert post. Real lib/sqtools-alert-intake.js, real lib/sqtools-alert-ack.js,
 * real state files in a temp dir; only Slack is a double.
 *
 * THE property the owner set (2026-11-07): acknowledgement is per alert OCCURRENCE. An
 * acknowledged alert is never sent again, but a new email with the same subject (the
 * next backup failure) is a new alert and is posted, with its own buttons.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('../lib/sqtools-alert-intake');
const buttons = require('../lib/sqtools-alert-buttons');

const FROM = 'JT Pets - SqTools Alerts <jtpets@jtpets.ca>';
const NOW = new Date('2026-11-02T14:00:00Z'); // 09:00 Toronto
const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(NOW.getTime() + h * HOUR);

const WEBHOOK = '18f3a2c4d5e6b7a1';
const WEBHOOK_AGAIN = '18f4c0ffee000001';
const ROUTINE = '27aa00bb11cc22dd';
const WEBHOOK_SUBJECT = '[SqTools] ALERT: Webhook dead: x';

function alert(id, subject) {
    return { id, from: FROM, subject, body: '', date: '2026-11-02T13:00:00Z' };
}
function slackDouble() {
    const posts = [];
    return { posts, chat: { postMessage: async (args) => { posts.push(args); return { ok: true, ts: `1.${posts.length}` }; } } };
}
function pressBody(post, id, action, userId = 'U_OWNER') {
    return {
        type: 'block_actions',
        user: { id: userId },
        channel: { id: 'C_SEC' },
        message: { ts: '1.1', text: post.text, blocks: post.blocks },
        actions: [{ action_id: `${buttons.ACTION_PREFIX}${action}`, value: id }],
    };
}

let dir;
let stateFile;
let slack;
let calls;
const check = (now, emails = []) => intake.processSqToolsAlerts({ emails, slack, channelId: 'C_SEC', now, stateFile });
const record = (id) => intake.readState(stateFile).recent.find((r) => r.id === id);
function deps(extra = {}) {
    return {
        isAuthorized: (u) => u === 'U_OWNER',
        updateMessage: async (args) => { calls.push(['update', args]); },
        postEphemeral: async (args) => { calls.push(['ephemeral', args]); },
        notify: async (text) => { calls.push(['notify', text]); },
        logger: { log() {}, warn() {}, error() {} },
        stateFile,
        now: at(1),
        ...extra,
    };
}
const press = (body, extra) => {
    const ack = jest.fn(async () => { calls.push(['ack']); });
    return buttons.handleAckAction({ ack, body }, deps(extra)).then((r) => ({ r, ack }));
};

beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqtools-buttons-'));
    stateFile = path.join(dir, 'sqtools-alerts.json');
    slack = slackDouble();
    calls = [];
    await check(NOW, [
        alert(WEBHOOK, WEBHOOK_SUBJECT),
        alert(ROUTINE, '[SqTools] ALERT: Min Stock Auto-Adjustment: 0 reduced, 2 increased — JT Pets'),
    ]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const actionRows = (post) => post.blocks.filter((b) => b.type === 'actions');

describe('the alert post carries buttons', () => {
    test('one row of three buttons per alert that needs the owner, valued by its FULL Gmail id', () => {
        const rows = actionRows(slack.posts[0]);
        expect(rows).toHaveLength(1);
        expect(rows[0].block_id).toBe(`${buttons.BLOCK_PREFIX}${WEBHOOK}`);
        expect(rows[0].elements.map((e) => e.action_id)).toEqual(
            ['silence', 'nag', 'close'].map((a) => `${buttons.ACTION_PREFIX}${a}`));
        expect(rows[0].elements.every((e) => e.value === WEBHOOK)).toBe(true);
    });

    test('a routine alert gets no buttons, and the text is still in the blocks and the fallback', () => {
        const post = slack.posts[0];
        expect(JSON.stringify(actionRows(post))).not.toContain(ROUTINE);
        const shown = post.blocks.filter((b) => b.type === 'section').map((b) => b.text.text).join('\n');
        expect(shown).toBe(post.text);
        expect(post.text).toContain('`ASK: ack <id> silence|nag|close`');
        expect(post.text).not.toContain('buttons: WORK-TODO #78');
    });

    test('a nag reminder carries buttons for the nagged alert', async () => {
        await press(pressBody(slack.posts[0], WEBHOOK, 'nag'));
        await check(at(3));
        expect(slack.posts).toHaveLength(2);
        expect(actionRows(slack.posts[1]).map((r) => r.block_id)).toEqual([`${buttons.BLOCK_PREFIX}${WEBHOOK}`]);
    });
});

describe('a press records the same decision as the typed verb', () => {
    test.each([
        ['silence', { state: 'silenced', nag: false }],
        ['nag', { state: 'nag', nag: true }],
        ['close', { state: 'closed', closedDay: '2026-11-02' }],
    ])('%s', async (action, expected) => {
        const { r, ack } = await press(pressBody(slack.posts[0], WEBHOOK, action));
        expect(r).toEqual({ ok: true, reason: 'recorded' });
        expect(ack).toHaveBeenCalledTimes(1);
        expect(calls[0]).toEqual(['ack']);
        expect(record(WEBHOOK).ack).toMatchObject({ ...expected, by: 'U_OWNER' });
    });

    test('the post is updated: the pressed row becomes the outcome, everything else is kept', async () => {
        await press(pressBody(slack.posts[0], WEBHOOK, 'silence'));
        const [, args] = calls.find((c) => c[0] === 'update');
        expect(args).toMatchObject({ channel: 'C_SEC', ts: '1.1', text: slack.posts[0].text });
        expect(args.blocks).toHaveLength(slack.posts[0].blocks.length);
        expect(args.blocks.filter((b) => b.type === 'actions')).toHaveLength(0);
        expect(JSON.stringify(args.blocks)).toContain('Silenced by <@U_OWNER>');
        expect(calls.some((c) => c[0] === 'ephemeral')).toBe(false);
    });
});

describe('acknowledgement is per occurrence, never per alert type', () => {
    test('a silenced alert is never re-sent, but a NEW email with the same subject is posted with its own buttons', async () => {
        await press(pressBody(slack.posts[0], WEBHOOK, 'silence'));
        await check(at(2), [alert(WEBHOOK, WEBHOOK_SUBJECT)]); // the same email, re-fetched
        expect(slack.posts).toHaveLength(1);

        await check(at(3), [alert(WEBHOOK_AGAIN, WEBHOOK_SUBJECT)]); // the next occurrence
        expect(slack.posts).toHaveLength(2);
        expect(actionRows(slack.posts[1]).map((r) => r.block_id)).toEqual([`${buttons.BLOCK_PREFIX}${WEBHOOK_AGAIN}`]);
        expect(record(WEBHOOK_AGAIN).ack).toBeNull();
        expect(record(WEBHOOK).ack.state).toBe('silenced');
    });

    test('silencing the new occurrence leaves the old one\'s record untouched', async () => {
        await check(at(1), [alert(WEBHOOK_AGAIN, WEBHOOK_SUBJECT)]);
        await press(pressBody(slack.posts[1], WEBHOOK_AGAIN, 'silence'));
        expect(record(WEBHOOK).ack).toBeNull();
        expect(record(WEBHOOK_AGAIN).ack.state).toBe('silenced');
    });
});

describe('refusals write nothing and are answered', () => {
    test('a presser not on the allowlist', async () => {
        const { r } = await press(pressBody(slack.posts[0], WEBHOOK, 'silence', 'U_STRANGER'));
        expect(r.reason).toBe('unauthorized');
        expect(record(WEBHOOK).ack).toBeNull();
        expect(calls.find((c) => c[0] === 'ephemeral')[1]).toMatchObject({ user: 'U_STRANGER' });
    });

    test('an id no recorded alert has', async () => {
        const { r } = await press(pressBody(slack.posts[0], 'ffffffffffffffff', 'silence'));
        expect(r.reason).toBe('refused');
        expect(calls.find((c) => c[0] === 'ephemeral')[1].text).toContain('No recorded SqTools alert');
        expect(calls.some((c) => c[0] === 'update')).toBe(false);
    });

    test('an update that fails still tells the presser the decision was recorded', async () => {
        const { r } = await press(pressBody(slack.posts[0], WEBHOOK, 'close'),
            { updateMessage: async () => { throw new Error('message_not_found'); } });
        expect(r.ok).toBe(true);
        expect(calls.find((c) => c[0] === 'ephemeral')[1].text).toContain('message_not_found');
    });

    test('a reply that cannot be delivered reaches ops', async () => {
        await press(pressBody(slack.posts[0], WEBHOOK, 'silence', 'U_STRANGER'),
            { postEphemeral: async () => { throw new Error('channel_not_found'); } });
        expect(calls.find((c) => c[0] === 'notify')[1]).toContain('channel_not_found');
    });

    test('an unwritable state file is reported, never thrown', async () => {
        const { r } = await press(pressBody(slack.posts[0], WEBHOOK, 'silence'),
            { stateFile: path.join(dir, 'missing-dir', 'x', '\0bad') });
        expect(r.ok).toBe(false);
        expect(calls.some((c) => c[0] === 'ephemeral')).toBe(true);
    });
});

describe('routing', () => {
    test('only these buttons are claimed; the /dispatch submission and other actions are not', () => {
        expect(buttons.isAckAction(pressBody(slack.posts[0], WEBHOOK, 'nag'))).toBe(true);
        expect(buttons.isAckAction({ type: 'view_submission', view: {} })).toBe(false);
        expect(buttons.isAckAction({ type: 'block_actions', actions: [{ action_id: 'other' }] })).toBe(false);
        expect(buttons.isAckAction({ type: 'block_actions', actions: [{ action_id: `${buttons.ACTION_PREFIX}delete` }] })).toBe(false);
        expect(buttons.isAckAction(null)).toBe(false);
    });

    test('bridge-agent.js routes a press here and everything else to the dispatch handler', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
        const seam = src.slice(src.indexOf('onInteractive:'), src.indexOf('.then((handle)'));
        expect(seam).toMatch(/sqtoolsAlertButtons\.isAckAction\(/);
        expect(seam).toMatch(/sqtoolsAlertButtons\.handleAckAction\(envelope, \{\s*isAuthorized: isUserAuthorized/);
        expect(seam).toMatch(/: handleViewSubmission\(envelope/);
    });
});

describe('Slack limits', () => {
    test('long text splits into sections under 3000 characters, losing nothing', () => {
        const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
        const blocks = buttons.textSections(text);
        expect(blocks.length).toBeGreaterThan(1);
        expect(blocks.every((b) => b.text.text.length <= 3000)).toBe(true);
        expect(blocks.map((b) => b.text.text).join('\n')).toBe(text);
    });

    test('more alerts than button rows: the rest are named, and the message stays under 50 blocks', () => {
        const many = Array.from({ length: 30 }, (_, i) => ({ id: `id${i}aaaaaa`, needsAck: true, title: `t${i}` }));
        const blocks = buttons.buildAlertBlocks('head', many);
        expect(blocks.length).toBeLessThanOrEqual(50);
        expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(buttons.MAX_BUTTON_ALERTS);
        expect(JSON.stringify(blocks)).toContain('20 more need you');
    });

    test('an alert with no Gmail id gets no buttons (nothing to key it by)', () => {
        const blocks = buttons.buildAlertBlocks('head', [{ id: null, needsAck: true, title: 't' }]);
        expect(blocks.filter((b) => b.type === 'actions')).toHaveLength(0);
    });
});
