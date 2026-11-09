/**
 * lib/catalog-new-items.js
 *
 * Which Square catalog items and categories are NEW since the last check.
 *
 * LOGIC CHANGE 2026-11-09: created for the social media agent, which drafts posts
 * about new items and brands. The bridge has no SqTools access, so "new" is
 * computed here from the read-only Square Catalog API: an item id never seen
 * before is new. Square has no brand field; a category name never seen before is
 * reported as a new category, which is the closest thing the catalog holds.
 *
 * State: `agents/shared/catalog-seen.json` (gitignored with the rest of
 * agents/shared/), the ids and category names ever seen. Ids are never removed,
 * so an item deleted and restored is not "new" a second time.
 *
 * Three outcomes are kept apart and never collapsed:
 *   - baseline: no state existed, so everything was recorded and nothing is
 *     reported as new (otherwise the first run would announce the whole catalog);
 *   - ok: the diff, possibly empty;
 *   - failed: the catalog could not be read, or came back empty. An empty catalog
 *     records nothing, because writing it would make every item "new" next time.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'catalog-seen.json');

/** The state, or null when there is none. A corrupt file throws: it is not "no state". */
function readSeen(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
    const parsed = JSON.parse(raw);
    return {
        items: Array.isArray(parsed.items) ? parsed.items : [],
        categories: Array.isArray(parsed.categories) ? parsed.categories : [],
        updatedAt: parsed.updatedAt || null,
    };
}

/** Write via a temp file and rename, so a crash never leaves half a file. */
function writeSeen(file, state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, file);
}

function categoryNamesOf(item) {
    if (Array.isArray(item.category_names) && item.category_names.length > 0) return item.category_names;
    return item.category_name ? [item.category_name] : [];
}

/**
 * Pure diff of a catalog against what was seen.
 * @returns {{ newItems: object[], newCategories: string[] }}
 */
function diffCatalog(items, seen) {
    const seenItems = new Set(seen.items);
    const seenCategories = new Set(seen.categories);
    const newItems = items.filter(item => item && item.id && !seenItems.has(item.id));
    const newCategories = [];
    for (const item of items) {
        for (const name of categoryNamesOf(item)) {
            if (!seenCategories.has(name) && !newCategories.includes(name)) newCategories.push(name);
        }
    }
    return { newItems, newCategories };
}

/**
 * Read the catalog, diff it, record what was seen.
 *
 * @param {object} opts
 * @param {Function} opts.fetchItems - resolves to catalog items (square-catalog refreshCatalog)
 * @param {string} [opts.stateFile]
 * @param {Date} [opts.now]
 * @returns {Promise<{ status: 'baseline'|'ok'|'failed', reason?: string,
 *   total?: number, newItems?: object[], newCategories?: string[] }>} never rejects
 */
async function checkNewItems({ fetchItems, stateFile = DEFAULT_STATE_FILE, now = new Date() }) {
    let items;
    try {
        items = await fetchItems();
    } catch (err) {
        return { status: 'failed', reason: `catalog read failed: ${err.message}` };
    }
    if (!Array.isArray(items) || items.length === 0) {
        return { status: 'failed', reason: 'the catalog came back empty, so nothing was recorded' };
    }

    let seen;
    try {
        seen = readSeen(stateFile);
    } catch (err) {
        return { status: 'failed', reason: `state file unreadable (${stateFile}): ${err.message}` };
    }

    const baseline = seen === null;
    const { newItems, newCategories } = baseline
        ? { newItems: [], newCategories: [] }
        : diffCatalog(items, seen);

    const allIds = new Set(baseline ? [] : seen.items);
    const allCategories = new Set(baseline ? [] : seen.categories);
    for (const item of items) {
        if (item && item.id) allIds.add(item.id);
        for (const name of categoryNamesOf(item)) allCategories.add(name);
    }
    try {
        writeSeen(stateFile, {
            items: [...allIds],
            categories: [...allCategories],
            updatedAt: now.toISOString(),
        });
    } catch (err) {
        return { status: 'failed', reason: `could not record the catalog: ${err.message}` };
    }

    return {
        status: baseline ? 'baseline' : 'ok',
        total: items.length,
        newItems,
        newCategories,
    };
}

function formatPrice(item) {
    const money = (item.variations || []).map(v => v.price_money).find(m => m && typeof m.amount === 'number');
    if (!money) return 'no price';
    return `$${(money.amount / 100).toFixed(2)}${money.currency && money.currency !== 'CAD' ? ` ${money.currency}` : ''}`;
}

/** The Slack text for a verdict. Says what was checked, so a quiet result is not a broken one. */
function formatNewItemsReport(verdict) {
    if (verdict.status === 'failed') {
        return `:x: New-item check failed: ${verdict.reason}`;
    }
    if (verdict.status === 'baseline') {
        return `:information_source: New-item check: first run, recorded ${verdict.total} catalog items as the starting point. Items added from now on will be reported.`;
    }
    if (verdict.newItems.length === 0 && verdict.newCategories.length === 0) {
        return `:white_check_mark: New-item check: no new items or categories among ${verdict.total} catalog items.`;
    }
    const lines = [`:new: New in the Square catalog (${verdict.total} items checked):`];
    for (const item of verdict.newItems) {
        const cats = categoryNamesOf(item);
        lines.push(`• *${item.name || item.id}*, ${formatPrice(item)}` +
            (cats.length ? `, ${cats.join(' / ')}` : '') +
            (item.image_url ? '' : ' (no photo: Instagram needs one)'));
    }
    if (verdict.newCategories.length > 0) {
        lines.push(`New categories: ${verdict.newCategories.join(', ')}`);
    }
    return lines.join('\n');
}

module.exports = {
    DEFAULT_STATE_FILE,
    readSeen,
    writeSeen,
    diffCatalog,
    checkNewItems,
    formatNewItemsReport,
    formatPrice,
};
