/**
 * tests/helpers/critique-fixtures.js
 *
 * Shared doubles for the jester's weekly-critique suites.
 *
 * LOGIC CHANGE 2026-09-16: extracted so `tests/weekly-critique.test.js` fits under the
 * repository's 300-line rule without a `lib/validate-exceptions.json` entry, and so the
 * behaviour suite and the gating guard cannot drift into two different ideas of what
 * "the jester" looks like.
 *
 * The digest here is a FIXTURE, not a sample of real output: it is shaped like
 * `buildDigest()`'s return value so a suite can vary one field without running git.
 */

'use strict';

const NOW = new Date('2026-09-18T18:00:00Z');

/** The jester as the registry declares him, plus a resolved channel. */
const JESTER = {
    id: 'jester',
    name: 'The Jester',
    status: 'active',
    channel: 'C0JESTER',
    channel_name: 'jester-agent',
    llm_provider: 'gemini',
    max_turns: 10,
    system_prompt: 'You are The Jester, the sharp-tongued contrarian of JT Pets.',
    schedule: { cron: '0 18 * * 5', task: 'weekly-critique' },
};

/** The bridge, i.e. whatever agent's channel an on-demand command was typed in. */
const BRIDGE = { id: 'bridge', channel: 'C0BRIDGE', llm_provider: 'claude', schedule: null };

function digestFixture(overrides = {}) {
    return {
        generatedAt: NOW.toISOString(),
        windowDays: 7,
        windowSince: new Date(NOW.getTime() - 7 * 86400000).toISOString(),
        backlog: { available: true, reason: null, open: 48, tiers: { P1: 8, P2: 32, P3: 8, untiered: 0 }, undated: 17, stale: [], staleThresholdDays: 3, overThreshold: 0, revisions: 30 },
        history: { available: true, reason: null, commits: 12, closes: [], addresses: [], repeatedlyAddressed: [], merged: [] },
        tasks: { available: true, reason: null, retentionHours: 24, rows: 0, counts: { completed: 0, failed: 0, interrupted: 0 }, failures: [], reattempted: [], slow: [], medianMinutes: null, outlierRule: 'x' },
        bulletins: { available: true, reason: null, items: [] },
        orphans: { available: true, reason: null, items: [] },
        deploy: { runningCommit: null, reason: 'nothing records which commit the running process loaded — WORK-TODO #17.' },
        thin: false,
        ...overrides,
    };
}

/** A Slack double that records posts. */
function slackDouble(behaviour = {}) {
    const posts = [];
    return {
        posts,
        chat: {
            postMessage: async (args) => {
                if (behaviour.fail) throw new Error(behaviour.fail);
                posts.push(args);
                return { ok: true };
            },
        },
    };
}

/** An llm-runner double that records calls. */
function llmDouble(behaviour = {}) {
    const calls = [];
    return {
        calls,
        runLLM: async (prompt, options) => {
            calls.push({ prompt, options });
            if (behaviour.throw) throw new Error(behaviour.throw);
            return { output: behaviour.output !== undefined ? behaviour.output : 'A roast, computed.', model: 'gemini-2.5-flash' };
        },
    };
}

function notifierDouble() {
    const ops = [];
    return { ops, notifyOps: async (text) => { ops.push(text); return true; } };
}

module.exports = { NOW, JESTER, BRIDGE, digestFixture, slackDouble, llmDouble, notifierDouble };
