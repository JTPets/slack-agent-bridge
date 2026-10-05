'use strict';

/**
 * lib/command-renderers.js
 *
 * The read-only REPORT handlers behind the command table in lib/command-router.js:
 * `status`, `agents`, `holidays` and `channels`, plus `renderHelp`, the pure renderer
 * behind `help`. Each returns `{ ok, text }` and
 * posts nothing; the router's table is still the only place a verb is registered.
 *
 * LOGIC CHANGE 2026-10-05: Split out of lib/command-router.js (WORK-TODO #10, wave 2),
 * which was over the 300-line limit. The functions are moved unchanged. The router
 * keeps the table, help, the scheduled-task delegate (tests/weekly-critique-gating.test.js
 * requires the task name to be named only there and in the catalogue) and the parsers.
 * tests/command-router.test.js enumerates `async function handle*` across BOTH files,
 * so a renderer that is not in the table is still red.
 */

const { buildSurface, formatSurface, findOrphans } = require('./agent-surface');
const { resolveAgentLlm, formatResolution } = require('./agent-llm-resolver');
const { loadAgents } = require('./agent-registry');

/**
 * Render a command table as help text. Built FROM the table it is given, not written
 * beside it: a hand-maintained list drifts the first time someone adds a command.
 * Pure — lib/command-router.js handleHelp passes its own COMMANDS.
 *
 * @param {object} commands - verb -> { summary, kind }
 * @returns {{ ok: boolean, text: string }}
 */
function renderHelp(commands) {
    const rows = Object.keys(commands).sort().map(verb => ({
        verb,
        summary: commands[verb].summary,
        kind: commands[verb].kind,
    }));
    const width = Math.max(...rows.map(r => r.verb.length));
    const lines = [
        '*Commands* — a command is a verb. To address an *agent*, post in its channel.',
        '```',
        ...rows.map(r => `${r.verb.padEnd(width)}  ${r.summary}`),
        '```',
        `${rows.length} commands. \`scheduled\` verbs are the same operations the cron ` +
        'registrar runs; the rest are read-only reports.',
    ];
    return { ok: true, text: lines.join('\n') };
}

/**
 * Per-agent provider, model and adapter inputs WITH PROVENANCE. Read-only.
 *
 * The provenance is the point: "secretary is on gemini" does not say whether that
 * came from the registry, from a per-agent override in .env, or from the global
 * default, and those are three different files to go and change.
 *
 * @param {object} ctx
 * @param {string} [ctx.args] - Optional single agent id to narrow to.
 * @returns {{ ok: boolean, text: string }}
 */
async function handleStatus(ctx = {}) {
    const agents = loadAgents();
    if (!agents.length) return { ok: false, text: ':x: The agent registry is empty or unreadable.' };

    const wanted = (ctx.args || '').trim();
    const subset = wanted ? agents.filter(a => a.id === wanted) : agents;
    if (wanted && !subset.length) {
        return { ok: false, text: `:x: No agent \`${wanted}\`. Known: ${agents.map(a => a.id).join(', ')}` };
    }

    const blocks = subset.map(a => formatResolution(resolveAgentLlm(a)).join('\n'));
    const blocked = subset
        .map(a => resolveAgentLlm(a))
        .filter(r => !r.ready);

    const lines = ['*Agent LLM resolution* — each value with where it came from.', '```', ...blocks, '```'];
    if (blocked.length) {
        lines.push(`:warning: ${blocked.length} agent(s) cannot run as configured: ` +
            blocked.map(r => `${r.agent_id} (${r.blocked_on})`).join('; '));
    }
    return { ok: true, text: lines.join('\n') };
}

/**
 * The declared-agent surface: channel, join, poll, scheduled job, provider, reader.
 * Read-only — the same rows `node scripts/agent-surface.js` prints.
 *
 * @returns {{ ok: boolean, text: string }}
 */
async function handleAgents() {
    const rows = buildSurface();
    const lines = ['*Agent surface*', '```', ...formatSurface(rows), '```'];
    const orphans = findOrphans(rows);
    if (orphans.length) {
        lines.push(`:warning: Output that reaches nobody (${orphans.length}):`);
        for (const o of orphans) lines.push(`• \`${o.id}\` — ${o.problem}`);
    }
    return { ok: true, text: lines.join('\n') };
}

/**
 * Today's Canadian statutory holiday and pet awareness dates.
 * Deterministic: `lib/integrations/holidays.js` is a cached API read with no model.
 *
 * @returns {{ ok: boolean, text: string }}
 */
async function handleHolidays() {
    // Required lazily so the router loads in tests that do not want a network module.
    const { getTodaySpecialDates } = require('./integrations/holidays');
    let special;
    try {
        special = await getTodaySpecialDates();
    } catch (err) {
        return { ok: false, text: `:x: Could not fetch holiday data: ${err.message}` };
    }
    const lines = [];
    if (special && special.holiday) lines.push(`*Today:* ${special.holiday.name} (Ontario statutory holiday)`);
    const pet = (special && special.petAwareness) || [];
    for (const p of pet) lines.push(`*Pet awareness:* ${p.name || p}`);
    if (!lines.length) lines.push('No statutory holiday and no pet awareness date today.');
    return { ok: true, text: lines.join('\n') };
}

/**
 * WORK-TODO #52: the reconciliation report. Read-only; a Slack failure is reported as
 * a failure, never as an empty workspace.
 * @param {object} ctx - { slack }
 */
async function handleChannels(ctx = {}) {
    const rec = require('./channel-reconcile');
    if (!ctx.slack) return { ok: false, text: ':x: `channels` needs a Slack client and was given none.' };
    let memberChannels;
    try {
        memberChannels = await rec.listMemberChannels(ctx.slack);
    } catch (err) {
        return { ok: false, text: `:x: Could not list the workspace's channels: ${err.message}` };
    }
    const result = rec.reconcileChannels({ memberChannels, agents: loadAgents(), env: ctx.env || process.env });
    return { ok: true, text: rec.formatReconciliation(result) };
}

module.exports = {
    renderHelp,
    handleStatus,
    handleAgents,
    handleHolidays,
    handleChannels,
};
