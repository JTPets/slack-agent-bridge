'use strict';

/**
 * lib/weekly-critique.js
 *
 * The jester's weekly post: a critique of the digest, in his own voice, on his own
 * provider, in his own channel. Deterministic scheduled task `weekly-critique`.
 *
 * LOGIC CHANGE 2026-09-16: New file (docs/JESTER-DESIGN.md, WORK-TODO #53).
 * `weekly-critique` used to be a TASK_TEMPLATES entry — a prose instruction ("Review
 * the week's activities and provide contrarian takes") posted as a TASK: message for
 * the poll loop to hand to an LLM with no material attached. It is now a
 * DETERMINISTIC_TASKS entry: code gathers the facts, the model is given them, and the
 * post is the model's only output. Exactly the shape `check-inbox` took on 2026-09-14
 * and for the same reason — a model asked to review a week it was never shown will
 * write something that reads like a review.
 *
 * HE CANNOT GATE ANYTHING, and that is enforced, not asserted:
 *   - This module RETURNS a verdict. It never decides anything for a caller.
 *   - It writes no state at all: no queue transition, no approval queue, no activation,
 *     no lock, no file. `tests/weekly-critique.test.js` walks this module's source and
 *     fails if it names any state-mutating API.
 *   - Its two call sites (the cron registrar and the `critique` verb) only REPORT the
 *     verdict; the same test enumerates them and fails if a third appears.
 * The powerlessness is the design. An opinion that gates something is an unaccountable
 * check with taste instead of rules.
 *
 * NO FALLBACK CHAIN, DELIBERATELY — the one place this module departs from the two
 * `bridge-agent.js` entry points. `runLLM` is called with the agent's resolved provider
 * and no failover, because the fallback chain can land on `claude`, whose adapter
 * spawns a CLI with `--dangerously-skip-permissions` in `cwd`
 * (`lib/llm-runner.js:357`). Jester's definition denies `file-system` and `github`;
 * routing him automatically onto a tool-capable engine to save a weekly joke is not a
 * trade worth making. A provider failure is REPORTED instead. Defence in depth for the
 * case where an operator pins him to claude on purpose: `maxTurns: 1` and a fresh empty
 * temp directory as `cwd`, removed in a `finally`.
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { buildDigest, formatDigestForPrompt, formatCoverage } = require('./critique-digest');
const { loadAgents } = require('./agent-registry');
const { resolveAgentLlm } = require('./agent-llm-resolver');
const { ANTI_HALLUCINATION_RULE } = require('./agent-context');
const llmRunner = require('./llm-runner');
const notifyOwner = require('./notify-owner');

/** The scheduled task this module implements. Used to find its owning agent. */
const TASK_NAME = 'weekly-critique';

/** One shot. He is given everything; there is nothing to go and fetch. */
const MAX_TURNS = 1;

/** Generous for a single HTTPS call, well under TASK_TIMEOUT_MS. */
const TIMEOUT_MS = Number(process.env.CRITIQUE_TIMEOUT_MS) || 120000;

const STATUS = {
    OK: 'ok',
    THIN: 'thin',
    NO_CHANNEL: 'no_channel',
    LLM_FAILED: 'llm_failed',
    POST_FAILED: 'post_failed',
};

/**
 * Which agent owns this task?
 *
 * Derived from the SAME declaration the cron registrar reads — the agent whose
 * `schedule.task` is this task name — so the verb and the schedule cannot name
 * different agents. The passed agent wins only when it is already that agent, which is
 * the cron path; on the on-demand path the caller passes whichever agent's channel the
 * command was typed in, and that must not decide where the critique lands.
 *
 * @param {object|null} passed - Agent supplied by the caller.
 * @param {Function} [load=loadAgents]
 * @returns {object|null}
 */
function resolveCritic(passed, load = loadAgents) {
    if (passed && passed.schedule && passed.schedule.task === TASK_NAME) return passed;
    let agents = [];
    try {
        agents = load() || [];
    } catch (err) {
        console.error('[weekly-critique] Could not load the agent registry:', err.message);
    }
    return agents.find(a => a.schedule && a.schedule.task === TASK_NAME) || passed || null;
}

/**
 * The post for a week in which nothing happened.
 *
 * NO MODEL IS CALLED on this path, and that is the whole guarantee. A model handed an
 * empty digest and a contrarian persona will produce a complaint, because that is what
 * it was asked to be; the only reliable way to get an honest "nothing to report" is not
 * to ask. The coverage line is what makes the short post evidence rather than an
 * absence of evidence — it names the sensors that ran and found nothing.
 *
 * @param {object} digest
 * @returns {string}
 */
function thinPost(digest) {
    return [
        ':jester: *Weekly critique* — nothing worth the breath.',
        '',
        `No commits, no finished tasks and no bulletins in the last ${digest.windowDays} days. `
        + 'A quiet week is not a failure and I am not going to invent one.',
        '',
        `_${formatCoverage(digest)}_`,
        `_${digest.backlog.available ? `${digest.backlog.open} backlog items are still open; none of them got older in a way worth a joke.` : `The backlog could not be read: ${digest.backlog.reason}`}_`,
    ].join('\n');
}

/**
 * Assemble the prompt: his voice, the rules, then the facts.
 *
 * @param {object} agent - The critic's registry record.
 * @param {object} digest
 * @returns {string}
 */
function buildCritiquePrompt(agent, digest) {
    return [
        agent.system_prompt || 'You are The Jester, the sharp-tongued contrarian of JT Pets.',
        '',
        ANTI_HALLUCINATION_RULE,
        '',
        'YOUR JOB THIS WEEK:',
        'Write one short Slack post reviewing the period below. Push back on what was',
        'wasted, what was absurd, and what has been ignored longer than it should have',
        'been. Be funny about things that are actually true.',
        '',
        'RULES, and they bind harder than the personality above:',
        '- Every fact below was COMPUTED. Cite the numbers. Do not add any of your own.',
        '- A line marked UNAVAILABLE means a sensor failed, NOT that there was nothing',
        '  there. Say the sensor failed. Never treat it as good news.',
        '- If a section is genuinely empty, say it is empty. Do not manufacture a',
        '  complaint to fill it. A short honest post is the correct output for a quiet',
        '  week.',
        '- You decide nothing and block nothing. Do not instruct anyone, do not approve',
        '  or reject anything, and do not claim a change will be made. You are read when',
        '  someone chooses to read you.',
        '- Under 250 words. Slack formatting. No headings, no bullet-point report.',
        '',
        formatDigestForPrompt(digest),
    ].join('\n');
}

/**
 * Run one weekly critique.
 *
 * Every non-`ok` outcome is reported to `#sqtools-ops` via `notifyOps` — never silent.
 * It is deliberately NOT `taskFailed`, which also raises a CRITICAL owner notification:
 * a missed joke is an operational note, not a page, and a weekly CRITICAL for an agent
 * the owner reads at his own convenience would train the alert to be ignored.
 *
 * @param {object} [deps]
 * @param {object} [deps.slack] - Slack WebClient.
 * @param {object} [deps.agent] - Agent supplied by the caller (cron or the verb).
 * @param {Date} [deps.now]
 * @param {number} [deps.windowDays]
 * @param {object} [deps.digest] - Prebuilt digest (tests).
 * @param {object} [deps.llm=llmRunner] - Module exposing runLLM.
 * @param {object} [deps.notifier=notifyOwner] - Module exposing notifyOps.
 * @param {Function} [deps.loadAgentsFn=loadAgents]
 * @returns {Promise<object>} Verdict. Nothing reads it to make a decision.
 */
async function runWeeklyCritique(deps = {}) {
    const {
        slack = null,
        agent = null,
        now = new Date(),
        windowDays,
        llm = llmRunner,
        notifier = notifyOwner,
        loadAgentsFn = loadAgents,
    } = deps;

    const critic = resolveCritic(agent, loadAgentsFn);
    const agentId = (critic && critic.id) || 'jester';

    /** Report an operational failure. Never throws; a failed report is logged. */
    const escalate = async (status, message) => {
        console.error(`[weekly-critique] ${status}: ${message}`);
        try {
            await notifier.notifyOps(`:jester: *Weekly critique did not post* — \`${agentId}:${TASK_NAME}\`\n${status}: ${message}`);
            return true;
        } catch (err) {
            console.error('[weekly-critique] Could not escalate:', err.message);
            return false;
        }
    };

    if (!critic || !critic.channel) {
        const declared = critic && critic.channel_name ? `#${critic.channel_name}` : 'no channel';
        const message = `${agentId} has no resolved channel (${declared}). Creating it is an owner action; nothing here creates a Slack channel.`;
        return { ok: false, status: STATUS.NO_CHANNEL, agentId, channel: null, posted: false, thin: null, escalated: await escalate(STATUS.NO_CHANNEL, message), error: message };
    }

    const digest = deps.digest || buildDigest({ now, ...(Number.isFinite(windowDays) ? { windowDays } : {}) });

    const post = async (text) => {
        if (!slack) return { posted: false, error: 'no Slack client was supplied' };
        try {
            await slack.chat.postMessage({ channel: critic.channel, text, unfurl_links: false });
            return { posted: true, error: null };
        } catch (err) {
            return { posted: false, error: err.message };
        }
    };

    const base = { agentId, channel: critic.channel, thin: digest.thin, windowDays: digest.windowDays };

    // ---- Thin week: no model is called at all. See thinPost(). ----
    if (digest.thin) {
        const sent = await post(thinPost(digest));
        if (!sent.posted) {
            return { ...base, ok: false, status: STATUS.POST_FAILED, posted: false, error: sent.error, escalated: await escalate(STATUS.POST_FAILED, sent.error) };
        }
        return { ...base, ok: true, status: STATUS.THIN, posted: true, error: null, escalated: false, provider: null };
    }

    // ---- Normal week: one shot, his provider, an empty working directory. ----
    const resolved = resolveAgentLlm(critic);
    let tempDir;
    let output;
    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'critique-'));
        const result = await llm.runLLM(buildCritiquePrompt(critic, digest), {
            cwd: tempDir,
            maxTurns: MAX_TURNS,
            timeout: TIMEOUT_MS,
            provider: resolved.provider,
            model: resolved.model,
            agentId,
        });
        output = (result && result.output ? String(result.output) : '').trim();
    } catch (err) {
        return { ...base, ok: false, status: STATUS.LLM_FAILED, posted: false, provider: resolved.provider, error: err.message, escalated: await escalate(STATUS.LLM_FAILED, err.message) };
    } finally {
        // CLAUDE.md: temp dirs are removed in `finally`, not only on the success path.
        if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    if (!output) {
        const message = `${resolved.provider} returned an empty critique`;
        return { ...base, ok: false, status: STATUS.LLM_FAILED, posted: false, provider: resolved.provider, error: message, escalated: await escalate(STATUS.LLM_FAILED, message) };
    }

    const sent = await post(`${output}\n\n_${formatCoverage(digest)}_`);
    if (!sent.posted) {
        return { ...base, ok: false, status: STATUS.POST_FAILED, posted: false, provider: resolved.provider, error: sent.error, escalated: await escalate(STATUS.POST_FAILED, sent.error) };
    }
    return { ...base, ok: true, status: STATUS.OK, posted: true, provider: resolved.provider, error: null, escalated: false };
}

module.exports = {
    runWeeklyCritique,
    TASK_NAME,
    STATUS,
    MAX_TURNS,
    // Exported for testing
    resolveCritic,
    thinPost,
    buildCritiquePrompt,
};
