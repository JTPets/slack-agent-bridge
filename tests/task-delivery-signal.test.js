'use strict';

/**
 * tests/task-delivery-signal.test.js
 *
 * THE GUARD for "a finished task is a DELIVERED task".
 *
 * Why this file exists
 * --------------------
 * Applying a self-update restarts the process. A drain that waits for "the task
 * finished" is only safe if finished means RESULT DELIVERED — because a task that
 * completed and never posted is, in every durable record, identical to one that
 * never ran. Before this change:
 *
 *   - `notifyOwner.taskCompleted()` returns a BOOLEAN and `notifyChannel()` returns
 *     false on a Slack failure rather than throwing (lib/notify-owner.js).
 *   - `processTask` awaited it and DISCARDED the value, then set `taskSuccess = true`
 *     and wrote `queue.complete(...)` regardless.
 *   - `output` is a local variable; it is gone when the function returns.
 *
 * So the queue said `completed` for a task whose result reached nobody, and the
 * update gate had no signal it could trust.
 *
 * Two halves, because either alone is insufficient:
 *
 *   1. THE ORDERING, read out of bridge-agent.js's own source. The delivery must
 *      happen BEFORE the terminal queue write, which must happen before the lock is
 *      released. Today that holds; nothing asserted it, so it was incidental, and
 *      "two mechanisms that agree today are not a lock". Moving the terminal write
 *      above the post, or dropping the return value again, turns this suite red.
 *
 *   2. THE RECORD, replayed against a REAL TaskQueue on a real file: the verdict is
 *      persisted, a caller that records nothing gets `delivered: false` with a stated
 *      reason rather than an optimistic default, and a re-attempt clears the previous
 *      attempt's verdict.
 *
 * Both carry negative controls, because several live assertions are of the form
 * "this index is less than that one" — which a pair of missing indices also satisfies.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    TaskQueue,
    STATUS,
    deliveryRecorded,
    normalizeDelivery,
    DELIVERY_NOT_RECORDED,
} = require('../lib/task-queue');

const BRIDGE_AGENT_PATH = path.join(__dirname, '..', 'bridge-agent.js');
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Source extraction — the regions of processTask that end a task
// ---------------------------------------------------------------------------

/**
 * Slice processTask into the four regions that matter to this question.
 * Throws (via expect) rather than returning empty regions, so a rename cannot
 * quietly turn every assertion below into a vacuous pass.
 *
 * @param {string} src - bridge-agent.js source, or a mutated copy for the meta-tests
 */
function extractRegions(src) {
    const fnStart = src.indexOf('async function processTask(');
    expect(fnStart).toBeGreaterThan(-1);
    // processTask is top-level, so its close is the next `}` at column 0.
    const fnEnd = src.indexOf('\n}\n', fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = src.slice(fnStart, fnEnd);

    const intStart = body.indexOf('if (interrupted) {');
    expect(intStart).toBeGreaterThan(-1);
    const intEnd = body.indexOf('\n      return;', intStart);
    expect(intEnd).toBeGreaterThan(intStart);

    const catchStart = body.indexOf('\n  } catch (err) {');
    expect(catchStart).toBeGreaterThan(-1);

    const finallyStart = body.indexOf('\n  } finally {');
    expect(finallyStart).toBeGreaterThan(catchStart);

    return {
        body,
        interrupted: body.slice(intStart, intEnd),
        // Everything between the interrupted branch's return and the catch: the
        // ordinary success path.
        success: body.slice(intEnd, catchStart),
        failure: body.slice(catchStart, finallyStart),
        cleanup: body.slice(finallyStart),
    };
}

/**
 * The argument text of the first `call` in `region`, brace/paren matched.
 * Used to ask "does this terminal write carry a delivery verdict at all?" without
 * depending on how the argument list is line-wrapped.
 *
 * @param {string} region - Source region
 * @param {string} call - Literal call prefix, e.g. '.complete('
 * @returns {string|null} The argument text, or null when the call is absent
 */
function argsOf(region, call) {
    const at = region.indexOf(call);
    if (at === -1) return null;
    let depth = 0;
    const from = at + call.length - 1; // the '('
    for (let i = from; i < region.length; i++) {
        if (region[i] === '(') depth++;
        else if (region[i] === ')') {
            depth--;
            if (depth === 0) return region.slice(from + 1, i);
        }
    }
    return null;
}

describe('the delivery of a task result precedes the record that it finished', () => {
    let regions;

    beforeAll(() => {
        regions = extractRegions(source);
    });

    test('the success path captures the delivery outcome instead of discarding it', () => {
        // The value must be BOUND. `await notifyOwner.taskCompleted(...)` on its own
        // line is exactly the defect: the post happens and its verdict evaporates.
        expect(regions.success).toMatch(
            /(?:const|let)\s+\w+\s*=\s*await\s+notifyOwner\.taskCompleted\(/
        );
    });

    test('the success path delivers BEFORE it writes the terminal queue entry', () => {
        const delivered = regions.success.indexOf('notifyOwner.taskCompleted(');
        const terminal = regions.success.indexOf('.complete(');

        expect(delivered).toBeGreaterThan(-1);
        expect(terminal).toBeGreaterThan(-1);
        expect(delivered).toBeLessThan(terminal);
    });

    test('the terminal write on the success path carries a delivery verdict', () => {
        const args = argsOf(regions.success, '.complete(');
        expect(args).not.toBeNull();
        // Word-boundary matched: `x_delivered:` must NOT satisfy this, or the
        // negative control below would pass against a renamed field.
        expect(args).toMatch(/\bdelivered\s*:/);
    });

    test('a result that could not be delivered is surfaced, not swallowed', () => {
        // The repo's standing rule: a blocked write throws or records a SURFACED
        // verdict. Here both — a post to ops and a durable `delivered: false`.
        expect(regions.success).toContain('result was not delivered');
        expect(regions.success).toMatch(/postToOps\(/);
    });

    test('the failure path captures its report outcome and records it', () => {
        expect(regions.failure).toMatch(
            /(?:const|let)\s+\w+\s*=\s*await\s+notifyOwner\.taskFailed\(/
        );

        const reported = regions.failure.indexOf('notifyOwner.taskFailed(');
        const terminal = regions.failure.indexOf('.fail(');
        expect(reported).toBeGreaterThan(-1);
        expect(terminal).toBeGreaterThan(-1);
        expect(reported).toBeLessThan(terminal);

        const args = argsOf(regions.failure, '.fail(');
        expect(args).not.toBeNull();
        // Word-boundary matched: `x_delivered:` must NOT satisfy this, or the
        // negative control below would pass against a renamed field.
        expect(args).toMatch(/\bdelivered\s*:/);
    });

    test('the interrupted path captures its notice outcome and records it', () => {
        // For an interrupted task this post IS the result; there is no other output.
        expect(regions.interrupted).toMatch(
            /(?:const|let)\s+\w+\s*=\s*await\s+postToOps\(/
        );

        const posted = regions.interrupted.indexOf('postToOps(');
        const terminal = regions.interrupted.indexOf('.interrupt(');
        expect(posted).toBeGreaterThan(-1);
        expect(terminal).toBeGreaterThan(-1);
        expect(posted).toBeLessThan(terminal);

        const args = argsOf(regions.interrupted, '.interrupt(');
        expect(args).not.toBeNull();
        // Word-boundary matched: `x_delivered:` must NOT satisfy this, or the
        // negative control below would pass against a renamed field.
        expect(args).toMatch(/\bdelivered\s*:/);
    });

    test('the task lock is released only after every terminal write', () => {
        // The lock is the OTHER answer to "is a task running?", and auto-update reads
        // it. Releasing it before the delivery is recorded would hand the updater a
        // green light while the result is still in flight — the precise race the
        // drain exists to close.
        expect(regions.cleanup).toContain('taskLock.release(');
        expect(regions.success).not.toContain('taskLock.release(');
        expect(regions.failure).not.toContain('taskLock.release(');
        expect(regions.interrupted).not.toContain('taskLock.release(');
    });
});

describe('the guard itself detects what it claims to', () => {
    // Without these, every ordering assertion above could pass by finding nothing.

    test('it fails when the delivery return value is discarded again', () => {
        const broken = source.replace(
            /(?:const|let)\s+resultDelivered\s*=\s*await\s+notifyOwner\.taskCompleted\(/,
            'await notifyOwner.taskCompleted('
        );
        expect(broken).not.toBe(source);

        const r = extractRegions(broken);
        expect(r.success).not.toMatch(
            /(?:const|let)\s+\w+\s*=\s*await\s+notifyOwner\.taskCompleted\(/
        );
    });

    test('it fails when a terminal write loses its delivery verdict', () => {
        const args = argsOf(regions_of(source).success, '.complete(');
        const stripped = source.replace(args, args.replace(/\bdelivered\s*:/g, 'wasSent:'));
        expect(stripped).not.toBe(source);

        const r = extractRegions(stripped);
        expect(argsOf(r.success, '.complete(')).not.toMatch(/\bdelivered\s*:/);
    });

    test('argsOf returns null for a call that is not there', () => {
        expect(argsOf('nothing to see', '.complete(')).toBeNull();
    });

    test('argsOf matches the whole nested argument list, not the first inner paren', () => {
        expect(argsOf('q.complete(id, f(a, b), { delivered: true })', '.complete('))
            .toBe('id, f(a, b), { delivered: true }');
    });

    /** Local helper so the meta-test can slice without the beforeAll above. */
    function regions_of(src) {
        return extractRegions(src);
    }
});

describe('the queue records the delivery verdict durably', () => {
    let dir;
    let queue;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-signal-'));
        queue = new TaskQueue(path.join(dir, 'task-queue.json'));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /** Read the row back off disk — an in-memory object proves nothing about durability. */
    function rowOf(id) {
        return JSON.parse(fs.readFileSync(queue.queueFile, 'utf8')).find(r => r.id === id);
    }

    test('a fresh entry records no verdict yet, explicitly', () => {
        const t = queue.enqueue({ msgTs: '1.1', channelId: 'C1', text: 'TASK: x' });
        const row = rowOf(t.id);

        // `null`, not absent: the difference is what tells "in flight under this
        // code" apart from "written before the field existed".
        expect(Object.prototype.hasOwnProperty.call(row, 'delivery')).toBe(true);
        expect(row.delivery).toBeNull();
        expect(deliveryRecorded(row)).toBe(false);
    });

    test('a delivered result is recorded as delivered', () => {
        const t = queue.enqueue({ msgTs: '2.1', channelId: 'C1', text: 'TASK: x' });
        queue.markRunning(t.id);
        queue.complete(t.id, 'Success in 12s', { delivered: true, detail: 'posted to ops' });

        const row = rowOf(t.id);
        expect(row.status).toBe(STATUS.COMPLETED);
        expect(row.delivery.delivered).toBe(true);
        expect(row.delivery.detail).toBe('posted to ops');
        expect(deliveryRecorded(row)).toBe(true);
    });

    test('THE EDGE CASE: a completed task whose post failed is distinguishable from one whose post landed', () => {
        // This is the assertion that is impossible before the fix. Both tasks ran to
        // completion; only one reached a human; the old record could not tell them
        // apart, and a drain built on it would restart believing both were reported.
        const landed = queue.enqueue({ msgTs: '3.1', channelId: 'C1', text: 'TASK: a' });
        const lost = queue.enqueue({ msgTs: '3.2', channelId: 'C1', text: 'TASK: b' });

        queue.complete(landed.id, 'Success in 9s', { delivered: true, detail: 'posted to ops' });
        queue.complete(lost.id, 'Success in 9s', {
            delivered: false,
            detail: 'the task result post to the ops channel failed',
        });

        const a = rowOf(landed.id);
        const b = rowOf(lost.id);

        expect(a.status).toBe(b.status);          // identical outcome...
        expect(a.delivery.delivered).toBe(true);  // ...distinguishable record.
        expect(b.delivery.delivered).toBe(false);
        expect(b.delivery.detail).toMatch(/failed/);
    });

    test('a caller that records nothing gets an explicit non-delivery, not an optimistic default', () => {
        const t = queue.enqueue({ msgTs: '4.1', channelId: 'C1', text: 'TASK: x' });
        queue.complete(t.id, 'Success in 3s');

        const row = rowOf(t.id);
        expect(row.delivery.delivered).toBe(false);
        expect(row.delivery.detail).toBe(DELIVERY_NOT_RECORDED);
        expect(deliveryRecorded(row)).toBe(true); // recorded — as a loss
    });

    test('fail() and interrupt() record theirs too', () => {
        const f = queue.enqueue({ msgTs: '5.1', channelId: 'C1', text: 'TASK: x' });
        queue.fail(f.id, 'boom', { delivered: true, detail: 'reported' });
        expect(rowOf(f.id).delivery).toMatchObject({ delivered: true, detail: 'reported' });

        const i = queue.enqueue({ msgTs: '5.2', channelId: 'C1', text: 'TASK: y' });
        queue.interrupt(i.id, 'killed', { delivered: false, detail: 'ops post failed' });
        expect(rowOf(i.id).delivery).toMatchObject({ delivered: false, detail: 'ops post failed' });
    });

    test('a task the process died holding is recorded as an undelivered result', () => {
        const t = queue.enqueue({ msgTs: '6.1', channelId: 'C1', text: 'TASK: x' });
        queue.markRunning(t.id);

        expect(queue.recoverInterrupted()).toBe(1);

        const row = rowOf(t.id);
        expect(row.status).toBe(STATUS.INTERRUPTED);
        expect(row.delivery.delivered).toBe(false);
        expect(row.delivery.detail).toMatch(/died before the result was delivered/);
        // Recorded, not null: a null would defer every future update for a task that
        // no longer exists.
        expect(deliveryRecorded(row)).toBe(true);
    });

    test('a re-attempt clears the previous attempt\'s verdict', () => {
        const t = queue.enqueue({ msgTs: '7.1', channelId: 'C1', text: 'TASK: x' });
        queue.markRunning(t.id);
        queue.complete(t.id, 'Success', { delivered: true, detail: 'posted' });
        expect(rowOf(t.id).delivery.delivered).toBe(true);

        // The poll loop re-reads a message whose task was killed (WORK-TODO #23).
        queue.markRunning(t.id);
        const row = rowOf(t.id);
        expect(row.status).toBe(STATUS.RUNNING);
        expect(row.delivery).toBeNull();
        expect(deliveryRecorded(row)).toBe(false);
    });
});

describe('deliveryRecorded keeps three states apart', () => {
    test('an absent key is a pre-change row and cannot block anything', () => {
        expect(deliveryRecorded({ status: 'completed' })).toBe(true);
    });

    test('an explicit null is in flight', () => {
        expect(deliveryRecorded({ status: 'completed', delivery: null })).toBe(false);
    });

    test('a recorded verdict is recorded whether it succeeded or failed', () => {
        expect(deliveryRecorded({ delivery: { delivered: true } })).toBe(true);
        expect(deliveryRecorded({ delivery: { delivered: false } })).toBe(true);
    });

    test('a non-object row does not crash the predicate', () => {
        expect(deliveryRecorded(null)).toBe(true);
        expect(deliveryRecorded(undefined)).toBe(true);
    });

    test('normalizeDelivery never invents a delivery', () => {
        expect(normalizeDelivery().delivered).toBe(false);
        expect(normalizeDelivery(null).delivered).toBe(false);
        expect(normalizeDelivery('yes').delivered).toBe(false);
        expect(normalizeDelivery({ delivered: 'true' }).delivered).toBe(false);
        expect(normalizeDelivery({ delivered: true }).delivered).toBe(true);
    });
});
