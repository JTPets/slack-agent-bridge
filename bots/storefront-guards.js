'use strict';

/**
 * bots/storefront-guards.js
 *
 * The request guards in front of the storefront's public routes: who may call them from a
 * browser (CORS), how often anyone may call them (the rate limit), and which session ids
 * are accepted. Each is middleware or a pure check, so the routes in bots/storefront.js
 * stay about the work and each guard is tested on its own (tests/storefront-guards.test.js).
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #87):
 * - RATE LIMIT. POST /api/chat ran the model for anyone, as often as they liked, at our
 *   cost; POST /api/delivery-quote wrote a file and posted to #store-inbox the same way.
 *   Each route now has a sliding-window limit per client AND a global one. The global
 *   limit is the one that bounds spend: behind the Cloudflare tunnel every request can
 *   arrive from the same address unless `trust proxy` is set (STOREFRONT_TRUST_PROXY), and
 *   a client that rotates addresses is held by it either way.
 * - CORS. The old config allowed `*` together with `credentials: true`. The widget and the
 *   delivery page send no cookies (fetch with the default credentials mode), so
 *   credentials are off, origins match exactly, and a `*` in STOREFRONT_ALLOWED_ORIGINS is
 *   ignored and reported rather than honoured.
 * - SESSION ID. A client-supplied sessionId was used as a Map key and printed in a log line
 *   unchecked (a number crashed the route, a newline forged a log line, any length was
 *   kept). It is now accepted only in a short id shape; anything else gets a new id.
 */

const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_PER_CLIENT = 10;
const DEFAULT_GLOBAL = 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

function positiveInt(raw, fallback) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The rate-limit settings, read from the environment (each falls back on a bad value). */
function rateLimitConfig(env = process.env) {
    return {
        windowMs: positiveInt(env.STOREFRONT_RATE_WINDOW_MS, DEFAULT_WINDOW_MS),
        perClient: positiveInt(env.STOREFRONT_RATE_PER_CLIENT, DEFAULT_PER_CLIENT),
        global: positiveInt(env.STOREFRONT_RATE_GLOBAL, DEFAULT_GLOBAL),
    };
}

/**
 * A sliding-window limiter: at most `perClient` calls per key and `global` calls in all,
 * in any `windowMs`. A refused call is not counted, so a client hammering a closed window
 * does not keep it closed. Pure apart from the clock, which is injectable.
 */
function createRateLimiter({ windowMs, perClient, global, now = Date.now }) {
    const perKey = new Map();
    let all = [];
    let lastSweep = now();

    const prune = (stamps, t) => stamps.filter((s) => t - s < windowMs);

    function sweep(t) {
        for (const [key, stamps] of perKey) {
            const kept = prune(stamps, t);
            if (kept.length === 0) perKey.delete(key);
            else perKey.set(key, kept);
        }
        lastSweep = t;
    }

    function check(key) {
        const t = now();
        if (t - lastSweep >= windowMs) sweep(t);
        all = prune(all, t);
        const mine = prune(perKey.get(key) || [], t);
        let scope = null;
        let oldest = null;
        if (all.length >= global) { scope = 'global'; oldest = all[0]; }
        else if (mine.length >= perClient) { scope = 'client'; oldest = mine[0]; }
        if (scope) {
            if (mine.length) perKey.set(key, mine); else perKey.delete(key);
            return { allowed: false, scope, retryAfterMs: Math.max(0, windowMs - (t - oldest)) };
        }
        mine.push(t);
        all.push(t);
        perKey.set(key, mine);
        return { allowed: true, scope: null, retryAfterMs: 0 };
    }

    function reset() {
        perKey.clear();
        all = [];
    }

    return { check, reset, trackedClients: () => perKey.size };
}

/**
 * Express middleware over a limiter. A refusal is a 429 with Retry-After and the same
 * `RATE_LIMITED` code the chat route already uses for a provider limit. `onGlobalLimit`
 * is told once per window when the GLOBAL limit first refuses, so a flood reaches a person.
 */
function rateLimitMiddleware(limiter, { windowMs, onGlobalLimit = () => {}, now = Date.now } = {}) {
    let lastGlobalReport = -Infinity;
    return function storefrontRateLimit(req, res, next) {
        const verdict = limiter.check(req.ip || 'unknown');
        if (verdict.allowed) return next();
        if (verdict.scope === 'global' && now() - lastGlobalReport >= windowMs) {
            lastGlobalReport = now();
            try { onGlobalLimit(req.path); } catch { /* reporting never fails the request */ }
        }
        res.set('Retry-After', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000))));
        return res.status(429).json({
            error: 'Too many requests. Please try again in a minute.',
            code: 'RATE_LIMITED',
        });
    };
}

/**
 * The CORS options for a list of allowed origins: exact match only, no credentials. A `*`
 * entry is dropped and returned in `ignored` for the caller to report.
 */
function buildCorsOptions(allowedOrigins) {
    const cleaned = allowedOrigins.map((o) => o.trim()).filter(Boolean);
    const ignored = cleaned.filter((o) => o === '*');
    const exact = new Set(cleaned.filter((o) => o !== '*'));
    return {
        ignored,
        options: {
            origin: (origin, callback) => {
                // No Origin header: not a browser cross-origin call (curl, server to server),
                // and CORS does not apply to it. The rate limit still does.
                if (!origin || exact.has(origin)) return callback(null, true);
                return callback(new Error('Not allowed by CORS'));
            },
            methods: ['GET', 'POST'],
            allowedHeaders: ['Content-Type', 'X-Session-ID'],
            credentials: false,
        },
    };
}

/** A client-supplied session id we keep, or null when it must be replaced. */
function acceptSessionId(value) {
    return typeof value === 'string' && SESSION_ID_PATTERN.test(value) ? value : null;
}

module.exports = {
    DEFAULT_WINDOW_MS,
    DEFAULT_PER_CLIENT,
    DEFAULT_GLOBAL,
    SESSION_ID_PATTERN,
    rateLimitConfig,
    createRateLimiter,
    rateLimitMiddleware,
    buildCorsOptions,
    acceptSessionId,
};
