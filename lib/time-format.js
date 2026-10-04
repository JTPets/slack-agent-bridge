'use strict';

/**
 * lib/time-format.js
 *
 * THE helpers for turning an instant into a day key or a displayed time. Each takes its
 * zone explicitly; nothing here reads the process timezone (tests/timezone-explicit.test.js).
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #33): `dayKey`. The idiom
 * `new Date().toISOString().split('T')[0]` is a UTC day, and was used as the STORE's day
 * in lib/staff-tasks.js (three sites) and morning-digest.js. A UTC key rolls over at
 * 20:00 Toronto in summer (19:00 in winter), so a staff task assigned at 21:00 was filed
 * under tomorrow and the day's state was reset mid-evening. lib/llm-metrics.js is the one
 * caller that wants UTC (a stable bucket across DST, documented there) and passes 'UTC'.
 * tests/time-format.test.js fails when the idiom reappears anywhere else.
 *
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #32): `formatTimestamp`. One bulletin timestamp was
 * rendered by three inline option sets in two files, and the two in lib/agent-context.js
 * gave a date with no time, so those agents could not order two bulletins from one day.
 */

/** The store's zone. Named once here rather than retyped at every caller. */
const STORE_TIME_ZONE = 'America/Toronto';

/**
 * The calendar day an instant falls on in `timeZone`, as `YYYY-MM-DD`.
 *
 * @param {Date|string|number} date
 * @param {string} timeZone - Required. 'UTC' or an IANA zone. There is no default, so a
 *   caller cannot get a UTC day by forgetting to choose.
 * @returns {string}
 */
function dayKey(date, timeZone) {
    if (!timeZone) throw new Error('dayKey: a timeZone is required');
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(date));
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * A short human-readable time: `Sep 14, 2:05 PM` (datetime) or `Sep 14` (date).
 *
 * @param {Date|string|number} date
 * @param {{ precision?: 'datetime'|'date', timeZone?: string }} [opts]
 * @returns {string}
 */
function formatTimestamp(date, { precision = 'datetime', timeZone = STORE_TIME_ZONE } = {}) {
    if (precision !== 'datetime' && precision !== 'date') {
        throw new Error(`formatTimestamp: unknown precision ${precision}`);
    }
    const clock = precision === 'datetime' ? { hour: 'numeric', minute: '2-digit', hour12: true } : {};
    return new Date(date).toLocaleString('en-US', { month: 'short', day: 'numeric', ...clock, timeZone: timeZone });
}

module.exports = { STORE_TIME_ZONE, dayKey, formatTimestamp };
