/**
 * lib/integrations/pet-awareness.js
 *
 * Pet industry awareness dates for content planning: the static list and the three
 * lookups over it. Moved unchanged out of lib/integrations/holidays.js on 2026-10-05
 * (WORK-TODO #10); holidays.js re-exports every name here.
 */

'use strict';

const { parseDate, formatDate } = require('./local-date');

// LOGIC CHANGE 2026-03-27: Added comprehensive pet industry awareness dates for social media content planning
const PET_AWARENESS_DATES = [
    // Monthly observances (use day: 1 to represent the whole month)
    { month: 2, day: 1, name: 'Responsible Pet Owners Month', type: 'month', socialTip: 'Share tips on responsible pet ownership all month!' },
    { month: 2, day: 1, name: 'Pet Dental Health Month', type: 'month', socialTip: 'Promote dental health products and tips!' },
    { month: 3, day: 1, name: 'Poison Prevention Awareness Month', type: 'month', socialTip: 'Share info about toxic foods and plants for pets' },
    { month: 4, day: 1, name: 'Heartworm Awareness Month', type: 'month', socialTip: 'Remind customers about heartworm prevention!' },
    { month: 5, day: 1, name: 'Pet Week Month', type: 'month', socialTip: 'Celebrate pets with special promotions!' },
    { month: 5, day: 1, name: 'Chip Your Pet Month', type: 'month', socialTip: 'Promote microchipping services and awareness' },
    { month: 6, day: 1, name: 'National Pet Preparedness Month', type: 'month', socialTip: 'Share emergency preparedness tips for pet owners' },
    { month: 9, day: 1, name: 'Responsible Dog Ownership Month', type: 'month', socialTip: 'Focus on dog training, safety, and care tips' },
    { month: 11, day: 1, name: 'Senior Pet Month', type: 'month', socialTip: 'Highlight products and care tips for aging pets' },
    { month: 12, day: 1, name: 'Safe Toys and Gifts Month', type: 'month', socialTip: 'Promote safe pet toys and holiday gift ideas' },

    // Specific dates
    { month: 4, day: 11, name: 'National Pet Day', type: 'day', socialTip: 'Great day for a social media post celebrating pets!' },
    { month: 8, day: 26, name: 'National Dog Day', type: 'day', socialTip: 'Celebrate dogs with special promotions and posts!' },
    { month: 10, day: 29, name: 'National Cat Day', type: 'day', socialTip: 'Feature cats and cat products in your content!' },
];

/**
 * Get today's pet awareness date if one exists
 * @param {Date} [date=new Date()] - Date to check (defaults to today)
 * @returns {{ name: string, type: string, socialTip: string }|null}
 */
function getTodayPetAwareness(date = new Date()) {
    const { month, day } = parseDate(date);

    for (const awareness of PET_AWARENESS_DATES) {
        // Check specific dates
        if (awareness.type === 'day' && awareness.month === month && awareness.day === day) {
            return {
                name: awareness.name,
                type: 'pet_awareness',
                socialTip: awareness.socialTip,
            };
        }
        // Check monthly observances (match on day 1 of the month)
        if (awareness.type === 'month' && awareness.month === month && day === 1) {
            return {
                name: awareness.name,
                type: 'pet_awareness_month',
                socialTip: awareness.socialTip,
            };
        }
    }

    return null;
}

/**
 * Get all pet awareness dates/months active for a given date
 * @param {Date} [date=new Date()] - Date to check (defaults to today)
 * @returns {Array<{ name: string, type: string, socialTip: string }>}
 */
function getActivePetAwareness(date = new Date()) {
    const { month, day } = parseDate(date);
    const active = [];

    for (const awareness of PET_AWARENESS_DATES) {
        // Check specific dates
        if (awareness.type === 'day' && awareness.month === month && awareness.day === day) {
            active.push({
                name: awareness.name,
                type: 'pet_awareness',
                socialTip: awareness.socialTip,
            });
        }
        // Check monthly observances (active all month)
        if (awareness.type === 'month' && awareness.month === month) {
            active.push({
                name: awareness.name,
                type: 'pet_awareness_month',
                socialTip: awareness.socialTip,
            });
        }
    }

    return active;
}

/**
 * Get upcoming pet awareness dates within N days
 * @param {number} [days=30] - Number of days to look ahead
 * @param {Date} [fromDate=new Date()] - Starting date
 * @returns {Array<{ date: string, name: string, type: string, daysAway: number, socialTip: string }>}
 */
function getUpcomingPetAwareness(days = 30, fromDate = new Date()) {
    const upcoming = [];
    const { year, month, day } = parseDate(fromDate);

    for (const awareness of PET_AWARENESS_DATES) {
        // Only check specific dates for upcoming
        if (awareness.type !== 'day') continue;

        // Check current year
        let awarenessDate = new Date(year, awareness.month - 1, awareness.day);

        // If it's already passed this year, check next year
        if (awarenessDate.getTime() <= fromDate.getTime()) {
            awarenessDate = new Date(year + 1, awareness.month - 1, awareness.day);
        }

        const daysAway = Math.ceil((awarenessDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000));

        if (daysAway > 0 && daysAway <= days) {
            upcoming.push({
                date: formatDate(awarenessDate),
                name: awareness.name,
                type: 'pet_awareness',
                daysAway,
                socialTip: awareness.socialTip,
            });
        }
    }

    // Sort by date
    upcoming.sort((a, b) => a.daysAway - b.daysAway);

    return upcoming;
}

module.exports = {
    PET_AWARENESS_DATES,
    getTodayPetAwareness,
    getActivePetAwareness,
    getUpcomingPetAwareness,
};
