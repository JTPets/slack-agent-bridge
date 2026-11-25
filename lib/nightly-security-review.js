'use strict';

/**
 * lib/nightly-security-review.js
 *
 * The security agent's nightly review of the last 24 hours of commits: deterministic
 * scheduled task `nightly-audit`. Code clones each configured repository, reads the
 * window's commits and diff (lib/security-review-git.js), and gives them to the model;
 * the model's review is the one part a model is for.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #83): New file. `nightly-audit` was a TASK_TEMPLATES
 * entry, a prose instruction ("Review all commits to monitored repos from the last 24
 * hours") posted as a TASK: with no REPO:, so the model ran with no clone and no git and
 * every night's report said it could not review the last 24 hours. The code that could,
 * security-review.js, was a cron script whose runner died with the Raspberry Pi. Same
 * defect and same fix as `check-inbox` (2026-09-14) and `weekly-critique` (2026-09-16).
 *
 * The model run is confined:
 *   - `runLLM`, not `runWithFallback`: a failure is reported, never moved to another engine.
 *   - NO TOOLS. The diff is in the prompt, so the run is given an agent record with no
 *     permissions (lib/agent-tools.js turns that into `--tools ""`), and its cwd is a fresh
 *     EMPTY temp directory, not the clone. Both temp dirs are removed in `finally`.
 *   - One turn.
 * Every failure (a repo that cannot be reviewed, the post, a bulletin, the follow-up
 * pipeline) is reported to #sqtools-ops through notifyOps. It never throws.
 */

const fs = require('fs').promises;
const os = require('os');
const path = require('path');

const { assertValidRepo } = require('./git-identifiers');

/** The scheduled task this module implements. Used to find its owning agent. */
const TASK_NAME = 'nightly-audit';
const REVIEW_TURNS = 1;
const MAX_DIFF_CHARS = 50000;
const SKILL_PATH = path.join(__dirname, '..', 'skills', 'security-review', 'SKILL.md');

/**
 * Which agent owns the review: the one whose `schedule.task` is this task, from the same
 * declaration the cron registrar reads. The passed agent wins only when it is that agent,
 * so `ASK: audit` typed anywhere posts in the security agent's channel.
 */
function resolveReviewer(passed, load) {
    if (passed && passed.schedule && passed.schedule.task === TASK_NAME) return passed;
    let agents = [];
    try {
        agents = load() || [];
    } catch (err) {
        console.error('[nightly-audit] Could not load the agent registry:', err.message);
    }
    return agents.find(a => a.schedule && a.schedule.task === TASK_NAME) || null;
}

/** The agent record a model run is governed by: the reviewer with every tool removed. */
function toolless(agent) {
    return { ...agent, permissions: [], denied: ['claude-code', 'file-system', 'github'] };
}

function buildReviewPrompt(skillPrompt, repo, commitLog, diff) {
    return `${skillPrompt}

## Repository: ${repo}

## Commits from last 24 hours:
${commitLog}

## Diff to review:
\`\`\`
${diff.slice(0, MAX_DIFF_CHARS)}
\`\`\`
${diff.length > MAX_DIFF_CHARS ? `\n(diff truncated to ${MAX_DIFF_CHARS / 1000}KB)` : ''}

You have no tools: everything there is to review is above. Review these changes for security issues.`;
}

/**
 * Review one repository. Returns null when the window has no commits (or no diff), the
 * result otherwise; throws on anything that stops the review, for the caller to report.
 *
 * @param {string} repo
 * @param {string} skillPrompt
 * @param {object} ctx - { git, llm, llmOptions }
 */
async function reviewRepo(repo, skillPrompt, ctx) {
    const { git, llm, llmOptions = {} } = ctx;
    // Asserted before the value builds a path: replace('/') replaces only the FIRST slash.
    assertValidRepo(repo);
    let cloneDir;
    let runDir;
    try {
        cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), `security-review-${repo.replace('/', '-')}-`));
        await git.cloneRepo(repo, cloneDir);
        const commits = await git.getRecentCommits(cloneDir);
        if (commits.length === 0) return null;
        const commitLog = await git.getCommitLog(cloneDir, commits);
        const diff = await git.getDiff(cloneDir, commits);
        if (!diff) return null;

        runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'security-review-run-'));
        const { output } = await llm.runLLM(buildReviewPrompt(skillPrompt, repo, commitLog, diff), {
            maxTurns: REVIEW_TURNS,
            agentId: 'security',
            ...llmOptions,
            cwd: runDir,
        });
        const review = (output ? String(output) : '').trim();
        if (!review) throw new Error('the model returned an empty review');
        return { repo, commitCount: commits.length, commitLog, review };
    } finally {
        for (const dir of [cloneDir, runDir]) {
            if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

/** Review every repository; one failure never stops the others. */
async function reviewAll(repos, skillPrompt, ctx) {
    const results = [];
    const errors = [];
    for (const repo of repos) {
        try {
            const result = await reviewRepo(repo, skillPrompt, ctx);
            if (result) results.push(result);
        } catch (err) {
            console.error(`[nightly-audit] Error reviewing ${repo}:`, err.message);
            errors.push({ repo, error: err.message });
        }
    }
    return { results, errors };
}

/** The report text. Says which repositories had nothing, so a short post is evidence. */
function buildReport({ results, errors }, repos) {
    const lines = ['*Daily Security Review* (commits from the last 24 hours)', ''];
    const reviewed = new Set([...results.map(r => r.repo), ...errors.map(e => e.repo)]);
    const quiet = repos.filter(r => !reviewed.has(r));
    for (const result of results) {
        lines.push(`*${result.repo}* (${result.commitCount} commits)`, '', result.review, '', '---', '');
    }
    if (quiet.length > 0) lines.push(`No commits in the last 24 hours: ${quiet.join(', ')}`);
    if (errors.length > 0) {
        lines.push('', '*Could not review:*');
        for (const { repo, error } of errors) lines.push(`- ${repo}: ${error}`);
    }
    return lines.join('\n');
}

/**
 * The bulletin and the security follow-up (CRITICAL/HIGH findings become remediation
 * tasks in the APPROVAL QUEUE; nothing runs until approved). Returns the failures.
 */
async function publishFindings(results, ctx) {
    const { slack, bulletinBoard, securityFollowup, config, report } = ctx;
    const failures = [];
    for (const result of results) {
        try {
            const posted = bulletinBoard.postBulletin('security', 'security_finding', {
                description: `Security review of ${result.repo}: ${result.commitCount} commit(s) reviewed`,
                repo: result.repo,
                commitCount: result.commitCount,
                summary: result.review.slice(0, 500),
                fullReview: result.review,
            });
            if (!posted || !posted.success) {
                failures.push(`bulletin for ${result.repo} was refused: ${(posted && posted.error) || 'no reason given'}`);
                continue;
            }
            if (!config.SECURITY_FOLLOWUP_ENABLED) continue;
            const followup = await securityFollowup.processSecurityBulletin(
                slack,
                { ...posted.bulletin, data: { ...posted.bulletin.data, fullReview: result.review } },
                { includeMedium: config.SECURITY_FOLLOWUP_INCLUDE_MEDIUM }
            );
            if (followup.tasks.length > 0) {
                await report(`*Security Auto-Task Pipeline* (${result.repo})\n${securityFollowup.formatFollowupSummary(followup)}`);
            }
        } catch (err) {
            failures.push(`bulletin or follow-up for ${result.repo} failed: ${err.message}`);
        }
    }
    return failures;
}

function defaultDeps() {
    return {
        git: require('./security-review-git'),
        llm: require('./llm-runner'),
        notifier: require('./notify-owner'),
        bulletinBoard: require('./bulletin-board'),
        securityFollowup: require('./security-followup'),
        config: require('./config').config,
        repos: require('./config').getConfiguredRepos(),
        loadAgentsFn: require('./agent-registry').loadAgents,
        resolveLlm: require('./agent-llm-resolver').resolveAgentLlm,
        readSkill: () => fs.readFile(SKILL_PATH, 'utf8'),
    };
}

/**
 * Run one nightly review and post it in the security agent's channel.
 *
 * @param {object} [deps] - { slack, agent } plus injectable dependencies (tests).
 * @returns {Promise<object>} Verdict { ok, status, channel, reviewed, errors, posted }.
 */
async function runNightlyReview(deps = {}) {
    const d = { ...defaultDeps(), ...deps };
    const escalate = async (status, message) => {
        console.error(`[nightly-audit] ${status}: ${message}`);
        try {
            return await d.notifier.notifyOps(`:rotating_light: *Nightly security review* — ${status}\n${message}`);
        } catch (err) {
            console.error('[nightly-audit] Could not escalate:', err.message);
            return false;
        }
    };
    const fail = async (status, message, extra = {}) => ({
        ok: false, status, error: message, posted: false, channel: null, ...extra,
        escalated: await escalate(status, message),
    });

    const reviewer = resolveReviewer(d.agent, d.loadAgentsFn);
    if (!reviewer || !reviewer.channel) {
        return fail('no_channel', `No agent with a resolved channel runs \`${TASK_NAME}\`; nothing was reviewed.`);
    }
    let skillPrompt;
    try {
        skillPrompt = await d.readSkill();
    } catch (err) {
        return fail('no_skill', `Could not read the review prompt (skills/security-review/SKILL.md): ${err.message}`);
    }

    const resolved = d.resolveLlm(reviewer);
    const outcome = await reviewAll(d.repos, skillPrompt, {
        git: d.git,
        llm: d.llm,
        llmOptions: { provider: resolved.provider, model: resolved.model, agentId: reviewer.id, agentRecord: toolless(reviewer) },
    });
    const channel = reviewer.channel;
    const base = { channel, reviewed: outcome.results.length, errors: outcome.errors };

    let posted = false;
    let postError = null;
    if (!d.slack) {
        postError = 'no Slack client was supplied';
    } else {
        try {
            await d.slack.chat.postMessage({ channel, text: buildReport(outcome, d.repos), unfurl_links: false });
            posted = true;
        } catch (err) {
            postError = err.message;
        }
    }
    if (!posted) return fail('post_failed', `The report did not reach <#${channel}>: ${postError}`, base);

    const failures = outcome.errors.map(e => `${e.repo} could not be reviewed: ${e.error}`);
    failures.push(...await publishFindings(outcome.results, {
        slack: d.slack, bulletinBoard: d.bulletinBoard, securityFollowup: d.securityFollowup,
        config: d.config, report: (t) => d.notifier.notifyOps(t),
    }));
    if (failures.length > 0) {
        return { ...base, ok: false, status: 'partial', posted: true, error: failures.join('; '), escalated: await escalate('partial', failures.join('\n')) };
    }
    return { ...base, ok: true, status: 'ok', posted: true, error: null, escalated: false };
}

module.exports = {
    TASK_NAME,
    REVIEW_TURNS,
    runNightlyReview,
    // Shared with security-review.js and exported for testing
    reviewRepo,
    reviewAll,
    buildReport,
    publishFindings,
    resolveReviewer,
    toolless,
    buildReviewPrompt,
};
