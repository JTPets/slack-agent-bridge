/**
 * lib/integrations/holidays.js
 *
 * Canadian public holidays and pet industry awareness dates.
 * Uses Nager.Date API for public holidays (free, no auth).
 * Filters for Ontario (CA-ON) and national holidays.
 *
 * Pet awareness dates are maintained as a static list for content planning.
 */

'use strict';

const https = require('https');

// ---- Cache configuration ----

// LOGIC CHANGE 2026-03-27: Cache API results for 24 hours to avoid hitting the API on every call
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let holidayCache = {
    data: null,
    year: null,
    fetchedAt: null,
};

// ---- Pet industry awareness dates ----

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

// ---- API helpers ----

/**
 * Fetch public holidays from Nager.Date API
 * @param {number} year - Year to fetch holidays for
 * @returns {Promise<Array>} Array of holiday objects
 */
function fetchPublicHolidays(year) {
    return new Promise((resolve, reject) => {
        const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/CA`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`[holidays] API returned status ${res.statusCode}`);
                        resolve([]);
                        return;
                    }
                    const holidays = JSON.parse(data);
                    resolve(holidays);
                } catch (err) {
                    console.error('[holidays] Failed to parse API response:', err.message);
                    resolve([]);
                }
            });
        }).on('error', (err) => {
            console.error('[holidays] API request failed:', err.message);
            resolve([]); // Return empty array on error, don't crash
        });
    });
}

/**
 * Get holidays from cache or fetch fresh data
 * @param {number} year - Year to get holidays for
 * @returns {Promise<Array>} Array of holiday objects
 */
async function getHolidaysWithCache(year) {
    const now = Date.now();

    // Check if cache is valid
    if (
        holidayCache.data &&
        holidayCache.year === year &&
        holidayCache.fetchedAt &&
        (now - holidayCache.fetchedAt) < CACHE_TTL_MS
    ) {
        return holidayCache.data;
    }

    // Fetch fresh data
    const holidays = await fetchPublicHolidays(year);

    // Update cache
    holidayCache = {
        data: holidays,
        year: year,
        fetchedAt: now,
    };

    return holidays;
}

/**
 * Filter holidays for Ontario (CA-ON) or national (counties is null)
 * @param {Array} holidays - Array of holiday objects from API
 * @returns {Array} Filtered holidays for Ontario
 */
function filterOntarioHolidays(holidays) {
    return holidays.filter(holiday => {
        // National holiday (applies to all provinces)
        if (!holiday.counties || holiday.counties.length === 0) {
            return true;
        }
        // Ontario-specific holiday
        return holiday.counties.includes('CA-ON');
    });
}

// ---- Date helpers ----

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

// ---- Public API ----

/**
 * Get today's holiday if one exists (Ontario statutory holidays only)
 * @param {Date} [date=new Date()] - Date to check (defaults to today)
 * @returns {Promise<{ name: string, type: string, localName?: string }|null>}
 */
async function getTodayHoliday(date = new Date()) {
    const { year, month, day } = parseDate(date);
    const dateStr = formatDate(date);

    // Check public holidays
    const holidays = await getHolidaysWithCache(year);
    const ontarioHolidays = filterOntarioHolidays(holidays);

    for (const holiday of ontarioHolidays) {
        if (holiday.date === dateStr) {
            return {
                name: holiday.localName || holiday.name,
                type: 'statutory',
                localName: holiday.localName,
            };
        }
    }

    return null;
}

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
 * Get upcoming holidays within N days
 * @param {number} [days=7] - Number of days to look ahead
 * @param {Date} [fromDate=new Date()] - Starting date
 * @returns {Promise<Array<{ date: string, name: string, type: string, daysAway: number }>>}
 */
async function getUpcomingHolidays(days = 7, fromDate = new Date()) {
    const upcoming = [];
    const { year } = parseDate(fromDate);

    // Fetch holidays for current year and next year (in case we're near year end)
    const [currentYearHolidays, nextYearHolidays] = await Promise.all([
        getHolidaysWithCache(year),
        days > 30 || fromDate.getMonth() === 11 ? getHolidaysWithCache(year + 1) : Promise.resolve([]),
    ]);

    const allHolidays = filterOntarioHolidays([...currentYearHolidays, ...nextYearHolidays]);

    const fromTime = fromDate.getTime();
    const endTime = fromTime + (days * 24 * 60 * 60 * 1000);

    for (const holiday of allHolidays) {
        const holidayDate = new Date(holiday.date);
        const holidayTime = holidayDate.getTime();

        if (holidayTime > fromTime && holidayTime <= endTime) {
            const daysAway = Math.ceil((holidayTime - fromTime) / (24 * 60 * 60 * 1000));
            upcoming.push({
                date: holiday.date,
                name: holiday.localName || holiday.name,
                type: 'statutory',
                daysAway,
            });
        }
    }

    // Sort by date
    upcoming.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return upcoming;
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

/**
 * Check if a specific date is a holiday
 * @param {string|Date} date - Date to check
 * @returns {Promise<boolean>}
 */
async function isHoliday(date) {
    const holiday = await getTodayHoliday(date instanceof Date ? date : new Date(date));
    return holiday !== null;
}

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

/**
 * Clear the holiday cache (useful for testing)
 */
function clearCache() {
    holidayCache = {
        data: null,
        year: null,
        fetchedAt: null,
    };
}

module.exports = {
    // Main API
    getTodayHoliday,
    getTodayPetAwareness,
    getActivePetAwareness,
    getUpcomingHolidays,
    getUpcomingPetAwareness,
    isHoliday,
    getTodaySpecialDates,

    // Static data for social media agent
    PET_AWARENESS_DATES,

    // Helpers (exported for testing)
    filterOntarioHolidays,
    parseDate,
    formatDate,
    clearCache,

    // Cache config (exported for testing)
    CACHE_TTL_MS,
};
