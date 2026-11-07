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

module.exports = { GRANTS, DENIES, FULL, resolveClaudeTools, claudeToolArgs };
