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

// LOGIC CHANGE 2026-11-07 (WORK-TODO #76): calendar arithmetic in a NAMED zone. The
// calendar's day range, the holiday and pet-awareness dates, the standup's weekday and the
// secretary's "tomorrow" were built from a Date's local fields (getFullYear/getDate,
// new Date(y, m, d), setDate), so they followed the process timezone. These replace them;
// tests/timezone-explicit.test.js now fails on a local-field read in production code.

/**
 * The wall-clock fields of an instant in `timeZone`.
 *
 * @param {Date|string|number} date
 * @param {string} timeZone - Required.
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 *   month is 1-12; weekday is 0 (Sunday) to 6, as Date#getDay.
 */
function zonedParts(date, timeZone) {
    if (!timeZone) throw new Error('zonedParts: a timeZone is required');
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short', hourCycle: 'h23',
    }).formatToParts(new Date(date));
    const get = (type) => parts.find((p) => p.type === type).value;
    return {
        year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
        hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    };
}

/**
 * A `YYYY-MM-DD` key moved by `n` calendar days. Pure calendar arithmetic (no zone, no
 * clock), so a 23- or 25-hour DST day cannot shift it.
 *
 * @param {string} key - `YYYY-MM-DD`
 * @param {number} n
 * @returns {string}
 */
function addDays(key, n) {
    const [y, m, d] = String(key).split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    const pad = (v) => String(v).padStart(2, '0');
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffsetMs(instant, timeZone) {
    const p = zonedParts(instant, timeZone);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant of 00:00 on day `key` in `timeZone`. Two passes, so a guess on the far side
 * of a DST transition is corrected (no zone this repo names changes offset at midnight).
 *
 * @param {string} key - `YYYY-MM-DD`
 * @param {string} timeZone - Required.
 * @returns {Date}
 */
function zonedMidnight(key, timeZone) {
    if (!timeZone) throw new Error('zonedMidnight: a timeZone is required');
    const [y, m, d] = String(key).split('-').map(Number);
    const wall = Date.UTC(y, m - 1, d);
    let t = wall - zoneOffsetMs(wall, timeZone);
    t = wall - zoneOffsetMs(t, timeZone);
    return new Date(t);
}

module.exports = { STORE_TIME_ZONE, dayKey, formatTimestamp, zonedParts, addDays, zonedMidnight };
