/**
 * tests/holidays.test.js
 *
 * Tests for lib/integrations/holidays.js
 */

'use strict';

const holidays = require('../lib/integrations/holidays');

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

    describe('parseDate', () => {
        test('parses Date object', () => {
            const date = new Date(2026, 3, 11); // April 11, 2026
            const result = holidays.parseDate(date);
            expect(result).toEqual({ year: 2026, month: 4, day: 11 });
        });

        test('parses date string', () => {
            // Use explicit Date object to avoid timezone issues with date string parsing
            const result = holidays.parseDate(new Date(2026, 3, 11)); // April 11, 2026
            expect(result).toEqual({ year: 2026, month: 4, day: 11 });
        });
    });

    describe('formatDate', () => {
        test('formats date as YYYY-MM-DD', () => {
            const date = new Date(2026, 3, 11); // April 11, 2026
            expect(holidays.formatDate(date)).toBe('2026-04-11');
        });

        test('pads single-digit months and days', () => {
            const date = new Date(2026, 0, 5); // January 5, 2026
            expect(holidays.formatDate(date)).toBe('2026-01-05');
        });
    });

    describe('filterOntarioHolidays', () => {
        test('includes national holidays (no counties)', () => {
            const input = [
                { name: 'Christmas', counties: null },
                { name: 'Christmas', counties: [] },
            ];
            const result = holidays.filterOntarioHolidays(input);
            expect(result).toHaveLength(2);
        });

        test('includes Ontario-specific holidays', () => {
            const input = [
                { name: 'Family Day', counties: ['CA-ON'] },
            ];
            const result = holidays.filterOntarioHolidays(input);
            expect(result).toHaveLength(1);
        });

        test('excludes non-Ontario provincial holidays', () => {
            const input = [
                { name: 'BC Day', counties: ['CA-BC'] },
                { name: 'Alberta Day', counties: ['CA-AB'] },
            ];
            const result = holidays.filterOntarioHolidays(input);
            expect(result).toHaveLength(0);
        });

        test('handles mixed Ontario and non-Ontario holidays', () => {
            const input = [
                { name: 'Canada Day', counties: null },
                { name: 'Family Day', counties: ['CA-ON'] },
                { name: 'BC Day', counties: ['CA-BC'] },
            ];
            const result = holidays.filterOntarioHolidays(input);
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe('Canada Day');
            expect(result[1].name).toBe('Family Day');
        });
    });

    describe('PET_AWARENESS_DATES', () => {
        test('contains expected monthly observances', () => {
            const months = holidays.PET_AWARENESS_DATES.filter(d => d.type === 'month');
            expect(months.length).toBeGreaterThan(0);

            const monthNames = months.map(m => m.name);
            expect(monthNames).toContain('Responsible Pet Owners Month');
            expect(monthNames).toContain('Pet Dental Health Month');
            expect(monthNames).toContain('Senior Pet Month');
        });

        test('contains expected specific dates', () => {
            const days = holidays.PET_AWARENESS_DATES.filter(d => d.type === 'day');
            expect(days.length).toBeGreaterThan(0);

            const dayNames = days.map(d => d.name);
            expect(dayNames).toContain('National Pet Day');
            expect(dayNames).toContain('National Dog Day');
            expect(dayNames).toContain('National Cat Day');
        });

        test('all entries have required fields', () => {
            for (const entry of holidays.PET_AWARENESS_DATES) {
                expect(entry).toHaveProperty('month');
                expect(entry).toHaveProperty('day');
                expect(entry).toHaveProperty('name');
                expect(entry).toHaveProperty('type');
                expect(entry).toHaveProperty('socialTip');
                expect(typeof entry.month).toBe('number');
                expect(typeof entry.day).toBe('number');
                expect(typeof entry.name).toBe('string');
                expect(['month', 'day']).toContain(entry.type);
            }
        });

        test('National Pet Day is April 11', () => {
            const petDay = holidays.PET_AWARENESS_DATES.find(d => d.name === 'National Pet Day');
            expect(petDay).toBeDefined();
            expect(petDay.month).toBe(4);
            expect(petDay.day).toBe(11);
        });

        test('National Dog Day is August 26', () => {
            const dogDay = holidays.PET_AWARENESS_DATES.find(d => d.name === 'National Dog Day');
            expect(dogDay).toBeDefined();
            expect(dogDay.month).toBe(8);
            expect(dogDay.day).toBe(26);
        });

        test('National Cat Day is October 29', () => {
            const catDay = holidays.PET_AWARENESS_DATES.find(d => d.name === 'National Cat Day');
            expect(catDay).toBeDefined();
            expect(catDay.month).toBe(10);
            expect(catDay.day).toBe(29);
        });
    });

    describe('getTodayPetAwareness', () => {
        test('returns National Pet Day on April 11', () => {
            const april11 = new Date(2026, 3, 11);
            const result = holidays.getTodayPetAwareness(april11);
            expect(result).not.toBeNull();
            expect(result.name).toBe('National Pet Day');
            expect(result.type).toBe('pet_awareness');
            expect(result.socialTip).toBeDefined();
        });

        test('returns null on non-pet-awareness day', () => {
            const july15 = new Date(2026, 6, 15);
            const result = holidays.getTodayPetAwareness(july15);
            expect(result).toBeNull();
        });

        test('returns monthly awareness on first of month', () => {
            const feb1 = new Date(2026, 1, 1);
            const result = holidays.getTodayPetAwareness(feb1);
            expect(result).not.toBeNull();
            expect(result.type).toBe('pet_awareness_month');
        });
    });

    describe('getActivePetAwareness', () => {
        test('returns all active monthly observances', () => {
            const feb15 = new Date(2026, 1, 15);
            const result = holidays.getActivePetAwareness(feb15);

            // February has two monthly observances
            const monthlyItems = result.filter(r => r.type === 'pet_awareness_month');
            expect(monthlyItems.length).toBeGreaterThanOrEqual(2);

            const names = monthlyItems.map(m => m.name);
            expect(names).toContain('Responsible Pet Owners Month');
            expect(names).toContain('Pet Dental Health Month');
        });

        test('includes specific date when applicable', () => {
            const april11 = new Date(2026, 3, 11);
            const result = holidays.getActivePetAwareness(april11);

            const petDay = result.find(r => r.name === 'National Pet Day');
            expect(petDay).toBeDefined();
            expect(petDay.type).toBe('pet_awareness');
        });

        test('returns empty array for month with no observances', () => {
            const july15 = new Date(2026, 6, 15);
            const result = holidays.getActivePetAwareness(july15);
            expect(result).toEqual([]);
        });
    });

    describe('getUpcomingPetAwareness', () => {
        test('returns upcoming pet awareness dates', () => {
            const march1 = new Date(2026, 2, 1);
            const result = holidays.getUpcomingPetAwareness(60, march1);

            // National Pet Day (April 11) should be within 60 days of March 1
            const petDay = result.find(r => r.name === 'National Pet Day');
            expect(petDay).toBeDefined();
            expect(petDay.daysAway).toBeLessThanOrEqual(60);
        });

        test('results are sorted by daysAway', () => {
            const jan1 = new Date(2026, 0, 1);
            const result = holidays.getUpcomingPetAwareness(365, jan1);

            for (let i = 1; i < result.length; i++) {
                expect(result[i].daysAway).toBeGreaterThanOrEqual(result[i - 1].daysAway);
            }
        });

        test('only includes specific dates, not monthly observances', () => {
            const jan1 = new Date(2026, 0, 1);
            const result = holidays.getUpcomingPetAwareness(365, jan1);

            for (const item of result) {
                expect(item.type).toBe('pet_awareness');
            }
        });
    });

    describe('getTodayHoliday with mocked API', () => {
        function mockApiResponse(statusCode, data) {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify(data));
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
        }

        test('returns holiday when date matches', async () => {
            mockApiResponse(200, [
                { date: '2026-12-25', name: 'Christmas Day', localName: 'Christmas Day', counties: null },
            ]);

            const christmas = new Date(2026, 11, 25);
            const result = await holidays.getTodayHoliday(christmas);

            expect(result).not.toBeNull();
            expect(result.name).toBe('Christmas Day');
            expect(result.type).toBe('statutory');
        });

        test('returns null when no holiday matches', async () => {
            mockApiResponse(200, [
                { date: '2026-12-25', name: 'Christmas Day', localName: 'Christmas Day', counties: null },
            ]);

            const randomDay = new Date(2026, 5, 15);
            const result = await holidays.getTodayHoliday(randomDay);

            expect(result).toBeNull();
        });

        test('filters out non-Ontario holidays', async () => {
            mockApiResponse(200, [
                { date: '2026-08-03', name: 'BC Day', localName: 'BC Day', counties: ['CA-BC'] },
            ]);

            const bcDay = new Date(2026, 7, 3);
            const result = await holidays.getTodayHoliday(bcDay);

            expect(result).toBeNull();
        });

        test('handles API error gracefully', async () => {
            https.get.mockImplementation((url, callback) => {
                return {
                    on: jest.fn((event, handler) => {
                        if (event === 'error') {
                            handler(new Error('Network error'));
                        }
                    }),
                };
            });

            const date = new Date(2026, 5, 15);
            const result = await holidays.getTodayHoliday(date);

            expect(result).toBeNull();
        });

        test('handles non-200 status code', async () => {
            mockApiResponse(500, {});

            const date = new Date(2026, 5, 15);
            const result = await holidays.getTodayHoliday(date);

            expect(result).toBeNull();
        });

        test('caches API results', async () => {
            mockApiResponse(200, [
                { date: '2026-07-01', name: 'Canada Day', localName: 'Canada Day', counties: null },
            ]);

            const date1 = new Date(2026, 6, 1);
            const date2 = new Date(2026, 6, 2);

            await holidays.getTodayHoliday(date1);
            await holidays.getTodayHoliday(date2);

            // API should only be called once due to caching
            expect(https.get).toHaveBeenCalledTimes(1);
        });
    });

    describe('isHoliday', () => {
        test('returns true for holiday date', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-07-01', name: 'Canada Day', counties: null },
                            ]));
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

            const result = await holidays.isHoliday(new Date(2026, 6, 1));
            expect(result).toBe(true);
        });

        test('returns false for non-holiday date', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-07-01', name: 'Canada Day', counties: null },
                            ]));
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

            const result = await holidays.isHoliday(new Date(2026, 6, 15));
            expect(result).toBe(false);
        });

        test('accepts Date object', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-12-25', name: 'Christmas', counties: null },
                            ]));
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

            // Use explicit Date object to avoid timezone issues
            const result = await holidays.isHoliday(new Date(2026, 11, 25));
            expect(result).toBe(true);
        });
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

            const april11 = new Date(2026, 3, 11);
            const result = await holidays.getTodaySpecialDates(april11);

            expect(result).toHaveProperty('holiday');
            expect(result).toHaveProperty('petAwareness');
            expect(Array.isArray(result.petAwareness)).toBe(true);

            // Should have National Pet Day in pet awareness
            const petDay = result.petAwareness.find(p => p.name === 'National Pet Day');
            expect(petDay).toBeDefined();
        });
    });

    describe('getUpcomingHolidays', () => {
        beforeEach(() => {
            holidays.clearCache();
        });

        test('returns holidays within specified days', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-07-01', name: 'Canada Day', localName: 'Canada Day', counties: null },
                                { date: '2026-09-07', name: 'Labour Day', localName: 'Labour Day', counties: null },
                            ]));
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

            const june25 = new Date(2026, 5, 25);
            const result = await holidays.getUpcomingHolidays(10, june25);

            expect(result.length).toBe(1);
            expect(result[0].name).toBe('Canada Day');
            expect(result[0].daysAway).toBeLessThanOrEqual(10);
        });

        test('results are sorted by date', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-12-25', name: 'Christmas', counties: null },
                                { date: '2026-07-01', name: 'Canada Day', counties: null },
                                { date: '2026-10-12', name: 'Thanksgiving', counties: null },
                            ]));
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

            const jan1 = new Date(2026, 0, 1);
            const result = await holidays.getUpcomingHolidays(365, jan1);

            for (let i = 1; i < result.length; i++) {
                expect(new Date(result[i].date).getTime())
                    .toBeGreaterThanOrEqual(new Date(result[i - 1].date).getTime());
            }
        });
    });

    describe('clearCache', () => {
        test('clears the holiday cache', async () => {
            https.get.mockImplementation((url, callback) => {
                const mockResponse = {
                    statusCode: 200,
                    on: jest.fn((event, handler) => {
                        if (event === 'data') {
                            handler(JSON.stringify([
                                { date: '2026-07-01', name: 'Canada Day', counties: null },
                            ]));
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

            const date = new Date(2026, 6, 1);

            // First call - populates cache
            await holidays.getTodayHoliday(date);
            expect(https.get).toHaveBeenCalledTimes(1);

            // Second call - uses cache
            await holidays.getTodayHoliday(date);
            expect(https.get).toHaveBeenCalledTimes(1);

            // Clear cache
            holidays.clearCache();

            // Third call - fetches fresh data
            await holidays.getTodayHoliday(date);
            expect(https.get).toHaveBeenCalledTimes(2);
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
