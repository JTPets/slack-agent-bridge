'use strict';

/**
 * lib/activation-checklist.js
 *
 * WORK-TODO #80, the owner's ask of 2026-11-09: "activation checklist should be a ask
 * and answer session in the bot itself". `ASK: activate <id>` walks the agent's
 * checklist (agents/activation-checklists.json) and activates only when every step
 * passes.
 *
 * LOGIC CHANGE 2026-11-09: new file. Before it, `activate` never read the checklist, so
 * an agent could be turned on with its credentials missing, and a step was "done" only
 * because someone had typed `completed: true` into a tracked file.
 *
 * Two kinds of step, decided from the step's own text:
 *   - `env`: "Add <NAME> to .env". The bridge checks it itself: SET when its process
 *     environment holds a non-blank value. Never the value. Cannot be ticked by hand,
 *     because a tick cannot make a missing credential present.
 *   - `ask`: everything else. The bridge cannot see it, so it asks; the owner answers
 *     with `activate <id> done <n>`. An answer lives in the gitignored workspace store
 *     (lib/bridge-state.js setActivationAnswer). A step already ticked `completed: true`
 *     in the tracked file counts as answered, so the history of earlier activations
 *     stands.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #80, B30): a SET env step is also PROBED when
 * `activate` is asked (lib/credential-probe.js, one live read-only call per credential).
 * It passes only when the probe says it works, or when no probe exists for that
 * credential, which the step says in those words ("SET (not probed)"). A probe that
 * fails blocks activation exactly as EMPTY does. Probes run inside checklistGate only,
 * never on a timer; taskPasses (the "what do I need to do" list) stays presence-only.
 *
 * Pure apart from the answer store; posts nothing.
 */

const bridgeState = require('./bridge-state');

const ENV_STEP = /^Add ([A-Z][A-Z0-9_]+) to \.env\b/;

/** What kind of step this is, from its text. */
function stepKind(description) {
    const m = ENV_STEP.exec(String(description || ''));
    return m ? { kind: 'env', name: m[1] } : { kind: 'ask' };
}

/**
 * One step's state.
 * @returns {{ kind: string, name?: string, pass: boolean, why: string }}
 */
function stepState(task, answer, env) {
    const k = stepKind(task.description);
    if (k.kind === 'env') {
        const set = typeof env[k.name] === 'string' && env[k.name].trim() !== '';
        return { ...k, pass: set, why: set ? `\`${k.name}\` is SET` : `\`${k.name}\` is EMPTY` };
    }
    if (answer) return { ...k, pass: true, why: `you answered done${answer.at ? ` (${answer.at.slice(0, 10)})` : ''}` };
    if (task.completed) return { ...k, pass: true, why: 'ticked in the checklist file' };
    return { ...k, pass: false, why: 'waiting on your answer' };
}

/**
 * Evaluate one agent's checklist.
 * @param {string} agentId
 * @param {object} deps - { checklists, answers, env }
 * @returns {{ known: boolean, ready: boolean, steps: object[] }}
 */
function evaluateChecklist(agentId, { checklists, answers = bridgeState.loadActivationAnswers(), env = process.env }) {
    const list = checklists && checklists[agentId];
    const tasks = list && Array.isArray(list.tasks) ? list.tasks : [];
    if (!tasks.length) return { known: false, ready: true, steps: [] };
    const mine = (answers && answers[agentId]) || {};
    const steps = tasks.map((t, i) => ({ n: i + 1, description: t.description, ...stepState(t, mine[t.description], env) }));
    return { known: true, ready: steps.every(s => s.pass), steps };
}

/**
 * Upgrade every SET env step with its live probe. Returns a new verdict; never rejects.
 * @param {object} verdict - from evaluateChecklist
 * @param {object} opts - { env, probe(name, { env, cache }) }
 */
async function probeSteps(verdict, { env = process.env, probe = require('./credential-probe').probeCredential } = {}) {
    const cache = new Map();
    const steps = await Promise.all(verdict.steps.map(async (s) => {
        if (s.kind !== 'env' || !s.pass) return s;
        let r;
        try { r = await probe(s.name, { env, cache }); } catch (err) { r = { status: 'fails', reason: 'the check itself failed' }; }
        if (r && r.status === 'works') return { ...s, probe: 'works', why: `\`${s.name}\` is SET and works (${r.reason})` };
        if (r && r.status === 'not_probed') return { ...s, probe: 'not_probed', why: `\`${s.name}\` is SET (not probed: ${r.reason})` };
        return { ...s, pass: false, probe: 'fails', why: `\`${s.name}\` is SET but does not work: ${(r && r.reason) || 'no answer'}` };
    }));
    return { ...verdict, steps, ready: steps.every(s => s.pass) };
}

/** Whether a single tracked task passes (for lib/owner-tasks-store.js's pending list). */
function taskPasses(agentId, task, { answers = bridgeState.loadActivationAnswers(), env = process.env } = {}) {
    return stepState(task, ((answers || {})[agentId] || {})[task.description], env).pass;
}

/**
 * `activate <id>`, `activate <id> done <n> ...`, `activate <id> undo <n> ...`.
 * @returns {{ id: string, op: 'activate'|'done'|'undo', numbers: number[], error?: string }}
 */
function parseActivateArgs(args) {
    const words = String(args || '').trim().split(/\s+/).filter(Boolean);
    const id = (words.shift() || '').replace(/^[`#]|[`]$/g, '');
    if (!words.length) return { id, op: 'activate', numbers: [] };
    const op = words.shift().toLowerCase();
    if (op !== 'done' && op !== 'undo') return { id, op, numbers: [], error: `unknown word \`${op}\`; after the id only \`done <n>\` or \`undo <n>\` is understood` };
    const numbers = words.map(w => Number(w));
    if (!numbers.length || numbers.some(n => !Number.isInteger(n) || n < 1)) {
        return { id, op, numbers: [], error: `\`${op}\` needs one or more step numbers, e.g. \`activate ${id} ${op} 2\`` };
    }
    return { id, op, numbers };
}

/**
 * Record done/undo answers. All or nothing: any refused number writes nothing.
 * @returns {{ ok: boolean, reason?: string }}
 */
function recordAnswers(agentId, op, numbers, verdict, meta = {}) {
    for (const n of numbers) {
        const step = verdict.steps[n - 1];
        if (!step) return { ok: false, reason: `step ${n} does not exist; \`${agentId}\` has ${verdict.steps.length}` };
        if (step.kind === 'env') {
            return { ok: false, reason: `step ${n} is checked by the bridge itself (\`${step.name}\` SET or EMPTY) and cannot be answered by hand` };
        }
    }
    for (const n of numbers) bridgeState.setActivationAnswer(agentId, verdict.steps[n - 1].description, op === 'done', meta);
    return { ok: true };
}

/** The checklist as a Slack reply. */
function formatChecklist(agentId, verdict) {
    const passed = verdict.steps.filter(s => s.pass).length;
    const lines = [`*Activation checklist for \`${agentId}\`: ${passed} of ${verdict.steps.length} pass.*`];
    for (const s of verdict.steps) {
        lines.push(`${s.pass ? ':white_check_mark:' : ':white_large_square:'} ${s.n}. ${s.description} (${s.why})`);
    }
    const open = verdict.steps.filter(s => !s.pass);
    const asks = open.filter(s => s.kind === 'ask');
    const envs = open.filter(s => s.kind === 'env' && s.probe !== 'fails');
    const broken = open.filter(s => s.probe === 'fails');
    if (asks.length) lines.push(`When you have done a step, answer \`ASK: activate ${agentId} done ${asks.map(s => s.n).join(' ')}\` (any of those numbers). \`undo <n>\` takes an answer back.`);
    if (envs.length) lines.push(`For ${envs.map(s => `\`${s.name}\``).join(', ')}: add it to \`.env\` on the NAS and run \`docker compose up -d --force-recreate bridge\`. Secrets never go through Slack; the bridge then sees SET.`);
    if (broken.length) lines.push(`${broken.map(s => `\`${s.name}\``).join(', ')} ${broken.length > 1 ? 'are' : 'is'} set but failed a live read-only check: replace the value in \`.env\` (an expired or revoked credential) and recreate the container, then ask again.`);
    return lines.join('\n');
}

/**
 * The gate `handleActivate` runs first.
 * @param {object} ctx - { args, userId, checklists?, env?, probe? }
 * @returns {Promise<{ proceed: boolean, id: string, text?: string, ok?: boolean, header?: string }>}
 */
async function checklistGate(ctx = {}) {
    const parsed = parseActivateArgs(ctx.args);
    if (!parsed.id) return { proceed: false, id: '', ok: false, text: ':x: Usage: `activate <agent-id>`. Run `available` for the list.' };
    if (parsed.error) return { proceed: false, id: parsed.id, ok: false, text: `:x: ${parsed.error}. Nothing was changed.` };
    const checklists = ctx.checklists || require('./owner-tasks-store').loadChecklists();
    const deps = { checklists, env: ctx.env || process.env };
    let verdict = evaluateChecklist(parsed.id, deps);

    if (parsed.op !== 'activate') {
        if (!verdict.known) return { proceed: false, id: parsed.id, ok: false, text: `:x: \`${parsed.id}\` has no activation checklist to answer. Nothing was changed.` };
        const rec = recordAnswers(parsed.id, parsed.op, parsed.numbers, verdict, ctx.userId ? { by: ctx.userId } : {});
        if (!rec.ok) return { proceed: false, id: parsed.id, ok: false, text: `:x: ${rec.reason}. Nothing was recorded.` };
        verdict = evaluateChecklist(parsed.id, deps);
    }
    if (verdict.known) verdict = await probeSteps(verdict, { env: deps.env, ...(ctx.probe ? { probe: ctx.probe } : {}) });
    const isActive = (() => { try { return require('./agent-registry').getAgent(parsed.id)?.status === 'active'; } catch { return false; } })();
    if (!verdict.known) return { proceed: true, id: parsed.id, header: '' };
    if (!verdict.ready) {
        return { proceed: false, id: parsed.id, ok: parsed.op !== 'activate', text: `${formatChecklist(parsed.id, verdict)}\n${isActive ? `\`${parsed.id}\` is already active; this only records the checklist.` : 'Not activated yet: every step must pass first.'}` };
    }
    if (isActive && parsed.op !== 'activate') return { proceed: false, id: parsed.id, ok: true, text: `${formatChecklist(parsed.id, verdict)}\n\`${parsed.id}\` is already active.` };
    return { proceed: true, id: parsed.id, header: `Checklist: all ${verdict.steps.length} steps pass.` };
}

module.exports = { stepKind, evaluateChecklist, probeSteps, taskPasses, parseActivateArgs, recordAnswers, formatChecklist, checklistGate, ENV_STEP };
