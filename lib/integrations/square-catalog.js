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
const https = require('https');

// ---- Configuration ----

const CACHE_FILE = process.env.CATALOG_CACHE_FILE ||
    path.join(__dirname, '../../data/catalog-cache.json');

// Cache TTL: 1 hour by default
const CACHE_TTL_MS = parseInt(process.env.CATALOG_CACHE_TTL_MS, 10) || (60 * 60 * 1000);

// Square API base URL
const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

// ---- Module state ----

let catalogCache = {
    items: null,
    fetchedAt: null,
};

// ---- Square API helpers ----

/**
 * Make a request to Square API
 * @param {string} endpoint - API endpoint (e.g., '/catalog/list')
 * @param {string} accessToken - Square access token
 * @returns {Promise<object>} API response
 */
function squareApiRequest(endpoint, accessToken) {
    return new Promise((resolve, reject) => {
        const url = new URL(SQUARE_API_BASE + endpoint);

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'Square-Version': '2024-01-18',
            },
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        const error = new Error(`Square API error: ${res.statusCode}`);
                        error.response = json;
                        reject(error);
                        return;
                    }
                    resolve(json);
                } catch (err) {
                    reject(new Error(`Failed to parse Square API response: ${err.message}`));
                }
            });
        });

        req.on('error', (err) => {
            reject(new Error(`Square API request failed: ${err.message}`));
        });

        req.end();
    });
}

/**
 * Fetch all catalog items from Square API with pagination
 * @param {string} accessToken - Square access token
 * @returns {Promise<Array>} Array of catalog item objects
 */
async function fetchCatalogFromSquare(accessToken) {
    const items = [];
    let cursor = null;

    do {
        const endpoint = cursor
            ? `/catalog/list?types=ITEM&cursor=${cursor}`
            : '/catalog/list?types=ITEM';

        const response = await squareApiRequest(endpoint, accessToken);

        if (response.objects) {
            // Transform Square catalog objects to our format
            for (const obj of response.objects) {
                if (obj.type === 'ITEM' && obj.item_data) {
                    const item = {
                        id: obj.id,
                        name: obj.item_data.name || '',
                        description: obj.item_data.description || '',
                        category_id: obj.item_data.category_id || null,
                        category_name: null, // Will be populated separately
                        variations: (obj.item_data.variations || []).map(v => ({
                            id: v.id,
                            name: v.item_variation_data?.name || '',
                            price_money: v.item_variation_data?.price_money || null,
                            sku: v.item_variation_data?.sku || null,
                        })),
                    };
                    items.push(item);
                }
            }
        }

        cursor = response.cursor || null;
    } while (cursor);

    // Fetch categories to populate category_name
    try {
        const categoriesResponse = await squareApiRequest('/catalog/list?types=CATEGORY', accessToken);
        const categoryMap = new Map();

        if (categoriesResponse.objects) {
            for (const cat of categoriesResponse.objects) {
                if (cat.type === 'CATEGORY' && cat.category_data) {
                    categoryMap.set(cat.id, cat.category_data.name);
                }
            }
        }

        // Populate category names
        for (const item of items) {
            if (item.category_id && categoryMap.has(item.category_id)) {
                item.category_name = categoryMap.get(item.category_id);
            }
        }
    } catch (err) {
        console.warn('[square-catalog] Failed to fetch categories:', err.message);
    }

    return items;
}

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
    // Export for testing
    CACHE_FILE,
    CACHE_TTL_MS,
};
