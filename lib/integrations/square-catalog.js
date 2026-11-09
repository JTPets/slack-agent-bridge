/**
 * lib/integrations/square-catalog.js
 *
 * Square Catalog API loader with local caching.
 * Fetches catalog from Square API if SQUARE_ACCESS_TOKEN is set,
 * otherwise falls back to local cache file.
 *
 * LOGIC CHANGE 2026-03-27: Created for storefront product search integration
 */

'use strict';

const fs = require('fs').promises;
const path = require('path');

// ---- Configuration ----

const CACHE_FILE = process.env.CATALOG_CACHE_FILE ||
    path.join(__dirname, '../../data/catalog-cache.json');

// Cache TTL: 1 hour by default
const CACHE_TTL_MS = parseInt(process.env.CATALOG_CACHE_TTL_MS, 10) || (60 * 60 * 1000);

// ---- Module state ----

let catalogCache = {
    items: null,
    fetchedAt: null,
};

const { fetchCatalogFromSquare, listCatalogObjects, toCatalogItem } = require('./square-catalog-api');

// ---- Cache helpers ----

/**
 * Load catalog from local cache file
 * @returns {Promise<Array|null>} Cached items or null if not found
 */
async function loadFromCache() {
    try {
        const data = await fs.readFile(CACHE_FILE, 'utf8');
        const cache = JSON.parse(data);

        if (cache.items && Array.isArray(cache.items)) {
            // Check if cache is still valid
            if (cache.fetchedAt && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS) {
                catalogCache = cache;
                return cache.items;
            }
        }
        return null;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn('[square-catalog] Failed to load cache:', err.message);
        }
        return null;
    }
}

/**
 * Save catalog to local cache file
 * @param {Array} items - Catalog items to cache
 */
async function saveToCache(items) {
    const cache = {
        items,
        fetchedAt: Date.now(),
    };

    try {
        // Ensure data directory exists
        const dir = path.dirname(CACHE_FILE);
        await fs.mkdir(dir, { recursive: true });

        await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
        catalogCache = cache;
    } catch (err) {
        console.warn('[square-catalog] Failed to save cache:', err.message);
    }
}

// ---- Public API ----

/**
 * Load catalog from Square API or local cache
 * @returns {Promise<Array>} Array of catalog items
 */
async function loadCatalog() {
    const accessToken = process.env.SQUARE_ACCESS_TOKEN;

    // If we have a valid in-memory cache, use it
    if (catalogCache.items && catalogCache.fetchedAt &&
        (Date.now() - catalogCache.fetchedAt) < CACHE_TTL_MS) {
        return catalogCache.items;
    }

    // If Square token is set, try to fetch from API
    if (accessToken) {
        try {
            console.log('[square-catalog] Fetching catalog from Square API...');
            const items = await fetchCatalogFromSquare(accessToken);
            await saveToCache(items);
            console.log(`[square-catalog] Loaded ${items.length} items from Square API`);
            return items;
        } catch (err) {
            console.error('[square-catalog] Square API fetch failed:', err.message);
            // Fall through to cache
        }
    }

    // Try to load from cache
    const cachedItems = await loadFromCache();
    if (cachedItems) {
        console.log(`[square-catalog] Loaded ${cachedItems.length} items from cache`);
        return cachedItems;
    }

    // No catalog available
    console.warn('[square-catalog] No catalog available (no token and no cache)');
    return [];
}

/**
 * Force refresh catalog from Square API
 * @returns {Promise<Array>} Array of catalog items
 */
async function refreshCatalog() {
    const accessToken = process.env.SQUARE_ACCESS_TOKEN;

    if (!accessToken) {
        throw new Error('SQUARE_ACCESS_TOKEN is required to refresh catalog');
    }

    console.log('[square-catalog] Force refreshing catalog from Square API...');
    const items = await fetchCatalogFromSquare(accessToken);
    await saveToCache(items);
    console.log(`[square-catalog] Refreshed ${items.length} items from Square API`);
    return items;
}

/**
 * Get catalog statistics
 * @returns {{ hasToken: boolean, cacheAge: number|null, itemCount: number }}
 */
function getCatalogStatus() {
    return {
        hasToken: !!process.env.SQUARE_ACCESS_TOKEN,
        cacheAge: catalogCache.fetchedAt ? Date.now() - catalogCache.fetchedAt : null,
        itemCount: catalogCache.items ? catalogCache.items.length : 0,
    };
}

/**
 * Clear the catalog cache (useful for testing)
 */
function clearCache() {
    catalogCache = {
        items: null,
        fetchedAt: null,
    };
}

module.exports = {
    loadCatalog,
    refreshCatalog,
    getCatalogStatus,
    clearCache,
    fetchCatalogFromSquare,
    listCatalogObjects,
    toCatalogItem,
    // Export for testing
    CACHE_FILE,
    CACHE_TTL_MS,
};
