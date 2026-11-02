/**
 * lib/sqtools-alerts.js
 *
 * Which emails are SqTools alerts, and what each one is.
 *
 * LOGIC CHANGE 2026-11-02: Created. SqTools reaches the bridge only by email (the
 * bridge has no SqTools access, by design). Its alerts already arrive in the inbox
 * the email-monitor reads, and the generic rules in
 * agents/email-monitor/memory/rules.json misfiled them: every "Min Stock
 * Auto-Adjustment" was flagged `urgent`, and every "Expiry Discount Report" and
 * "Job OK: ..." was flagged `vendor_deal`, because the keywords `urgent`,
 * `discount` and `promo` appear in them. This module recognises them by sender and
 * subject prefix and classifies them from a catalogue, so no model decides what an
 * alert means.
 *
 * THE CATALOGUE IS A COPY OF SQTOOLS' SUBJECT TEMPLATES, read from
 * JTPets/SquareDashboardTool at 0eef658 (2026-11-02): utils/email-notifier.js
 * builds `[SqTools] ALERT: <subject>` (sendAlert), `[SqTools] CRITICAL: <subject>`
 * (sendCritical), `[SqTools] Daily Heartbeat — System Healthy` and
 * `[SqTools] Test Email`; each `sendAlert(` call site supplies the subject. A
 * subject SqTools adds later matches no entry and is classified `unrecognised`,
 * which is surfaced for review, never dropped.
 *
 * Severity says what the owner owes the alert:
 *   action - something is broken or waiting on a person; needs acknowledgement
 *   review - a report with findings worth reading; needs acknowledgement
 *   info   - a routine report of work SqTools did; logged, posted, no ack
 *   ok     - a liveness signal (heartbeat, Job OK, clean digest); counted only
 *
 * TRUST: the sender check is on the From header, which a sender outside the
 * domain can forge. Nothing here acts on an alert: the worst a forged one can do
 * is cause a Slack post. Subjects and bodies have already been through
 * lib/integrations/email-sanitizer.js by the Gmail fetch.
 *
 * Pure: no I/O, no Slack, no state.
 */

'use strict';

const SEVERITY = Object.freeze({ ACTION: 'action', REVIEW: 'review', INFO: 'info', OK: 'ok' });

// Severities that wait for the owner. The acknowledgement buttons (silence / nag /
// close for the day) are WORK-TODO #78; until they exist this only marks the post.
const NEEDS_ACK = new Set([SEVERITY.ACTION, SEVERITY.REVIEW]);

// LOGIC CHANGE 2026-11-02: the address SqTools sends from in production. Observed on
// every SqTools alert in #email-monitor-agent 2026-10-13..2026-11-02 as
// `JT Pets - SqTools Alerts <jtpets@jtpets.ca>`.
const DEFAULT_SENDERS = 'jtpets@jtpets.ca';

const SUBJECT_PREFIX = /^\s*\[SqTools\]\s*/i;

/**
 * The catalogue. `match` runs against the subject with the `[SqTools] ALERT: ` or
 * `[SqTools] CRITICAL: ` prefix removed. First match wins, so specific entries
 * come before general ones. `source` is the SqTools file that sends it.
 */
const KINDS = [
    // ---- action ----
    { kind: 'square_connection', match: /^Square connection needs attention/i, severity: SEVERITY.ACTION,
        title: 'Square connection needs attention', source: 'utils/square-token.js',
        next: 'SqTools cannot renew the Square token, so syncs and price pushes stop. Reconnect Square in SqTools settings.' },
    { kind: 'price_not_saved', match: /price\(s\) LIVE in Square but NOT saved in SqTools/i, severity: SEVERITY.ACTION,
        title: 'Prices live in Square but not saved in SqTools', source: 'services/square/square-pricing.js',
        next: 'Square and SqTools disagree on these prices. Re-save them in SqTools before the next sync overwrites one side.' },
    { kind: 'webhook_dead', match: /^Webhook dead:/i, severity: SEVERITY.ACTION,
        title: 'Square webhook permanently failed', source: 'utils/webhook-retry.js',
        next: 'A Square event was dropped after every retry. The change it carried is missing until a full sync.' },
    { kind: 'clearance_restocked', match: /Clearance Items? Restocked/i, severity: SEVERITY.ACTION,
        title: 'Clearance item restocked: enter new expiry date', source: 'services/webhook-handlers/inventory-restock-guard.js',
        next: 'Enter the expiry date on the new stock in SqTools Expiry Discounts, or it keeps clearance pricing.' },
    { kind: 'restocked_from_zero', match: /Restocked From Zero/i, severity: SEVERITY.ACTION,
        title: 'Restocked from zero: enter new expiry date', source: 'services/webhook-handlers/inventory-restock-guard.js',
        next: 'Enter the expiry date on the new stock in SqTools Expiry Discounts.' },
    { kind: 'seniors_failed', match: /^Seniors Discount Failed/i, severity: SEVERITY.ACTION,
        title: 'Seniors discount failed', source: 'jobs/seniors-day-job.js',
        next: 'The seniors pricing rule was not applied or removed. Check it in Square before the till opens.' },
    { kind: 'min_max_sync_failed', match: /^Auto Min\/Max Square Sync Failed/i, severity: SEVERITY.ACTION,
        title: 'Auto min/max could not sync to Square', source: 'jobs/auto-min-max-job.js',
        next: 'New minimums were computed but not written to Square, so stock alerts use the old ones.' },
    { kind: 'min_max_aborted', match: /^Auto Min\/Max Aborted/i, severity: SEVERITY.ACTION,
        title: 'Auto min/max stopped itself', source: 'services/inventory/auto-min-max-service.js',
        next: 'A guardrail stopped the adjustment (stale sales data or too many changes). Review the min/max history page.' },
    { kind: 'promo_revert_failed', match: /^Promo Revert Failed|revert error\(s\)/i, severity: SEVERITY.ACTION,
        title: 'Subscriber promo revert failed', source: 'jobs/promo-expiry-job.js',
        next: 'A subscriber is still on promo pricing. Revert it by hand.' },
    { kind: 'sync_failed', match: /Sync Partial Failure/i, severity: SEVERITY.ACTION,
        title: 'Sync partly failed', source: 'jobs/sync-job.js, server.js',
        next: 'Some SqTools data is out of date with Square (or Google Merchant Center) until the next good sync.' },
    { kind: 'loyalty_refund_failed', match: /^Loyalty refund reversal failed/i, severity: SEVERITY.ACTION,
        title: 'Loyalty refund reversal failed', source: 'services/webhook-handlers/order-handler/index.js',
        next: 'A refunded order kept its loyalty credit. Reverse it by hand.' },
    { kind: 'subscription_lookup_failed', match: /^Subscription plan lookup failed/i, severity: SEVERITY.ACTION,
        title: 'Subscription plan lookup failed', source: 'utils/subscription-handler.js',
        next: 'A subscriber sign-up was stopped to avoid wrong billing.' },
    { kind: 'account_locked', match: /^Account locked/i, severity: SEVERITY.ACTION,
        title: 'SqTools account locked', source: 'services/auth/sign-in-session.js',
        next: 'Repeated failed sign-ins locked an account. If it was not you or staff, treat it as an attack.' },
    { kind: 'webhook_signature_abuse', match: /^Webhook signature failures/i, severity: SEVERITY.ACTION,
        title: 'Forged webhook attempts', source: 'services/webhook-handlers/webhook-signature.js',
        next: 'Something is sending SqTools fake Square webhooks.' },
    { kind: 'alert_undeliverable', match: /^Merchant alert undeliverable/i, severity: SEVERITY.ACTION,
        title: 'A SqTools alert had no recipient', source: 'utils/email-notifier.js',
        next: 'A store alert was not sent at all. Add a recipient for that merchant.' },
    { kind: 'job_failed', match: /^Job (FAILED|WARN):/i, severity: SEVERITY.ACTION,
        title: 'Scheduled job reported a problem', source: 'utils/job-status.js',
        next: 'A SqTools scheduled job failed or warned. The email names the job and the failure.' },
    { kind: 'automation_digest_problems', match: /^Automation digest: \d+ problem/i, severity: SEVERITY.ACTION,
        title: 'Automation digest found problems', source: 'utils/automation-digest.js',
        next: 'The daily digest lists the jobs that are not OK.' },
    { kind: 'logged_error', match: /^Logged error:/i, severity: SEVERITY.ACTION,
        title: 'SqTools logged an error', source: 'utils/error-log-alert.js',
        next: 'An error reached the SqTools error log.' },
    // ---- review ----
    // Cycle count severity depends on the body (discrepancies); see classify().
    { kind: 'cycle_count', match: /^Cycle Count Report/i, severity: SEVERITY.REVIEW,
        title: 'Cycle count report', source: 'services/inventory/cycle-count-service.js',
        next: 'Review the counted items that did not match what SqTools expected.' },
    { kind: 'loyalty_review', match: /^Loyalty credit to review/i, severity: SEVERITY.REVIEW,
        title: 'Loyalty credit to review', source: 'services/loyalty-admin/attribution-review-service.js',
        next: 'A delivered order needs a decision on who gets the loyalty credit.' },
    { kind: 'loyalty_coverage_gap', match: /^Loyalty: \d+ new item\(s\) not in any offer/i, severity: SEVERITY.REVIEW,
        title: 'New items not in any loyalty offer', source: 'jobs/loyalty-coverage-gap-job.js',
        next: 'Add them to an offer or confirm they are excluded.' },
    { kind: 'trial_expiry', match: /^Trial Expiry Report/i, severity: SEVERITY.REVIEW,
        title: 'Subscriber trial expiry report', source: 'jobs/trial-expiry-job.js',
        next: null },
    // ---- info ----
    { kind: 'min_stock_adjusted', match: /^Min Stock Auto-Adjustment/i, severity: SEVERITY.INFO,
        title: 'Minimum stock levels adjusted', source: 'services/inventory/auto-min-max-summary.js',
        next: null },
    { kind: 'expiry_discount_report', match: /^Expiry Discount (Report|Automation Report)/i, severity: SEVERITY.INFO,
        title: 'Expiry discounts changed', source: 'jobs/expiry-discount-job.js, routes/expiry-discounts.js',
        next: null },
    { kind: 'loyalty_merged', match: /^Loyalty: \d+ customer\(s\) merged/i, severity: SEVERITY.INFO,
        title: 'Loyalty customers merged', source: 'jobs/loyalty-merge-sweep-job.js',
        next: null },
    { kind: 'promo_expiry_report', match: /^Promo Expiry Report/i, severity: SEVERITY.INFO,
        title: 'Subscriber promos reverted', source: 'jobs/promo-expiry-job.js',
        next: null },
    // ---- ok ----
    { kind: 'job_ok', match: /^Job OK:/i, severity: SEVERITY.OK,
        title: 'Scheduled job OK', source: 'utils/job-status.js', next: null },
    { kind: 'automation_digest_ok', match: /^Automation digest: all jobs OK/i, severity: SEVERITY.OK,
        title: 'Automation digest: all OK', source: 'utils/automation-digest.js', next: null },
];

// Subjects that carry no ALERT:/CRITICAL: marker.
const HEARTBEAT = { kind: 'heartbeat', severity: SEVERITY.OK, title: 'SqTools daily heartbeat', source: 'utils/email-notifier.js', next: null };
const TEST_EMAIL = { kind: 'test_email', severity: SEVERITY.OK, title: 'SqTools test email', source: 'utils/email-notifier.js', next: null };
const CRITICAL = { kind: 'critical', severity: SEVERITY.ACTION, title: 'SqTools critical error', source: 'utils/email-notifier.js',
    next: 'SqTools hit an error it could not handle (the email carries the stack trace). Check the app is up.' };
const UNRECOGNISED = { kind: 'unrecognised', severity: SEVERITY.REVIEW, title: 'Unrecognised SqTools alert', source: null,
    next: 'SqTools sent an alert this bridge has no entry for. Read it, then add it to lib/sqtools-alerts.js.' };

/**
 * The configured sender addresses, lower-cased.
 *
 * @param {string} [raw] - Comma-separated list (default SQTOOLS_ALERT_SENDERS)
 * @returns {string[]}
 */
function configuredSenders(raw = process.env.SQTOOLS_ALERT_SENDERS || DEFAULT_SENDERS) {
    return String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The bare address out of a From header (`Name <a@b>` or `a@b`).
 *
 * @param {string} from
 * @returns {string}
 */
function senderAddress(from) {
    const text = String(from || '');
    const angle = text.match(/<([^>]+)>/);
    return (angle ? angle[1] : text).trim().toLowerCase();
}

/**
 * True when the email came from a SqTools sender AND carries the `[SqTools]`
 * subject prefix. Both, so a person writing from the same address is not an alert.
 *
 * @param {{ from?: string, subject?: string }} email
 * @param {string[]} [senders]
 * @returns {boolean}
 */
function isSqToolsAlert(email, senders = configuredSenders()) {
    if (!email) return false;
    return senders.includes(senderAddress(email.from)) && SUBJECT_PREFIX.test(String(email.subject || ''));
}

/**
 * Facts read out of a cycle count report body. The body is SqTools' HTML table
 * after the Gmail fetch stripped the tags, so labels and values may be separated
 * by any whitespace. Unparseable is `null`, never 0.
 *
 * @param {string} body
 * @returns {{ discrepancies: number|null, totalVariance: number|null }}
 */
function cycleCountFacts(body) {
    const text = String(body || '');
    const disc = text.match(/Discrepancies Found:\s*(\d+)/i);
    const variance = text.match(/Total Variance:\s*(-?\d+(?:\.\d+)?)/i);
    return {
        discrepancies: disc ? Number(disc[1]) : null,
        totalVariance: variance ? Number(variance[1]) : null,
    };
}

/**
 * Classify one SqTools email. Call only on an email isSqToolsAlert() accepted.
 *
 * @param {{ id?: string, subject?: string, body?: string, snippet?: string, date?: string }} email
 * @returns {{ kind: string, severity: string, title: string, detail: string, next: string|null, needsAck: boolean, facts: Object, source: string|null }}
 */
function classify(email) {
    const subject = String(email.subject || '').replace(SUBJECT_PREFIX, '');
    let entry;
    let detail = subject.trim();
    const marker = subject.match(/^(ALERT|CRITICAL):\s*/i);

    if (marker) {
        detail = subject.slice(marker[0].length).trim();
        entry = marker[1].toUpperCase() === 'CRITICAL'
            ? CRITICAL
            : (KINDS.find(k => k.match.test(detail)) || UNRECOGNISED);
    } else if (/^Daily Heartbeat/i.test(subject)) {
        entry = HEARTBEAT;
    } else if (/^Test Email/i.test(subject)) {
        entry = TEST_EMAIL;
    } else {
        entry = UNRECOGNISED;
    }

    let severity = entry.severity;
    let facts = {};
    // LOGIC CHANGE 2026-11-02: a cycle count with no discrepancies is routine; one
    // with discrepancies is the variance the owner asked to be alerted on. A body
    // that cannot be read stays at REVIEW rather than being downgraded.
    if (entry.kind === 'cycle_count') {
        facts = cycleCountFacts(email.body || email.snippet);
        if (facts.discrepancies === 0) severity = SEVERITY.INFO;
        else if (facts.discrepancies > 0) severity = SEVERITY.ACTION;
    }

    return {
        kind: entry.kind,
        severity,
        title: entry.title,
        detail,
        next: entry.next,
        needsAck: NEEDS_ACK.has(severity),
        facts,
        source: entry.source,
    };
}

module.exports = {
    SEVERITY,
    KINDS,
    DEFAULT_SENDERS,
    configuredSenders,
    senderAddress,
    isSqToolsAlert,
    cycleCountFacts,
    classify,
};
