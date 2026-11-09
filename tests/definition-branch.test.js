'use strict';

/**
 * tests/definition-branch.test.js
 *
 * WORK-TODO #51 (shape c) and #47: a command that changes a tracked file pushes it as a
 * NEW BRANCH. Against REAL git: a bare "origin" in a temp dir stands in for GitHub; the
 * clone is injected (cloneRepo only speaks https/ssh to github.com) and does what
 * cloneRepo does, a clone of main whose origin can be pushed to.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pushDefinitionBranch, branchName, isAllowedPath, describePushed } = require('../lib/definition-branch');
const { handleProvider, planSwitch, setProviderLine } = require('../lib/provider-switch');
const { SOURCE } = require('../lib/agent-llm-resolver');

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let root, origin;
const clone = (repo, branch, dir) => git(root, ['clone', '-q', '--branch', branch, '--', origin, dir]);

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'definition-branch-'));
    origin = path.join(root, 'origin.git');
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
    const seed = path.join(root, 'seed');
    git(root, ['clone', '-q', origin, seed]);
    for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false']]) git(seed, ['config', k, v]);
    fs.mkdirSync(path.join(seed, 'agents', 'jester'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'agents', 'jester', 'agent.md'), '---\nid: jester\nllm_provider: claude\n---\n\n## Role\nx\n');
    git(seed, ['add', '-A']); git(seed, ['commit', '-q', '-m', 'seed']); git(seed, ['push', '-q', 'origin', 'HEAD:main']);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test('pushes the files as a new branch; the remote holds exactly that commit; main is untouched', async () => {
    const mainBefore = git(origin, ['rev-parse', 'main']);
    const r = await pushDefinitionBranch({
        files: [{ path: 'agents/inventory/agent.md', content: '---\nid: inventory\n---\n' }],
        branch: 'agent-def/create-inventory-20261109000000', message: 'create inventory', clone,
    });
    expect(r.ok).toBe(true);
    expect(git(origin, ['rev-parse', 'refs/heads/agent-def/create-inventory-20261109000000'])).toBe(r.sha);
    expect(git(origin, ['show', `${r.sha}:agents/inventory/agent.md`])).toBe('---\nid: inventory\n---');
    expect(git(origin, ['rev-parse', 'main'])).toBe(mainBefore);
    expect(describePushed(r)).toMatch(/compare\/main\.\.\.agent-def\/create-inventory-20261109000000[\s\S]*Nothing has changed on the box yet/);
});

test('an existing branch name is refused (no force), and reported', async () => {
    const files = [{ path: 'agents/a/agent.md', content: 'one' }];
    expect((await pushDefinitionBranch({ files, branch: 'agent-def/dup', message: 'm', clone })).ok).toBe(true);
    const second = await pushDefinitionBranch({ files: [{ path: 'agents/a/agent.md', content: 'two' }], branch: 'agent-def/dup', message: 'm', clone });
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/rejected|fetch first|non-fast-forward/);
});

test('a path outside agents/, a traversal or a bad branch never reaches git', async () => {
    let cloned = false;
    const spy = () => { cloned = true; };
    for (const p of ['bridge-agent.js', 'agents/../.env', '/etc/passwd', 'agents/x/../../y']) {
        expect(isAllowedPath(p)).toBe(false);
        expect((await pushDefinitionBranch({ files: [{ path: p, content: 'x' }], branch: 'agent-def/x', message: 'm', clone: spy })).ok).toBe(false);
    }
    expect((await pushDefinitionBranch({ files: [{ path: 'agents/x/agent.md', content: 'x' }], branch: '--upload-pack=x', message: 'm', clone: spy })).ok).toBe(false);
    expect(cloned).toBe(false);
});

test('content that main already holds is "nothing to push", not an empty commit', async () => {
    const same = fs.readFileSync(path.join(root, 'seed', 'agents', 'jester', 'agent.md'), 'utf8');
    const r = await pushDefinitionBranch({ files: [{ path: 'agents/jester/agent.md', content: same }], branch: 'agent-def/same', message: 'm', clone });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/nothing to push/) });
});

test('a failed clone is reported, and the scratch directory is gone', async () => {
    const before = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('definition-branch-')).length;
    const r = await pushDefinitionBranch({ files: [{ path: 'agents/x/agent.md', content: 'x' }], branch: 'agent-def/y', message: 'm',
        clone: () => { throw new Error('Repository not found'); } });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Repository not found/) });
    expect(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('definition-branch-')).length).toBe(before);
});

test('branchName is valid for git-identifiers', () => {
    const b = branchName('agent-def', 'provider-gemini', new Date('2026-11-09T13:04:05Z'));
    expect(b).toBe('agent-def/provider-gemini-20261109130405');
    expect(require('../lib/git-identifiers').isValidBranch(b)).toBe(true);
});

describe('#47 the provider switch', () => {
    const defs = [
        { id: 'jester', llm_provider: 'claude', permissions: [] },
        { id: 'bridge', llm_provider: 'claude', permissions: ['claude-code'] },
        { id: 'secretary', llm_provider: 'claude', permissions: [] },
        { id: 'storefront', llm_provider: 'gemini', permissions: [] },
    ];
    const files = {};
    let defRoot;
    beforeAll(() => {
        defRoot = fs.mkdtempSync(path.join(root, 'defs-'));
        for (const d of defs) {
            fs.mkdirSync(path.join(defRoot, 'agents', d.id), { recursive: true });
            files[d.id] = `---\nid: ${d.id}\nllm_provider: ${d.llm_provider}\nmax_turns: 10\n---\n\n## Role\nllm_provider: in the body is not touched\n`;
            fs.writeFileSync(path.join(defRoot, 'agents', d.id, 'agent.md'), files[d.id]);
        }
    });
    const deps = (env = {}) => ({ definitions: defs, env, root: defRoot });

    test('setProviderLine edits the one frontmatter line and nothing in the body', () => {
        const out = setProviderLine(files.jester, 'gemini');
        expect(out).toBe(files.jester.replace('llm_provider: claude\nmax', 'llm_provider: gemini\nmax'));
        expect(setProviderLine('no frontmatter', 'gemini')).toBeNull();
        expect(setProviderLine('---\nid: x\n---\n', 'gemini')).toBeNull();
    });

    test('changes only what is not pinned or already there, and says why for each', () => {
        const plan = planSwitch('gemini', [], deps({ LLM_PROVIDER_SECRETARY: 'claude' }));
        const by = Object.fromEntries(plan.rows.map(r => [r.id, r]));
        expect(by.jester).toMatchObject({ outcome: 'changed', before: 'claude', after: 'gemini', losesTools: false });
        expect(by.bridge).toMatchObject({ outcome: 'changed', losesTools: true });
        expect(by.secretary).toMatchObject({ outcome: 'kept', source: SOURCE.AGENT_ENV });
        expect(by.secretary.why).toMatch(/LLM_PROVIDER_SECRETARY/);
        expect(by.storefront).toMatchObject({ outcome: 'unchanged' });
        expect(plan.files.map(f => f.path).sort()).toEqual(['agents/bridge/agent.md', 'agents/jester/agent.md']);
    });

    test('named ids narrow it; an unknown id or provider refuses the whole switch', () => {
        expect(planSwitch('gemini', ['jester'], deps()).files.map(f => f.path)).toEqual(['agents/jester/agent.md']);
        expect(planSwitch('gemini', ['nobody'], deps()).errors[0]).toMatch(/nobody/);
        expect(planSwitch('gpt5', [], deps()).errors[0]).toMatch(/must be one of/);
    });

    test('the verb pushes one branch and lists every agent; nothing to change pushes nothing', async () => {
        const pushes = [];
        const push = async (p) => { pushes.push(p); return { ok: true, branch: p.branch, sha: 'a'.repeat(40) }; };
        const r = await handleProvider({ args: 'gemini', push, planDeps: deps() });
        expect(r.ok).toBe(true);
        expect(pushes).toHaveLength(1);
        expect(pushes[0].branch).toMatch(/^agent-def\/provider-gemini-\d{14}$/);
        expect(r.text).toMatch(/`jester`: claude \(registry:agent\.md\) → \*gemini\*/);
        expect(r.text).toMatch(/`bridge`[^\n]*exist only on claude/);
        expect(r.text).toMatch(/`storefront`[^\n]*unchanged/);
        expect(r.text).toMatch(/Nothing has changed on the box yet/);
        const none = await handleProvider({ args: 'gemini storefront', push, planDeps: deps() });
        expect(none.text).toMatch(/Nothing to change/);
        expect(pushes).toHaveLength(1);
    });

    test('a failed push says nothing changed and shows what would have', async () => {
        const r = await handleProvider({ args: 'ollama jester', push: async (p) => ({ ok: false, branch: p.branch, reason: 'denied' }), planDeps: deps() });
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/denied\. Nothing was changed\.\nIt would have been:\n• `jester`/);
    });

    test('provider is a mutating verb, so an agent channel refuses it', () => {
        expect(require('../lib/command-router').COMMANDS.provider.kind).toBe('mutate');
    });
});
