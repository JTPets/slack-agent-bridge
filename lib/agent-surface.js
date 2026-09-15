'use strict';

/**
 * lib/agent-surface.js
 *
 * THE enumerator for the declared-agent surface: for every agent in
 * `agents/agents.json`, what channel it has, whether the bridge joins that channel,
 * whether the bridge polls it, whether a scheduled job is registered, which provider
 * it resolves to, and — the question the others exist to answer — whether anything
 * it produces has a reader.
 *
 * LOGIC CHANGE 2026-09-15: New file. It replaces a figure with a command. "Eleven
 * agents, five channels, four jobs" was true when someone counted; nothing failed
 * when it stopped being true. `scripts/agent-surface.js` prints this, and
 * `tests/agent-surface.test.js` fails when the registry grows an agent whose output
 * reaches nobody.
 *
 * PURE. It reads the registry and the environment and computes; it opens no socket,
 * posts nothing, and joins nothing. Every function here is safe to call from a test.
 */

const { loadAgents } = require('./agent-registry');
const { getTaskTemplate, getDeterministicTask } = require('./agent-task-catalogue');
const { resolveAgentLlm } = require('./agent-llm-resolver');

/**
 * Why an agent's output does or does not reach anything. These are the only values
 * `reader` takes, so a caller can switch on them rather than parsing prose.
 */
const READER = {
    // A scheduled LLM task posts a TASK: message; poll() executes it. Both halves present.
    POLLED: 'polled',
    // The channel exists and the bot joins it, but nothing polls it: a TASK: message
    // posted there is never executed. A human in the channel still sees the text.
    HUMAN_ONLY: 'human-only',
    // Deterministic handler: it posts its own summary and escalates its own failures.
    // It needs no poll loop, only a channel the bot is in.
    DETERMINISTIC: 'deterministic',
    // No channel at all. Nothing this agent produces can go anywhere.
    NONE: 'none',
};

/**
 * Would `startScheduler` register a job for this agent?
 *
 * Mirrors the conditions in `lib/agent-scheduler.js` startScheduler exactly:
 * a schedule, a channel, a task name, and a task name that resolves to either a
 * deterministic handler or a template. It deliberately does NOT check
 * `status: "planned"` — because the scheduler does not either (WORK-TODO #3), and
 * this enumerator reports what happens, not what should.
 *
 * @param {object} agent - Registry record.
 * @returns {{ registered: boolean, task: string|null, cron: string|null, kind: string|null, reason: string|null }}
 */
function describeSchedule(agent) {
    const schedule = agent && agent.schedule;
    if (!schedule) return { registered: false, task: null, cron: null, kind: null, reason: 'no schedule declared' };

    const task = schedule.task || null;
    const cron = schedule.cron || null;
    if (!agent.channel) {
        return { registered: false, task, cron, kind: null, reason: 'schedule declared but agent has no channel' };
    }
    if (!task) {
        return { registered: false, task, cron, kind: null, reason: 'schedule declared with no task name' };
    }
    if (getDeterministicTask(task)) {
        return { registered: true, task, cron, kind: 'deterministic', reason: null };
    }
    if (getTaskTemplate(task)) {
        return { registered: true, task, cron, kind: 'template', reason: null };
    }
    return { registered: false, task, cron, kind: null, reason: `task "${task}" has no handler and no template` };
}

/**
 * The channels the bridge POLLS, as `buildChannelsToPoll()` computes them.
 *
 * Duplicated conditions are the point of this function: the live one lives inside
 * bridge-agent.js at module scope and cannot be called from a test without loading
 * the whole bridge. Keeping the rule here, pure, is what lets the guard test assert
 * the consequence. `tests/agent-surface.test.js` pins the two in agreement.
 *
 * @param {object[]} agents - Registry records.
 * @param {string} bridgeChannel - config.BRIDGE_CHANNEL.
 * @returns {Set<string>} Channel ids the poll loop reads.
 */
function pollableChannels(agents, bridgeChannel) {
    const polled = new Set();
    if (bridgeChannel) polled.add(bridgeChannel);
    for (const agent of agents) {
        if (agent.id === 'bridge' || !agent.channel) continue;
        if (agent.status === 'planned') continue;      // getActiveAgents()
        if (agent.channel === bridgeChannel) continue;
        polled.add(agent.channel);
    }
    return polled;
}

/**
 * The channels the bridge JOINS at startup.
 *
 * LOGIC CHANGE 2026-09-15: this is now every channel any declared agent names, not
 * only the polled ones. Before, `joinAgentChannels(channelsToPoll)` meant a planned
 * agent with a real channel was never joined — which is exactly story-bot, whose
 * weekly job posted into a channel the bot was not a member of and got
 * `not_in_channel` every Friday. Joining a channel that already exists is safe and
 * reversible; creating one is not, and this does not create any.
 *
 * @param {object[]} agents - Registry records.
 * @param {string} bridgeChannel - config.BRIDGE_CHANNEL.
 * @returns {Array<{ channelId: string, agentId: string }>} Deduplicated by channelId.
 */
function joinableChannels(agents, bridgeChannel) {
    const seen = new Map();
    if (bridgeChannel) seen.set(bridgeChannel, { channelId: bridgeChannel, agentId: 'bridge' });
    for (const agent of agents) {
        if (!agent.channel || seen.has(agent.channel)) continue;
        seen.set(agent.channel, { channelId: agent.channel, agentId: agent.id });
    }
    return Array.from(seen.values());
}

/**
 * Build the full surface row for every declared agent.
 *
 * @param {object} [options]
 * @param {object[]} [options.agents] - Registry records; defaults to loadAgents().
 * @param {string} [options.bridgeChannel] - Defaults to process.env.BRIDGE_CHANNEL_ID.
 * @param {object} [options.env] - Environment to resolve providers against.
 * @returns {object[]} One row per declared agent, in registry order.
 */
function buildSurface(options = {}) {
    const agents = options.agents || loadAgents();
    const env = options.env || process.env;
    const bridgeChannel = options.bridgeChannel !== undefined
        ? options.bridgeChannel
        : env.BRIDGE_CHANNEL_ID || '';

    const polled = pollableChannels(agents, bridgeChannel);
    const joined = new Set(joinableChannels(agents, bridgeChannel).map(c => c.channelId));

    return agents.map(agent => {
        const schedule = describeSchedule(agent);
        const llm = resolveAgentLlm(agent, { env });

        let reader;
        if (!agent.channel) {
            reader = READER.NONE;
        } else if (schedule.kind === 'deterministic') {
            reader = READER.DETERMINISTIC;
        } else if (polled.has(agent.channel)) {
            reader = READER.POLLED;
        } else {
            reader = READER.HUMAN_ONLY;
        }

        // An agent whose channel the bot never joins cannot post there at all, so
        // the reader question is moot — record it separately rather than folding it
        // into `reader`, because the two have different fixes (invite the bot vs.
        // poll the channel).
        const canPost = Boolean(agent.channel) && joined.has(agent.channel);

        return {
            id: agent.id,
            name: agent.name || agent.id,
            status: agent.status || 'active',
            channel: agent.channel || null,
            joined: canPost,
            polled: Boolean(agent.channel) && polled.has(agent.channel),
            scheduled: schedule.registered,
            schedule_task: schedule.task,
            schedule_cron: schedule.cron,
            schedule_kind: schedule.kind,
            schedule_reason: schedule.reason,
            provider: llm.provider,
            provider_source: llm.provider_source,
            model: llm.model,
            model_source: llm.model_source,
            reader,
        };
    });
}

/**
 * Rows whose output reaches nothing: a registered scheduled job that posts a TASK:
 * message into a channel nothing polls, or an agent that can be addressed by no
 * channel at all while carrying a schedule.
 *
 * This is the list the guard test asserts against. It is not "every row with a
 * problem" — an agent with no channel and no schedule is idle by design, not broken.
 *
 * @param {object[]} rows - From buildSurface().
 * @returns {Array<{ id: string, problem: string }>}
 */
function findOrphans(rows) {
    const orphans = [];
    for (const row of rows) {
        if (row.schedule_task && !row.scheduled) {
            orphans.push({ id: row.id, problem: `schedule declared but not registered — ${row.schedule_reason}` });
            continue;
        }
        if (row.scheduled && row.schedule_kind === 'template' && row.reader !== READER.POLLED) {
            orphans.push({ id: row.id, problem: `scheduled job posts a TASK: message to ${row.channel}, which the poll loop does not read` });
            continue;
        }
        if (row.scheduled && !row.joined) {
            orphans.push({ id: row.id, problem: `scheduled job posts to ${row.channel}, which the bot never joins` });
        }
    }
    return orphans;
}

/**
 * Render the surface as a fixed-width table for a terminal or a Slack code block.
 *
 * @param {object[]} rows - From buildSurface().
 * @returns {string[]} Lines.
 */
function formatSurface(rows) {
    const head = ['AGENT', 'STATUS', 'CHANNEL', 'JOIN', 'POLL', 'JOB', 'PROVIDER', 'READER'];
    const body = rows.map(r => [
        r.id,
        r.status,
        r.channel || '—',
        r.joined ? 'yes' : 'no',
        r.polled ? 'yes' : 'no',
        r.scheduled ? `${r.schedule_task}` : (r.schedule_task ? 'REFUSED' : '—'),
        `${r.provider} (${r.provider_source})`,
        r.reader,
    ]);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(row => String(row[i]).length)));
    const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
    return [line(head), line(widths.map(w => '-'.repeat(w))), ...body.map(line)];
}

module.exports = {
    READER,
    describeSchedule,
    pollableChannels,
    joinableChannels,
    buildSurface,
    findOrphans,
    formatSurface,
};
