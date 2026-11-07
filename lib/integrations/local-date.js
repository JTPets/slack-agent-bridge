/**
 * lib/integrations/local-date.js
 *
 * The calendar fields of a date, as the holiday and pet-awareness lookups read them.
 * Moved out of lib/integrations/holidays.js on 2026-10-05 (WORK-TODO #10).
 *
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #76): read in the STORE's zone (America/Toronto,
 * lib/time-format.js STORE_TIME_ZONE), not the process timezone, so "today's holiday"
 * does not move if the container runs in UTC. A bare `YYYY-MM-DD` string is that calendar
 * day as written; it used to be parsed as UTC midnight and read back locally, which in
 * any zone west of UTC is the day before.
 */

'use strict';

const { STORE_TIME_ZONE, zonedParts, dayKey, zonedMidnight } = require('../time-format');

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a date string or Date object into year, month, day (store zone)
 * @param {string|Date} date - Date to parse
 * @returns {{ year: number, month: number, day: number }}
 */
function parseDate(date) {
    const m = typeof date === 'string' ? date.match(DATE_ONLY) : null;
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    const p = zonedParts(date instanceof Date ? date : new Date(date), STORE_TIME_ZONE);
    return { year: p.year, month: p.month, day: p.day };
}

/**
 * Format a date as YYYY-MM-DD (store zone)
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date) {
    return dayKey(date, STORE_TIME_ZONE);
}

/**
 * The instant a store-zone calendar day starts (WORK-TODO #76): replaces
 * `new Date(year, month - 1, day)`, which is local midnight.
 * @param {number} year
 * @param {number} month - 1-12
 * @param {number} day
 * @returns {Date}
 */
function storeDayStart(year, month, day) {
    const pad = (v) => String(v).padStart(2, '0');
    return zonedMidnight(`${year}-${pad(month)}-${pad(day)}`, STORE_TIME_ZONE);
}

module.exports = { parseDate, formatDate, storeDayStart };
