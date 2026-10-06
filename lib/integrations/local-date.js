/**
 * lib/integrations/local-date.js
 *
 * The calendar fields of a date in the PROCESS timezone, as the holiday and pet-awareness
 * lookups have always read them. Moved unchanged out of lib/integrations/holidays.js on
 * 2026-10-05 (WORK-TODO #10). Like the calendar's day range, these depend on the process
 * timezone rather than naming America/Toronto (WORK-TODO #76); the container's TZ shares
 * Toronto's offset, so today they agree.
 */

'use strict';

/**
 * Parse a date string or Date object into year, month, day
 * @param {string|Date} date - Date to parse
 * @returns {{ year: number, month: number, day: number }}
 */
function parseDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return {
        year: d.getFullYear(),
        month: d.getMonth() + 1, // 1-indexed
        day: d.getDate(),
    };
}

/**
 * Format a date as YYYY-MM-DD
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

module.exports = { parseDate, formatDate };
