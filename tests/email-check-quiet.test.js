/**
 * tests/email-check-quiet.test.js
 *
 * A routine scheduled inbox check posts nothing unless something needs a person,
 * and silence never hides a broken or stopped check (lib/email-check-report.js).
 *
 * Regression for the owner's 2026-10-01 report: 26 "Inbox check OK" posts a day,
 * nearly all of them "0 new messages". Before the fix every one of the "quiet"
 * cases below posted.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const emailCheck = require('../lib/email-check');
const report = require('../lib/email-check-report');

// 2026-10-01 18:00 and later in Toronto (EDT, UTC-4).
const T_1800 = new Date('2026-10-01T22:00:00Z');
const T_1830 = new Date('2026-10-01T22:30:00Z');
const T_2100 = new Date('2026-10-02T01:00:00Z');
const NEXT_DAY_0900 = new Date('2026-10-02T13:00:00Z');

const EMPTY = () => ({ byCategory: {}, flagged: [], total: 0, rateLimited: 0 });

function harness({ categorize = EMPTY, fetch } = {}) {
    const posted = [];
    const escalations = [];
    return {
        posted,
        escalations,
        deps: {
            slack: { chat: { postMessage: async (args) => { posted.push(args); return { ok: true }; } } },
            channelId: 'C_EMAIL',
            notifier: {
                taskFailed: async (task, error) => {
                    escalations.push(String(error));
                    return { opsPosted: true, ownerNotified: true };
                },
            },
            categorizer: { categorizeEmails: (emails) => ({ ...categorize(), total: emails.length || categorize().total }), formatSummary: (s) => `Email: ${s.total} new` },
            gmailClient: {
                fetchRecentEmails: fetch || (async () => ({ ok: true, emails: [], reason: null, error: null, listed: 0, failed: 0 })),
            },
        },
    };
}

describe('scheduled inbox check: quiet unless something needs a person', () => {
    let tmpDir;
    let stateFile;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-quiet-'));
        stateFile = path.join(tmpDir, 'check-state.json');
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    async function primeToday() {
        // First check of the day posts the heartbeat and records it.
        const h = harness();
        await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1800 });
        expect(h.posted).toHaveLength(1);
        expect(h.posted[0].text).toContain('First check today');
    }

    it('posts NOTHING for a routine empty check after the daily heartbeat', async () => {
        await primeToday();
        const h = harness();
        const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
        expect(verdict.ok).toBe(true);
        expect(verdict.posted).toBe(false);
        expect(verdict.postReasons).toEqual([]);
        expect(h.posted).toEqual([]);
        // The window still advances: silence is not a skipped check.
        expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSuccessfulCheckAt).toBe(T_1830.toISOString());
    });

    it('posts nothing for unflagged mail either ("2 new (2 important)")', async () => {
        await primeToday();
        const h = harness({
            categorize: () => ({ byCategory: { important: 2 }, flagged: [], total: 2, rateLimited: 0 }),
            fetch: async () => ({ ok: true, emails: [{ id: 'a' }, { id: 'b' }], reason: null, error: null, listed: 2, failed: 0 }),
        });
        const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
        expect(verdict.posted).toBe(false);
        expect(h.posted).toEqual([]);
    });

    it('posts when something is flagged', async () => {
        await primeToday();
        const email = { subject: 'Order not sent', from: 'alerts@example.test' };
        const h = harness({
            categorize: () => ({ byCategory: { urgent: 1 }, flagged: [{ email, category: 'urgent', priority: 'high' }], total: 1, rateLimited: 0 }),
            fetch: async () => ({ ok: true, emails: [email], reason: null, error: null, listed: 1, failed: 0 }),
        });
        const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
        expect(verdict.postReasons).toEqual([report.POST_REASON.FLAGGED]);
        expect(h.posted).toHaveLength(1);
        expect(h.posted[0].text).toContain('Order not sent');
    });

    it('posts a partial fetch, which is a degraded check', async () => {
        await primeToday();
        const h = harness({ fetch: async () => ({ ok: true, emails: [], reason: 'partial', error: '2 of 5 messages failed', listed: 5, failed: 2 }) });
        const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
        expect(verdict.postReasons).toContain(report.POST_REASON.PARTIAL);
        expect(h.posted[0].text).toContain('Partial fetch');
    });

    it('an on-demand check always posts', async () => {
        await primeToday();
        const h = harness();
        const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830, onDemand: true });
        expect(verdict.postReasons).toEqual([report.POST_REASON.ON_DEMAND]);
        expect(h.posted).toHaveLength(1);
        expect(h.posted[0].text).toContain('0 new messages');
        expect(h.posted[0].text).not.toContain('First check today');
    });

    describe('silence never hides a broken or stopped check', () => {
        it('a failed check still escalates and posts no all-clear', async () => {
            await primeToday();
            const h = harness({ fetch: async () => ({ ok: false, emails: [], reason: 'list_failed', error: 'invalid_grant', listed: 0, failed: 0 }) });
            const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
            expect(verdict.ok).toBe(false);
            expect(h.escalations).toHaveLength(1);
            expect(h.posted).toEqual([]);
        });

        it('the first check of a new Toronto day posts a heartbeat', async () => {
            await primeToday();
            const h = harness();
            const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: NEXT_DAY_0900 });
            expect(verdict.postReasons).toEqual([report.POST_REASON.DAILY_HEARTBEAT]);
            expect(h.posted).toHaveLength(1);
        });

        it('a heartbeat whose post failed is retried on the next check', async () => {
            const failing = harness();
            failing.deps.slack.chat.postMessage = async () => { throw new Error('channel_not_found'); };
            await emailCheck.runInboxCheck({ ...failing.deps, stateFile, now: T_1800 });
            expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastHeartbeatDay).toBeNull();

            const h = harness();
            const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_1830 });
            expect(verdict.postReasons).toEqual([report.POST_REASON.DAILY_HEARTBEAT]);
            expect(h.posted).toHaveLength(1);
        });

        it('a gap of more than GAP_ALERT_MS within the day is reported', async () => {
            await primeToday();
            const h = harness();
            const verdict = await emailCheck.runInboxCheck({ ...h.deps, stateFile, now: T_2100 });
            expect(verdict.postReasons).toEqual([report.POST_REASON.GAP]);
            expect(h.posted[0].text).toContain('No successful inbox check for 3h 0m');
        });

        it('the overnight gap is the schedule, not a fault', () => {
            const d = report.decidePost({
                summary: EMPTY(), partial: null, onDemand: false, now: NEXT_DAY_0900,
                lastSuccessfulCheckAt: T_2100.toISOString(), lastHeartbeatDay: report.torontoDay(NEXT_DAY_0900),
            });
            expect(d.reasons).not.toContain(report.POST_REASON.GAP);
            expect(d.post).toBe(false);
        });
    });

    it('torontoDay rolls over at Toronto midnight, not UTC midnight', () => {
        // 21:00 Toronto on Oct 1 is 01:00 UTC on Oct 2.
        expect(report.torontoDay(T_2100)).toBe('2026-10-01');
    });
});
