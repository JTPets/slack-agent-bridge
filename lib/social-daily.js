/**
 * lib/social-daily.js
 *
 * The social media agent's daily run, deterministic task `social-daily`:
 *   1. read every set-up platform and keep the day's snapshot (lib/social-insights.js);
 *   2. find new Square items (lib/catalog-new-items.js), have the agent's model draft a
 *      post for each, and post each draft with Publish / Edit / Reject buttons;
 *   3. on Mondays, or when run on demand, post the weekly digest.
 *
 * LOGIC CHANGE 2026-11-09: created (owner, 2026-11-09). NOTHING HERE PUBLISHES. A
 * draft goes live only from a press (lib/social-buttons.js).
 *
 * The model runs with the agent's own provider, one turn, in an empty temp directory,
 * and the claude adapter gives the social-media agent no tools (lib/agent-tools.js:
 * none of its declared permissions grants one). It never sees a platform token.
 *
 * Every failure is posted to #sqtools-ops through `notify`, and the run says what it
 * checked, so a quiet day is distinguishable from a broken job. Never rejects.
 */

'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { STORE_TIME_ZONE, zonedParts } = require('./time-format');

const MAX_DRAFTS_PER_RUN = 5;
const DRAFT_TIMEOUT_MS = 180000;
const DIGEST_WEEKDAY = 1; // Monday

function defaultDeps() {
    const platforms = require('./social-platforms');
    const insights = require('./social-insights');
    const newItems = require('./catalog-new-items');
    const drafts = require('./social-drafts');
    return {
        readEverything: (o) => platforms.readEverything(o),
        publishTargets: () => platforms.publishTargets(),
        labelOf: (id) => platforms.getPlatform(id).label,
        recordSnapshot: (s, o) => insights.recordSnapshot(s, o),
        readHistory: () => insights.readHistory(),
        buildWeeklyDigest: (h, o) => insights.buildWeeklyDigest(h, o),
        checkNewItems: () => newItems.checkNewItems({ fetchItems: () => require('./integrations/square-catalog').refreshCatalog() }),
        formatNewItemsReport: (v) => newItems.formatNewItemsReport(v),
        createDrafts: (items, o) => drafts.createDrafts(items, o),
        buildDraftBlocks: (d, o) => drafts.buildDraftBlocks(d, o),
        recordPost: (id, post) => drafts.updateDraft(id, { post }),
        runModel: defaultRunModel,
    };
}

/** One turn of the agent's own model, no tools, in an empty temp directory. */
async function defaultRunModel(prompt, agent) {
    const { runLLM } = require('./llm-runner');
    const { resolveAgentLlm } = require('./agent-llm-resolver');
    const resolved = resolveAgentLlm(agent);
    let dir;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-draft-'));
        const result = await runLLM(prompt, {
            cwd: dir, maxTurns: 1, timeout: DRAFT_TIMEOUT_MS,
            provider: resolved.provider, model: resolved.model, agentId: agent.id,
        });
        return result && result.output ? String(result.output) : '';
    } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * @param {object} opts
 * @param {object} opts.slack - Slack Web client (chat.postMessage)
 * @param {object} opts.agent - the social-media agent record (channel, id, system_prompt)
 * @param {boolean} [opts.onDemand] - run by a person: always posts the digest and a summary
 * @param {Function} [opts.notify] - posts to #sqtools-ops
 * @param {object} [opts.deps] - test seams
 * @returns {Promise<{ ok: boolean, text: string }>} never rejects
 */
async function runSocialDaily({ slack, agent, onDemand = false, notify, now = new Date(), env = process.env, deps: injected = {} }) {
    const deps = { ...defaultDeps(), ...injected };
    const report = notify || (async () => {});
    const summary = [];
    const problems = [];
    const post = async (args) => {
        const res = await slack.chat.postMessage({ channel: agent.channel, unfurl_links: false, ...args });
        return res && res.ts ? { channel: res.channel || agent.channel, ts: res.ts } : null;
    };

    if (!agent || !agent.channel) {
        const text = ':x: Social daily run: the social media agent has no resolved channel, so nothing was run.';
        await report(text).catch(() => {});
        return { ok: false, text };
    }

    // 1. Snapshot.
    try {
        const snapshot = await deps.readEverything({ env, now });
        const day = deps.recordSnapshot(snapshot, { now });
        const states = Object.entries(snapshot).map(([id, s]) => `${id} ${s.notConfigured ? 'not set up' : (s.account && s.account.available === false ? 'unreadable' : 'read')}`);
        summary.push(`Snapshot ${day}: ${states.join(', ')}`);
        for (const [id, s] of Object.entries(snapshot)) {
            if (s.account && s.account.available === false) problems.push(`${id} could not be read: ${s.account.reason}`);
        }
    } catch (err) {
        problems.push(`snapshot failed: ${err.message}`);
    }

    // 2. New items -> drafts.
    if (!env.SQUARE_ACCESS_TOKEN) {
        summary.push('New items: not checked, SQUARE_ACCESS_TOKEN is not set');
    } else {
        const verdict = await deps.checkNewItems();
        summary.push(deps.formatNewItemsReport(verdict));
        if (verdict.status === 'failed') problems.push(`new-item check failed: ${verdict.reason}`);
        const items = verdict.status === 'ok' ? verdict.newItems : [];
        if (items.length > MAX_DRAFTS_PER_RUN) {
            summary.push(`Drafting the first ${MAX_DRAFTS_PER_RUN} of ${items.length} new items today; the rest are listed above and get no draft.`);
        }
        if (items.length) {
            const { drafts, failures } = await deps.createDrafts(items.slice(0, MAX_DRAFTS_PER_RUN), {
                agent, now, runModel: (prompt) => deps.runModel(prompt, agent),
            });
            for (const f of failures) problems.push(`draft for "${f.item}" failed: ${f.reason}`);
            const targets = deps.publishTargets().ready.map(deps.labelOf);
            for (const d of drafts) {
                try {
                    const where = await post({ text: `Social post draft: ${d.itemName}`, blocks: deps.buildDraftBlocks(d, { targets }) });
                    if (where) deps.recordPost(d.id, where);
                    else problems.push(`draft for "${d.itemName}" was written but Slack returned no message id, so its buttons cannot update it`);
                } catch (err) {
                    problems.push(`draft for "${d.itemName}" could not be posted: ${err.message}`);
                }
            }
            summary.push(`Drafts posted: ${drafts.length}`);
        }
    }

    // 3. Weekly digest.
    const monday = zonedParts(now, STORE_TIME_ZONE).weekday === DIGEST_WEEKDAY;
    if (monday || onDemand) {
        try {
            const digest = deps.buildWeeklyDigest(deps.readHistory(), { now });
            await post({ text: digest.text });
            summary.push('Weekly digest posted');
        } catch (err) {
            problems.push(`weekly digest failed: ${err.message}`);
        }
    }

    const text = [`Social daily run${onDemand ? ' (on demand)' : ''}:`, ...summary.map(s => `• ${s}`),
        ...(problems.length ? ['Problems:', ...problems.map(p => `• ${p}`)] : [])].join('\n');
    if (problems.length) await report(`:warning: ${text}`).catch(() => {});
    return { ok: problems.length === 0, text };
}

module.exports = { MAX_DRAFTS_PER_RUN, DIGEST_WEEKDAY, runSocialDaily, defaultRunModel };
