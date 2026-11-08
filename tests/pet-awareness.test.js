/**
 * tests/pet-awareness.test.js
 *
 * Tests for lib/integrations/pet-awareness.js: the static date list and its lookups.
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

describe('holidays module: pet awareness', () => {
    beforeEach(() => {
        // Clear cache before each test
        holidays.clearCache();
        jest.clearAllMocks();
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
            const april11 = storeDay(2026, 3, 11);
            const result = holidays.getTodayPetAwareness(april11);
            expect(result).not.toBeNull();
            expect(result.name).toBe('National Pet Day');
            expect(result.type).toBe('pet_awareness');
            expect(result.socialTip).toBeDefined();
        });

        test('returns null on non-pet-awareness day', () => {
            const july15 = storeDay(2026, 6, 15);
            const result = holidays.getTodayPetAwareness(july15);
            expect(result).toBeNull();
        });

        test('returns monthly awareness on first of month', () => {
            const feb1 = storeDay(2026, 1, 1);
            const result = holidays.getTodayPetAwareness(feb1);
            expect(result).not.toBeNull();
            expect(result.type).toBe('pet_awareness_month');
        });
    });

    describe('getActivePetAwareness', () => {
        test('returns all active monthly observances', () => {
            const feb15 = storeDay(2026, 1, 15);
            const result = holidays.getActivePetAwareness(feb15);

            // February has two monthly observances
            const monthlyItems = result.filter(r => r.type === 'pet_awareness_month');
            expect(monthlyItems.length).toBeGreaterThanOrEqual(2);

            const names = monthlyItems.map(m => m.name);
            expect(names).toContain('Responsible Pet Owners Month');
            expect(names).toContain('Pet Dental Health Month');
        });

        test('includes specific date when applicable', () => {
            const april11 = storeDay(2026, 3, 11);
            const result = holidays.getActivePetAwareness(april11);

            const petDay = result.find(r => r.name === 'National Pet Day');
            expect(petDay).toBeDefined();
            expect(petDay.type).toBe('pet_awareness');
        });

        test('returns empty array for month with no observances', () => {
            const july15 = storeDay(2026, 6, 15);
            const result = holidays.getActivePetAwareness(july15);
            expect(result).toEqual([]);
        });
    });

    describe('getUpcomingPetAwareness', () => {
        test('returns upcoming pet awareness dates', () => {
            const march1 = storeDay(2026, 2, 1);
            const result = holidays.getUpcomingPetAwareness(60, march1);

            // National Pet Day (April 11) should be within 60 days of March 1
            const petDay = result.find(r => r.name === 'National Pet Day');
            expect(petDay).toBeDefined();
            expect(petDay.daysAway).toBeLessThanOrEqual(60);
        });

        test('results are sorted by daysAway', () => {
            const jan1 = storeDay(2026, 0, 1);
            const result = holidays.getUpcomingPetAwareness(365, jan1);

            for (let i = 1; i < result.length; i++) {
                expect(result[i].daysAway).toBeGreaterThanOrEqual(result[i - 1].daysAway);
            }
        });

        test('only includes specific dates, not monthly observances', () => {
            const jan1 = storeDay(2026, 0, 1);
            const result = holidays.getUpcomingPetAwareness(365, jan1);

            for (const item of result) {
                expect(item.type).toBe('pet_awareness');
            }
        });
    });
});
