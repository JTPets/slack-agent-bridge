'use strict';

/**
 * tests/task-rerun-guard.test.js
 *
 * THE GUARD for WORK-TODO #23: a task killed mid-run is not re-read and re-run on
 * the next poll.
 *
 * The poll loop's dedup guards were both written only AFTER the task finished, so
 * a kill (a container restart, an OOM, a task that crashes the bridge) left the
 * message looking unprocessed and it ran again on the next poll - a loop under
 * `restart: unless-stopped`. The fix marks the message processed between the
 * enqueue and the run. A kill cannot reach into processTask's `finally`, and it
 * cannot reach code after `await currentTaskPromise`, so the mark has to precede
 * the run. This suite reads the poll loop's TASK: branch from bridge-agent.js's own
 * source, because the property is an ordering and no mocked run can observe it.
 */

const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

/** The TASK: branch, from the admitting dedup check to the run's await. */
function taskBranch(src) {
    const start = src.indexOf('if (isTaskMessage(msg) && !alreadyProcessed(msg)');
    if (start < 0) return null;
    const end = src.indexOf('await currentTaskPromise;', start);
    if (end < 0) return null;
    // Include the rest of the branch up to its `continue;` so a late mark is visible.
    const close = src.indexOf('continue;\n        }', end);
    return { pre: src.slice(start, end), post: src.slice(end, close < 0 ? end + 1500 : close) };
}

/** Violations of "marked after the enqueue, before the run, and not only after it". */
function check(src) {
    const b = taskBranch(src);
    if (!b) return ['TASK: branch not found'];
    const out = [];
    const enqueueIdx = b.pre.indexOf('queue.enqueue(');
    const runIdx = b.pre.indexOf('processTask(msg');
    // the drain refusal's own mark sits before the enqueue; look only after it
    const markIdx = enqueueIdx < 0 ? -1 : b.pre.indexOf('markTaskProcessed(msg.ts)', enqueueIdx);
    if (enqueueIdx < 0) out.push('no enqueue in the TASK: branch');
    if (runIdx < 0) out.push('no processTask call in the TASK: branch');
    if (markIdx < 0) out.push('message is not marked processed between enqueue and run');
    else if (runIdx >= 0 && markIdx > runIdx) out.push('message is marked processed after the run starts');
    return out;
}

describe('the guard detects what it claims to (negative controls)', () => {
    test('a mark only after the await is reported', () => {
        const mutated = SOURCE
            .replace(/\n\s*markTaskProcessed\(msg\.ts\);\n(\s*isRunning = true;)/, '\n$1')
            .replace('currentTaskPromise = null;\n\n          isRunning = false;',
                'currentTaskPromise = null;\n\n          isRunning = false;\n          markTaskProcessed(msg.ts);');
        expect(mutated).not.toBe(SOURCE);
        expect(check(mutated)).toContain('message is not marked processed between enqueue and run');
    });

    test('a mark moved below the processTask call is reported', () => {
        const mutated = SOURCE
            .replace(/\n\s*markTaskProcessed\(msg\.ts\);\n(\s*isRunning = true;)/, '\n$1');
        const withLate = mutated.replace(/(currentTaskPromise = processTask\(msg, channelId[^\n]*\n)/,
            '$1          markTaskProcessed(msg.ts);\n');
        expect(check(withLate).length).toBeGreaterThan(0);
    });

    test('a source with no TASK: branch is reported, not passed', () => {
        expect(check('const x = 1;')).toEqual(['TASK: branch not found']);
    });
});

describe('bridge-agent.js marks a TASK: message processed before running it', () => {
    test('the mark sits between the enqueue and processTask', () => {
        expect(check(SOURCE)).toEqual([]);
    });

    test('the run is still awaited inside the branch (the slice is the real branch)', () => {
        const b = taskBranch(SOURCE);
        expect(b.pre).toContain('drainStateForDispatch()');
        expect(b.pre).toContain('currentTaskPromise = processTask(msg, channelId, queuedTask.id, channelAgentConfig)');
    });
});
