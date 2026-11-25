'use strict';

/**
 * lib/agent-tools.js
 *
 * THE mapping from an agent's declared `permissions` / `denied` (agents/<id>/agent.md)
 * to the Claude CLI tools that agent's run is given.
 *
 * LOGIC CHANGE 2026-11-07: before this, `permissions` and `denied` were read by no
 * production code (docs/CAPABILITY-AND-ISOLATION-DESIGN.md), and every Claude run got
 * every tool via `--dangerously-skip-permissions`. That was tolerable while the agents
 * that read email, chat with customers or write social posts ran on Gemini, which has
 * no tools at all. Moving them to Claude (owner, 2026-11-07: "move all to claude",
 * then "per agent permission is needed") would have handed an email-driven prompt a
 * shell on the box that holds the Slack token, the deploy key and the Claude token.
 *
 * The rule is DEFAULT-DENY over a CLOSED vocabulary:
 *   - only the names in GRANTS give a CLI tool; every other permission (gmail-read,
 *     twilio-sms, linkedin-api, ...) is an integration the bridge's own code performs,
 *     so it grants no CLI tool. A typo therefore grants nothing.
 *   - `claude-code` is the one grant of the FULL tool set (shell, edit, web, ...),
 *     which code agents need to clone, test and push.
 *   - a `denied` entry removes tools even when a permission would grant them.
 *   - no agent id, or an id with no definition, gets NO tools.
 *
 * How the CLI is restricted, each part verified on CLI 2.1.319 (2026-11-07):
 *   --restricted        drops the code-running tools and CONFINES the file tools to the
 *                       working directory: Read on /etc/hostname returned "outside ...
 *                       --restricted confines the file tools to the working directory",
 *                       so a read-only agent cannot read /bridge/.env from a scratch cwd.
 *   --tools <list>      exactly these built-in tools; `""` = none (init event `tools: []`).
 *   --strict-mcp-config no MCP server configured on the box widens the run.
 * `--restricted` refuses `--dangerously-skip-permissions` ("bypassPermissions not
 * supported in restricted mode"), so a restricted run carries neither; the read-only
 * read-only tools need no permission prompt, and granted write tools are pre-approved
 * with `--permission-mode acceptEdits` (verified: Write created a file in the cwd).
 */

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

/** permission name -> CLI tools it grants. `claude-code` is FULL, handled apart. */
const GRANTS = Object.freeze({
    'file-system': [...READ_TOOLS, ...WRITE_TOOLS],
    'file-system-read': READ_TOOLS,
    'github-read': READ_TOOLS,
});

/** denied name -> CLI tools it removes. */
const DENIES = Object.freeze({
    'file-system': [...READ_TOOLS, ...WRITE_TOOLS],
    'file-system-write': WRITE_TOOLS,
});

const FULL = 'claude-code';

function asList(value) {
    return Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
}

/**
 * @param {Object|null} agent - an agent record (needs `permissions` / `denied`)
 * @returns {{ full: boolean, tools: string[], reason: string }}
 *   full=true  -> the run keeps every tool (no --tools flag).
 *   full=false -> the run gets exactly `tools` (possibly none).
 */
function resolveClaudeTools(agent) {
    if (!agent || typeof agent !== 'object') {
        return { full: false, tools: [], reason: 'no agent definition: no tools' };
    }
    const permissions = asList(agent.permissions);
    const denied = asList(agent.denied);

    if (permissions.includes(FULL) && !denied.includes(FULL)) {
        return { full: true, tools: [], reason: `${agent.id}: ${FULL} permission: full tool set` };
    }

    const granted = new Set();
    for (const p of permissions) for (const t of GRANTS[p] || []) granted.add(t);
    for (const d of denied) for (const t of DENIES[d] || []) granted.delete(t);

    const tools = [...granted].sort();
    return {
        full: false,
        tools,
        reason: `${agent.id}: ${tools.length ? tools.join(', ') : 'no tools'}`,
    };
}

/**
 * The CLI permission arguments that enforce `resolveClaudeTools(agent)`.
 * @returns {string[]}
 */
function claudeToolArgs(agent) {
    const r = resolveClaudeTools(agent);
    if (r.full) return ['--dangerously-skip-permissions'];
    const args = ['--restricted', '--strict-mcp-config', '--tools', r.tools.join(',')];
    // A non-interactive run cannot answer an edit prompt, so a granted write tool is
    // pre-approved; it stays confined to the working directory by --restricted.
    if (r.tools.some(t => WRITE_TOOLS.includes(t))) args.push('--permission-mode', 'acceptEdits');
    return args;
}

// LOGIC CHANGE 2026-11-25 (WORK-TODO #85): a run with NO tools can only think and write,
// and a normal one takes seconds (the 07:00 briefing: about 20 s). On 2026-11-20 and
// 11-21 two such runs thought silently for 13-15 minutes, cost about $2.60 each and
// were refused by the model's safeguards; the task deadline on the box let them run.
const DEFAULT_NO_TOOLS_TIMEOUT_MS = 300000;

/**
 * The deadline for a run: the caller's, capped at NO_TOOLS_TIMEOUT_MS when the agent's
 * run has no tools at all. A run with any tool keeps the caller's deadline. `0` turns
 * the cap off; a value that is not a number uses the default.
 * @returns {{ timeout: number, capped: boolean }}
 */
function runDeadline(timeout, agent, env = process.env) {
    const r = resolveClaudeTools(agent);
    if (r.full || r.tools.length) return { timeout, capped: false };
    const raw = env.NO_TOOLS_TIMEOUT_MS;
    const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
    const cap = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_NO_TOOLS_TIMEOUT_MS;
    if (cap === 0 || timeout <= cap) return { timeout, capped: false };
    return { timeout: cap, capped: true };
}

// LOGIC CHANGE 2026-11-25 (WORK-TODO #85): the Claude adapter ignored `options.model`, so
// an agent's `llm_model` never reached the CLI and every claude agent ran on the CLI's
// default model. A model id is an argv value after `--model`; one that does not look like a
// model id (a leading `-` would be read as a flag) is refused, never passed or cleaned.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/;

/**
 * The CLI arguments that select `model`: none when no model is given.
 * @throws {Error} when `model` is not shaped like a model id
 */
function claudeModelArgs(model) {
    if (model === undefined || model === null || model === '') return [];
    if (typeof model !== 'string' || !MODEL_ID.test(model)) {
        throw new Error(`Refused Claude model id ${JSON.stringify(String(model)).slice(0, 60)}: expected letters, digits and . _ : [ ] -`);
    }
    return ['--model', model];
}

module.exports = {
    GRANTS, DENIES, FULL, READ_TOOLS, WRITE_TOOLS, DEFAULT_NO_TOOLS_TIMEOUT_MS,
    resolveClaudeTools, claudeToolArgs, claudeModelArgs, runDeadline,
};
