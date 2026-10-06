/**
 * lib/integrations/holidays-public.js
 *
 * Canadian public holidays from the Nager.Date API (free, no auth), cached for 24 hours,
 * filtered to Ontario (CA-ON) and national holidays. Moved unchanged out of
 * lib/integrations/holidays.js on 2026-10-05 (WORK-TODO #10); holidays.js re-exports every
 * name here. The cache lives in this module, so clearCache() here is the one that clears it.
 */

'use strict';

const https = require('https');
const { parseDate, formatDate } = require('./local-date');

// ---- Cache configuration ----

// LOGIC CHANGE 2026-03-27: Cache API results for 24 hours to avoid hitting the API on every call
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let holidayCache = {
    data: null,
    year: null,
    fetchedAt: null,
};

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
 * Check if a specific date is a holiday
 * @param {string|Date} date - Date to check
 * @returns {Promise<boolean>}
 */
async function isHoliday(date) {
    const holiday = await getTodayHoliday(date instanceof Date ? date : new Date(date));
    return holiday !== null;
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
    fetchPublicHolidays,
    getHolidaysWithCache,
    filterOntarioHolidays,
    getTodayHoliday,
    getUpcomingHolidays,
    isHoliday,
    clearCache,
    CACHE_TTL_MS,
};
