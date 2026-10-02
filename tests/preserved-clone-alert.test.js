'use strict';

/**
 * tests/preserved-clone-alert.test.js
 *
 * Regression test for WORK-TODO #25: the preserved-clone alert must tell the owner
 * that the path is inside the container, how to reach it, and what deletes it.
 * The old text said only `Location: <path>` and "the clone was NOT deleted".
 */

const { formatPreservedCloneAlert, CONTAINER_NAME } = require('../lib/preserved-clone-alert');

const base = {
    description: 'Fix the parser',
    reason: 'local commits not on the remote',
    taskDir: '/tmp/bridge-agent/task-1790000000-123',
    workDir: '/tmp/bridge-agent',
    sourceLink: '<https://example.slack.com/archives/C1/p1|source>',
};

describe('formatPreservedCloneAlert', () => {
    const text = formatPreservedCloneAlert(base);

    test('keeps what the old alert said: task, reason, location, not deleted, source', () => {
        expect(text).toMatch(/Scratch clone preserved/);
        expect(text).toContain('Task: Fix the parser');
        expect(text).toContain('Reason: local commits not on the remote');
        expect(text).toContain('`/tmp/bridge-agent/task-1790000000-123`');
        expect(text).toMatch(/NOT deleted/);
        expect(text).toContain('Source: <https://example.slack.com/archives/C1/p1|source>');
    });

    test('says the path is inside the container, not on the NAS host', () => {
        expect(CONTAINER_NAME).toBe('jt-agent');
        expect(text).toMatch(/inside the `jt-agent` container/);
        expect(text).toMatch(/not on the NAS host/);
    });

    test('says how to reach it', () => {
        expect(text).toContain('docker exec -it jt-agent sh');
        expect(text).toContain('cd /tmp/bridge-agent/task-1790000000-123');
    });

    test('says a recreate deletes it unless WORK_DIR is on a mount, and a restart does not', () => {
        expect(text).toMatch(/survives `docker compose restart`/);
        expect(text).toMatch(/--force-recreate/);
        expect(text).toMatch(/deletes it\s+unless WORK_DIR \(`\/tmp\/bridge-agent`\) is on a mount/);
        expect(text).toMatch(/Push it before the container is recreated/);
    });

    test('names the configured WORK_DIR, not a hardcoded default', () => {
        const other = formatPreservedCloneAlert({ ...base, workDir: '/bridge/work', taskDir: '/bridge/work/task-9' });
        expect(other).toContain('WORK_DIR (`/bridge/work`)');
        expect(other).toContain('cd /bridge/work/task-9');
    });

    test('omits the Source line when no link is given', () => {
        const noLink = formatPreservedCloneAlert({ ...base, sourceLink: undefined });
        expect(noLink).not.toMatch(/Source:/);
    });
});
