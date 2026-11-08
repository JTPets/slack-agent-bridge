/**
 * tests/holidays-public.test.js
 *
 * Tests for lib/integrations/holidays-public.js: the Nager.Date client (https mocked),
 * its cache and the Ontario filter.
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

describe('holidays module: public holidays', () => {
    beforeEach(() => {
        // Clear cache before each test
        holidays.clearCache();
        jest.clearAllMocks();
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

            const christmas = storeDay(2026, 11, 25);
            const result = await holidays.getTodayHoliday(christmas);

            expect(result).not.toBeNull();
            expect(result.name).toBe('Christmas Day');
            expect(result.type).toBe('statutory');
        });

        test('returns null when no holiday matches', async () => {
            mockApiResponse(200, [
                { date: '2026-12-25', name: 'Christmas Day', localName: 'Christmas Day', counties: null },
            ]);

            const randomDay = storeDay(2026, 5, 15);
            const result = await holidays.getTodayHoliday(randomDay);

            expect(result).toBeNull();
        });

        test('filters out non-Ontario holidays', async () => {
            mockApiResponse(200, [
                { date: '2026-08-03', name: 'BC Day', localName: 'BC Day', counties: ['CA-BC'] },
            ]);

            const bcDay = storeDay(2026, 7, 3);
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

            const date = storeDay(2026, 5, 15);
            const result = await holidays.getTodayHoliday(date);

            expect(result).toBeNull();
        });

        test('handles non-200 status code', async () => {
            mockApiResponse(500, {});

            const date = storeDay(2026, 5, 15);
            const result = await holidays.getTodayHoliday(date);

            expect(result).toBeNull();
        });

        test('caches API results', async () => {
            mockApiResponse(200, [
                { date: '2026-07-01', name: 'Canada Day', localName: 'Canada Day', counties: null },
            ]);

            const date1 = storeDay(2026, 6, 1);
            const date2 = storeDay(2026, 6, 2);

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

            const result = await holidays.isHoliday(storeDay(2026, 6, 1));
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

            const result = await holidays.isHoliday(storeDay(2026, 6, 15));
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
            const result = await holidays.isHoliday(storeDay(2026, 11, 25));
            expect(result).toBe(true);
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

            const june25 = storeDay(2026, 5, 25);
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

            const jan1 = storeDay(2026, 0, 1);
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

            const date = storeDay(2026, 6, 1);

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
});
