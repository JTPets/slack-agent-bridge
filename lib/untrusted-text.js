'use strict';

/**
 * lib/untrusted-text.js
 *
 * Making text a stranger typed safe to put in front of a reader: a Slack message or a log
 * line. Each function is for one sink; the escaping for one sink does not protect another.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #87): created for the public storefront API, which
 * posted customer text into #store-inbox as Slack markup and wrote a customer-supplied
 * business name straight into a log line.
 *
 * - escapeSlackText: Slack's three control characters (& < >). Without it a customer's
 *   `<!channel>` pings the whole channel and `<https://evil.example|Your order>` renders as
 *   a link with text of their choosing. Slack documents exactly these three as the ones to
 *   escape; everything else is literal text.
 * - quoteForSlack: escapes, then puts `> ` in front of EVERY line, so a multi-line value
 *   cannot end the quote and write lines that look like our own labels.
 * - logSafe: JSON string form (quotes included), so a newline or carriage return becomes
 *   the two characters `\n` and cannot start a forged log line. Non-strings are
 *   stringified first; the result is capped so one request cannot flood the log.
 */

const LOG_SAFE_MAX = 200;

function escapeSlackText(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function quoteForSlack(value) {
    return escapeSlackText(value)
        .split(/\r\n|\r|\n|\u2028|\u2029/)
        .map((line) => `> ${line}`)
        .join('\n');
}

function logSafe(value, max = LOG_SAFE_MAX) {
    const text = String(value === undefined || value === null ? '' : value);
    const cut = text.length > max ? `${text.slice(0, max)}…` : text;
    // JSON.stringify escapes \n, \r, every C0 control and the quote itself, and (since
    // ES2019) lone surrogates; U+2028/U+2029 are escaped by hand because it leaves them.
    return JSON.stringify(cut).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

module.exports = {
    LOG_SAFE_MAX,
    escapeSlackText,
    quoteForSlack,
    logSafe,
};
