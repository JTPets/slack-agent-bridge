'use strict';

/**
 * lib/task-queue-delivery.js
 *
 * The delivery verdict a terminal task-queue row carries: what "the result reached a
 * human" is recorded as (normalizeDelivery) and how a reader asks whether a row has
 * recorded one yet (deliveryRecorded). lib/update-deferral.js asks the second
 * question of task-queue.json without the class, which is why it is a function of a
 * row and not a method.
 *
 * LOGIC CHANGE 2026-11-12 (WORK-TODO #10, B28): moved unchanged out of
 * lib/task-queue.js, which re-exports every name here as the same object. The
 * terminal WRITERS that call normalizeDelivery() stay in lib/task-queue.js; the
 * invariant that each of them does is enforced wherever a writer lives by
 * tests/task-queue-delivery-invariant.test.js.
 */

// LOGIC CHANGE 2026-09-20: every terminal transition stamps a DELIVERY VERDICT.
//
// Why a queue entry needs one. `completed` used to mean "processTask reached its
// end", which is not the same fact as "the result reached a human". The result post
// is `notifyOwner.taskCompleted()`, which returns a BOOLEAN and returns `false` on a
// Slack failure rather than throwing (lib/notify-owner.js); bridge-agent.js awaited
// it and discarded the value, then wrote `complete()` regardless. A task whose
// output never left the process was therefore indistinguishable, in the only durable
// record there is, from one the owner read - and the output itself lived in a local
// variable that is gone the moment the function returns.
//
// That mattered on its own, and it is load-bearing for the drain-one update gate
// (lib/update-drain.js): "the current task is finished" has to mean RESULT
// DELIVERED, because applying an update restarts the process. A gate keyed on the
// process returning, or on the lock releasing, is keyed on a signal that can lie.
//
// Three states, kept distinct on purpose:
//   { delivered: true }   - the post was accepted by Slack.
//   { delivered: false }  - it was attempted and refused/failed. A LOSS, recorded.
//   delivery === null     - not yet recorded. Written ONLY beside a non-terminal
//                           status (enqueue -> pending, _startRunning -> running).
// LOGIC CHANGE 2026-10-02 (WORK-TODO #74): this line used to say a null verdict
// means "in flight whatever its status says". No writer produces a terminal status
// with a null verdict: every terminal write below pairs the status with
// normalizeDelivery(), which never returns null. That pairing is now an invariant
// guarded by tests/task-queue-delivery-invariant.test.js, not an accident.
// A row with NO `delivery` key at all predates this change; see deliveryRecorded().
const DELIVERY_NOT_RECORDED = 'the caller recorded no delivery verdict';

/**
 * Normalise a caller-supplied delivery verdict into the stored shape.
 *
 * A caller that passes nothing gets `delivered: false` with an explicit reason,
 * never an optimistic default: an unrecorded delivery is a delivery that did not
 * demonstrably happen, and this module will not invent the happier reading.
 *
 * @param {{ delivered?: boolean, detail?: string }} [verdict]
 * @returns {{ delivered: boolean, detail: string, at: string }}
 */
function normalizeDelivery(verdict) {
    if (!verdict || typeof verdict !== 'object') {
        return { delivered: false, detail: DELIVERY_NOT_RECORDED, at: new Date().toISOString() };
    }
    return {
        delivered: verdict.delivered === true,
        detail: typeof verdict.detail === 'string' && verdict.detail
            ? verdict.detail
            : (verdict.delivered === true ? 'delivered' : DELIVERY_NOT_RECORDED),
        at: new Date().toISOString(),
    };
}

/**
 * Has this entry recorded a delivery verdict yet?
 *
 * The three-way distinction is the whole point and a truthiness test destroys it:
 *   - key absent    -> the entry was written before this field existed. It CANNOT
 *                      block anything: treating a pre-change row as "still in
 *                      flight" would freeze every deploy for the retention window
 *                      the first time this code runs against an existing queue file.
 *   - `null`        -> written by this code and not yet delivered. In flight.
 *   - object        -> recorded, whether the delivery succeeded or failed.
 *
 * @param {object} task - Queue entry
 * @returns {boolean} True when the entry carries a recorded verdict, or predates the field.
 */
function deliveryRecorded(task) {
    if (!task || typeof task !== 'object') return true;
    if (!Object.prototype.hasOwnProperty.call(task, 'delivery')) return true; // pre-change row
    return task.delivery !== null && typeof task.delivery === 'object';
}

module.exports = {
    DELIVERY_NOT_RECORDED,
    normalizeDelivery,
    deliveryRecorded,
};
