'use strict';

/**
 * lib/task-queue-status.js
 *
 * The status vocabulary of a task-queue row, shared by the writers in
 * lib/task-queue.js and the readers in lib/task-queue-view.js. Its own module so
 * neither half has to require the facade back (a require cycle).
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): moved unchanged out of
 * lib/task-queue.js, which re-exports it as the same object.
 */

// Task statuses
const STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    INTERRUPTED: 'interrupted',
};

module.exports = { STATUS };
