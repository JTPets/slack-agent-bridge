'use strict';

/**
 * lib/task-result.js
 *
 * WORK-TODO #6: ONE shape for "how did this task end", rendered as a Slack Block Kit card
 * and a plain-text fallback that carry the same facts.
 *
 * LOGIC CHANGE 2026-11-12: new file. A finished task used to post a raw dump of the
 * model's output with an elapsed time and nothing else; whether it pushed, what it
 * changed and whether its tests ran were in three other posts or nowhere. The result now
 * collects facts the bridge already has, and computes none of them itself:
 *   - outcome: completed / failed / interrupted / max-turns (processTask decides).
 *   - repo, branch and head, commits added, files changed: lib/task-work.js describeWork.
 *   - the Phase-3 test verdict: validateOutput's testRun, i.e. lib/test-verdict.js
 *     classifyTestRun. Never re-parsed here.
 *   - the delivery verdict: known only AFTER the card is posted, so it is attached with
 *     withDelivery() and goes into the `[task-result]` log line, not onto the card.
 *
 * resultFacts() is the single list both renderers read, so the card and the text cannot
 * carry different facts (tests/task-result.test.js compares them). Pure: posts nothing.
 */

const { redact } = require('./redact-secrets');

const OUTCOME = {
    COMPLETED: 'completed',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted',
    MAX_TURNS: 'max-turns',
};

const HEADLINE = {
    [OUTCOME.COMPLETED]: ':white_check_mark: Task completed',
    [OUTCOME.FAILED]: ':x: Task failed',
    [OUTCOME.INTERRUPTED]: ':warning: Task interrupted',
    [OUTCOME.MAX_TURNS]: ':hourglass: Task stopped at max turns (may be partial)',
};

const TEXT_BODY_MAX = 3500;   // the old completion post's limit
const BLOCK_BODY_MAX = 2800;  // a section's text is capped at 3000 by Slack
const FIELD_MAX = 1900;       // a field is capped at 2000
const FIELDS_PER_SECTION = 10;
const FILES_SHOWN = 5;

function clip(text, max) {
    const s = String(text || '');
    if (s.length <= max) return s;
    const half = Math.floor((max - 24) / 2);
    return `${s.slice(0, half)}\n... [truncated] ...\n${s.slice(-half)}`;
}

/** The Phase-3 verdict reduced to what the card says, or null when no gate applies. */
function testsFrom(validation, validationError) {
    if (validationError) {
        return { status: 'error', command: null, reason: `the gate threw: ${validationError.message || validationError}` };
    }
    if (!validation || !validation.testRun) return null;
    const run = validation.testRun;
    const a = run.assertions || {};
    return {
        status: run.outcome,
        green: run.green === true,
        command: validation.testCommand || null,
        passed: a.passed ?? null,
        failed: a.failed ?? null,
        skipped: a.skipped ?? null,
        total: a.total ?? null,
        reason: run.reason || null,
    };
}

/**
 * Build the result record.
 *
 * @param {object} p
 * @param {object} p.task - Parsed task (description, repo, branch).
 * @param {string} p.outcome - One of OUTCOME.
 * @param {string|number} [p.elapsed] - Seconds.
 * @param {string} [p.provider] - LLM engine that served the task.
 * @param {object} [p.work] - lib/task-work.js describeWork() result.
 * @param {object} [p.validation] - validateOutput() result.
 * @param {Error} [p.validationError] - validateOutput() threw.
 * @param {string} [p.summary] - The model's output.
 * @param {string} [p.error] - Failure or interruption reason.
 * @param {string} [p.sourceLink] - Slack mrkdwn link to the source message.
 * @returns {object}
 */
function buildTaskResult({
    task = {}, outcome, elapsed = null, provider = null, work = null,
    validation = null, validationError = null, summary = '', error = null, sourceLink = null,
} = {}) {
    if (!Object.values(OUTCOME).includes(outcome)) {
        throw new Error(`unknown task outcome: ${outcome}`);
    }
    return {
        outcome,
        description: task.description || 'Unknown task',
        repo: task.repo || null,
        requestedBranch: task.repo ? (task.branch || 'main') : null,
        elapsed: elapsed === null || elapsed === undefined ? null : String(elapsed),
        provider: provider || null,
        sourceLink: sourceLink || null,
        work: work ? {
            branch: work.branch || null,
            head: work.head || null,
            newCommits: work.newCommits ?? null,
            filesChanged: Array.isArray(work.filesChanged) ? work.filesChanged : null,
            onRemote: work.onRemote ?? null,
            remoteRefs: Array.isArray(work.remoteRefs) ? work.remoteRefs : [],
            note: work.note || null,
        } : null,
        tests: testsFrom(validation, validationError),
        summary: redact(String(summary || '')),
        error: error ? redact(String(error)) : null,
        delivery: null,
    };
}

/** A copy of the result with its delivery verdict, once the post has been attempted. */
function withDelivery(result, delivered, detail) {
    return { ...result, delivery: { delivered: delivered === true, detail: detail || null } };
}

function describeTests(t) {
    if (!t) return null;
    if (t.status === 'error') return `DID NOT COMPLETE — ${t.reason}`;
    const cmd = t.command ? ` (\`${t.command}\`)` : '';
    if (t.status === 'passed' || t.status === 'failed') {
        const skipped = t.skipped ? `, ${t.skipped} skipped` : '';
        return `${t.status} — ${t.passed} passed, ${t.failed} failed${skipped}${cmd}`;
    }
    return `DID NOT RUN — \`${t.status}\`${cmd}: ${t.reason}`;
}

function workFacts(w) {
    if (!w.head) return { branch: w.note || 'not recorded' };
    const commits = w.newCommits === null ? 'unknown' : `${w.newCommits} new`;
    let remote = 'not checked';
    if (w.onRemote === true) remote = `yes (${w.remoteRefs.map((r) => r.replace('refs/heads/', '')).join(', ')})`;
    else if (w.onRemote === false) remote = 'NO — not on the remote';
    let files = 'unknown';
    if (w.filesChanged) {
        const shown = w.filesChanged.slice(0, FILES_SHOWN).map((f) => `\`${f}\``).join(', ');
        const more = w.filesChanged.length > FILES_SHOWN ? ` and ${w.filesChanged.length - FILES_SHOWN} more` : '';
        files = w.filesChanged.length ? `${w.filesChanged.length}: ${shown}${more}` : '0';
    }
    return { branch: `\`${w.branch || 'detached'}\` @ \`${w.head.slice(0, 7)}\``, commits, remote, files };
}

/**
 * THE facts, in order, as [label, value]. Both renderers read only this.
 *
 * @param {object} result - buildTaskResult()
 * @returns {Array<[string, string]>}
 */
function resultFacts(result) {
    const facts = [['Task', result.description]];
    if (result.repo) facts.push(['Repo', `\`${result.repo}\` (from \`${result.requestedBranch}\`)`]);
    if (result.work) {
        const w = workFacts(result.work);
        facts.push(['Branch', w.branch]);
        if (w.commits) facts.push(['Commits', w.commits], ['On remote', w.remote], ['Files changed', w.files]);
    }
    const tests = describeTests(result.tests);
    if (tests) facts.push(['Tests', tests]);
    else if (result.repo) facts.push(['Tests', 'not run']);
    if (result.provider) facts.push(['Engine', result.provider]);
    if (result.elapsed !== null) facts.push(['Elapsed', `${result.elapsed}s`]);
    if (result.sourceLink) facts.push(['Source', result.sourceLink]);
    return facts;
}

/** The body under the facts: the error for a failure, else the model's output. */
function bodyOf(result) {
    return result.error || result.summary || '';
}

/** Plain-text fallback: the same facts, one per line, then the body. */
function renderText(result) {
    const lines = [`*${HEADLINE[result.outcome]}*`];
    for (const [label, value] of resultFacts(result)) lines.push(`${label}: ${value}`);
    const body = bodyOf(result);
    if (body) lines.push('', '```', clip(body, TEXT_BODY_MAX), '```');
    return lines.join('\n');
}

/** Block Kit card: a header, the facts as fields, then the body. */
function renderBlocks(result) {
    const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `*${HEADLINE[result.outcome]}*` } }];
    const facts = resultFacts(result);
    for (let i = 0; i < facts.length; i += FIELDS_PER_SECTION) {
        blocks.push({
            type: 'section',
            fields: facts.slice(i, i + FIELDS_PER_SECTION).map(([label, value]) => ({
                type: 'mrkdwn',
                text: clip(`*${label}*\n${value}`, FIELD_MAX),
            })),
        });
    }
    const body = bodyOf(result);
    if (body) {
        blocks.push({ type: 'divider' });
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${clip(body, BLOCK_BODY_MAX)}\n\`\`\`` } });
    }
    return blocks;
}

/** @returns {{ text: string, blocks: object[] }} */
function renderTaskResult(result) {
    return { text: renderText(result), blocks: renderBlocks(result) };
}

/** One structured log line carrying every fact and the delivery verdict, never the body. */
function formatResultLogLine(result) {
    const { summary, error, ...facts } = result;
    return `[task-result] ${redact(JSON.stringify({ ...facts, hasError: Boolean(error) }))}`;
}

module.exports = {
    OUTCOME,
    buildTaskResult,
    withDelivery,
    resultFacts,
    renderText,
    renderBlocks,
    renderTaskResult,
    formatResultLogLine,
};
