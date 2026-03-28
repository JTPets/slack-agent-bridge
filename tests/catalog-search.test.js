/**
 * tests/catalog-search.test.js
 *
 * Tests for lib/integrations/catalog-search.js
 * Covers fuzzy matching: exact, partial, misspelling, no match cases.
 */

'use strict';

const {
    initCatalog,
    searchCatalog,
    getCatalogStats,
    clearCatalog,
} = require('../lib/integrations/catalog-search');

// Sample test catalog data
const TEST_CATALOG = [
    {
        id: 'item-001',
        name: 'Premium Chicken Dog Food',
        description: 'High-quality chicken formula for adult dogs',
        category_name: 'Dog Food',
        variations: [
            { name: '5lb bag', price_money: { amount: 2499, currency: 'CAD' } },
            { name: '15lb bag', price_money: { amount: 5999, currency: 'CAD' } },
        ],
    },
    {
        id: 'item-002',
        name: 'Salmon Cat Food',
        description: 'Wild-caught salmon recipe for cats',
        category_name: 'Cat Food',
        variations: [
            { name: '3lb bag', price_money: { amount: 1899, currency: 'CAD' } },
        ],
    },
    {
        id: 'item-003',
        name: 'Beef & Sweet Potato Dog Treats',
        description: 'Natural treats with real beef and sweet potato',
        category_name: 'Dog Treats',
        variations: [
            { name: '8oz bag', price_money: { amount: 899, currency: 'CAD' } },
        ],
    },
    {
        id: 'item-004',
        name: 'Grain-Free Duck Formula',
        description: 'Limited ingredient duck recipe for sensitive stomachs',
        category_name: 'Dog Food',
        variations: [
            { name: '12lb bag', price_money: { amount: 4599, currency: 'CAD' } },
        ],
    },
    {
        id: 'item-005',
        name: 'Catnip Mouse Toy',
        description: 'Organic catnip stuffed plush mouse',
        category_name: 'Cat Toys',
        variations: [
            { name: 'Single', price: 4.99 },
        ],
    },
];

describe('catalog-search', () => {
    beforeEach(() => {
        clearCatalog();
    });

    afterAll(() => {
        clearCatalog();
    });

    describe('initCatalog', () => {
        it('should initialize catalog with items', () => {
            const count = initCatalog(TEST_CATALOG);
            expect(count).toBe(5);
        });

        it('should throw error if items is not an array', () => {
            expect(() => initCatalog(null)).toThrow('initCatalog requires an array of items');
            expect(() => initCatalog('not an array')).toThrow('initCatalog requires an array of items');
        });

        it('should handle empty array', () => {
            const count = initCatalog([]);
            expect(count).toBe(0);
        });
    });

    describe('getCatalogStats', () => {
        it('should return uninitialized stats when catalog not loaded', () => {
            const stats = getCatalogStats();
            expect(stats.initialized).toBe(false);
            expect(stats.itemCount).toBe(0);
            expect(stats.categories).toBe(0);
        });

        it('should return correct stats after initialization', () => {
            initCatalog(TEST_CATALOG);
            const stats = getCatalogStats();
            expect(stats.initialized).toBe(true);
            expect(stats.itemCount).toBe(5);
            expect(stats.categories).toBe(4); // Dog Food, Cat Food, Dog Treats, Cat Toys
        });
    });

    describe('searchCatalog - exact match', () => {
        beforeEach(() => {
            initCatalog(TEST_CATALOG);
        });

        it('should find exact product name match', () => {
            const results = searchCatalog('Salmon Cat Food');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toBe('Salmon Cat Food');
            expect(results[0].score).toBeGreaterThan(0.7); // High confidence
        });

        it('should return price in dollars not cents', () => {
            const results = searchCatalog('Salmon Cat Food');
            expect(results[0].price).toBe(18.99);
        });

        it('should include category', () => {
            const results = searchCatalog('Salmon Cat Food');
            expect(results[0].category).toBe('Cat Food');
        });
    });

    describe('searchCatalog - partial match', () => {
        beforeEach(() => {
            initCatalog(TEST_CATALOG);
        });

        it('should find partial name match', () => {
            const results = searchCatalog('chicken');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toContain('Chicken');
        });

        it('should find match in description', () => {
            const results = searchCatalog('sensitive stomachs');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toBe('Grain-Free Duck Formula');
        });

        it('should find match in category', () => {
            const results = searchCatalog('Dog Food');
            expect(results.length).toBeGreaterThan(0);
            // Should find multiple dog food items
            const dogFoodItems = results.filter(r => r.category === 'Dog Food');
            expect(dogFoodItems.length).toBeGreaterThan(0);
        });

        it('should find match in variation name', () => {
            const results = searchCatalog('15lb bag');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toBe('Premium Chicken Dog Food');
        });
    });

    describe('searchCatalog - misspelling', () => {
        beforeEach(() => {
            initCatalog(TEST_CATALOG);
        });

        it('should find match with minor misspelling', () => {
            const results = searchCatalog('chiken'); // Missing 'c'
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toContain('Chicken');
        });

        it('should find match with missing letter', () => {
            const results = searchCatalog('salmo'); // Missing 'n' at end
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toContain('Salmon');
        });

        it('should find match with common typo', () => {
            const results = searchCatalog('catnp'); // Missing 'i'
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toContain('Catnip');
        });
    });

    describe('searchCatalog - no match', () => {
        beforeEach(() => {
            initCatalog(TEST_CATALOG);
        });

        it('should return empty array for completely unrelated query', () => {
            const results = searchCatalog('xyzabc123');
            expect(results).toEqual([]);
        });

        it('should return empty array for very different term', () => {
            const results = searchCatalog('automobile');
            expect(results).toEqual([]);
        });

        it('should return empty array for empty query', () => {
            const results = searchCatalog('');
            expect(results).toEqual([]);
        });

        it('should return empty array for short query', () => {
            const results = searchCatalog('a'); // Less than minMatchCharLength
            expect(results).toEqual([]);
        });

        it('should return empty array for null/undefined query', () => {
            expect(searchCatalog(null)).toEqual([]);
            expect(searchCatalog(undefined)).toEqual([]);
        });
    });

    describe('searchCatalog - limit parameter', () => {
        beforeEach(() => {
            initCatalog(TEST_CATALOG);
        });

        it('should respect limit parameter', () => {
            const results = searchCatalog('dog', 2);
            expect(results.length).toBeLessThanOrEqual(2);
        });

        it('should use default limit of 5', () => {
            // Add more items to test limit
            const manyItems = [];
            for (let i = 0; i < 20; i++) {
                manyItems.push({
                    id: `item-${i}`,
                    name: `Dog Product ${i}`,
                    description: 'Test product for dogs',
                    category_name: 'Dog Products',
                    variations: [],
                });
            }
            initCatalog(manyItems);

            const results = searchCatalog('dog');
            expect(results.length).toBeLessThanOrEqual(5);
        });
    });

    describe('searchCatalog - uninitialized catalog', () => {
        it('should return empty array and warn when catalog not initialized', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
            const results = searchCatalog('chicken');
            expect(results).toEqual([]);
            expect(consoleSpy).toHaveBeenCalledWith(
                '[catalog-search] Catalog not initialized. Call initCatalog first.'
            );
            consoleSpy.mockRestore();
        });
    });

    describe('searchCatalog - item with alternative price format', () => {
        it('should handle items with price instead of price_money', () => {
            initCatalog(TEST_CATALOG);
            const results = searchCatalog('catnip mouse');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].price).toBe(4.99);
        });

        it('should handle items with no price', () => {
            initCatalog([{
                id: 'no-price',
                name: 'Test Item No Price',
                description: 'Item without price',
                category_name: 'Test',
                variations: [{ name: 'Standard' }],
            }]);

            const results = searchCatalog('no price');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].price).toBeNull();
        });
    });
});
