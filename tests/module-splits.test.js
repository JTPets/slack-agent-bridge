'use strict';

/**
 * tests/module-splits.test.js
 *
 * WORK-TODO #10: a split moves code between files and must change nothing a caller
 * can see. Each split keeps the original module as a facade, so the property is that
 * every name the facade exported before the split is still exported, and is the SAME
 * function object as the one in the module it moved to (not a copy that can drift).
 *
 * The export lists are the pre-split `module.exports` keys, copied from the parent
 * commit, so a name dropped from a facade is a red test. Since 2026-11-12 (B28) the
 * table lives in tests/helpers/module-splits-table.js, so this suite stays under the
 * 300-line limit as it grows.
 */

const path = require('path');

const { SPLITS } = require('./helpers/module-splits-table');

const load = (rel) => require(path.join(__dirname, '..', rel));

/** Names the facade exports that a part also exports, with identity checked. */
function mismatches(split) {
    const facade = load(split.facade);
    const parts = split.parts.map(load);
    const out = [];
    for (const name of split.exports) {
        if (!(name in facade)) { out.push(`${name}: missing from ${split.facade}`); continue; }
        if ((split.wrapped || []).includes(name)) continue;
        for (const part of parts) {
            if (name in part && typeof part[name] === 'function' && part[name] !== facade[name]) {
                out.push(`${name}: facade and part export different functions`);
            }
        }
    }
    return out;
}

describe.each(SPLITS)('$facade', (split) => {
    test('every pre-split export is still exported, and a moved function is the same object', () => {
        expect(mismatches(split)).toEqual([]);
    });

    test('every part is under the 300-line limit and is loaded by the facade', () => {
        expect(overLimit(split)).toEqual([]);
    });
});

/** Files of a split over 300 lines; a facadeOverLimit facade must instead be declared. */
function overLimit(split) {
    const gate = require('../lib/file-size-gate');
    const measured = new Map(gate.measure().map((f) => [f.path, f.lines]));
    const declared = require('../lib/validate-exceptions.json').exceptions.map((e) => e.path);
    const out = [];
    for (const rel of [split.facade, ...split.parts]) {
        if (!measured.has(rel)) { out.push(`${rel}: not found`); continue; }
        if (measured.get(rel) <= 300) continue;
        if (rel === split.facade && split.facadeOverLimit && declared.includes(rel)) continue;
        out.push(`${rel}: ${measured.get(rel)} lines`);
    }
    return out;
}

describe('B28 (2026-11-12): moved constants are the same objects, and the bulletin path still moves', () => {
    test('a constant re-exported by a facade is the part\'s own object, not a copy', () => {
        expect(load('lib/task-queue.js').STATUS).toBe(load('lib/task-queue-status.js').STATUS);
        expect(load('lib/integrations/email-sanitizer.js').INJECTION_PATTERNS)
            .toBe(load('lib/integrations/email-injection-patterns.js').INJECTION_PATTERNS);
        expect(load('lib/integrations/email-categorizer.js').DEFAULT_RULES)
            .toBe(load('lib/integrations/email-categorizer-rules.js').DEFAULT_RULES);
        expect(load('lib/clone-lifecycle.js').SHA_PATTERN).toBe(load('lib/clone-delivery.js').SHA_PATTERN);
    });

    test('init() through the bulletin-board facade moves the path the store reads', () => {
        const bb = load('lib/bulletin-board.js');
        const store = load('lib/bulletin-board-store.js');
        try {
            bb.init({ bulletinFile: '/nonexistent/bulletin.json' });
            expect(store.BULLETIN_FILE).toBe('/nonexistent/bulletin.json');
            expect(bb.BULLETIN_FILE).toBe('/nonexistent/bulletin.json');
        } finally {
            bb.init();
        }
        expect(bb.BULLETIN_FILE).toBe(bb.DEFAULT_BULLETIN_FILE);
    });

    test('negative control: facadeOverLimit exempts a declared facade, never a part or an undeclared one', () => {
        expect(overLimit({ facade: 'lib/task-queue.js', facadeOverLimit: true, parts: [] })).toEqual([]);
        expect(overLimit({ facade: 'lib/task-queue.js', parts: [] })).toHaveLength(1);
        expect(overLimit({ facade: 'lib/task-queue-view.js', facadeOverLimit: true, parts: ['lib/task-queue.js'] }))
            .toHaveLength(1);
    });
});

describe('the watercooler state-file override still reaches the code that reads it', () => {
    test('init() through the facade moves the path the context module uses', () => {
        const wc = load('lib/watercooler.js');
        const ctx = load('lib/watercooler-context.js');
        try {
            wc.init({ stateFile: '/nonexistent/wc-state.json' });
            expect(ctx.getStateFile()).toBe('/nonexistent/wc-state.json');
            expect(wc.WATERCOOLER_STATE_FILE).toBe('/nonexistent/wc-state.json');
        } finally {
            wc.init();
        }
        expect(wc.WATERCOOLER_STATE_FILE).toBe(wc.DEFAULT_WATERCOOLER_STATE_FILE);
    });
});

describe('the staff-tasks state-file override still reaches the store', () => {
    test('init() through the facade moves the path the store reads', () => {
        const st = load('lib/staff-tasks.js');
        const store = load('lib/staff-tasks-store.js');
        try {
            expect(st.init({ stateFile: '/nonexistent/st-state.json' })).toBe('/nonexistent/st-state.json');
            expect(store.getStateFile()).toBe('/nonexistent/st-state.json');
            expect(st.TASKS_STATE_FILE).toBe('/nonexistent/st-state.json');
        } finally {
            st.init();
        }
        expect(st.TASKS_STATE_FILE).toBe(st.DEFAULT_TASKS_STATE_FILE);
    });
});

describe('the approval-queue path override still reaches the store', () => {
    test('init() through the facade returns the facade and moves the store path', () => {
        const os = require('os');
        const fs = require('fs');
        const aq = load('lib/approval-queue.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-split-'));
        try {
            const file = path.join(dir, 'q.json');
            expect(aq.init({ queueFile: file })).toBe(aq);
            aq.clearQueue();
            expect(fs.existsSync(file)).toBe(true);
        } finally {
            aq.init({ queueFile: aq.DEFAULT_QUEUE_FILE });
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the bridge-state init() override reaches both halves', () => {
    test('one init() through the facade moves all four paths and returns the facade', () => {
        const os = require('os');
        const fs = require('fs');
        const bs = load('lib/bridge-state.js');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-split-'));
        const files = ['state', 'processed', 'channels', 'activation'].map((n) => path.join(dir, n + '.json'));
        try {
            const [stateFile, processedTasksFile, channelMapFile, activationFile] = files;
            expect(bs.init({ stateFile, processedTasksFile, channelMapFile, activationFile })).toBe(bs);
            bs.setLastChecked('C0SPLIT', '1.0');
            bs.markTaskProcessed('2.0');
            bs.setChannelId('split-test', 'C0SPLIT');
            bs.setActivation('split-agent', true);
            for (const f of files) expect(fs.existsSync(f)).toBe(true);
            expect(bs.getChannelId('split-test')).toBe('C0SPLIT');
            expect(bs.isTaskProcessed('2.0')).toBe(true);
        } finally {
            // The overrides stay pointed at the deleted temp dir. Jest gives each test
            // file its own module registry, so no other suite sees them, and nothing in
            // this file writes bridge state after this test.
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the storefront catalog flag is read live, not copied at load', () => {
    test('the facade exports the prompt module accessor itself', () => {
        const sf = load('bots/storefront.js');
        const prompt = load('bots/storefront-prompt.js');
        expect(sf.catalogInitialized).toBe(prompt.isCatalogInitialized);
        expect(sf.catalogInitialized()).toBe(false);
    });
});

describe('negative control: the check fails on a facade that dropped a name', () => {
    test('a name absent from the facade is reported', () => {
        const fake = { facade: 'lib/integrations/gmail.js', parts: [], exports: ['noSuchExport'] };
        expect(mismatches(fake)).toEqual(['noSuchExport: missing from lib/integrations/gmail.js']);
    });
});
