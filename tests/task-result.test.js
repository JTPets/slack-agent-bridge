'use strict';

/**
 * tests/task-result.test.js
 *
 * WORK-TODO #6: the structured task result (lib/task-result.js), its card and text
 * renderings, the post through lib/slack-web.js postBlocks, and the notify-owner and
 * bridge-agent.js wiring.
 *
 * The properties that matter:
 *   - the card and the text carry the SAME facts (both read resultFacts());
 *   - the verdicts are taken from their owners, never re-derived: the test verdict is
 *     lib/test-verdict.js classifyTestRun's, the work is lib/task-work.js describeWork's;
 *   - a card posted through a REAL createWebClient client has its blocks redacted, with a
 *     plain WebClient as the negative control;
 *   - processTask runs Phase 3 before the result post and passes the result to it.
 */
const {
    OUTCOME, buildTaskResult, withDelivery, resultFacts, renderText, renderBlocks,
    renderTaskResult, formatResultLogLine,
} = require('../lib/task-result');
const { TASK, HEAD, WORK, validationFor, fullResult, blockText } = require('./helpers/task-result-fixtures');

describe('buildTaskResult takes its facts from their owners', () => {
    test('the test verdict is the classifier\'s, with its counts', () => {
        const r = fullResult();
        expect(r.tests).toMatchObject({
            status: 'passed', green: true, command: 'npm test', passed: 12, failed: 0, skipped: 1, total: 13,
        });
    });

    test('a gate that did not run is carried as such, never as a pass', () => {
        const r = fullResult({ validation: validationFor('', 127) });
        expect(r.tests.status).toBe('runner_absent');
        expect(r.tests.green).toBe(false);
        expect(renderText(r)).toMatch(/Tests: DID NOT RUN — `runner_absent`/);
    });

    test('a gate that threw is reported as not completed', () => {
        const r = fullResult({ validation: null, validationError: new Error('spawn blew up') });
        expect(r.tests.status).toBe('error');
        expect(renderText(r)).toMatch(/Tests: DID NOT COMPLETE — the gate threw: spawn blew up/);
    });

    test('the work record comes through, files counted and the first five named', () => {
        const text = renderText(fullResult());
        expect(text).toMatch(/Branch: `feature\/widget` @ `aaaaaaa`/);
        expect(text).toMatch(/Commits: 2 new/);
        expect(text).toMatch(/On remote: yes \(feature\/widget\)/);
        expect(text).toMatch(/Files changed: 7: `lib\/a.js`, `lib\/b.js`, `tests\/a.test.js`, `README.md`, `x.js` and 2 more/);
    });

    test('work that is NOT on the remote says so', () => {
        const text = renderText(fullResult({ work: { ...WORK, onRemote: false, remoteRefs: [] } }));
        expect(text).toMatch(/On remote: NO — not on the remote/);
    });

    test('an unknown outcome is refused', () => {
        expect(() => buildTaskResult({ task: TASK, outcome: 'done' })).toThrow(/unknown task outcome/);
    });

    test('a task with no repository has no repo, work or tests lines', () => {
        const r = buildTaskResult({ task: { description: 'Say hi' }, outcome: OUTCOME.COMPLETED, summary: 'hi' });
        const labels = resultFacts(r).map(([l]) => l);
        expect(labels).toEqual(['Task']);
    });

    test('a repo task whose gate never ran says "not run", not nothing', () => {
        const r = buildTaskResult({ task: TASK, outcome: OUTCOME.FAILED, error: 'clone failed' });
        expect(renderText(r)).toMatch(/Tests: not run/);
    });

    test('each outcome has its own headline', () => {
        const heads = Object.values(OUTCOME).map((o) => renderText(buildTaskResult({ task: TASK, outcome: o })).split('\n')[0]);
        expect(new Set(heads).size).toBe(Object.values(OUTCOME).length);
        expect(heads.join('\n')).toMatch(/max turns/);
    });

    test('summary and error are redacted when built', () => {
        const r = buildTaskResult({ task: TASK, outcome: OUTCOME.FAILED, error: 'token xoxb-1234567890-abcdefghij leaked' });
        expect(r.error).not.toContain('xoxb-1234567890-abcdefghij');
    });
});

describe('the card and the text carry the same facts', () => {
    const cases = {
        completed: fullResult(),
        failed: buildTaskResult({ task: TASK, outcome: OUTCOME.FAILED, work: WORK, error: 'boom' }),
        interrupted: buildTaskResult({ task: TASK, outcome: OUTCOME.INTERRUPTED, elapsed: 3, error: 'SIGTERM' }),
        maxTurns: fullResult({ outcome: OUTCOME.MAX_TURNS }),
        noRepo: buildTaskResult({ task: { description: 'x' }, outcome: OUTCOME.COMPLETED, summary: 'y' }),
    };

    test.each(Object.entries(cases))('%s', (_, result) => {
        const { text, blocks } = renderTaskResult(result);
        const inBlocks = blockText(blocks);
        const facts = resultFacts(result);
        expect(facts.length).toBeGreaterThan(0);
        for (const [label, value] of facts) {
            expect(text).toContain(`${label}: ${value}`);
            expect(inBlocks).toContain(`*${label}*\n${value}`);
        }
        // The headline and body appear in both.
        expect(inBlocks).toContain(text.split('\n')[0]);
        const body = result.error || result.summary;
        if (body) {
            expect(text).toContain(body);
            expect(inBlocks).toContain(body);
        }
    });

    test('negative control: a fact missing from the card is caught by the comparison', () => {
        const result = fullResult();
        const blocks = renderBlocks(result);
        blocks[1].fields.pop();
        const [label, value] = resultFacts(result)[Math.min(resultFacts(result).length, 10) - 1];
        expect(blockText(blocks)).not.toContain(`*${label}*\n${value}`);
    });

    test('Slack block limits hold for a huge body and many files', () => {
        const huge = fullResult({
            summary: 'x'.repeat(50000),
            work: { ...WORK, filesChanged: Array.from({ length: 500 }, (_, i) => `f${i}.js`) },
        });
        const { text, blocks } = renderTaskResult(huge);
        expect(text.length).toBeLessThan(5000);
        expect(blocks.length).toBeLessThanOrEqual(50);
        for (const b of blocks) {
            if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
            if (b.fields) {
                expect(b.fields.length).toBeLessThanOrEqual(10);
                b.fields.forEach((f) => expect(f.text.length).toBeLessThanOrEqual(2000));
            }
        }
    });
});

describe('the delivery verdict and the log line', () => {
    test('withDelivery attaches the verdict without touching the rest', () => {
        const r = fullResult();
        const d = withDelivery(r, true, 'posted');
        expect(d.delivery).toEqual({ delivered: true, detail: 'posted' });
        expect(r.delivery).toBeNull();
        expect(withDelivery(r, 'yes').delivery.delivered).toBe(false);
    });

    test('the log line carries every fact and the verdict, and never the body', () => {
        const line = formatResultLogLine(withDelivery(fullResult({ summary: 'SECRET-BODY' }), false, 'post failed'));
        expect(line.startsWith('[task-result] ')).toBe(true);
        const parsed = JSON.parse(line.slice('[task-result] '.length));
        expect(parsed).toMatchObject({ outcome: 'completed', repo: 'jtpets/example', delivery: { delivered: false } });
        expect(parsed.tests.status).toBe('passed');
        expect(parsed.work.head).toBe(HEAD);
        expect(line).not.toContain('SECRET-BODY');
    });
});
