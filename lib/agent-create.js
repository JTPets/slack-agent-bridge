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
 * DURABILITY. A definition is `agents/<id>/agent.md`, a TRACKED file. Until 2026-11-09
 * this command wrote it into the running checkout and said the next pull would destroy
 * it (WORK-TODO #51). Since then `create` PUSHES it as a new branch
 * (lib/definition-branch.js, the owner's shape c): it is reviewed and merged like any
 * other change, and deploys through the update gate. Nothing on the box changes until
 * then, and nothing here writes to `main`.
 */

const fs = require('fs');
const path = require('path');
// LOGIC CHANGE 2026-10-04 (WORK-TODO #33): the date written into a new definition is the
// store's day, not a UTC one.
const { dayKey, STORE_TIME_ZONE } = require('./time-format');

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
        role: `TODO — what ${fields.name} is for. Written by \`create\` on ${dayKey(new Date(), STORE_TIME_ZONE)}; edit this before activating.`,
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
 * Build a new definition's file content without writing anything. Refuses on any
 * validation failure.
 *
 * @param {object} fields - { id, name, channel_name, llm_provider, target_repo }
 * @param {object} [options] - { dir, existing } (tests)
 * @returns {{ ok: boolean, rel: string|null, content: string|null, definition: object|null, errors: string[] }}
 */
function renderAgentDefinition(fields, options = {}) {
    const existing = options.existing || loadDefinitions({ dir: options.dir || AGENTS_DIR });
    const errors = validateFields(fields, existing);
    if (errors.length) return { ok: false, rel: null, content: null, definition: null, errors };
    const order = 1 + existing.reduce((max, a) => (Number.isFinite(a.order) ? Math.max(max, a.order) : max), 0);
    const definition = buildDefinition({ ...fields, channel_name: String(fields.channel_name).replace(/^#/, ''), order });
    return { ok: true, rel: `agents/${definition.id}/agent.md`, content: serializeAgent(definition), definition, errors: [] };
}

/**
 * Write a new definition into a directory. Refuses, writing nothing, on any validation
 * failure. The `create` command no longer calls this (it pushes a branch, #51); it stays
 * for scripted use against a scratch directory.
 *
 * @param {object} fields - { id, name, channel_name, llm_provider, target_repo }
 * @param {object} [options]
 * @param {string} [options.dir] - Agents directory (tests).
 * @param {object[]} [options.existing] - Definitions to collide against (tests).
 * @returns {{ ok: boolean, file: string|null, definition: object|null, errors: string[] }}
 */
function createAgentDefinition(fields, options = {}) {
    const dir = options.dir || AGENTS_DIR;
    const rendered = renderAgentDefinition(fields, { dir, existing: options.existing });
    if (!rendered.ok) return { ok: false, file: null, definition: null, errors: rendered.errors };
    const { definition } = rendered;
    const agentDir = path.join(dir, definition.id);
    const file = path.join(agentDir, 'agent.md');

    if (fs.existsSync(file)) {
        return { ok: false, file: null, definition: null, errors: [`${path.relative(path.join(dir, '..'), file)} already exists. Nothing was written.`] };
    }

    fs.mkdirSync(path.join(agentDir, 'memory'), { recursive: true });
    fs.writeFileSync(file, rendered.content, 'utf8');
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
 * LOGIC CHANGE 2026-11-09 (WORK-TODO #51, owner's answer 2026-11-08): the definition is
 * pushed as a new branch of the bridge's repository (lib/definition-branch.js) instead of
 * being written into the running checkout, where the next update discarded it and an
 * untracked copy would block the self-deploy's fast-forward. The owner merges it.
 *
 * @param {object} ctx - { args, push } (`push` is injectable for tests)
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
async function handleCreate(ctx = {}) {
    const usage = '`create <id> channel=<name> provider=<claude|gemini|ollama> [repo=<owner/name>] [name=<Display Name>]`';
    const { fields, errors: parseErrors } = parseCreateArgs(ctx.args);
    if (parseErrors.includes('no arguments')) {
        return { ok: false, text: `:x: Usage: ${usage}\nIt proposes a DEFINITION as a branch. It does not create a Slack channel and does not activate anything.` };
    }

    // A parse error alongside valid fields would mean a field was silently dropped:
    // refuse rather than push a half-specified file.
    const rendered = renderAgentDefinition(fields, ctx.existing ? { existing: ctx.existing } : {});
    const errors = [...parseErrors, ...rendered.errors];
    if (!rendered.ok || parseErrors.length) {
        return { ok: false, text: `:x: Did not create an agent. Nothing was pushed.\n• ${errors.join('\n• ')}\nUsage: ${usage}` };
    }

    const { definition } = rendered;
    const push = ctx.push || require('./definition-branch').pushDefinitionBranch;
    const { branchName, describePushed } = require('./definition-branch');
    const pushed = await push({
        files: [{ path: rendered.rel, content: rendered.content }],
        branch: branchName('agent-def', `create-${definition.id}`),
        message: `Agent definition: create ${definition.id} (${definition.name})\n\nProposed by \`ASK: create\` (WORK-TODO #51). planned, no schedule, no watches.`,
    });
    if (!pushed.ok) {
        return { ok: false, text: `:x: Could not push \`${rendered.rel}\` as a branch: ${pushed.reason}. Nothing was written on the box.` };
    }

    return {
        ok: true,
        text: [
            `:new: Proposed \`${rendered.rel}\` — \`${definition.id}\` (${definition.name}), ` +
            `channel \`#${definition.channel_name}\`, provider \`${definition.llm_provider}\`` +
            (definition.target_repo ? `, repo \`${definition.target_repo}\`` : '') + '.',
            describePushed(pushed),
            '',
            `It is \`default_status: planned\` with no schedule and no watches: once deployed nothing polls it, nothing is joined, ` +
            `nothing fires. Fill in the three TODO sections on the branch before merging, make sure \`#${definition.channel_name}\` exists ` +
            `(nothing here creates a channel), then \`ASK: activate ${definition.id}\` after the deploy.`,
            definition.target_repo
                ? `Repository-level rules live in \`${definition.target_repo}\`'s own CLAUDE.md and are read from the clone. Do not copy them into the system prompt — that is how the two drift.`
                : '',
        ].filter(Boolean).join('\n'),
    };
}

module.exports = {
    buildDefinition,
    validateFields,
    renderAgentDefinition,
    createAgentDefinition,
    parseCreateArgs,
    handleCreate,
    ID_PATTERN,
    CHANNEL_NAME_PATTERN,
    REPO_PATTERN,
    PROVIDERS,
};
