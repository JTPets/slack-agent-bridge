'use strict';

/**
 * tests/helpers/task-result-fixtures.js
 *
 * Shared fixtures for tests/task-result.test.js and tests/task-result-delivery.test.js
 * (WORK-TODO #6): one task, one work record, one fully populated result, and blockText(),
 * which flattens a Block Kit tree so a test can ask whether a fact appears in it.
 */

const { OUTCOME, buildTaskResult } = require('../../lib/task-result');
const { classifyTestRun } = require('../../lib/test-verdict');

const TASK = { description: 'Add a widget', repo: 'jtpets/example', branch: 'main' };
const HEAD = 'a'.repeat(40);
const WORK = {
    branch: 'feature/widget',
    head: HEAD,
    baseSha: 'b'.repeat(40),
    newCommits: 2,
    filesChanged: ['lib/a.js', 'lib/b.js', 'tests/a.test.js', 'README.md', 'x.js', 'y.js', 'z.js'],
    remoteRefs: ['refs/heads/feature/widget'],
    onRemote: true,
    note: null,
};
const validationFor = (stdout, exitCode, testCommand = 'npm test') => ({
    testRun: classifyTestRun({ command: testCommand, exitCode, stdout }),
    testCommand,
});

function fullResult(overrides = {}) {
    return buildTaskResult({
        task: TASK,
        outcome: OUTCOME.COMPLETED,
        elapsed: '42',
        provider: 'claude',
        work: WORK,
        validation: validationFor('Tests:       1 skipped, 12 passed, 13 total\n', 0),
        summary: 'Did the thing.',
        sourceLink: '<https://example.slack.com/x|source>',
        ...overrides,
    });
}

/** Every string inside a block tree, joined. */
function blockText(blocks) {
    const out = [];
    const walk = (v) => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(blocks);
    return out.join('\n');
}

module.exports = { TASK, HEAD, WORK, validationFor, fullResult, blockText };
