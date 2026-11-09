/**
 * lib/integrations/square-catalog-api.js
 *
 * The Square Catalog API half of lib/integrations/square-catalog.js: one GET
 * request helper, a paginator, and the transform to the catalog item shape.
 * Read-only: every call is GET /v2/catalog/list.
 *
 * LOGIC CHANGE 2026-11-09: split out of square-catalog.js (which keeps the cache)
 * when the new-item check needed created_at and image URLs and the file crossed
 * the 300-line limit. square-catalog.js re-exports everything here.
 */

'use strict';

const https = require('https');

// Square API base URL
const SQUARE_API_BASE = 'https://connect.squareup.com/v2';

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
 * List every object of one catalog type, following Square's pagination cursor.
 *
 * LOGIC CHANGE 2026-11-09: one paginator for items, categories and images. The
 * cursor is now URL-encoded; it was interpolated raw, and Square's cursors are
 * opaque strings that may carry characters a query string must escape.
 *
 * @param {string} type - ITEM, CATEGORY or IMAGE
 * @param {string} accessToken
 * @param {Function} [request] - injectable for tests; defaults to squareApiRequest
 * @returns {Promise<Array>} raw catalog objects of that type
 */
async function listCatalogObjects(type, accessToken, request = squareApiRequest) {
    const objects = [];
    let cursor = null;
    do {
        const query = `types=${encodeURIComponent(type)}` +
            (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const response = await request(`/catalog/list?${query}`, accessToken);
        for (const obj of response.objects || []) {
            if (obj.type === type && !obj.is_deleted) objects.push(obj);
        }
        cursor = response.cursor || null;
    } while (cursor);
    return objects;
}

/**
 * Square's object to the catalog shape the storefront and the new-item check read.
 *
 * LOGIC CHANGE 2026-11-09: adds `created_at` (when Square says the item was made),
 * `category_ids` (Square's `categories` list, falling back to the older single
 * `category_id`) and `image_url` (the first image's public URL, which Instagram
 * publishing needs). Existing fields are unchanged.
 */
function toCatalogItem(obj, categoryMap, imageMap) {
    const data = obj.item_data || {};
    const categoryIds = Array.isArray(data.categories) && data.categories.length > 0
        ? data.categories.map(c => c.id).filter(Boolean)
        : (data.category_id ? [data.category_id] : []);
    const firstImage = (data.image_ids || []).find(id => imageMap.has(id));
    return {
        id: obj.id,
        name: data.name || '',
        description: data.description || '',
        created_at: obj.created_at || null,
        category_id: categoryIds[0] || null,
        category_ids: categoryIds,
        category_name: categoryMap.get(categoryIds[0]) || null,
        category_names: categoryIds.map(id => categoryMap.get(id)).filter(Boolean),
        image_url: firstImage ? imageMap.get(firstImage) : null,
        variations: (data.variations || []).map(v => ({
            id: v.id,
            name: v.item_variation_data?.name || '',
            price_money: v.item_variation_data?.price_money || null,
            sku: v.item_variation_data?.sku || null,
        })),
    };
}

/**
 * Fetch all catalog items from Square API with pagination.
 * A failed category or image listing leaves those fields empty and is logged;
 * a failed item listing throws.
 *
 * @param {string} accessToken - Square access token
 * @param {Function} [request] - injectable for tests
 * @returns {Promise<Array>} Array of catalog item objects
 */
async function fetchCatalogFromSquare(accessToken, request = squareApiRequest) {
    const items = await listCatalogObjects('ITEM', accessToken, request);
    const categoryMap = new Map();
    const imageMap = new Map();
    try {
        for (const cat of await listCatalogObjects('CATEGORY', accessToken, request)) {
            if (cat.category_data) categoryMap.set(cat.id, cat.category_data.name);
        }
    } catch (err) {
        console.warn('[square-catalog] Failed to fetch categories:', err.message);
    }
    try {
        for (const img of await listCatalogObjects('IMAGE', accessToken, request)) {
            if (img.image_data && img.image_data.url) imageMap.set(img.id, img.image_data.url);
        }
    } catch (err) {
        console.warn('[square-catalog] Failed to fetch images:', err.message);
    }
    return items.filter(o => o.item_data).map(o => toCatalogItem(o, categoryMap, imageMap));
}

module.exports = {
    SQUARE_API_BASE,
    squareApiRequest,
    listCatalogObjects,
    toCatalogItem,
    fetchCatalogFromSquare,
};
