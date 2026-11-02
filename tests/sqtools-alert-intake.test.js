/**
 * tests/sqtools-alert-intake.test.js
 *
 * Tests for lib/sqtools-alert-intake.js and its wiring into lib/email-check.js:
 * SqTools alerts are taken out of the generic categorizer, posted once to the
 * secretary's channel, never recorded when the post fails, and a quiet SqTools
 * heartbeat is reported. Every state file is in a temp dir.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('../lib/sqtools-alert-intake');
const emailCheck = require('../lib/email-check');

const FROM = 'JT Pets - SqTools Alerts <jtpets@jtpets.ca>';
const NOW = new Date('2026-11-02T14:00:00Z');

function alert(id, subject, date = '2026-11-02T13:00:00Z') {
    return { id, from: FROM, subject, body: '', date };
}

function slackDouble({ fail = false } = {}) {
    const posts = [];
    return {
        posts,
        chat: {
            postMessage: async (args) => {
                if (fail) throw new Error('channel_not_found');
                posts.push(args);
                return { ok: true };
            },
        },
    };
}

let dir;
let stateFile;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqtools-intake-'));
    stateFile = path.join(dir, 'sqtools-alerts.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('partition', () => {
    test('separates SqTools alerts from other mail', () => {
        const other = { id: 'x', from: 'Kane <s@kanevet.com>', subject: '20% Off Holiday Open Stock' };
        const sq = alert('a', '[SqTools] ALERT: Job OK: Expiry discount');
        const { sqtools, rest } = intake.partition([other, sq]);
        expect(sqtools).toEqual([sq]);
        expect(rest).toEqual([other]);
    });
});

describe('processSqToolsAlerts', () => {
    test('posts new alerts to the secretary channel with what to do next, and records them', async () => {
        const slack = slackDouble();
        const v = await intake.processSqToolsAlerts({
            emails: [alert('a', '[SqTools] ALERT: Square connection needs attention'),
                alert('b', '[SqTools] ALERT: Min Stock Auto-Adjustment: 0 reduced, 2 increased — JT Pets')],
            slack, channelId: 'C_SEC', fallbackChannelId: 'C_EMAIL', now: NOW, stateFile,
        });
        expect(v).toMatchObject({ ok: true, fresh: 2, needAck: 1, posted: true, channel: 'C_SEC', stateWritten: true });
        expect(slack.posts).toHaveLength(1);
        const text = slack.posts[0].text;
        expect(text).toMatch(/1 need you, 1 routine/);
        expect(text).toMatch(/Square connection needs attention/);
        expect(text).toMatch(/_Next:_ .*Reconnect Square/);
        // The action is listed before the routine report.
        expect(text.indexOf('Square connection')).toBeLessThan(text.indexOf('Minimum stock'));
        const state = intake.readState(stateFile);
        expect(Object.keys(state.seen).sort()).toEqual(['a', 'b']);
        expect(state.recent[0].ack).toBeNull();
    });

    test('an alert already handled is not posted again (a re-scanned window)', async () => {
        const slack = slackDouble();
        const emails = [alert('a', '[SqTools] ALERT: Webhook dead: x')];
        await intake.processSqToolsAlerts({ emails, slack, channelId: 'C_SEC', now: NOW, stateFile });
        const v = await intake.processSqToolsAlerts({ emails, slack, channelId: 'C_SEC', now: NOW, stateFile });
        expect(v.fresh).toBe(0);
        expect(slack.posts).toHaveLength(1);
    });

    test('a failed post records nothing, so the next check posts the alert again', async () => {
        const emails = [alert('a', '[SqTools] ALERT: Webhook dead: x')];
        const v = await intake.processSqToolsAlerts({ emails, slack: slackDouble({ fail: true }), channelId: 'C_SEC', now: NOW, stateFile });
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/not posted.*retried/);
        expect(fs.existsSync(stateFile)).toBe(false);
        const slack = slackDouble();
        const retry = await intake.processSqToolsAlerts({ emails, slack, channelId: 'C_SEC', now: NOW, stateFile });
        expect(retry.posted).toBe(true);
        expect(slack.posts).toHaveLength(1);
    });

    test('without a secretary channel it posts in the fallback channel and says why', async () => {
        const slack = slackDouble();
        const v = await intake.processSqToolsAlerts({
            emails: [alert('a', '[SqTools] ALERT: Webhook dead: x')], slack, channelId: null, fallbackChannelId: 'C_EMAIL', now: NOW, stateFile,
        });
        expect(v.channel).toBe('C_EMAIL');
        expect(slack.posts[0].text).toMatch(/secretary's channel is not resolved/);
    });

    test('liveness emails alone are recorded but post nothing', async () => {
        const slack = slackDouble();
        const v = await intake.processSqToolsAlerts({
            emails: [alert('h', '[SqTools] Daily Heartbeat — System Healthy'), alert('j', '[SqTools] ALERT: Job OK: Expiry discount')],
            slack, channelId: 'C_SEC', now: NOW, stateFile,
        });
        expect(v).toMatchObject({ ok: true, fresh: 2, posted: false });
        expect(slack.posts).toHaveLength(0);
        expect(intake.readState(stateFile).lastHeartbeatAt).toBe('2026-11-02T13:00:00.000Z');
    });

    test('a check with no SqTools mail and nothing to say writes no state file', async () => {
        const v = await intake.processSqToolsAlerts({ emails: [], slack: slackDouble(), channelId: 'C_SEC', now: NOW, stateFile });
        expect(v).toMatchObject({ ok: true, fresh: 0, posted: false, stateWritten: false });
        expect(fs.existsSync(stateFile)).toBe(false);
    });

    test('a SqTools heartbeat older than 26 hours is reported once per Toronto day', async () => {
        const slack = slackDouble();
        await intake.processSqToolsAlerts({
            emails: [alert('h', '[SqTools] Daily Heartbeat — System Healthy', '2026-10-31T10:00:00Z')],
            slack, channelId: 'C_SEC', now: new Date('2026-10-31T11:00:00Z'), stateFile,
        });
        expect(slack.posts).toHaveLength(0);
        await intake.processSqToolsAlerts({ emails: [], slack, channelId: 'C_SEC', now: NOW, stateFile });
        expect(slack.posts).toHaveLength(1);
        expect(slack.posts[0].text).toMatch(/No SqTools daily heartbeat since/);
        await intake.processSqToolsAlerts({ emails: [], slack, channelId: 'C_SEC', now: new Date(NOW.getTime() + 30 * 60 * 1000), stateFile });
        expect(slack.posts).toHaveLength(1);
    });

    test('no heartbeat ever seen reports nothing: the watch arms on the first one', async () => {
        const slack = slackDouble();
        await intake.processSqToolsAlerts({ emails: [], slack, channelId: 'C_SEC', now: NOW, stateFile });
        expect(slack.posts).toHaveLength(0);
    });
});

describe('recentAlerts', () => {
    test('an unreadable state file is unavailable, not "no alerts"', () => {
        fs.writeFileSync(stateFile, '{not json');
        const r = intake.recentAlerts(new Date(0), stateFile);
        expect(r.available).toBe(false);
        expect(r.reason).toEqual(expect.any(String));
    });
});

describe('wired into the inbox check', () => {
    function deps(emails, slack, categorized) {
        return {
            slack,
            channelId: 'C_EMAIL',
            secretaryChannelId: 'C_SEC',
            alertStateFile: stateFile,
            stateFile: path.join(dir, 'check-state.json'),
            now: NOW,
            gmailClient: { fetchRecentEmails: async () => ({ ok: true, emails, reason: null, error: null }) },
            categorizer: {
                categorizeEmails: (list) => { categorized.push(...list); return { byCategory: {}, flagged: [], total: list.length, rateLimited: 0 }; },
                formatSummary: (s) => `Email: ${s.total} new`,
            },
            notifier: { taskFailed: async () => ({ opsPosted: true }) },
        };
    }

    test('SqTools alerts reach the secretary and never reach the generic categorizer', async () => {
        const slack = slackDouble();
        const categorized = [];
        const other = { id: 'x', from: 'Kane <s@kanevet.com>', subject: 'Promo', body: '' };
        const result = await emailCheck.runInboxCheck(deps([other, alert('a', '[SqTools] ALERT: Webhook dead: x')], slack, categorized));
        expect(result.ok).toBe(true);
        expect(categorized).toEqual([other]);
        expect(result.sqtools).toMatchObject({ fresh: 1, posted: true, channel: 'C_SEC' });
        expect(slack.posts.map(p => p.channel)).toContain('C_SEC');
    });

    test('an intake that cannot post is escalated, and the check itself still succeeds', async () => {
        const escalations = [];
        const d = deps([alert('a', '[SqTools] ALERT: Webhook dead: x')], slackDouble({ fail: true }), []);
        d.notifier = { taskFailed: async (task, error) => { escalations.push(String(error)); return { opsPosted: true }; } };
        const result = await emailCheck.runInboxCheck(d);
        expect(result.ok).toBe(true);
        expect(escalations.some(e => /sqtools_alert_intake_failed/.test(e))).toBe(true);
    });
});

describe("the secretary's briefing context", () => {
    const { buildSqToolsAlertLines } = require('../lib/agent-context-ops');

    test('names when the inbox was last read and lists the last day of non-liveness alerts', async () => {
        const checkStateFile = path.join(dir, 'check-state.json');
        fs.writeFileSync(checkStateFile, JSON.stringify({ lastSuccessfulCheckAt: '2026-11-02T13:30:00Z' }));
        await intake.processSqToolsAlerts({
            emails: [alert('a', '[SqTools] ALERT: Webhook dead: x'), alert('j', '[SqTools] ALERT: Job OK: Expiry discount')],
            slack: slackDouble(), channelId: 'C_SEC', now: NOW, stateFile,
        });
        const text = buildSqToolsAlertLines(NOW, { checkStateFile, alertStateFile: stateFile }).join('\n');
        expect(text).toMatch(/last read the inbox successfully/);
        expect(text).toMatch(/SQTOOLS ALERTS \(last 24 hours, 1\)/);
        expect(text).toMatch(/\[ACTION\] Square webhook permanently failed/);
        expect(text).not.toMatch(/Job OK/);
    });

    test('an unreadable alert file says so instead of "none"', () => {
        fs.writeFileSync(stateFile, '{not json');
        const text = buildSqToolsAlertLines(NOW, { checkStateFile: path.join(dir, 'nope.json'), alertStateFile: stateFile }).join('\n');
        expect(text).toMatch(/no successful inbox check is recorded/);
        expect(text).toMatch(/SQTOOLS ALERTS: unable to load/);
    });
});
