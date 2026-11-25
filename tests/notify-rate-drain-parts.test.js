'use strict';

/**
 * tests/notify-rate-drain-parts.test.js
 *
 * WORK-TODO #10, B38 (2026-11-25): each part the notify-owner, email-rate-limiter and
 * update-drain hubs were split into, tested on its own (through the part, not the hub).
 * The hubs' own suites (tests/notify-owner.test.js, tests/email-rate-limiter.test.js,
 * tests/update-drain.test.js) are unchanged and still pass through the hubs; identity of
 * every re-exported name is tests/module-splits.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../lib/agent-registry', () => ({ getAgent: jest.fn(() => null) }));
jest.mock('../lib/high-notices', () => ({ record: jest.fn(() => ({ recorded: true, id: 'abcd1234' })) }));

describe('lib/notify-owner-core.js', () => {
    const core = require('../lib/notify-owner-core');

    test('getContext reads the state init() set, at call time', () => {
        core.init({ slack: { id: 'a' }, ownerId: 'U1', opsChannelId: 'C1' });
        expect(core.getContext()).toEqual({ slackClient: { id: 'a' }, ownerId: 'U1', opsChannelId: 'C1' });
        core.init({ slack: null, ownerId: null, opsChannelId: 'C2' });
        expect(core.getContext().opsChannelId).toBe('C2');
    });

    test('notifyOps with no ops channel reports the drop and returns false', async () => {
        core.init({ slack: null, ownerId: null, opsChannelId: null });
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect(await core.notifyOps('lost')).toBe(false);
            expect(err.mock.calls.flat().join(' ')).toContain('lost');
        } finally {
            err.mockRestore();
        }
    });
});

describe('lib/notify-owner-tasks.js truncateMiddle (the one copy of the middle cut)', () => {
    const { truncateMiddle } = require('../lib/notify-owner-tasks');

    test('text at the limit is unchanged', () => {
        const text = 'x'.repeat(3500);
        expect(truncateMiddle(text)).toBe(text);
    });

    test('longer text keeps 1750 from each end with the marker between', () => {
        const text = 'a'.repeat(2000) + 'MIDDLE' + 'b'.repeat(2000);
        const out = truncateMiddle(text);
        expect(out).toBe('a'.repeat(1750) + '\n\n... [truncated] ...\n\n' + 'b'.repeat(1750));
        expect(out).not.toContain('MIDDLE');
    });

    test('taskCompleted reads the ops channel through the core context', async () => {
        const core = require('../lib/notify-owner-core');
        const { taskCompleted } = require('../lib/notify-owner-tasks');
        const postMessage = jest.fn().mockResolvedValue({ ok: true });
        core.init({ slack: { chat: { postMessage } }, ownerId: 'U1', opsChannelId: 'COPS' });
        expect(await taskCompleted({ description: 'd' }, 'done', { elapsed: '3' })).toBe(true);
        expect(postMessage.mock.calls[0][0].channel).toBe('COPS');
    });
});

describe('lib/notify-owner-rate-limit.js', () => {
    test('the all-clear goes to the ops channel set by init()', async () => {
        const core = require('../lib/notify-owner-core');
        const { rateLimitCleared } = require('../lib/notify-owner-rate-limit');
        const postMessage = jest.fn().mockResolvedValue({ ok: true });
        core.init({ slack: { chat: { postMessage } }, ownerId: 'U1', opsChannelId: 'COPS2' });
        expect(await rateLimitCleared()).toBe(true);
        expect(postMessage.mock.calls[0][0].channel).toBe('COPS2');
    });
});

describe('lib/email-rate-window.js: one checkBucket for three buckets', () => {
    const win = require('../lib/email-rate-window');

    beforeEach(() => {
        win.resetWindow();
        win.configure({ maxEmailsPerWindow: 2, maxBulletinsPerWindow: 2, maxSlackMessagesPerWindow: 2 });
    });
    afterAll(() => { win.resetWindow(); win.configure(); });

    test.each([
        ['emails', 'Email rate limit exceeded (2/2 in window)'],
        ['bulletins', 'Bulletin rate limit exceeded (2/2 in window)'],
        ['slackMessages', 'Slack message rate limit exceeded (2/2 in window)'],
    ])('%s: allowed with headroom, then refused with its own reason', (bucket, reason) => {
        expect(win.checkBucket(bucket)).toEqual({ allowed: true, remaining: 2 });
        win.recordIn(bucket);
        win.recordIn(bucket);
        expect(win.checkBucket(bucket)).toEqual({ allowed: false, reason, remaining: 0 });
    });

    test('only the email bucket starts the cooldown (as before the split)', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            win.recordIn('bulletins'); win.recordIn('bulletins');
            win.checkBucket('bulletins');
            expect(win.isInCooldown()).toBe(false);
            win.recordIn('emails'); win.recordIn('emails');
            win.checkBucket('emails');
            expect(win.isInCooldown()).toBe(true);
            expect(win.checkBucket('slackMessages').reason).toBe('Rate limit cooldown active');
        } finally {
            warn.mockRestore();
        }
    });

    test('windowStatus counts each bucket against its own limit, and old timestamps leave', () => {
        win.configure({ maxEmailsPerWindow: 5, windowSizeMs: 1000 });
        const now = jest.spyOn(Date, 'now');
        try {
            now.mockReturnValue(10000);
            win.recordIn('emails');
            expect(win.windowStatus().emails).toEqual({ count: 1, max: 5, remaining: 4 });
            now.mockReturnValue(12000);
            expect(win.windowStatus().emails.count).toBe(0);
        } finally {
            now.mockRestore();
        }
    });
});

describe('lib/email-rate-suppressed.js', () => {
    const sup = require('../lib/email-rate-suppressed');

    beforeEach(() => sup.resetSuppressed());

    test('counts, take-and-reset, and the summary line', () => {
        sup.recordEmailSuppressed();
        sup.recordBulletinSuppressed({ type: 'vendor_deal' });
        sup.recordSlackMessageSuppressed();
        expect(sup.suppressedCounts()).toEqual({ emails: 1, bulletins: 1, slackMessages: 1 });
        const taken = sup.getSuppressedAndReset();
        expect(sup.suppressedCounts()).toEqual({ emails: 0, bulletins: 0, slackMessages: 0 });
        expect(sup.formatSuppressedSummary(taken)).toBe(
            ':warning: *Rate limit summary:* 1 email skipped, 1 bulletin suppressed (1 vendor_deal), '
            + '1 notification batched. This protects Slack from email flood attacks.'
        );
    });

    test('nothing suppressed is no summary', () => {
        expect(sup.formatSuppressedSummary(sup.getSuppressedAndReset())).toBeNull();
    });
});

describe('lib/update-drain-marker.js on a real temp file', () => {
    const marker = require('../lib/update-drain-marker');
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-part-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('mark, inspect (same commit keeps its since), clear', () => {
        const file = path.join(dir, '.update-pending');
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        try {
            expect(marker.inspect({ markerFile: file }).pending).toBe(false);
            marker.markPending({ commit: 'abc1234', markerFile: file, now: 1000 });
            const again = marker.markPending({ commit: 'abc1234', markerFile: file, now: 5000 });
            expect(again).toMatchObject({ marked: true, refreshed: true, since: 1000 });
            const state = marker.inspect({ markerFile: file, now: 6000, staleAfterMs: 10000 });
            expect(state).toMatchObject({ pending: true, stale: false, waitingMs: 5000, sinceHeartbeatMs: 1000 });
            expect(marker.clear({ markerFile: file })).toMatchObject({ cleared: true, existed: true });
            expect(fs.existsSync(file)).toBe(false);
        } finally {
            log.mockRestore();
        }
    });
});

describe('lib/update-drain-messages.js', () => {
    const msg = require('../lib/update-drain-messages');
    const state = { commit: 'abcdef1234', markerFile: '/w/.update-pending', waitingMs: 120000 };

    test('short never throws on a null commit', () => {
        expect(msg.short(null)).toBe('(unknown commit)');
        expect(msg.short('abcdef1234')).toBe('`abcdef1`');
    });

    test('the two stale verdicts name the commit, the times and what did NOT happen', () => {
        const cleared = msg.describeStaleCleared(state, 25, 20);
        expect(cleared).toContain('`abcdef1`');
        expect(cleared).toContain('heartbeat stopped 25m ago, past the 20m limit');
        expect(cleared).toContain('did not cancel, force or hurry any update');
        const failed = msg.describeStaleClearFailed(state, 25, 20, 'EPERM');
        expect(failed).toContain('`/w/.update-pending`');
        expect(failed).toContain('could NOT be removed (EPERM)');
        expect(msg.describeStaleClearFailed(state, 25, 20)).toContain('(unknown error)');
    });

    test('the refusal says nothing was queued and to resubmit', () => {
        const text = msg.describeRefusal(state, 'fix it');
        expect(text).toContain('*fix it* was NOT queued and NOT started');
        expect(text).toContain('waiting 2m');
        expect(text).toContain('resubmit it once the update has applied');
    });
});
