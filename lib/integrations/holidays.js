/**
 * lib/integrations/holidays.js
 *
 * Canadian public holidays and pet industry awareness dates.
 * Uses Nager.Date API for public holidays (free, no auth).
 * Filters for Ontario (CA-ON) and national holidays.
 *
 * Pet awareness dates are maintained as a static list for content planning.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): a facade over three modules, with every name it
 * exported before. The public-holiday client and its cache are holidays-public.js, the pet
 * dates are pet-awareness.js, and the two date helpers both use are local-date.js. This
 * file keeps getTodaySpecialDates, which combines the two halves.
 */

'use strict';

const publicHolidays = require('./holidays-public');
const petAwareness = require('./pet-awareness');
const { parseDate, formatDate } = require('./local-date');

const { getTodayHoliday } = publicHolidays;
const { getActivePetAwareness } = petAwareness;

/**
 * Get all relevant dates for today (holiday + pet awareness)
 * @param {Date} [date=new Date()] - Date to check
 * @returns {Promise<{ holiday: object|null, petAwareness: Array }>}
 */
async function getTodaySpecialDates(date = new Date()) {
    const holiday = await getTodayHoliday(date);
    const petAwareness = getActivePetAwareness(date);

    return {
        holiday,
        petAwareness,
    };
}

module.exports = {
    // Main API
    getTodayHoliday,
    getTodayPetAwareness: petAwareness.getTodayPetAwareness,
    getActivePetAwareness,
    getUpcomingHolidays: publicHolidays.getUpcomingHolidays,
    getUpcomingPetAwareness: petAwareness.getUpcomingPetAwareness,
    isHoliday: publicHolidays.isHoliday,
    getTodaySpecialDates,

    // Static data for social media agent
    PET_AWARENESS_DATES: petAwareness.PET_AWARENESS_DATES,

    // Helpers (exported for testing)
    filterOntarioHolidays: publicHolidays.filterOntarioHolidays,
    parseDate,
    formatDate,
    clearCache: publicHolidays.clearCache,

    // Cache config (exported for testing)
    CACHE_TTL_MS: publicHolidays.CACHE_TTL_MS,
};
