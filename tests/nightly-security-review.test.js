'use strict';

/**
 * tests/nightly-security-review.test.js
 *
 * WORK-TODO #83: the nightly security audit reviewed no commits. `nightly-audit` was an
 * LLM prompt posted as a TASK: with no REPO:, so the model had no clone and no git, and
 * every night said it could not review the last 24 hours. It is now a deterministic task
 * (lib/nightly-security-review.js) that reads the 24-hour diff with REAL git and gives it
 * to a model run with no tools in an empty directory.
 *
 * The git reads here run against a real temporary repository; only the clone source (a
 * local origin instead of GitHub) and the model are injected.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gitReads = require('../lib/security-review-git');
const review = require('../lib/nightly-security-review');
const { getDeterministicTask, getTaskTemplate } = require('../lib/agent-task-catalogue');
const { resolveClaudeTools } = require('../lib/agent-tools');
const { COMMANDS } = require('../lib/command-router');

const SECRET_LINE = 'const API_KEY = "sk-test-not-a-real-key";';

function git(dir, args) {
    return execFileSync('git', args, {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid',
            GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' },
        encoding: 'utf8',
    }).trim();
}

const SECURITY = {
    id: 'security', name: 'Security Auditor', channel: 'C0SECURITY', channel_name: 'sqtools-alerts',
    permissions: ['github-read'], denied: ['github-write'], llm_provider: 'claude',
    schedule: { cron: '0 1 * * *', task: 'nightly-audit' },
};
const OTHER = { id: 'bridge', channel: 'C0BRIDGE', permissions: ['claude-code'] };

let origin;
beforeEach(() => {
    origin = fs.mkdtempSync(path.join(os.tmpdir(), 'nsr-origin-'));
    git(origin, ['init', '-q', '-b', 'main']);
});
afterEach(() => fs.rmSync(origin, { recursive: true, force: true }));

function commitToOrigin(content, message) {
    fs.writeFileSync(path.join(origin, 'config.js'), content);
    git(origin, ['add', 'config.js']);
    git(origin, ['commit', '-q', '-m', message]);
}

/** Real git reads; the clone comes from the local origin instead of GitHub. */
function localGit(seen) {
    return {
        ...gitReads,
        cloneRepo: async (repo, dir) => {
            seen.cloneDirs.push(dir);
            git(dir, ['clone', '-q', '--', origin, '.']);
        },
    };
}

function harness(overrides = {}) {
    const seen = { cloneDirs: [], calls: [], posts: [], ops: [], bulletins: [], followups: [] };
    const deps = {
        slack: { chat: { postMessage: async (msg) => { seen.posts.push(msg); return { ok: true }; } } },
        agent: SECURITY,
        repos: ['jtpets/slack-agent-bridge'],
        git: localGit(seen),
        llm: {
            runLLM: async (prompt, options) => {
                seen.calls.push({ prompt, options, cwdEntries: fs.readdirSync(options.cwd) });
                return { output: 'HIGH: hardcoded key - config.js:1 - move it to .env' };
            },
        },
        notifier: { notifyOps: async (t) => { seen.ops.push(t); return true; } },
        bulletinBoard: {
            postBulletin: (agentId, type, data) => {
                seen.bulletins.push({ agentId, type, data });
                return { success: true, bulletin: { id: 'b1', agentId, type, data } };
            },
        },
        securityFollowup: {
            processSecurityBulletin: async (slack, bulletin, opts) => {
                seen.followups.push({ bulletin, opts });
                return { tasks: [] };
            },
            formatFollowupSummary: () => 'one task queued',
        },
        config: { SECURITY_FOLLOWUP_ENABLED: true, SECURITY_FOLLOWUP_INCLUDE_MEDIUM: false },
        loadAgentsFn: () => [OTHER, SECURITY],
        resolveLlm: (a) => ({ provider: a.llm_provider || 'claude', model: null }),
        readSkill: async () => '# Security Review Skill\nReview the diff.',
        ...overrides,
    };
    return { deps, seen };
}

describe('nightly-audit is a deterministic task now (#83)', () => {
    test('the catalogue runs code for it, and it is no longer an LLM template', () => {
        expect(getTaskTemplate('nightly-audit')).toBeNull();
        const task = getDeterministicTask('nightly-audit');
        expect(task).not.toBeNull();
        expect(typeof task.run).toBe('function');
    });

    test('`audit` is the on-demand verb for the same catalogue entry', () => {
        expect(COMMANDS.audit).toMatchObject({ kind: 'scheduled', task: 'nightly-audit', resolvesOwnChannel: true });
    });

    test('the live security definition still schedules nightly-audit', () => {
        const def = require('../lib/agent-registry').getAgent('security');
        expect(def.schedule.task).toBe('nightly-audit');
    });
});

describe('runNightlyReview against a real repository', () => {
    test('the model is given the real 24-hour diff, and posts in the security channel', async () => {
        commitToOrigin('module.exports = {};\n', 'initial');
        commitToOrigin(`${SECRET_LINE}\nmodule.exports = { API_KEY };\n`, 'add the api key');
        const { deps, seen } = harness();

        const verdict = await review.runNightlyReview(deps);

        expect(verdict).toMatchObject({ ok: true, status: 'ok', posted: true, channel: 'C0SECURITY', reviewed: 1 });
        expect(seen.calls).toHaveLength(1);
        expect(seen.calls[0].prompt).toContain(SECRET_LINE);
        expect(seen.calls[0].prompt).toContain('add the api key');
        expect(seen.posts).toHaveLength(1);
        expect(seen.posts[0].channel).toBe('C0SECURITY');
        expect(seen.posts[0].text).toContain('jtpets/slack-agent-bridge');
        expect(seen.posts[0].text).toContain('HIGH: hardcoded key');
        expect(seen.ops).toEqual([]);
    });

    test('the model run has no tools, one turn, no fallback, and an EMPTY cwd that is not the clone', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness();
        await review.runNightlyReview(deps);

        const { options, cwdEntries } = seen.calls[0];
        expect(options.maxTurns).toBe(1);
        expect(options.provider).toBe('claude');
        expect(options.agentId).toBe('security');
        expect(cwdEntries).toEqual([]);
        expect(seen.cloneDirs).not.toContain(options.cwd);
        expect(resolveClaudeTools(options.agentRecord).tools).toEqual([]);
        expect(resolveClaudeTools(options.agentRecord).full).toBe(false);
        // Both temp dirs are gone afterwards.
        expect(fs.existsSync(options.cwd)).toBe(false);
        expect(fs.existsSync(seen.cloneDirs[0])).toBe(false);
    });

    test('the module calls runLLM and never runWithFallback', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'nightly-security-review.js'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect(src).toMatch(/\.runLLM\(/);
        expect(src).not.toMatch(/runWithFallback/);
    });

    test('a quiet day calls no model and says which repositories had nothing', async () => {
        fs.writeFileSync(path.join(origin, 'a.js'), 'old\n');
        git(origin, ['add', 'a.js']);
        const when = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
        execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd: origin, env: { ...process.env,
            GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T',
            GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
        const { deps, seen } = harness();
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.ok).toBe(true);
        expect(seen.calls).toHaveLength(0);
        expect(seen.posts[0].text).toContain('No commits in the last 24 hours: jtpets/slack-agent-bridge');
        expect(seen.bulletins).toHaveLength(0);
    });

    test('`ASK: audit` typed in another channel still posts in the security channel', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness({ agent: OTHER });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.channel).toBe('C0SECURITY');
        expect(seen.posts[0].channel).toBe('C0SECURITY');
    });
});

describe('findings keep the bulletin and approval-queue path', () => {
    test('a bulletin is posted with the full review and the follow-up pipeline is given it', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness();
        deps.securityFollowup.processSecurityBulletin = async (slack, bulletin, opts) => {
            seen.followups.push({ bulletin, opts });
            return { tasks: [{ id: 't1' }] };
        };
        await review.runNightlyReview(deps);
        expect(seen.bulletins[0]).toMatchObject({ agentId: 'security', type: 'security_finding' });
        expect(seen.followups[0].bulletin.data.fullReview).toContain('HIGH: hardcoded key');
        expect(seen.followups[0].opts).toEqual({ includeMedium: false });
        expect(seen.ops.join('\n')).toContain('Security Auto-Task Pipeline');
    });

    test('follow-up disabled: bulletin only', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness({ config: { SECURITY_FOLLOWUP_ENABLED: false } });
        await review.runNightlyReview(deps);
        expect(seen.bulletins).toHaveLength(1);
        expect(seen.followups).toHaveLength(0);
    });
});

describe('every failure reaches #sqtools-ops', () => {
    test('a repository that cannot be cloned is named in the report and in ops', async () => {
        const { deps, seen } = harness();
        deps.git = { ...gitReads, cloneRepo: async () => { throw new Error('Repository not found'); } };
        const verdict = await review.runNightlyReview(deps);
        expect(verdict).toMatchObject({ ok: false, status: 'partial', posted: true });
        expect(seen.posts[0].text).toContain('Could not review');
        expect(seen.ops.join('\n')).toContain('Repository not found');
    });

    test('a model failure is reported, not posted as a review', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness({ llm: { runLLM: async () => { throw new Error('Credit balance is too low'); } } });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.ok).toBe(false);
        expect(seen.ops.join('\n')).toContain('Credit balance is too low');
    });

    test('an empty review is a failure', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness({ llm: { runLLM: async () => ({ output: '  ' }) } });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.ok).toBe(false);
        expect(seen.ops.join('\n')).toContain('empty review');
    });

    test('a failed post is reported', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness({ slack: { chat: { postMessage: async () => { throw new Error('not_in_channel'); } } } });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict).toMatchObject({ ok: false, status: 'post_failed', posted: false });
        expect(seen.ops.join('\n')).toContain('not_in_channel');
        expect(seen.bulletins).toHaveLength(0);
    });

    test('no security agent with a channel: nothing reviewed, reported', async () => {
        const { deps, seen } = harness({ agent: null, loadAgentsFn: () => [OTHER] });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.status).toBe('no_channel');
        expect(seen.calls).toHaveLength(0);
        expect(seen.ops).toHaveLength(1);
    });

    test('a refused bulletin is reported', async () => {
        commitToOrigin('x\n', 'initial');
        const { deps, seen } = harness();
        deps.bulletinBoard.postBulletin = () => ({ success: false, error: 'unknown type' });
        const verdict = await review.runNightlyReview(deps);
        expect(verdict.status).toBe('partial');
        expect(seen.ops.join('\n')).toContain('unknown type');
    });

    test('it never throws, even when ops cannot be told', async () => {
        const { deps } = harness({ agent: null, loadAgentsFn: () => { throw new Error('boom'); },
            notifier: { notifyOps: async () => { throw new Error('ops down'); } } });
        await expect(review.runNightlyReview(deps)).resolves.toMatchObject({ ok: false, escalated: false });
    });
});
