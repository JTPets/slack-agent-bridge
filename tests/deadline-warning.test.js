'use strict';

/**
 * tests/deadline-warning.test.js
 *
 * WORK-TODO #7: a running task is announced in #sqtools-ops at 80% of TASK_TIMEOUT_MS.
 * lib/llm-runner.js fires the callback (tests/llm-runner-deadline.test.js proves the
 * timing against a real child). This suite proves the text, and that processTask's
 * LLM call actually passes the callback, read from bridge-agent.js's source because the
 * module cannot be loaded without live Slack configuration.
 */

const fs = require('fs');
const path = require('path');
const { formatDeadlineWarning } = require('../lib/deadline-warning');

describe('formatDeadlineWarning', () => {
    const base = { description: 'Fix the parser', elapsedMs: 480000, remainingMs: 120000, timeoutMs: 600000 };

    test('says how long it has run, the limit, the time left and what a kill means', () => {
        const text = formatDeadlineWarning({ ...base, repo: 'jtpets/slack-agent-bridge', agentId: 'code-bridge' });
        expect(text).toContain('after 8 min of its 10 min limit');
        expect(text).toContain('"Fix the parser" (agent code-bridge, repo jtpets/slack-agent-bridge)');
        expect(text).toContain('finished in 2 min it will be killed');
        expect(text).toMatch(/not re-run/);
    });

    test('names the max-turns retry and shows seconds under a minute', () => {
        const text = formatDeadlineWarning({ description: 'x', elapsedMs: 4000, remainingMs: 1000, timeoutMs: 5000, isRetry: true });
        expect(text).toContain('(max-turns retry)');
        expect(text).toContain('after 4 s of its 5 s limit');
        expect(text).toContain('finished in 1 s');
    });
});

describe('processTask passes the warning to the LLM call', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    const start = src.indexOf('async function processTask(');
    const body = src.slice(start, src.indexOf('\nasync function ', start + 10));
    const call = body.slice(body.indexOf('runWithFallback(prompt, {'));
    const options = call.slice(0, call.indexOf('});'));

    test('the task path calls runWithFallback with onDeadlineWarning posting formatDeadlineWarning to ops', () => {
        expect(start).toBeGreaterThan(-1);
        expect(options).toMatch(/timeout:\s*TASK_TIMEOUT/);
        expect(options).toMatch(/onDeadlineWarning:\s*\(info\)\s*=>\s*postToOps\(formatDeadlineWarning\(/);
    });

    test('the extraction would notice the callback missing (negative control)', () => {
        const without = options.replace(/onDeadlineWarning[\s\S]*$/, '');
        expect(/onDeadlineWarning:/.test(without)).toBe(false);
    });
});
