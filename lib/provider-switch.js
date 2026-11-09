'use strict';

/**
 * lib/provider-switch.js
 *
 * WORK-TODO #47, the owner's answer of 2026-11-08: a "switch every agent's provider"
 * command that lists exactly what it changed and leaves per-agent settings alone.
 *
 *     ASK: provider <claude|gemini|ollama>            every defined agent
 *     ASK: provider <claude|gemini|ollama> <id> ...    only these
 *
 * LOGIC CHANGE 2026-11-09: new file.
 *
 * What it changes. Every definition declares its own `llm_provider` (since 2026-11-07),
 * so the global LLM_PROVIDER no longer reaches any agent and switching it would change
 * nothing. The switch therefore edits each definition's `llm_provider:` line and pushes
 * the result as a branch (lib/definition-branch.js, WORK-TODO #51): the owner merges it
 * and the update gate deploys it. Nothing changes on the box before then, and the reply
 * says so.
 *
 * What it leaves alone, and says so per agent:
 *   - an agent pinned by its own `LLM_PROVIDER_<AGENTID>` in .env. That is a per-agent
 *     setting the owner made on the box; the definition edit would not reach the agent
 *     anyway, so it is not edited and the variable is named.
 *   - an agent already on the target.
 *   - a definition with no `llm_provider:` line (none today): reported, not guessed at.
 *
 * The edit is the one frontmatter line, so the branch's diff is one line per agent and
 * nothing else in a definition is rewritten.
 */

const fs = require('fs');
const path = require('path');
const { loadDefinitions } = require('./agent-markdown');
const { resolveAgentLlm, SOURCE } = require('./agent-llm-resolver');
const { PROVIDERS } = require('./agent-create');
const { branchName, describePushed } = require('./definition-branch');
const { resolveClaudeTools } = require('./agent-tools');

const REPO_ROOT = path.join(__dirname, '..');
const LINE = /^llm_provider:[ \t]*([^\r\n]*)$/m;

/** Replace the frontmatter's llm_provider line; null when there is none. Pure. */
function setProviderLine(text, provider) {
    const end = text.indexOf('\n---', 3);
    if (!text.startsWith('---') || end < 0) return null;
    const front = text.slice(0, end);
    if (!LINE.test(front)) return null;
    return front.replace(LINE, `llm_provider: ${provider}`) + text.slice(end);
}

/**
 * Decide every agent's outcome. Pure apart from reading the definition files.
 * @returns {{ errors: string[], rows: object[], files: object[] }}
 */
function planSwitch(target, ids, { definitions = loadDefinitions(), env = process.env, root = REPO_ROOT } = {}) {
    if (!PROVIDERS.includes(target)) return { errors: [`provider must be one of ${PROVIDERS.join(', ')}, got \`${target || ''}\``], rows: [], files: [] };
    const unknown = ids.filter(id => !definitions.some(d => d.id === id));
    if (unknown.length) return { errors: [`no agent is defined as ${unknown.map(u => `\`${u}\``).join(', ')}`], rows: [], files: [] };
    const chosen = ids.length ? definitions.filter(d => ids.includes(d.id)) : definitions;

    const rows = [];
    const files = [];
    for (const agent of chosen) {
        const before = resolveAgentLlm(agent, { env });
        const row = { id: agent.id, before: before.provider, source: before.provider_source };
        if (before.provider_source === SOURCE.AGENT_ENV) {
            rows.push({ ...row, outcome: 'kept', why: `pinned by ${before.provider_env_key} in .env (a per-agent setting; not touched)` });
        } else if (agent.llm_provider === target) {
            rows.push({ ...row, outcome: 'unchanged', why: `already ${target}` });
        } else {
            const rel = `agents/${agent.id}/agent.md`;
            const edited = setProviderLine(fs.readFileSync(path.join(root, rel), 'utf8'), target);
            if (edited === null) {
                rows.push({ ...row, outcome: 'skipped', why: 'its definition has no `llm_provider:` line' });
            } else {
                files.push({ path: rel, content: edited });
                // A code agent's tools (clone, test, push) exist only on the Claude CLI.
                const losesTools = target !== 'claude' && resolveClaudeTools(agent).full;
                rows.push({ ...row, outcome: 'changed', after: target, losesTools });
            }
        }
    }
    return { errors: [], rows, files };
}

function formatRows(rows) {
    return rows.map(r => r.outcome === 'changed'
        ? `• \`${r.id}\`: ${r.before} (${r.source}) → *${r.after}*${r.losesTools ? ' :warning: its tools (shell, edit, push) exist only on claude' : ''}`
        : `• \`${r.id}\`: ${r.before} (${r.source}) — ${r.outcome}, ${r.why}`).join('\n');
}

/** The `provider` verb. Never posts; returns { ok, text }. `push` is injectable (tests). */
async function handleProvider(ctx = {}) {
    const usage = '`provider <claude|gemini|ollama> [agent-id ...]`';
    const [target, ...ids] = String(ctx.args || '').trim().split(/\s+/).filter(Boolean).map(s => s.toLowerCase());
    if (!target) return { ok: false, text: `Usage: ${usage}. With no ids it covers every defined agent. It proposes the change as a branch.` };
    const plan = planSwitch(target, ids, ctx.planDeps || {});
    if (plan.errors.length) return { ok: false, text: `:x: ${plan.errors.join(' ')}. Nothing was changed.\nUsage: ${usage}` };
    const table = formatRows(plan.rows);
    if (!plan.files.length) return { ok: true, text: `Nothing to change for \`${target}\`; nothing was pushed.\n${table}` };

    const push = ctx.push || require('./definition-branch').pushDefinitionBranch;
    const changed = plan.rows.filter(r => r.outcome === 'changed').map(r => r.id);
    const pushed = await push({
        files: plan.files,
        branch: branchName('agent-def', `provider-${target}`),
        message: `Agent definitions: ${changed.join(', ')} -> ${target}\n\nProposed by \`ASK: provider\` (WORK-TODO #47).`,
    });
    if (!pushed.ok) return { ok: false, text: `:x: Could not push the provider change as a branch: ${pushed.reason}. Nothing was changed.\nIt would have been:\n${table}` };
    return { ok: true, text: `:twisted_rightwards_arrows: Provider switch to \`${target}\`, ${changed.length} agent(s):\n${table}\n${describePushed(pushed)}` };
}

module.exports = { handleProvider, planSwitch, setProviderLine, formatRows };
