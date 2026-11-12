'use strict';

/**
 * lib/credential-probe.js
 *
 * WORK-TODO #80's remainder: a credential that is SET is not a credential that works.
 * An expired Google refresh token or a revoked Meta Page token reads SET to
 * lib/activation-checklist.js, so `ASK: activate <id>` asks this module for ONE live,
 * read-only call per credential and passes the step only when it answers.
 *
 * LOGIC CHANGE 2026-11-12: new file (batch B30).
 *
 * The rule for what gets a probe: only a credential for which a READ-ONLY client
 * already exists in this repository. Nothing here writes, posts or publishes, and no
 * new client is built for a probe. Everything else is `not_probed`, and says so.
 *
 *   probe       variables it covers                  the call
 *   facebook    META_PAGE_ACCESS_TOKEN, META_PAGE_ID lib/social-meta.js readFacebook (Page fields)
 *   instagram   INSTAGRAM_BUSINESS_ID                lib/social-meta.js readInstagram (account fields)
 *   gbp         GBP_REFRESH_TOKEN, GBP_ACCOUNT_ID,   lib/social-gbp.js readGbp (token exchange + reviews)
 *               GBP_LOCATION_ID
 *   bluesky     BLUESKY_HANDLE                       lib/social-bluesky.js readBluesky (public profile)
 *   square      SQUARE_ACCESS_TOKEN                  square-catalog-api squareApiRequest, one page of
 *                                                    GET /v2/catalog/list?types=CATEGORY
 *   gmail       GOOGLE_REFRESH_TOKEN                 gmail-auth createGmailClient + users.getProfile
 *
 * Deliberately NOT probed (no read-only client exists): BLUESKY_APP_PASSWORD (the only
 * call that proves it is createSession, which lives inline in publishBluesky), every
 * LINKEDIN_*, YELP_API_KEY, GA_PROPERTY_ID, GOOGLE_MERCHANT_CENTER_ID,
 * GOOGLE_BUSINESS_PROFILE_ACCOUNT_ID, HTTPSMS_*, GEMINI_API_KEY (its only check is a
 * paid generateContent call, not a models list).
 *
 * Every probe: bounded by PROBE_TIMEOUT_MS, never rejects, and returns
 * { status: 'works'|'fails'|'not_probed', probe, reason }. The reason NEVER carries a
 * value: the probe's own variable values are cut out literally, then the text goes
 * through lib/redact-secrets.js, because a platform's error body can echo what it was
 * sent.
 */

const { redact, MIN_SECRET_LEN } = require('./redact-secrets');

const PROBE_TIMEOUT_MS = 15000;

/** A section of a social read that failed is { available: false, reason }. */
function needSection(section, what) {
    if (!section || !section.available) throw new Error((section && section.reason) || `${what} could not be read`);
}

const PROBES = {
    facebook: {
        label: 'reads the Facebook Page',
        vars: ['META_PAGE_ACCESS_TOKEN', 'META_PAGE_ID'],
        run: async ({ env, fetchImpl, deps }) => {
            const r = await (deps.readFacebook || require('./social-meta').readFacebook)({ env, fetchImpl });
            needSection(r.account, 'the Page');
        },
    },
    instagram: {
        label: 'reads the Instagram account',
        vars: ['META_PAGE_ACCESS_TOKEN', 'INSTAGRAM_BUSINESS_ID'],
        run: async ({ env, fetchImpl, deps }) => {
            const r = await (deps.readInstagram || require('./social-meta').readInstagram)({ env, fetchImpl });
            needSection(r.account, 'the Instagram account');
        },
    },
    gbp: {
        label: 'reads the Google Business Profile reviews',
        vars: ['GBP_REFRESH_TOKEN', 'GBP_ACCOUNT_ID', 'GBP_LOCATION_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
        run: async ({ env, fetchImpl, deps }) => {
            const r = await (deps.readGbp || require('./social-gbp').readGbp)({ env, fetchImpl });
            needSection(r.account, 'the Google token');
            needSection(r.reviews, 'the listing');
        },
    },
    bluesky: {
        label: 'reads the public Bluesky profile',
        vars: ['BLUESKY_HANDLE'],
        run: async ({ env, fetchImpl, deps }) => {
            const r = await (deps.readBluesky || require('./social-bluesky').readBluesky)({ env, fetchImpl });
            needSection(r.account, 'the profile');
        },
    },
    square: {
        label: 'lists one page of the Square catalog',
        vars: ['SQUARE_ACCESS_TOKEN'],
        run: async ({ env, deps }) => {
            const request = deps.squareApiRequest || require('./integrations/square-catalog-api').squareApiRequest;
            try {
                await request('/catalog/list?types=CATEGORY', env.SQUARE_ACCESS_TOKEN);
            } catch (err) {
                // The Square error object carries the response body; only the status line is reported.
                throw new Error(err && err.message ? err.message : 'Square request failed');
            }
        },
    },
    gmail: {
        label: 'reads the Gmail profile (read-only scope)',
        vars: ['GOOGLE_REFRESH_TOKEN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
        run: async ({ deps }) => {
            // createGmailClient reads process.env itself; the probe tests what the bridge would use.
            const created = await (deps.createGmailClient || require('./integrations/gmail-auth').createGmailClient)();
            if (!created.client) throw new Error(created.error || created.reason || 'no Gmail client');
            await created.client.users.getProfile({ userId: 'me' });
        },
    },
};

/** Which probe covers each variable. A variable not listed has no probe. */
const PROBE_FOR = {
    META_PAGE_ACCESS_TOKEN: 'facebook',
    META_PAGE_ID: 'facebook',
    INSTAGRAM_BUSINESS_ID: 'instagram',
    GBP_REFRESH_TOKEN: 'gbp',
    GBP_ACCOUNT_ID: 'gbp',
    GBP_LOCATION_ID: 'gbp',
    BLUESKY_HANDLE: 'bluesky',
    SQUARE_ACCESS_TOKEN: 'square',
    GOOGLE_REFRESH_TOKEN: 'gmail',
};

const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

/** Cut every value of the probe's variables out of the text, then run the general redactor. */
function scrub(text, vars, env) {
    let out = String(text || '');
    for (const name of vars) {
        const v = env[name];
        if (typeof v === 'string' && v.trim().length >= MIN_SECRET_LEN) out = out.split(v).join(`[REDACTED:${name}]`);
    }
    return redact(out, { env: { ...process.env, ...env } }).slice(0, 300);
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
        if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function runProbe(id, { env, fetchImpl, deps, timeoutMs }) {
    const p = PROBES[id];
    const missing = p.vars.filter(n => !isSet(env, n));
    if (missing.length) {
        return { status: 'fails', probe: id, reason: `cannot be tested while ${missing.map(n => `\`${n}\``).join(', ')} ${missing.length > 1 ? 'are' : 'is'} EMPTY` };
    }
    try {
        await withTimeout(Promise.resolve().then(() => p.run({ env, fetchImpl, deps })), timeoutMs);
        return { status: 'works', probe: id, reason: p.label };
    } catch (err) {
        return { status: 'fails', probe: id, reason: scrub(err && err.message ? err.message : String(err), p.vars, env) };
    }
}

/**
 * Probe one credential by its variable name. Never rejects, never returns a value.
 *
 * @param {string} name - the env var name
 * @param {object} [opts] - { env, fetchImpl, deps, timeoutMs, cache: Map }
 *   `cache` shares one run between variables covered by the same probe.
 * @returns {Promise<{ status: 'works'|'fails'|'not_probed', probe: string|null, reason: string }>}
 */
async function probeCredential(name, { env = process.env, fetchImpl, deps = {}, timeoutMs = PROBE_TIMEOUT_MS, cache } = {}) {
    const id = PROBE_FOR[name];
    if (!id) return { status: 'not_probed', probe: null, reason: 'no live check exists for it' };
    if (cache && cache.has(id)) return cache.get(id);
    const result = runProbe(id, { env, fetchImpl, deps, timeoutMs }).catch(err => ({
        status: 'fails', probe: id, reason: scrub(err && err.message, PROBES[id].vars, env),
    }));
    if (cache) cache.set(id, result);
    return result;
}

module.exports = { probeCredential, PROBES, PROBE_FOR, PROBE_TIMEOUT_MS };
