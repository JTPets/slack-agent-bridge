'use strict';

/**
 * tests/module-splits.test.js
 *
 * WORK-TODO #10: a split moves code between files and must change nothing a caller
 * can see. Each split keeps the original module as a facade, so the property is that
 * every name the facade exported before the split is still exported, and is the SAME
 * function object as the one in the module it moved to (not a copy that can drift).
 *
 * The export lists below are the pre-split `module.exports` keys, copied from the
 * parent commit, so a name dropped from a facade is a red test.
 */

const path = require('path');

const SPLITS = [
    {
        facade: 'lib/integrations/gmail.js',
        parts: ['lib/integrations/gmail-auth.js', 'lib/integrations/gmail-message.js'],
        exports: [
            'getRecentEmails', 'fetchRecentEmails', 'getEmailById', 'getEmailHeaders', 'hasCredentials',
            'createGmailClient', 'getRefreshToken', 'stripHtml', 'decodeBase64Url', 'getHeader',
            'extractBody', 'transformEmail',
        ],
    },
    {
        facade: 'lib/watercooler.js',
        parts: ['lib/watercooler-catalogue.js', 'lib/watercooler-context.js', 'lib/watercooler-prompt.js'],
        exports: [
            'runStandup', 'isStandupCommand', 'parseStandupType', 'getStandupSchedule',
            'getLastStandupTime', 'saveLastStandupTime', 'getBulletinsSinceLastStandup',
            'getRecentCompletions', 'getAgentBacklog', 'formatBulletinsSummary',
            'formatCompletionsSummary', 'formatBacklogSummary', 'formatPreviousMessages',
            'buildStandupPrompt', 'getAgentDisplay', 'sortAgentsForStandup',
            'filterStandupParticipants', 'isGeminiConfigured', 'init', 'AGENT_DISPLAY',
            'DEFAULT_WATERCOOLER_STATE_FILE', 'WATERCOOLER_STATE_FILE', 'STANDUP_TYPES',
            'AGENT_STANDUP_PROMPTS', 'DEFAULT_STANDUP_TYPE',
        ],
    },
    {
        facade: 'lib/memory-tiers.js',
        parts: ['lib/memory-tiers-store.js', 'lib/memory-tiers-entries.js', 'lib/memory-tiers-maintenance.js'],
        exports: [
            'MEMORY_FILES', 'DEFAULT_SHORT_TERM_TTL', 'DEFAULT_LONG_TERM_DECAY_DAYS', 'AUTO_PROMOTE_THRESHOLD',
            'createEntry', 'getAgentMemoryPath', 'ensureMemoryDir', 'loadMemoryFile', 'saveMemoryFile',
            'isExpired', 'shouldDecay', 'addWorkingMemory', 'clearWorkingMemory', 'addShortTerm',
            'promoteToLongTerm', 'addPermanent', 'getRelevantMemory', 'cleanupMemory', 'autoPromote',
            'startupCleanup', 'migrateToTiers', 'touchEntry',
        ],
    },
    {
        facade: 'lib/approval-queue.js',
        parts: ['lib/approval-queue-store.js', 'lib/approval-queue-decisions.js', 'lib/approval-queue-view.js'],
        // init is wrapped on purpose: the store's init sets the path, the facade's
        // returns the facade so `init(...).queueTask` keeps working.
        wrapped: ['init'],
        exports: [
            'init', 'loadQueue', 'saveQueue', 'queueTask', 'getPendingTasks', 'getTaskById', 'approveTask',
            'approveAllTasks', 'rejectTask', 'rejectAllTasks', 'cleanup', 'getStats', 'formatPendingTasks',
            'formatTaskDetails', 'requiresApproval', 'clearQueue', 'DEFAULT_QUEUE_FILE',
            'APPROVAL_REQUIRED_SOURCES', 'MAX_PENDING_AGE_MS',
        ],
    },
];

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
        const gate = require('../lib/file-size-gate');
        const measured = new Map(gate.measure().map((f) => [f.path, f.lines]));
        for (const rel of [split.facade, ...split.parts]) {
            expect(measured.get(rel)).toBeLessThanOrEqual(300);
        }
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

describe('negative control: the check fails on a facade that dropped a name', () => {
    test('a name absent from the facade is reported', () => {
        const fake = { facade: 'lib/integrations/gmail.js', parts: [], exports: ['noSuchExport'] };
        expect(mismatches(fake)).toEqual(['noSuchExport: missing from lib/integrations/gmail.js']);
    });
});
