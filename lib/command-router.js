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
 *   weather — `fetchWeather()` moved out of `morning-digest.js` into
 *     `lib/integrations/weather.js` on 2026-10-05 (WORK-TODO #10), so a verb is now
 *     buildable. It is not registered yet: that is a new feature, not part of a split.
 *
 *   morning-briefing / nightly-audit / draft-weekly-posts / content-calendar /
 *   weekly-analytics — these are TASK_TEMPLATES, not deterministic handlers. They are
 *     LLM prompts, so invoking one is a dispatch, and a dispatch already has a command
 *     (`/dispatch`). Registering them here would put a verb and an addressee in one
 *     namespace, which is exactly what #45 forbids.
 *     (`weekly-critique` was in this list until 2026-09-16. It is no longer a template:
 *     it became a deterministic handler that computes its own material, so it is a verb
 *     now — `critique`. The reasoning above did not change; the task did.)
 *
 * Handlers NEVER post. They return `{ ok, text }` and the caller posts, so every
 * handler is callable from a test with no Slack client.
 */

const { getDeterministicTask, DETERMINISTIC_TASKS } = require('./agent-task-catalogue');
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the read-only report handlers moved to
// lib/command-renderers.js. The table below still registers every verb.
const {
    handleStatus, handleAgents, handleHolidays, handleChannels, renderHelp,
} = require('./command-renderers');

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
    // LOGIC CHANGE 2026-10-05 (WORK-TODO #10): the rendering moved to
    // lib/command-renderers.js renderHelp; it is still given this table and nothing else.
    return renderHelp(COMMANDS);
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
    // LOGIC CHANGE 2026-09-16: no channel check for a handler that resolves its OWN
    // destination (the critique posts into the jester's channel); check-inbox posts
    // into the agent it is handed, so it needs one.
    if (!entry.resolvesOwnChannel && (!ctx.agent || !ctx.agent.channel)) {
        return { ok: false, text: `:x: \`${ctx.verb}\` needs an agent with a channel to report into.` };
    }
    try {
        // LOGIC CHANGE 2026-10-02: `onDemand: true` - a person asked, so a handler
        // that is quiet on its cron tick (check-inbox) reports anyway.
        const verdict = await task.run({ slack: ctx.slack, agent: ctx.agent, onDemand: true });
        const ok = verdict?.ok !== false;
        // LOGIC CHANGE 2026-09-16: report the channel the HANDLER posted into, falling
        // back to the caller's agent. Naming ctx.agent.channel unconditionally would
        // send the operator to the wrong channel for a handler that posts elsewhere.
        const reported = verdict?.channel || (ctx.agent && ctx.agent.channel);
        return {
            ok,
            text: ok
                ? `:white_check_mark: Ran \`${ctx.verb}\` (${entry.task})${reported ? ` — it reports into <#${reported}>.` : '.'}`
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
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #9): the last n finished tasks, from the task
    // memory rather than the 24-hour queue. Spelled `history`, not `task history`: a
    // verb is the first word, and `task` would capture `ASK: task status`.
    history: {
        summary: 'The last n finished tasks (default 10, max 50) with when and how each ended',
        kind: 'report',
        handler: (ctx) => require('./task-history').handleHistory(ctx),
    },
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #52): channels the bot is in vs channels an
    // agent or a *_CHANNEL_ID declares, both directions. One read-only Slack call.
    channels: {
        summary: 'Channels the bot is in vs channels agents declare, both directions',
        kind: 'report',
        handler: handleChannels,
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
    // LOGIC CHANGE 2026-09-15: `create` makes a definition. Separate from
    // lib/agent-activation.js because it writes a TRACKED file the next pull discards,
    // not gitignored workspace state. It creates NO Slack channel and activates
    // nothing: the new definition is `planned`, with no schedule and no watches.
    create: {
        summary: 'Write a new agent definition from a template (no Slack channel, not activated)',
        kind: 'mutate',
        handler: (ctx) => require('./agent-create').handleCreate(ctx),
    },
    'check-inbox': {
        summary: 'Run the deterministic inbox check now (same operation as the cron job)',
        kind: 'scheduled',
        task: 'check-inbox',
        handler: handleScheduledTask,
    },
    // LOGIC CHANGE 2026-09-16: `critique` — the jester's weekly post, on demand. Not
    // a second route: the cron tick and this verb reach the same catalogue run(), so
    // they cannot diverge. It stopped being a TASK_TEMPLATES entry (a dispatch) when it
    // became deterministic; tests/command-router.test.js fails on a deterministic task
    // that is neither a verb here nor a NOT_COMMANDS entry.
    critique: {
        summary: "Run the jester's weekly critique now (same operation as the cron job)",
        kind: 'scheduled',
        task: 'weekly-critique',
        // It resolves the agent whose schedule declares this task, so the channel the
        // verb was typed in decides nothing about where the critique lands.
        resolvesOwnChannel: true,
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
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #64, the safe half): is this body a verb typed
 * on its own? bridge-agent.js uses it to REFUSE such a body in an agent channel instead
 * of letting a model answer it as conversation. Deliberately narrow: the verb alone, or
 * the verb and ONE argument that is a number or a known agent id (`history 20`,
 * `status secretary`). "create a post about the sale" and "help me" start with a verb
 * and are requests to the agent, so they are left to the agent.
 * @param {string} text
 * @param {string[]} [agentIds] - Ids that count as a verb argument.
 * @returns {boolean}
 */
function isBareCommand(text, agentIds = []) {
    const { verb, args } = parseCommand(text);
    if (!verb) return false;
    const arg = args.trim();
    return arg === '' || /^\d+$/.test(arg) || agentIds.includes(arg);
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
    isBareCommand,
    runCommand,
    listVerbs,
};
