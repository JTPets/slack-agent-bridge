'use strict';

/**
 * tests/helpers/task-spoke-fixtures.js
 *
 * WORK-TODO #10, B36 (2026-11-25): what the two task-spoke suites share
 * (tests/task-hub.test.js and tests/task-spokes.test.js): a temp directory per test,
 * a REAL TaskQueue on a file in it served by getQueue(), one queued row, and silenced
 * console output. Call useTaskSpokeFixtures() at the top of a suite.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function useTaskSpokeFixtures() {
    const state = { tmp: null };
    beforeEach(() => { state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-spoke-')); });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(state.tmp, { recursive: true, force: true });
    });

    return {
        tmp: () => state.tmp,
        quiet() {
            for (const m of ['log', 'warn', 'error']) jest.spyOn(console, m).mockImplementation(() => {});
        },
        /** A real TaskQueue on a temp file, served by getQueue() for the spokes. */
        useTempQueue() {
            const taskQueue = require('../../lib/task-queue');
            const queue = new taskQueue.TaskQueue(path.join(state.tmp, 'task-queue.json'));
            jest.spyOn(taskQueue, 'getQueue').mockReturnValue(queue);
            return queue;
        },
        enqueue(queue) {
            return queue.enqueue({
                msgTs: '1700000000.000100', channelId: 'C_BRIDGE', text: 'TASK: t\nINSTRUCTIONS: x',
                description: 't', repo: null,
            }).id;
        },
        /** The persisted row for `id`. */
        row(queue, id) {
            return JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find((r) => r.id === id);
        },
    };
}

module.exports = { useTaskSpokeFixtures };
