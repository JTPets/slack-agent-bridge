/**
 * lib/integrations/catalog-search.js
 *
 * Fuzzy search for product catalog using Fuse.js.
 * Used by storefront chat to find products matching customer queries.
 *
 * LOGIC CHANGE 2026-03-27: Created for storefront product search integration
 */

'use strict';

const Fuse = require('fuse.js');

// ---- Module state ----

let fuseIndex = null;
let catalogItems = [];

// ---- Fuse.js configuration ----

const FUSE_OPTIONS = {
    // Search keys with weights
    keys: [
        { name: 'name', weight: 0.4 },
        { name: 'description', weight: 0.2 },
        { name: 'category_name', weight: 0.2 },
        { name: 'variations.name', weight: 0.2 },
    ],
    // Fuzzy matching threshold (0 = exact match, 1 = match anything)
    threshold: 0.3,
    // Include score in results
    includeScore: true,
    // Ignore location in string for better partial matching
    ignoreLocation: true,
    // Minimum characters before results are returned
    minMatchCharLength: 2,
};

// ---- Public API ----

/**
 * Initialize the catalog search index
 * @param {Array<object>} items - Catalog items to index
 * @returns {number} Number of items indexed
 */
function initCatalog(items) {
    if (!Array.isArray(items)) {
        throw new Error('initCatalog requires an array of items');
    }

    catalogItems = items;
    fuseIndex = new Fuse(catalogItems, FUSE_OPTIONS);

    return catalogItems.length;
}

/**
 * Search the catalog for matching products
 * @param {string} query - Search query
 * @param {number} [limit=5] - Maximum number of results to return
 * @returns {Array<{ name: string, price: number|null, category: string|null, score: number, item: object }>}
 */
function searchCatalog(query, limit = 5) {
    if (!fuseIndex) {
        console.warn('[catalog-search] Catalog not initialized. Call initCatalog first.');
        return [];
    }

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
        return [];
    }

    const results = fuseIndex.search(query.trim(), { limit });

    return results.map(result => {
        const item = result.item;

        // Extract price from first variation if available
        let price = null;
        if (item.variations && item.variations.length > 0) {
            const firstVariation = item.variations[0];
            if (firstVariation.price_money) {
                // Square stores price in cents
                price = firstVariation.price_money.amount / 100;
            } else if (firstVariation.price) {
                price = firstVariation.price;
            }
        }

        return {
            name: item.name || 'Unknown',
            price,
            category: item.category_name || null,
            // Fuse score: 0 = perfect match, higher = worse match
            // Convert to confidence: 1 = perfect, 0 = threshold
            score: 1 - (result.score || 0),
            item,
        };
    });
}

/**
 * Get catalog statistics
 * @returns {{ initialized: boolean, itemCount: number, categories: number }}
 */
function getCatalogStats() {
    if (!fuseIndex) {
        return {
            initialized: false,
            itemCount: 0,
            categories: 0,
        };
    }

    // Count unique categories
    const categories = new Set();
    for (const item of catalogItems) {
        if (item.category_name) {
            categories.add(item.category_name);
        }
    }

    return {
        initialized: true,
        itemCount: catalogItems.length,
        categories: categories.size,
    };
}

/**
 * Clear the catalog index (useful for testing or reloading)
 */
function clearCatalog() {
    fuseIndex = null;
    catalogItems = [];
}

module.exports = {
    initCatalog,
    searchCatalog,
    getCatalogStats,
    clearCatalog,
    // Export options for testing
    FUSE_OPTIONS,
};
