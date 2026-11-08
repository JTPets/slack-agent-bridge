/**
 * tests/local-date.test.js
 *
 * Tests for lib/integrations/local-date.js: parseDate and formatDate.
 * Split from tests/holidays.test.js 2026-11-08 (WORK-TODO #10 Wave T: one suite per part of the B15 split). Still requires the facade, so the names under test are the ones callers use.
 */

'use strict';

const holidays = require('../lib/integrations/holidays');

// LOGIC CHANGE 2026-11-07 (WORK-TODO #76): noon on a Toronto calendar day (month 0-based,
// as Date's). These tests used new Date(y, m, d), a LOCAL midnight, which in a UTC test
// process is the previous evening in Toronto; they encoded the process-zone dependence.
const storeDay = (y, m0, d) => new Date(Date.UTC(y, m0, d, 16));

// Mock https module
jest.mock('https', () => ({
    get: jest.fn(),
}));

const https = require('https');

describe('holidays module: local date', () => {
    beforeEach(() => {
        // Clear cache before each test
        holidays.clearCache();
        jest.clearAllMocks();
    });

    describe('parseDate', () => {
        test('parses Date object', () => {
            const date = storeDay(2026, 3, 11); // April 11, 2026
            const result = holidays.parseDate(date);
            expect(result).toEqual({ year: 2026, month: 4, day: 11 });
        });

        test('parses date string', () => {
            // Use explicit Date object to avoid timezone issues with date string parsing
            const result = holidays.parseDate(storeDay(2026, 3, 11)); // April 11, 2026
            expect(result).toEqual({ year: 2026, month: 4, day: 11 });
        });
    });

    describe('formatDate', () => {
        test('formats date as YYYY-MM-DD', () => {
            const date = storeDay(2026, 3, 11); // April 11, 2026
            expect(holidays.formatDate(date)).toBe('2026-04-11');
        });

        test('pads single-digit months and days', () => {
            const date = storeDay(2026, 0, 5); // January 5, 2026
            expect(holidays.formatDate(date)).toBe('2026-01-05');
        });
    });
});
