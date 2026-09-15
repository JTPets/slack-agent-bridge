'use strict';

/**
 * lib/agent-create.js
 *
 * `create` — a new agent DEFINITION from a template, given an identity, a channel
 * name, a provider and a target repository.
 *
 * LOGIC CHANGE 2026-09-15: New file. `available`/`activate`/`deactivate`
 * (lib/agent-activation.js) could turn an existing definition on and off; nothing
 * could make one. It is a separate module because lib/agent-activation.js is at the
 * 300-line limit and because the two have genuinely different durability: activation
 * writes GITIGNORED workspace state and survives a pull, creation writes a TRACKED
 * file and does not. Putting them in one module would invite one durability sentence
 * covering both, and it would be wrong about one of them.
 *
 * IT DOES NOT CREATE A SLACK CHANNEL, and it does not resolve one either. Creating a
 * channel has a cost outside this repository; resolving one is `activate`'s job, and
 * doing it here would mean a definition arriving already half-activated. The new
 * definition is written with `default_status: planned`, so the sequence is:
 *
 *     create  ->  (a human creates the channel, if it does not exist)  ->  activate
 *
 * THE DURABILITY, STATED PLAINLY BECAUSE IT IS BAD: a created definition is
 * `agents/<id>/agent.md`, which is TRACKED. `auto-update.js` runs
 * `git reset --hard HEAD` before every pull, so the first pull after a create
 * DESTROYS IT unless it has been committed. That is not a flaw in this command — it
 * is the standing problem every configuration-writing command in this repository has
 * (WORK-TODO #51), and this command's answer to it is the honest one: it returns the
 * file it wrote and says, in the verdict itself, that the file must be committed or
 * it will be discarded. It does not commit, because a command that can write to
 * `main` from an `ASK:` message is a much larger blast radius than anything here has.
 */

const fs = require('fs');
const path = require('path');

const { serializeAgent, loadDefinitions, SLACK_ID_PATTERN } = require('./agent-markdown');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

/** Agent ids are directory names and command arguments: keep them boring. */
const ID_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Channel names follow Slack's own rule, which lib/slack-client.js also enforces. */
const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,78}[a-z0-9]$/;

/** `owner/name`, the same shape lib/git-identifiers.js accepts for REPO:. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,37}[A-Za-z0-9]\/[A-Za-z0-9._-]{1,100}$/;

/** Providers lib/llm-runner.js actually has an adapter for. */
const PROVIDERS = ['claude', 'gemini', 'ollama'];

/**
 * The template a new definition is built from.
 *
 * Deliberately minimal: identity, the four fields the command takes, and the
 * conservative permission posture. It carries NO schedule and NO watches — both make
 * an agent act on its own, and an agent that acts before anyone has read its
 * definition is how `story-bot` spent months posting into a channel nothing read
 * (WORK-TODO #3). Add them by editing the file, which is a reviewable diff.
 *
 * @param {object} fields - { id, name, channel_name, llm_provider, target_repo, order }
 * @returns {object} A definition record ready for serializeAgent().
 */
function buildDefinition(fields) {
    return {
        id: fields.id,
        name: fields.name,
        order: fields.order,
        default_status: 'planned',
        channel_name: fields.channel_name,
        permissions: [],
        denied: ['github-write', 'file-system-write', 'payment-processing'],
        priority: 3,
        max_turns: 20,
        memory_dir: `agents/${fields.id}/memory`,
        ...(fields.target_repo ? { target_repo: fields.target_repo } : {}),
        llm_provider: fields.llm_provider,
        schedule: null,
        watches: null,
        role: `TODO — what ${fields.name} is for. Written by \`create\` on ${new Date().toISOString().slice(0, 10)}; edit this before activating.`,
        personality: 'TODO — how this agent talks. One or two sentences.',
        system_prompt: `You are ${fields.name} for JT Pets. TODO — replace this with the agent's actual instructions before activating it.` +
            (fields.target_repo
                ? ` When you work in ${fields.target_repo}, that repository's own CLAUDE.md governs; do not restate its rules here.`
                : ''),
    };
}

/**
 * Validate every field. REJECTS, never sanitises — the same rule `REPO:`/`BRANCH:`
 * follow (CLAUDE.md -> Field Value Rules): quietly turning `my agent` into `my-agent`
 * creates a different agent than the one that was asked for, with nobody told.
 *
 * @param {object} fields
 * @param {object[]} [existing] - Current definitions, for the collision checks.
 * @returns {string[]} Reasons; empty means valid.
 */
function validateFields(fields, existing = []) {
    const errors = [];

    if (!fields.id) errors.push('`id` is required.');
    else if (!ID_PATTERN.test(fields.id)) {
        errors.push(`\`id\` must be 3-40 lowercase letters, digits and hyphens, starting with a letter and ending alphanumeric — got \`${fields.id}\`.`);
    } else if (existing.some(a => a.id === fields.id)) {
        errors.push(`\`${fields.id}\` is already defined. Edit \`agents/${fields.id}/agent.md\`, or pick another id.`);
    }

    if (!fields.name) errors.push('`name` is required.');

    if (!fields.channel_name) errors.push('`channel` is required — an agent with no channel reaches nobody.');
    else if (SLACK_ID_PATTERN.test(fields.channel_name)) {
        errors.push(`\`channel\` must be a NAME, not a Slack id — got \`${fields.channel_name}\`. A tracked definition may not carry a workspace id (lib/agent-markdown.js refuses one).`);
    } else if (!CHANNEL_NAME_PATTERN.test(String(fields.channel_name).replace(/^#/, ''))) {
        errors.push(`\`channel\` must be a Slack channel name: lowercase letters, digits, hyphens, underscores and dots — got \`${fields.channel_name}\`.`);
    }

    if (!fields.llm_provider) errors.push(`\`provider\` is required — one of ${PROVIDERS.join(', ')}.`);
    else if (!PROVIDERS.includes(fields.llm_provider)) {
        errors.push(`\`provider\` must be one of ${PROVIDERS.join(', ')} — got \`${fields.llm_provider}\`. An unknown provider is a configuration defect, not a fallback (CLAUDE.md).`);
    }

    if (fields.target_repo && !REPO_PATTERN.test(fields.target_repo)) {
        errors.push(`\`repo\` must be \`owner/name\` — got \`${fields.target_repo}\`.`);
    }

    return errors;
}

/**
 * Write a new definition. Refuses, writing nothing, on any validation failure.
 *
 * @param {object} fields - { id, name, channel_name, llm_provider, target_repo }
 * @param {object} [options]
 * @param {string} [options.dir] - Agents directory (tests).
 * @param {object[]} [options.existing] - Definitions to collide against (tests).
 * @returns {{ ok: boolean, file: string|null, definition: object|null, errors: string[] }}
 */
function createAgentDefinition(fields, options = {}) {
    const dir = options.dir || AGENTS_DIR;
    const existing = options.existing || loadDefinitions({ dir });

    const errors = validateFields(fields, existing);
    if (errors.length) return { ok: false, file: null, definition: null, errors };

    const order = 1 + existing.reduce((max, a) => (Number.isFinite(a.order) ? Math.max(max, a.order) : max), 0);
    const definition = buildDefinition({ ...fields, channel_name: String(fields.channel_name).replace(/^#/, ''), order });
    const agentDir = path.join(dir, definition.id);
    const file = path.join(agentDir, 'agent.md');

    if (fs.existsSync(file)) {
        return { ok: false, file: null, definition: null, errors: [`${path.relative(path.join(dir, '..'), file)} already exists. Nothing was written.`] };
    }

    fs.mkdirSync(path.join(agentDir, 'memory'), { recursive: true });
    fs.writeFileSync(file, serializeAgent(definition), 'utf8');
    return { ok: true, file, definition, errors: [] };
}

/**
 * Parse `create <id> channel=<name> provider=<p> [repo=<owner/name>] [name=<Display Name>]`.
 *
 * Positional id, then `key=value` pairs. A bare positional after the id is an error
 * rather than a guess — this command writes a file, so guessing which field an
 * unlabelled value belongs to is exactly the wrong trade.
 *
 * @param {string} args
 * @returns {{ fields: object, errors: string[] }}
 */
function parseCreateArgs(args) {
    const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
    const errors = [];
    const fields = {};

    if (!tokens.length) return { fields, errors: ['no arguments'] };
    fields.id = tokens.shift().replace(/^[`#]|[`]$/g, '');

    const KEYS = { channel: 'channel_name', provider: 'llm_provider', repo: 'target_repo', name: 'name' };
    let pending = null;
    for (const token of tokens) {
        const eq = token.indexOf('=');
        if (eq > 0) {
            const key = token.slice(0, eq).toLowerCase();
            if (!Object.prototype.hasOwnProperty.call(KEYS, key)) {
                errors.push(`unknown field \`${key}\` — expected one of ${Object.keys(KEYS).join(', ')}`);
                pending = null;
                continue;
            }
            pending = KEYS[key];
            fields[pending] = token.slice(eq + 1).replace(/^[`"']|[`"']$/g, '');
        } else if (pending === 'name') {
            // A display name is the one field that may contain spaces.
            fields.name = `${fields.name} ${token}`.trim();
        } else {
            errors.push(`\`${token}\` is not a \`key=value\` pair. Every field must be labelled.`);
        }
    }
    if (!fields.name && fields.id) {
        fields.name = fields.id.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }
    return { fields, errors };
}

/**
 * `create` — the command handler. Never posts; returns { ok, text }.
 *
 * @param {object} ctx - { args }
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function handleCreate(ctx = {}) {
    const usage = '`create <id> channel=<name> provider=<claude|gemini|ollama> [repo=<owner/name>] [name=<Display Name>]`';
    const { fields, errors: parseErrors } = parseCreateArgs(ctx.args);
    if (parseErrors.includes('no arguments')) {
        return { ok: false, text: `:x: Usage: ${usage}\nIt writes a DEFINITION. It does not create a Slack channel and does not activate anything.` };
    }

    const result = createAgentDefinition(fields);
    const errors = [...parseErrors, ...result.errors];
    if (!result.ok || parseErrors.length) {
        if (result.ok) {
            // Parse errors alongside a successful write would mean a field was
            // silently dropped. Refuse rather than leave a half-specified file.
            fs.rmSync(path.dirname(result.file), { recursive: true, force: true });
        }
        return { ok: false, text: `:x: Did not create an agent. Nothing was written.\n• ${errors.join('\n• ')}\nUsage: ${usage}` };
    }

    const rel = `agents/${result.definition.id}/agent.md`;
    return {
        ok: true,
        text: [
            `:new: Wrote \`${rel}\` — \`${result.definition.id}\` (${result.definition.name}), ` +
            `channel \`#${result.definition.channel_name}\`, provider \`${result.definition.llm_provider}\`` +
            (result.definition.target_repo ? `, repo \`${result.definition.target_repo}\`` : '') + '.',
            '',
            ':warning: *This file is TRACKED, and the next pull destroys it unless it is committed.* ' +
            "auto-update runs `git reset --hard HEAD` before every pull, so an uncommitted definition is gone. " +
            'Commit and push it, or treat it as a draft. This is WORK-TODO #51 and it is not solved here.',
            '',
            `It is \`default_status: planned\` with no schedule and no watches: nothing polls it, nothing is joined, ` +
            `nothing fires. Fill in the three TODO sections, make sure \`#${result.definition.channel_name}\` exists ` +
            `(nothing here creates a channel), then \`ASK: activate ${result.definition.id}\`.`,
            result.definition.target_repo
                ? `Repository-level rules live in \`${result.definition.target_repo}\`'s own CLAUDE.md and are read from the clone. Do not copy them into the system prompt — that is how the two drift.`
                : '',
        ].filter(Boolean).join('\n'),
    };
}

module.exports = {
    buildDefinition,
    validateFields,
    createAgentDefinition,
    parseCreateArgs,
    handleCreate,
    ID_PATTERN,
    CHANNEL_NAME_PATTERN,
    REPO_PATTERN,
    PROVIDERS,
};
