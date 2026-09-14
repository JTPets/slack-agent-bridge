/**
 * lib/email-check.js
 *
 * Deterministic scheduled inbox check for the email-monitor agent.
 *
 * LOGIC CHANGE 2026-09-14: Created. The scheduled `check-inbox` job used to post
 * a prose TASK: message to the email-monitor channel, which bridge-agent picked
 * up and handed to an LLM with instructions to "check the email inbox". Nothing
 * in that path ever called lib/integrations/gmail.js: the LLM ran in an empty
 * scratch directory with no mailbox access of any kind, so the summary it posted
 * every 30 minutes was either a refusal or an invention. This module replaces
 * that dispatch with a fetch the operator can reason about:
 *
 *   gmail.fetchRecentEmails()  ->  emailCategorizer.categorizeEmails()  ->  Slack
 *
 * No model decides what matters. Filtering is entirely
 * agents/email-monitor/memory/rules.json, read on every run by
 * emailCategorizer.loadRules().
 *
 * READ-ONLY. Gmail list/get only - never sends, deletes, archives, labels or
 * unsubscribes. The email-monitor agent declares a `gmail-unsubscribe`
 * permission in agents/agents.json that no code in this repository implements;
 * this module does not add it.
 *
 * A check that finds nothing and a check that failed are different outcomes and
 * are reported differently - see runInboxCheck()'s `status`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const gmail = require('./integrations/gmail');
const emailCategorizer = require('./integrations/email-categorizer');
const notifyOwner = require('./notify-owner');

// Where the last successful check time is recorded, so a missed or failed cycle
// does not silently drop the emails that arrived during it. Runtime state:
// agents/*/memory/* is gitignored except for an allowlist this file is not on.
const STATE_FILE = path.join(__dirname, '..', 'agents', 'email-monitor', 'memory', 'check-state.json');

// Ceiling on how far back a check will look when state is missing or stale.
// Without it, a first run (or a run after a long outage) would pull the entire
// inbox in one pass and rate-limit itself against #sqtools-ops.
const MAX_LOOKBACK_MS = Number(process.env.EMAIL_CHECK_MAX_LOOKBACK_MS) || 24 * 60 * 60 * 1000;

// Ceiling on messages fetched per check. Gmail's list cap, not a filter.
const MAX_RESULTS = Number(process.env.EMAIL_CHECK_MAX_RESULTS) || 50;

// Outcome statuses. `ok` is the only one that means the check ran; everything
// else needs a human, which is why runInboxCheck escalates on all of them.
const STATUS = {
    OK: 'ok',
    NOT_CONFIGURED: 'not_configured',
    FETCH_FAILED: 'fetch_failed',
    CATEGORIZE_FAILED: 'categorize_failed',
};

/**
 * Read the last successful check time. A missing or unreadable state file means
 * "first run" and falls back to the lookback ceiling; the reason is carried in
 * the verdict so a file that can never be read shows up rather than quietly
 * re-scanning the same window forever.
 *
 * @param {string} [stateFile] - Override path (tests)
 * @returns {{ lastSuccessfulCheckAt: string|null, error: string|null }}
 */
function readState(stateFile = STATE_FILE) {
    try {
        if (!fs.existsSync(stateFile)) {
            return { lastSuccessfulCheckAt: null, error: null };
        }
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const stamp = parsed?.lastSuccessfulCheckAt;
        if (typeof stamp !== 'string' || Number.isNaN(Date.parse(stamp))) {
            return { lastSuccessfulCheckAt: null, error: 'lastSuccessfulCheckAt is missing or unparseable' };
        }
        return { lastSuccessfulCheckAt: stamp, error: null };
    } catch (err) {
        return { lastSuccessfulCheckAt: null, error: err.message };
    }
}

/**
 * Record a successful check time.
 *
 * @param {Date} at - Time to record
 * @param {string} [stateFile] - Override path (tests)
 * @returns {{ written: boolean, error: string|null }}
 */
function writeState(at, stateFile = STATE_FILE) {
    try {
        fs.mkdirSync(path.dirname(stateFile), { recursive: true });
        fs.writeFileSync(stateFile, JSON.stringify({ lastSuccessfulCheckAt: at.toISOString() }, null, 2));
        return { written: true, error: null };
    } catch (err) {
        return { written: false, error: err.message };
    }
}

/**
 * Work out the window this check should cover.
 *
 * @param {Date} now - Current time
 * @param {string|null} lastSuccessfulCheckAt - ISO stamp from state, or null
 * @returns {{ since: Date, sinceSource: string }}
 */
function resolveWindow(now, lastSuccessfulCheckAt) {
    const floor = new Date(now.getTime() - MAX_LOOKBACK_MS);
    if (!lastSuccessfulCheckAt) {
        return { since: floor, sinceSource: 'lookback_ceiling' };
    }
    const last = new Date(lastSuccessfulCheckAt);
    if (last.getTime() < floor.getTime()) {
        return { since: floor, sinceSource: 'lookback_ceiling_capped' };
    }
    return { since: last, sinceSource: 'last_successful_check' };
}

/**
 * Format a successful check for Slack. The zero case says "0 new messages"
 * explicitly and names the window; it must never be mistakable for a failure,
 * which is why this is only ever called on STATUS.OK.
 *
 * @param {{ since: Date, summary: Object, partial: string|null }} verdict
 * @returns {string} Slack message text
 */
function formatOkMessage({ since, summary, partial }) {
    const window = since.toLocaleString('en-US', {
        timeZone: 'America/Toronto',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });

    const lines = [];
    if (summary.total === 0) {
        lines.push(`:inbox_tray: *Inbox check OK* - 0 new messages since ${window}.`);
    } else {
        lines.push(`:inbox_tray: *Inbox check OK* - ${emailCategorizer.formatSummary(summary)}`);
        lines.push(`Window: since ${window}. Filtered by \`agents/email-monitor/memory/rules.json\`.`);

        for (const item of summary.flagged.slice(0, 5)) {
            // Subject and sender are already sanitized by gmail.transformEmail.
            lines.push(`  • [${item.category}/${item.priority}] ${item.email.subject || '(no subject)'} - ${item.email.from || '(unknown sender)'}`);
        }
        if (summary.flagged.length > 5) {
            lines.push(`  • (${summary.flagged.length - 5} more flagged)`);
        }
    }

    if (partial) {
        lines.push(`:warning: Partial fetch: ${partial}`);
    }

    return lines.join('\n');
}

/**
 * Run one deterministic inbox check. Every non-`ok` status escalates through
 * notifyOwner.taskFailed(), which posts to #sqtools-ops AND sends a CRITICAL
 * owner notification, so a check that stops working reaches a person rather
 * than a log line. Dependencies are injectable so the whole path is testable
 * without a network, a Slack workspace or a mailbox.
 *
 * @param {Object} [deps] - Injectable dependencies
 * @param {Object} [deps.slack] - Slack WebClient (for the summary post)
 * @param {string} [deps.channelId] - Channel to post the summary to
 * @param {Object} [deps.gmailClient=gmail] - Module exposing fetchRecentEmails
 * @param {Object} [deps.categorizer=emailCategorizer] - Module exposing categorizeEmails
 * @param {Object} [deps.notifier=notifyOwner] - Module exposing taskFailed
 * @param {Date} [deps.now] - Clock override
 * @param {string} [deps.stateFile] - State file override
 * @returns {Promise<{ status: string, ok: boolean, fetched: number, since: string, summary: Object|null, error: string|null, posted: boolean, escalated: boolean, stateWritten: boolean }>}
 */
async function runInboxCheck(deps = {}) {
    const {
        slack = null,
        channelId = null,
        gmailClient = gmail,
        categorizer = emailCategorizer,
        notifier = notifyOwner,
        now = new Date(),
        stateFile = STATE_FILE,
    } = deps;

    const state = readState(stateFile);
    const { since, sinceSource } = resolveWindow(now, state.lastSuccessfulCheckAt);

    /**
     * Post the summary of a successful check. Failure to post is itself a
     * failure - a check nobody can see did not happen.
     */
    const post = async (text) => {
        if (!slack || !channelId) return false;
        try {
            await slack.chat.postMessage({ channel: channelId, text, unfurl_links: false });
            return true;
        } catch (err) {
            console.error('[email-check] Failed to post inbox summary:', err.message);
            return false;
        }
    };

    /**
     * Escalate a failed check to a human via #sqtools-ops and a CRITICAL owner
     * notification. Never swallows: an escalation that itself fails is logged.
     */
    const escalate = async (status, message) => {
        console.error(`[email-check] ${status}: ${message}`);
        try {
            const result = await notifier.taskFailed(
                { description: 'Scheduled inbox check (email-monitor)' },
                `${status}: ${message}`,
                { elapsed: '0' }
            );
            return Boolean(result?.opsPosted || result?.ownerNotified);
        } catch (err) {
            console.error('[email-check] Failed to escalate inbox check failure:', err.message);
            return false;
        }
    };

    const base = {
        fetched: 0,
        since: since.toISOString(),
        sinceSource,
        summary: null,
        posted: false,
        stateWritten: false,
        stateError: state.error,
    };

    // ---- Fetch ----
    let fetch;
    try {
        fetch = await gmailClient.fetchRecentEmails(since, MAX_RESULTS, { sanitize: true });
    } catch (err) {
        return { ...base, status: STATUS.FETCH_FAILED, ok: false, error: err.message, escalated: await escalate(STATUS.FETCH_FAILED, err.message) };
    }

    if (!fetch.ok) {
        const status = fetch.reason === 'no_credentials' || fetch.reason === 'service_account_key_missing'
            ? STATUS.NOT_CONFIGURED
            : STATUS.FETCH_FAILED;
        const message = fetch.error || `Gmail fetch failed (${fetch.reason || 'unknown reason'})`;
        return { ...base, status, ok: false, error: message, escalated: await escalate(status, message) };
    }

    // ---- Filter (rules file, no model) ----
    let summary;
    try {
        summary = categorizer.categorizeEmails(fetch.emails);
    } catch (err) {
        return { ...base, fetched: fetch.emails.length, status: STATUS.CATEGORIZE_FAILED, ok: false, error: err.message, escalated: await escalate(STATUS.CATEGORIZE_FAILED, err.message) };
    }

    // ---- Report ----
    const posted = await post(formatOkMessage({ since, summary, partial: fetch.reason === 'partial' ? fetch.error : null }));
    const written = writeState(now, stateFile);

    // A state file that cannot be written means the next check re-scans this
    // window. Visible, not silent - but the check itself succeeded.
    if (!written.written) {
        await escalate('state_write_failed', `Inbox check succeeded but could not record its timestamp: ${written.error}. The next check will re-scan from ${since.toISOString()}.`);
    }

    return {
        ...base,
        status: STATUS.OK,
        ok: true,
        fetched: fetch.emails.length,
        summary,
        error: fetch.reason === 'partial' ? fetch.error : null,
        posted,
        escalated: false,
        stateWritten: written.written,
    };
}

module.exports = {
    runInboxCheck,
    STATUS,
    STATE_FILE,
    MAX_LOOKBACK_MS,
    MAX_RESULTS,
    // Exported for testing
    readState,
    writeState,
    resolveWindow,
    formatOkMessage,
};
