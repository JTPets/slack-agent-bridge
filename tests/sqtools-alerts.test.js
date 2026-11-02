/**
 * tests/sqtools-alerts.test.js
 *
 * Tests for lib/sqtools-alerts.js: which emails are SqTools alerts, and what kind
 * each is. Subjects below are the shapes SqTools sends (utils/email-notifier.js and
 * its sendAlert call sites at JTPets/SquareDashboardTool 0eef658), including the
 * ones observed in #email-monitor-agent 2026-10-13..2026-11-02. Bodies are synthetic.
 */

'use strict';

const alerts = require('../lib/sqtools-alerts');

const FROM = 'JT Pets - SqTools Alerts <jtpets@jtpets.ca>';
const mail = (subject, extra = {}) => ({ id: 'm1', from: FROM, subject, body: '', ...extra });

describe('isSqToolsAlert', () => {
    test('accepts the production sender with the [SqTools] prefix', () => {
        expect(alerts.isSqToolsAlert(mail('[SqTools] ALERT: Job OK: Expiry discount'))).toBe(true);
        expect(alerts.isSqToolsAlert(mail('[SqTools] Daily Heartbeat — System Healthy'))).toBe(true);
    });

    test('needs BOTH the sender and the prefix', () => {
        expect(alerts.isSqToolsAlert(mail('Lunch?'))).toBe(false);
        expect(alerts.isSqToolsAlert({ from: 'Someone <x@example.com>', subject: '[SqTools] ALERT: Webhook dead: x' })).toBe(false);
    });

    test('sender comparison ignores case and the display name', () => {
        expect(alerts.isSqToolsAlert({ from: 'JTPETS@JTPETS.CA', subject: '[sqtools] ALERT: x' })).toBe(true);
    });

    test('SQTOOLS_ALERT_SENDERS replaces the default list', () => {
        const senders = alerts.configuredSenders(' a@b.ca , C@D.ca ');
        expect(senders).toEqual(['a@b.ca', 'c@d.ca']);
        expect(alerts.isSqToolsAlert(mail('[SqTools] ALERT: x'), senders)).toBe(false);
    });
});

describe('classify', () => {
    // Every one of these was misfiled by the generic rules before 2026-11-02.
    test.each([
        ['[SqTools] ALERT: Min Stock Auto-Adjustment: 2 reduced, 4 increased — JT Pets', 'min_stock_adjusted', 'info'],
        ['[SqTools] ALERT: Expiry Discount Report - JT Pets - 5 Changes', 'expiry_discount_report', 'info'],
        ['[SqTools] ALERT: Job OK: Expiry discount', 'job_ok', 'ok'],
        ['[SqTools] ALERT: Job OK: Promo expiry check', 'job_ok', 'ok'],
    ])('observed subject %s -> %s / %s', (subject, kind, severity) => {
        const c = alerts.classify(mail(subject));
        expect(c.kind).toBe(kind);
        expect(c.severity).toBe(severity);
        expect(c.needsAck).toBe(false);
    });

    test.each([
        ['[SqTools] ALERT: Square connection needs attention', 'square_connection'],
        ['[SqTools] ALERT: 3 price(s) LIVE in Square but NOT saved in SqTools', 'price_not_saved'],
        ['[SqTools] ALERT: Webhook dead: inventory.count.updated', 'webhook_dead'],
        ['[SqTools] ALERT: ⚠️ Clearance Item Restocked — Enter New Expiry Date', 'clearance_restocked'],
        ['[SqTools] ALERT: ⚠️ 4 Clearance Items Restocked — Enter New Expiry Dates', 'clearance_restocked'],
        ['[SqTools] ALERT: 2 Items Restocked From Zero — Enter New Expiry Dates', 'restocked_from_zero'],
        ['[SqTools] ALERT: Job FAILED: Catalog sync', 'job_failed'],
        ['[SqTools] ALERT: Job WARN: Auto min/max', 'job_failed'],
        ['[SqTools] ALERT: Automation digest: 2 problem(s) — sync, backup', 'automation_digest_problems'],
        ['[SqTools] ALERT: Promo Expiry Report — 1 revert error(s), manual review required', 'promo_revert_failed'],
        ['[SqTools] ALERT: Auto Min/Max Aborted — Circuit Breaker', 'min_max_aborted'],
        ['[SqTools] CRITICAL: Database Connection Lost', 'critical'],
    ])('%s is an action that needs acknowledgement', (subject, kind) => {
        const c = alerts.classify(mail(subject));
        expect(c.kind).toBe(kind);
        expect(c.severity).toBe('action');
        expect(c.needsAck).toBe(true);
        expect(c.next).toEqual(expect.any(String));
    });

    test('a clean automation digest is a liveness signal, not a problem', () => {
        expect(alerts.classify(mail('[SqTools] ALERT: Automation digest: all jobs OK')).kind).toBe('automation_digest_ok');
    });

    test('a subject the catalogue does not know is surfaced for review, never dropped', () => {
        const c = alerts.classify(mail('[SqTools] ALERT: Purchase orders not sent — 2 overdue'));
        expect(c.kind).toBe('unrecognised');
        expect(c.severity).toBe('review');
        expect(c.needsAck).toBe(true);
        expect(c.detail).toBe('Purchase orders not sent — 2 overdue');
    });

    test('the detail is the subject without the [SqTools] marker', () => {
        expect(alerts.classify(mail('[SqTools] ALERT: Webhook dead: x')).detail).toBe('Webhook dead: x');
    });
});

describe('cycle count severity follows the discrepancies in the body', () => {
    // The body after the Gmail fetch stripped SqTools' HTML table.
    const body = (n, v) => `Cycle Count Report\nAccuracy Rate: 90.0% (9/10 accurate)\nDiscrepancies Found:  ${n} items\nTotal Variance: ${v} units`;

    test('discrepancies make it an action, with the counts', () => {
        const c = alerts.classify(mail('[SqTools] ALERT: Cycle Count Report - 2026-11-02 ✅ COMPLETE', { body: body(3, 7) }));
        expect(c.severity).toBe('action');
        expect(c.facts).toEqual({ discrepancies: 3, totalVariance: 7 });
    });

    test('no discrepancies is routine', () => {
        expect(alerts.classify(mail('[SqTools] ALERT: Cycle Count Report - 2026-11-02', { body: body(0, 0) })).severity).toBe('info');
    });

    test('an unreadable body stays at review: unknown is not zero', () => {
        const c = alerts.classify(mail('[SqTools] ALERT: Cycle Count Report - 2026-11-02', { body: 'nothing parseable' }));
        expect(c.severity).toBe('review');
        expect(c.facts.discrepancies).toBeNull();
    });
});

describe('the catalogue itself', () => {
    test('every entry has a kind, a pattern, a known severity, a title and a source', () => {
        const severities = new Set(Object.values(alerts.SEVERITY));
        for (const k of alerts.KINDS) {
            expect(k.kind).toMatch(/^[a-z_]+$/);
            expect(k.match).toBeInstanceOf(RegExp);
            expect(severities.has(k.severity)).toBe(true);
            expect(k.title).toEqual(expect.any(String));
            expect(k.source).toEqual(expect.any(String));
        }
    });

    test('every action entry says what to do next', () => {
        for (const k of alerts.KINDS.filter(x => x.severity === 'action')) {
            expect(k.next).toEqual(expect.any(String));
        }
    });

    test('kinds are unique', () => {
        const kinds = alerts.KINDS.map(k => k.kind);
        expect(new Set(kinds).size).toBe(kinds.length);
    });
});
