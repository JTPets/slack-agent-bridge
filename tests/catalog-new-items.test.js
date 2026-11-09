'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    checkNewItems, diffCatalog, formatNewItemsReport, readSeen,
} = require('../lib/catalog-new-items');

const item = (id, extra = {}) => ({
    id,
    name: `Item ${id}`,
    category_names: ['Dog Food'],
    image_url: `https://example.test/${id}.jpg`,
    variations: [{ price_money: { amount: 2499, currency: 'CAD' } }],
    ...extra,
});

describe('lib/catalog-new-items.js', () => {
    let dir;
    let stateFile;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-seen-'));
        stateFile = path.join(dir, 'catalog-seen.json');
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('first run is a baseline: everything recorded, nothing reported as new', async () => {
        const v = await checkNewItems({ fetchItems: async () => [item('A'), item('B')], stateFile });
        expect(v.status).toBe('baseline');
        expect(v.newItems).toEqual([]);
        expect(readSeen(stateFile).items.sort()).toEqual(['A', 'B']);
        expect(formatNewItemsReport(v)).toMatch(/first run, recorded 2/);
    });

    test('an item id not seen before is new, and is reported once', async () => {
        await checkNewItems({ fetchItems: async () => [item('A')], stateFile });
        const v = await checkNewItems({ fetchItems: async () => [item('A'), item('B')], stateFile });
        expect(v.status).toBe('ok');
        expect(v.newItems.map(i => i.id)).toEqual(['B']);
        const again = await checkNewItems({ fetchItems: async () => [item('A'), item('B')], stateFile });
        expect(again.newItems).toEqual([]);
        expect(formatNewItemsReport(again)).toMatch(/no new items/);
    });

    test('an item deleted and restored is not new a second time', async () => {
        await checkNewItems({ fetchItems: async () => [item('A'), item('B')], stateFile });
        await checkNewItems({ fetchItems: async () => [item('A')], stateFile });
        const v = await checkNewItems({ fetchItems: async () => [item('A'), item('B')], stateFile });
        expect(v.newItems).toEqual([]);
    });

    test('a category name not seen before is reported as a new category', async () => {
        await checkNewItems({ fetchItems: async () => [item('A')], stateFile });
        const v = await checkNewItems({
            fetchItems: async () => [item('A'), item('B', { category_names: ['Acana'] })],
            stateFile,
        });
        expect(v.newCategories).toEqual(['Acana']);
        expect(formatNewItemsReport(v)).toMatch(/New categories: Acana/);
    });

    test('a failed read is failed, never "nothing new", and records nothing', async () => {
        const v = await checkNewItems({ fetchItems: async () => { throw new Error('401'); }, stateFile });
        expect(v.status).toBe('failed');
        expect(v.reason).toMatch(/401/);
        expect(fs.existsSync(stateFile)).toBe(false);
        expect(formatNewItemsReport(v)).toMatch(/failed/);
    });

    test('an empty catalog is a failure and does not overwrite what was seen', async () => {
        await checkNewItems({ fetchItems: async () => [item('A')], stateFile });
        const v = await checkNewItems({ fetchItems: async () => [], stateFile });
        expect(v.status).toBe('failed');
        expect(readSeen(stateFile).items).toEqual(['A']);
    });

    test('a corrupt state file is a failure, not a fresh baseline', async () => {
        fs.writeFileSync(stateFile, '{not json');
        const v = await checkNewItems({ fetchItems: async () => [item('A')], stateFile });
        expect(v.status).toBe('failed');
        expect(v.reason).toMatch(/unreadable/);
        expect(fs.readFileSync(stateFile, 'utf8')).toBe('{not json');
    });

    test('the report names price and category and flags a missing photo', () => {
        const text = formatNewItemsReport({
            status: 'ok', total: 3, newCategories: [],
            newItems: [item('B', { name: 'Salmon Kibble', image_url: null })],
        });
        expect(text).toMatch(/Salmon Kibble\*, \$24\.99, Dog Food/);
        expect(text).toMatch(/no photo/);
    });

    test('diffCatalog falls back to the single category_name', () => {
        const out = diffCatalog([{ id: 'X', category_name: 'Cat Treats' }], { items: [], categories: [] });
        expect(out.newCategories).toEqual(['Cat Treats']);
    });
});
