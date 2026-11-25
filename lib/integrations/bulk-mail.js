/**
 * lib/integrations/bulk-mail.js
 *
 * What a Gmail message says about itself as bulk mail: who sent it, the signals that
 * mark it as a list or a promotion, and the unsubscribe link the sender published.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #88, phase 1): new file. The owner asked for the
 * secretary to "find me unsubscribe links" and to "learn how to filter out the noise".
 * Phase 1 is the facts both need, read from the message the inbox check already fetches
 * (format 'full', so every header and body part is present):
 *
 *   - the sender's address and display name (one sender is one entry downstream);
 *   - bulk signals: a List-Unsubscribe or List-Id header, `Precedence: bulk|list|junk`,
 *     and Gmail's own Promotions / Social / Forums category labels;
 *   - the unsubscribe link: the List-Unsubscribe header first (RFC 2369; RFC 8058
 *     one-click is noted), and only when it is absent, a link in the body whose address
 *     or text says "unsubscribe" or "opt out".
 *
 * EVERYTHING HERE IS UNTRUSTED. A link is never followed, fetched or clicked by the
 * bridge: it is shown to the owner, who decides. Only `https:`, `http:` and `mailto:`
 * links are kept, each parsed by the URL parser, capped in length, and re-serialised so
 * nothing but a parsed URL leaves this module. Pure: no network, no file, no Slack.
 */

'use strict';

const { getHeader, decodeBase64Url } = require('./gmail-message');

/** Longest link kept; real unsubscribe links are well under this. */
const MAX_LINK_LENGTH = 2000;
/** Longest HTML part scanned for a footer link. */
const MAX_SCAN_BYTES = 512 * 1024;
/** Gmail category labels that mark mail as not personal. Updates (receipts) is excluded. */
const BULK_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'];
const LINK_WORDS = /unsubscribe|opt[\s_-]?out/i;

/**
 * Parse one candidate link. Returns the re-serialised URL, or null when it is not an
 * https/http/mailto URL the parser accepts.
 * @param {string} raw
 * @returns {{ href: string, protocol: string }|null}
 */
function parseLink(raw) {
    const text = String(raw || '').trim().replace(/&amp;/gi, '&');
    if (!text || text.length > MAX_LINK_LENGTH) return null;
    let url;
    try { url = new URL(text); } catch { return null; }
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return null;
    if (url.protocol !== 'mailto:' && !url.hostname) return null;
    return { href: url.href, protocol: url.protocol };
}

/**
 * Split a List-Unsubscribe header value into its `<...>` entries (RFC 2369).
 * @param {string} value
 * @returns {{ url: string|null, mailto: string|null }}
 */
function parseListUnsubscribe(value) {
    const out = { url: null, mailto: null };
    const entries = String(value || '').slice(0, MAX_LINK_LENGTH * 4).match(/<[^<>]*>/g) || [];
    for (const entry of entries) {
        const link = parseLink(entry.slice(1, -1));
        if (!link) continue;
        if (link.protocol === 'mailto:') out.mailto = out.mailto || link.href;
        // The first https link wins; an http one is kept only until an https one appears.
        else if (!out.url || (link.protocol === 'https:' && !out.url.startsWith('https:'))) out.url = link.href;
    }
    return out;
}

/** Every text/html and text/plain body part, decoded, depth first. */
function bodyParts(payload, found = []) {
    if (!payload) return found;
    if (payload.body?.data && /^text\/(html|plain)$/i.test(payload.mimeType || '')) {
        found.push({ type: payload.mimeType.toLowerCase(), text: decodeBase64Url(payload.body.data).slice(0, MAX_SCAN_BYTES) });
    }
    for (const part of payload.parts || []) bodyParts(part, found);
    return found;
}

/**
 * A footer unsubscribe link: an anchor whose href or text says unsubscribe / opt out
 * (HTML), else a bare URL that says it (plain text). The LAST match wins, since the
 * link sits in the footer.
 * @param {Object} payload - Gmail message payload
 * @returns {string|null}
 */
function findFooterLink(payload) {
    let found = null;
    for (const part of bodyParts(payload)) {
        if (part.type === 'text/html') {
            const anchors = part.text.matchAll(/<a\b[^>]*?href\s*=\s*(["'])([^"']{1,2000})\1[^>]*>([\s\S]{0,500}?)<\/a>/gi);
            for (const [, , href, inner] of anchors) {
                if (!LINK_WORDS.test(href) && !LINK_WORDS.test(inner.replace(/<[^>]+>/g, ' '))) continue;
                const link = parseLink(href);
                if (link && link.protocol !== 'mailto:') found = link.href;
            }
        } else {
            for (const [raw] of part.text.matchAll(/https?:\/\/[^\s<>"']{1,2000}/gi)) {
                const link = LINK_WORDS.test(raw) ? parseLink(raw) : null;
                if (link) found = link.href;
            }
        }
        if (found) return found;
    }
    return null;
}

/**
 * Split a From header into an address and a display name.
 * @param {string} from
 * @returns {{ address: string|null, name: string }}
 */
function parseSender(from) {
    const text = String(from || '').replace(/[\r\n]+/g, ' ').trim();
    const angle = text.match(/<([^<>\s]+@[^<>\s]+)>/);
    const bare = text.match(/[^\s<>"]+@[^\s<>"]+/);
    const address = (angle ? angle[1] : bare ? bare[0] : '').toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return { address: null, name: text.slice(0, 80) };
    const name = (angle ? text.slice(0, angle.index) : '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 80);
    return { address, name: name || address };
}

/**
 * Describe one Gmail message (format 'full') as bulk mail.
 * @param {Object} message - Gmail API message
 * @returns {{ sender: { address: string|null, name: string }, signals: string[], isBulk: boolean,
 *   unsubscribe: { url: string|null, mailto: string|null, oneClick: boolean, source: 'header'|'footer' }|null }}
 */
function describeBulkMail(message) {
    const headers = message?.payload?.headers || [];
    const signals = [];
    const listUnsub = getHeader(headers, 'List-Unsubscribe');
    if (listUnsub) signals.push('list-unsubscribe');
    if (getHeader(headers, 'List-Id')) signals.push('list-id');
    if (/^\s*(bulk|list|junk)\b/i.test(getHeader(headers, 'Precedence'))) signals.push('precedence');
    for (const label of message?.labelIds || []) {
        if (BULK_LABELS.includes(label)) signals.push(label.replace('CATEGORY_', '').toLowerCase());
    }

    let unsubscribe = null;
    const header = parseListUnsubscribe(listUnsub);
    if (header.url || header.mailto) {
        const oneClick = Boolean(header.url) && /one-click/i.test(getHeader(headers, 'List-Unsubscribe-Post'));
        unsubscribe = { url: header.url, mailto: header.mailto, oneClick, source: 'header' };
    } else {
        const footer = findFooterLink(message?.payload);
        if (footer) {
            signals.push('footer-link');
            unsubscribe = { url: footer, mailto: null, oneClick: false, source: 'footer' };
        }
    }
    return { sender: parseSender(getHeader(headers, 'From')), signals, isBulk: signals.length > 0, unsubscribe };
}

module.exports = {
    describeBulkMail, parseListUnsubscribe, findFooterLink, parseSender, parseLink,
    BULK_LABELS, MAX_LINK_LENGTH,
};
