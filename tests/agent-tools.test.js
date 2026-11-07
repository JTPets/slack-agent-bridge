'use strict';

/**
 * tests/agent-tools.test.js
 *
 * THE guard for per-agent Claude tool permissions (lib/agent-tools.js, 2026-11-07).
 * Owner: "move all to claude", then "per agent permission is needed". Before this,
 * every Claude run got --dangerously-skip-permissions, so an agent that reads email or
 * chats with customers would have had a shell once it moved off Gemini.
 *
 * Three layers: the rule itself; every LIVE definition enumerated from disk (so a new
 * agent, or an edited permission list, changes a red/green answer rather than nothing);
 * and the adapter's real argv, captured from a stub binary, because a mocked spawn
 * proves only what the mock was told.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveClaudeTools, claudeToolArgs } = require('../lib/agent-tools');
const { loadDefinitions } = require('../lib/agent-markdown');

const ROOT = path.join(__dirname, '..');

describe('the rule', () => {
    test('no agent, or a non-object, gets no tools', () => {
        for (const a of [null, undefined, 'bridge', 42]) {
            expect(resolveClaudeTools(a)).toEqual(expect.objectContaining({ full: false, tools: [] }));
        }
    });

    test('claude-code is the only grant of the full tool set', () => {
        expect(resolveClaudeTools({ id: 'c', permissions: ['claude-code'] }).full).toBe(true);
        expect(claudeToolArgs({ id: 'c', permissions: ['claude-code'] })).toEqual(['--dangerously-skip-permissions']);
    });

    test('a denied claude-code wins over the grant', () => {
        expect(resolveClaudeTools({ id: 'c', permissions: ['claude-code'], denied: ['claude-code'] }).full).toBe(false);
    });

    test('integration permissions and typos grant no CLI tool (default-deny)', () => {
        const r = resolveClaudeTools({ id: 'x', permissions: ['gmail-read', 'twilio-sms', 'claude_code', 'Claude-Code'] });
        expect(r).toEqual(expect.objectContaining({ full: false, tools: [] }));
        expect(claudeToolArgs({ id: 'x', permissions: ['gmail-read'] }))
            .toEqual(['--restricted', '--strict-mcp-config', '--tools', '']);
    });

    test('github-read grants read tools only, with no edit pre-approval', () => {
        expect(resolveClaudeTools({ id: 's', permissions: ['github-read'] }).tools).toEqual(['Glob', 'Grep', 'Read']);
        expect(claudeToolArgs({ id: 's', permissions: ['github-read'] }))
            .toEqual(['--restricted', '--strict-mcp-config', '--tools', 'Glob,Grep,Read']);
    });

    test('file-system grants writes, pre-approved, and file-system-write takes them back', () => {
        const args = claudeToolArgs({ id: 'f', permissions: ['file-system'] });
        expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
        expect(args).not.toContain('--dangerously-skip-permissions');
        const r = resolveClaudeTools({ id: 'f', permissions: ['file-system'], denied: ['file-system-write'] });
        expect(r.tools).toEqual(['Glob', 'Grep', 'Read']);
        expect(resolveClaudeTools({ id: 'f', permissions: ['file-system'], denied: ['file-system'] }).tools).toEqual([]);
    });

    test('a restricted run never carries the bypass flag (it and --restricted are exclusive in the CLI)', () => {
        for (const perms of [[], ['github-read'], ['file-system']]) {
            const args = claudeToolArgs({ id: 'r', permissions: perms });
            expect(args).toContain('--restricted');
            expect(args).not.toContain('--dangerously-skip-permissions');
        }
    });
});

describe('every live definition, enumerated from disk', () => {
    const defs = loadDefinitions(path.join(ROOT, 'agents'));
    const byId = Object.fromEntries(defs.map(d => [d.id, resolveClaudeTools(d)]));

    test('the definitions were found', () => {
        expect(defs.length).toBeGreaterThanOrEqual(11);
    });

    test('exactly the code agents hold the full tool set', () => {
        const full = defs.filter(d => byId[d.id].full).map(d => d.id).sort();
        expect(full).toEqual(['bridge', 'code-bridge', 'code-sqtools']);
    });

    test('the agents that read email or talk to customers get no tools at all', () => {
        for (const id of ['email-monitor', 'secretary', 'storefront', 'jester', 'story-bot', 'marketing', 'social-media']) {
            expect(byId[id]).toEqual(expect.objectContaining({ full: false, tools: [] }));
        }
    });

    test('security reads, and writes nothing', () => {
        expect(byId.security).toEqual(expect.objectContaining({ full: false, tools: ['Glob', 'Grep', 'Read'] }));
    });

    test('every agent is on claude (owner, 2026-11-07)', () => {
        for (const d of defs) expect([d.id, d.llm_provider]).toEqual([d.id, 'claude']);
    });
});

describe('the adapter enforces it on the real argv', () => {
    let tmpDir; let stub;
    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-'));
        stub = path.join(tmpDir, 'argv-stub');
        fs.writeFileSync(stub,
            `#!${process.execPath}\nprocess.stdin.resume();\n` +
            `process.stdin.on('end', () => process.stdout.write(JSON.stringify(process.argv.slice(2))));\n`,
            { mode: 0o755 });
    });
    afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const run = async (opts) => {
        const { runClaudeAdapter } = require('../lib/llm-adapter-claude');
        const r = await runClaudeAdapter('p', { claudeBin: stub, cwd: tmpDir, ...opts });
        return JSON.parse(r.output);
    };

    test('a passed record decides: full for a code agent, nothing for the secretary', async () => {
        const { getAgent } = require('../lib/agent-registry');
        expect(await run({ agentRecord: getAgent('code-bridge') })).toContain('--dangerously-skip-permissions');
        const sec = await run({ agentRecord: getAgent('secretary') });
        expect(sec).not.toContain('--dangerously-skip-permissions');
        expect(sec.slice(-4)).toEqual(['--restricted', '--strict-mcp-config', '--tools', '']);
    });

    test('an agentId alone is looked up in the registry', async () => {
        expect(await run({ agentId: 'bridge' })).toContain('--dangerously-skip-permissions');
        expect((await run({ agentId: 'security' })).slice(-1)).toEqual(['Glob,Grep,Read']);
    });

    test('an unknown id, or none, is no tools (negative control for default-allow)', async () => {
        for (const opts of [{}, { agentId: 'no-such-agent' }]) {
            const argv = await run(opts);
            expect(argv).not.toContain('--dangerously-skip-permissions');
            expect(argv.slice(-2)).toEqual(['--tools', '']);
        }
    });
});

describe('the callers that used to name no agent now do', () => {
    const src = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

    test('the customer chat runs as storefront and the nightly review as security', () => {
        expect(src('bots/storefront.js')).toMatch(/runLLM\(prompt, \{[\s\S]{0,400}agentId: 'storefront'/);
        expect(src('security-review.js')).toMatch(/runLLM\(prompt, \{[\s\S]{0,400}agentId: 'security'/);
    });

    test('both bridge entry points hand the adapter the executing agent', () => {
        const matches = src('bridge-agent.js').match(/agentRecord: currentAgent/g) || [];
        expect(matches).toHaveLength(2);
    });

    test('the standup resolves its provider like every other site', () => {
        const wc = src('lib/watercooler.js');
        expect(wc).toMatch(/resolveLlmProvider\(agent, agent\.id\)/);
        expect(wc).not.toMatch(/llm_provider \|\| 'gemini'/);
        expect(src('lib/task-decomposer.js')).not.toMatch(/provider: 'gemini'/);
    });
});
