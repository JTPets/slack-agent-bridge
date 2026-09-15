'use strict';

/**
 * lib/command-router.js
 *
 * THE table mapping a VERB to a handler. A command is an operation with known
 * parameters; it may or may not involve a model. A deterministic operation — the
 * inbox check is the live example — needs no model, no turn budget and no clone, so
 * calling it is a function call, not a dispatch.
 *
 * LOGIC CHANGE 2026-09-15: New file. WORK-TODO #45 records the rule this enforces:
 * **a command is a verb; an agent is addressed by its channel or a mention, never by
 * a command name.** A namespace holding both gives two similar-looking commands
 * completely different paths — one needs a persona, a provider and a turn budget,
 * the other needs none of them — and it cannot be documented or guarded as one thing.
 *
 * WHY THIS IS NOT A SECOND REGISTRY. `lib/agent-task-catalogue.js` already declares
 * what deterministic operations exist (`DETERMINISTIC_TASKS`), because a scheduled
 * job and an on-demand command are the same operation triggered differently. This
 * module does NOT redeclare them: a verb whose `kind` is `scheduled` carries the
 * catalogue's task name and delegates to `getDeterministicTask(name).run()`. The
 * catalogue stays the source of truth for the operation; the table below adds only
 * the verb spelling and who may run it. `tests/command-router.test.js` fails if a
 * catalogue entry is neither registered here nor explicitly declared not-a-command.
 *
 * WHAT IS DELIBERATELY NOT REGISTERED, and why — reported rather than assumed:
 *
 *   weather — `fetchWeather()` exists and works, but it is a private function inside
 *     `morning-digest.js`, which has NO `module.exports` at all
 *     (`grep -c 'module.exports' morning-digest.js` -> 0). Nothing outside that file
 *     can call it. Registering a `weather` verb therefore means extracting it into
 *     `lib/integrations/` first, which edits a live cron script, so it is not bundled
 *     into the change that built this table. It is the obvious next verb.
 *
 *   morning-briefing / nightly-audit / weekly-critique / draft-weekly-posts /
 *   content-calendar / weekly-analytics — these are TASK_TEMPLATES, not deterministic
 *     handlers. They are LLM prompts, so invoking one is a dispatch, and a dispatch
 *     already has a command (`/dispatch`). Registering them here would put a verb
 *     and an addressee in one namespace, which is exactly what #45 forbids.
 *
 * Handlers NEVER post. They return `{ ok, text }` and the caller posts, so every
 * handler is callable from a test with no Slack client.
 */

const { getDeterministicTask, DETERMINISTIC_TASKS } = require('./agent-task-catalogue');
const { buildSurface, formatSurface, findOrphans } = require('./agent-surface');
const { resolveAgentLlm, formatResolution } = require('./agent-llm-resolver');
const { loadAgents } = require('./agent-registry');

/**
 * Catalogue entries deliberately NOT exposed as commands, each with a reason.
 * An entry here is a decision; an entry in neither this nor COMMANDS is a gap, and
 * the guard test treats it as one.
 */
const NOT_COMMANDS = {
    // (none today — check-inbox is registered below)
};

/**
 * Render the whole table as help text. Built FROM the table, not written beside it:
 * a hand-maintained list drifts the first time someone adds a command.
 *
 * @returns {{ ok: boolean, text: string }}
 */
async function handleHelp() {
    const rows = Object.keys(COMMANDS).sort().map(verb => ({
        verb,
        summary: COMMANDS[verb].summary,
        kind: COMMANDS[verb].kind,
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
 * Run a deterministic operation the task catalogue already declares.
 *
 * The handler posts nothing itself — the catalogue's `run` is responsible for its own
 * output and its own failure escalation, exactly as it is on a cron tick, so a verb
 * and its schedule cannot diverge. This returns the verdict, not the content.
 *
 * @param {object} ctx - { verb, slack, agent }
 * @returns {{ ok: boolean, text: string }}
 */
async function handleScheduledTask(ctx = {}) {
    const entry = COMMANDS[ctx.verb];
    const task = getDeterministicTask(entry.task);
    if (!task) {
        // Unreachable while the guard test is green; a loud failure beats a silent one.
        return { ok: false, text: `:x: \`${ctx.verb}\` maps to task \`${entry.task}\`, which the catalogue does not declare.` };
    }
    if (!ctx.agent || !ctx.agent.channel) {
        return { ok: false, text: `:x: \`${ctx.verb}\` needs an agent with a channel to report into.` };
    }
    try {
        const verdict = await task.run({ slack: ctx.slack, agent: ctx.agent });
        const ok = verdict?.ok !== false;
        return {
            ok,
            text: ok
                ? `:white_check_mark: Ran \`${ctx.verb}\` (${entry.task}) — it reports into <#${ctx.agent.channel}>.`
                : `:x: \`${ctx.verb}\` reported failure: ${verdict?.error || verdict?.status || 'no reason given'}`,
        };
    } catch (err) {
        return { ok: false, text: `:x: \`${ctx.verb}\` threw: ${err.message}` };
    }
}

/**
 * THE TABLE. Verb -> handler. Everything else in this module exists to serve it.
 *
 * `kind`:
 *   'report'    — read-only; touches nothing, calls no model.
 *   'scheduled' — the same operation the cron registrar runs, named by `task` in
 *                 lib/agent-task-catalogue.js. Not redeclared here.
 *   'mutate'    — changes workspace state. The only kind that writes anything.
 */
const COMMANDS = {
    help: {
        summary: 'List every command in this table',
        kind: 'report',
        handler: handleHelp,
    },
    status: {
        summary: 'Per-agent provider, model and adapter inputs, each with its source',
        kind: 'report',
        handler: handleStatus,
    },
    agents: {
        summary: 'The agent surface: channel, join, poll, job, provider, reader',
        kind: 'report',
        handler: handleAgents,
    },
    holidays: {
        summary: "Today's statutory holiday and pet awareness dates",
        kind: 'report',
        handler: handleHolidays,
    },
    // LOGIC CHANGE 2026-09-15: the activation verbs. Handlers live in
    // lib/agent-activation.js — this table registers verbs, it does not implement
    // them — and are required lazily so the router still loads in a test that wants
    // no registry. `available` lists what the markdown DEFINES; `activate` turns one
    // on and NEVER creates a Slack channel.
    available: {
        summary: 'List defined agents this workspace has not activated, and what each is waiting on',
        kind: 'report',
        handler: (ctx) => require('./agent-activation').handleAvailable(ctx),
    },
    activate: {
        summary: 'Activate a defined agent: resolve its channel, join, poll and schedule it',
        kind: 'mutate',
        handler: (ctx) => require('./agent-activation').handleActivate(ctx),
    },
    deactivate: {
        summary: 'Stop polling and scheduling an agent, keeping its resolved channel',
        kind: 'mutate',
        handler: (ctx) => require('./agent-activation').handleDeactivate(ctx),
    },
    'check-inbox': {
        summary: 'Run the deterministic inbox check now (same operation as the cron job)',
        kind: 'scheduled',
        task: 'check-inbox',
        handler: handleScheduledTask,
    },
};

/**
 * Split an ASK body into a verb and the rest.
 *
 * Case-insensitive on the verb only, and anchored at the start: a verb is the FIRST
 * word or nothing. This deliberately does not search the body — the same misparse
 * `lib/task-parser.js` was fixed for, where an unanchored match found a label inside
 * prose, applies here.
 *
 * @param {string} text
 * @returns {{ verb: string|null, args: string }}
 */
function parseCommand(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return { verb: null, args: '' };
    const [first, ...rest] = trimmed.split(/\s+/);
    const verb = first.toLowerCase();
    return Object.prototype.hasOwnProperty.call(COMMANDS, verb)
        ? { verb, args: rest.join(' ') }
        : { verb: null, args: '' };
}

/**
 * Is this ASK body a registered command?
 * @param {string} text
 * @returns {boolean}
 */
function isCommand(text) {
    return parseCommand(text).verb !== null;
}

/**
 * Run a command. Returns a verdict; it never throws and never posts.
 *
 * @param {string} text - The ASK body.
 * @param {object} [ctx] - { slack, agent, channelId, userId }
 * @returns {Promise<{ handled: boolean, ok?: boolean, text?: string, verb?: string }>}
 */
async function runCommand(text, ctx = {}) {
    const { verb, args } = parseCommand(text);
    if (!verb) return { handled: false };
    try {
        const result = await COMMANDS[verb].handler({ ...ctx, verb, args });
        return { handled: true, verb, ok: result.ok, text: result.text };
    } catch (err) {
        // A handler that throws is a defect, not a user error — say so rather than
        // falling through to the LLM, which would answer a question about the system
        // by guessing.
        return { handled: true, verb, ok: false, text: `:x: \`${verb}\` failed: ${err.message}` };
    }
}

/**
 * Every verb in the table. Used by the guard test and by help.
 * @returns {string[]}
 */
function listVerbs() {
    return Object.keys(COMMANDS).sort();
}

module.exports = {
    COMMANDS,
    NOT_COMMANDS,
    DETERMINISTIC_TASKS,
    parseCommand,
    isCommand,
    runCommand,
    listVerbs,
};
