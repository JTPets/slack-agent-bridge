'use strict';

const { fetchCatalogFromSquare, listCatalogObjects } = require('../lib/integrations/square-catalog-api');
const squareCatalog = require('../lib/integrations/square-catalog');

function fakeSquare(pages) {
    const calls = [];
    const request = async (endpoint) => {
        calls.push(endpoint);
        const url = new URL(`https://x.test${endpoint}`);
        const type = url.searchParams.get('types');
        const cursor = url.searchParams.get('cursor') || '';
        const page = (pages[type] || {})[cursor];
        if (page instanceof Error) throw page;
        return page || {};
    };
    return { request, calls };
}

describe('lib/integrations/square-catalog-api.js', () => {
    test('follows the cursor, URL-encoded, and skips deleted objects', async () => {
        const { request, calls } = fakeSquare({
            ITEM: {
                '': { objects: [{ type: 'ITEM', id: 'A', item_data: {} }], cursor: 'a+b/c' },
                'a+b/c': { objects: [{ type: 'ITEM', id: 'B', is_deleted: true, item_data: {} }] },
            },
        });
        const out = await listCatalogObjects('ITEM', 'tok', request);
        expect(out.map(o => o.id)).toEqual(['A']);
        expect(calls[1]).toContain('cursor=a%2Bb%2Fc');
    });

    test('maps created_at, categories and the first image url', async () => {
        const { request } = fakeSquare({
            ITEM: { '': { objects: [{
                type: 'ITEM', id: 'A', created_at: '2026-11-01T10:00:00Z',
                item_data: {
                    name: 'Kibble', categories: [{ id: 'C1' }, { id: 'C2' }], image_ids: ['I0', 'I1'],
                    variations: [{ id: 'V', item_variation_data: { name: 'Bag', price_money: { amount: 500, currency: 'CAD' } } }],
                },
            }] } },
            CATEGORY: { '': { objects: [
                { type: 'CATEGORY', id: 'C1', category_data: { name: 'Dog Food' } },
                { type: 'CATEGORY', id: 'C2', category_data: { name: 'Acana' } },
            ] } },
            IMAGE: { '': { objects: [{ type: 'IMAGE', id: 'I1', image_data: { url: 'https://img.test/1.jpg' } }] } },
        });
        const [item] = await fetchCatalogFromSquare('tok', request);
        expect(item).toMatchObject({
            id: 'A', name: 'Kibble', created_at: '2026-11-01T10:00:00Z',
            category_id: 'C1', category_name: 'Dog Food', category_names: ['Dog Food', 'Acana'],
            image_url: 'https://img.test/1.jpg',
        });
        expect(item.variations[0].price_money.amount).toBe(500);
    });

    test('the older single category_id still resolves', async () => {
        const { request } = fakeSquare({
            ITEM: { '': { objects: [{ type: 'ITEM', id: 'A', item_data: { category_id: 'C1' } }] } },
            CATEGORY: { '': { objects: [{ type: 'CATEGORY', id: 'C1', category_data: { name: 'Treats' } }] } },
        });
        const [item] = await fetchCatalogFromSquare('tok', request);
        expect(item.category_name).toBe('Treats');
        expect(item.image_url).toBeNull();
    });

    test('a failed image listing leaves image_url empty; a failed item listing throws', async () => {
        const ok = fakeSquare({
            ITEM: { '': { objects: [{ type: 'ITEM', id: 'A', item_data: { image_ids: ['I'] } }] } },
            IMAGE: { '': new Error('boom') },
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const [item] = await fetchCatalogFromSquare('tok', ok.request);
        expect(item.image_url).toBeNull();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();

        const bad = fakeSquare({ ITEM: { '': new Error('401') } });
        await expect(fetchCatalogFromSquare('tok', bad.request)).rejects.toThrow('401');
    });

    test('square-catalog.js re-exports the same functions', () => {
        expect(squareCatalog.fetchCatalogFromSquare).toBe(fetchCatalogFromSquare);
        expect(squareCatalog.listCatalogObjects).toBe(listCatalogObjects);
    });
});
