/**
 * tests/holidays.test.js
 *
 * Tests for the facade lib/integrations/holidays.js: getTodaySpecialDates and the export
 * surface. Its parts have their own suites since 2026-11-08 (WORK-TODO #10 Wave T):
 * tests/local-date.test.js, tests/pet-awareness.test.js, tests/holidays-public.test.js.
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

describe('holidays module', () => {
    beforeEach(() => {
        // Clear cache before each test
        holidays.clearCache();
        jest.clearAllMocks();
    });

    describe('getTodaySpecialDates', () => {
        test('returns both holiday and pet awareness data', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([]));
                        }
                        if (event === 'end') {
                            handler();
                        }
                        return mockResponse;
                    }),
                };
                callback(mockResponse);
                return { on: jest.fn() };
            });

            const april11 = storeDay(2026, 3, 11);
            const result = await holidays.getTodaySpecialDates(april11);

            expect(result).toHaveProperty('holiday');
            expect(result).toHaveProperty('petAwareness');
            expect(Array.isArray(result.petAwareness)).toBe(true);

            // Should have National Pet Day in pet awareness
            const petDay = result.petAwareness.find(p => p.name === 'National Pet Day');
            expect(petDay).toBeDefined();
        });
    });

    describe('module exports', () => {
        test('exports all expected functions', () => {
            expect(holidays).toHaveProperty('getTodayHoliday');
            expect(holidays).toHaveProperty('getTodayPetAwareness');
            expect(holidays).toHaveProperty('getActivePetAwareness');
            expect(holidays).toHaveProperty('getUpcomingHolidays');
            expect(holidays).toHaveProperty('getUpcomingPetAwareness');
            expect(holidays).toHaveProperty('isHoliday');
            expect(holidays).toHaveProperty('getTodaySpecialDates');
            expect(holidays).toHaveProperty('PET_AWARENESS_DATES');
            expect(holidays).toHaveProperty('filterOntarioHolidays');
            expect(holidays).toHaveProperty('parseDate');
            expect(holidays).toHaveProperty('formatDate');
            expect(holidays).toHaveProperty('clearCache');
            expect(holidays).toHaveProperty('CACHE_TTL_MS');

            expect(typeof holidays.getTodayHoliday).toBe('function');
            expect(typeof holidays.isHoliday).toBe('function');
            expect(Array.isArray(holidays.PET_AWARENESS_DATES)).toBe(true);
        });
    });
});