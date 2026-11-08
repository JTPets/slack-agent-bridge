'use strict';

/**
 * lib/self-deploy.js
 *
 * WORK-TODO #17: runs auto-update.js's cycle INSIDE the bridge process, gated by
 * lib/update-gate.js. The owner's choice of 2026-11-08: merged code deploys itself once
 * the full suite passes on it.
 *
 * LOGIC CHANGE 2026-11-08: new file.
 *
 * Why inside the bridge and not a second daemon. The container's main process is
 * `node bridge-agent.js` (behind `init: true`); a second process's exit restarts nothing,
 * so auto-update.js's "exit is the restart" only works when the exiting process is the
 * bridge. Inside the bridge it also sees what the coordination files cannot: an `ASK:`
 * being answered (WORK-TODO #71), passed in as `busy`. No compose change is needed.
 *
 * One cycle at a time: a gate run is minutes long and outlasts the interval. Refuses to
 * start, and says why, when auto-update.js would operate on a different checkout than the
 * one this process runs from (a stale LOCAL_REPO_DIR in .env). Never throws.
 */

const path = require('path');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_DELAY_MS = 2 * 60 * 1000;

/** SELF_DEPLOY_INTERVAL_MS: unset = 5 min, 0 = off, anything unparseable = the default. */
function intervalFromEnv(env = process.env) {
    const raw = env.SELF_DEPLOY_INTERVAL_MS;
    if (raw === undefined || raw === '') return DEFAULT_INTERVAL_MS;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

/**
 * @param {object} deps
 * @param {string} deps.repoDir - the checkout this process runs from (bridge-agent's __dirname)
 * @param {() => string|null} deps.busy - a reason while in-process work is in flight
 * @param {(text: string) => Promise<any>} deps.postToOps
 * @param {number} [deps.intervalMs]
 * @param {() => object} [deps.loadAutoUpdate] - require('../auto-update'), injectable
 */
function createSelfDeploy({
    repoDir, busy, postToOps, intervalMs = intervalFromEnv(),
    loadAutoUpdate = () => require('../auto-update'),
    setIntervalFn = setInterval, setTimeoutFn = setTimeout, firstDelayMs = FIRST_DELAY_MS,
}) {
    let inFlight = false;
    let autoUpdate = null;

    async function cycle() {
        if (inFlight || !autoUpdate) return false;
        inFlight = true;
        try {
            await autoUpdate.checkForUpdates(autoUpdate.gatedDeps({ inProcessBusy: busy }));
        } catch (err) {
            await postToOps(`:x: Self-deploy: the update cycle threw - ${err.message}`).catch(() => {});
        } finally {
            inFlight = false;
        }
        return true;
    }

    async function start() {
        try {
            if (!intervalMs) return { started: false, reason: 'SELF_DEPLOY_INTERVAL_MS is 0' };
            autoUpdate = loadAutoUpdate();
            const target = path.resolve(autoUpdate.LOCAL_REPO_DIR || '');
            if (target !== path.resolve(repoDir)) {
                autoUpdate = null;
                const reason = `LOCAL_REPO_DIR is ${target}, but this bridge runs from ${path.resolve(repoDir)}`;
                await postToOps(`:warning: Self-deploy is OFF: ${reason}. Remove LOCAL_REPO_DIR from .env (the default is the right checkout) and recreate the container.`).catch(() => {});
                return { started: false, reason };
            }
            const first = setTimeoutFn(cycle, firstDelayMs);
            const every = setIntervalFn(cycle, intervalMs);
            for (const t of [first, every]) if (t && typeof t.unref === 'function') t.unref();
            return { started: true, reason: null };
        } catch (err) {
            autoUpdate = null;
            await postToOps(`:warning: Self-deploy is OFF: it could not start - ${err.message}`).catch(() => {});
            return { started: false, reason: err.message };
        }
    }

    return { start, cycle, inFlight: () => inFlight };
}

module.exports = { createSelfDeploy, intervalFromEnv, DEFAULT_INTERVAL_MS, FIRST_DELAY_MS };
