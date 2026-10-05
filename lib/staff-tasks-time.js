/**
 * lib/staff-tasks-time.js
 *
 * Store-hours and time-of-day arithmetic for staff tasks: HH:MM to minutes, the
 * current Toronto minute, whether the store is open, and normalising "3pm"-style input.
 * Pure apart from reading the clock.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/staff-tasks.js unchanged, on
 * the four concerns #10 names (staff/template/state, time parsing, Slack side, command
 * recognition and rendering). lib/staff-tasks.js re-exports every name.
 */

'use strict';

// Store hours (America/Toronto timezone)
const STORE_HOURS = {
  open: 9,   // 9:00 AM
  close: 21, // 9:00 PM
};

/**
 * Parse time string (HH:MM) to minutes since midnight
 * @param {string} timeStr - Time in HH:MM format
 * @returns {number} Minutes since midnight
 */
function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Get current time in minutes since midnight (America/Toronto)
 * @returns {number}
 */
function getCurrentTimeMinutes() {
  const now = new Date();
  const torontoTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  return torontoTime.getHours() * 60 + torontoTime.getMinutes();
}

/**
 * Check if current time is within store hours
 * @returns {boolean}
 */
function isStoreHours() {
  const currentMinutes = getCurrentTimeMinutes();
  const openMinutes = STORE_HOURS.open * 60;
  const closeMinutes = STORE_HOURS.close * 60;
  return currentMinutes >= openMinutes && currentMinutes < closeMinutes;
}

/**
 * Normalize time string to HH:MM 24h format
 * @param {string} timeStr - Input time (e.g., "9am", "14:30", "2:30pm")
 * @returns {string} Normalized time in HH:MM format
 */
function normalizeTimeString(timeStr) {
  const lower = timeStr.toLowerCase().trim();

  // Check for am/pm
  const isPM = lower.includes('pm');
  const isAM = lower.includes('am');

  // Remove am/pm
  const cleaned = lower.replace(/\s*(am|pm)/i, '');

  let hours, minutes;

  if (cleaned.includes(':')) {
    [hours, minutes] = cleaned.split(':').map(Number);
  } else {
    hours = parseInt(cleaned, 10);
    minutes = 0;
  }

  // Convert to 24h
  if (isPM && hours !== 12) {
    hours += 12;
  } else if (isAM && hours === 12) {
    hours = 0;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

module.exports = { STORE_HOURS, parseTimeToMinutes, getCurrentTimeMinutes, isStoreHours, normalizeTimeString };
