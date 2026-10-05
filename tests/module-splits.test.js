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
    {
        facade: 'lib/staff-tasks.js',
        parts: ['lib/staff-tasks-store.js', 'lib/staff-tasks-time.js', 'lib/staff-tasks-slack.js', 'lib/staff-tasks-commands.js'],
        exports: [
            'loadStaff', 'getStaffByName', 'getStaffBySlackId', 'getEscalationRecipients',
            'loadDailyTemplate', 'loadTasksState', 'saveTasksState', 'formatTask', 'formatCompletedTask',
            'createTask', 'completeTask', 'getDailyTasks', 'getOverdueTasks', 'getCriticalOverdueTasks',
            'postDailyTasks', 'escalateTask', 'checkAndEscalateOverdue', 'isStoreHours',
            'parseTimeToMinutes', 'getCurrentTimeMinutes', 'normalizeTimeString', 'parseAssignCommand',
            'isStaffTaskCommand', 'parseStaffTaskCommandType', 'formatDigestSummary', 'formatOverdueList',
            'formatTodayList', 'PRIORITY_EMOJI', 'STORE_HOURS', 'STAFF_FILE', 'TEMPLATE_FILE', 'init',
            'DEFAULT_TASKS_STATE_FILE', 'TASKS_STATE_FILE',
        ],
    },
    {
        facade: 'lib/security-followup.js',
        parts: ['lib/security-findings.js', 'lib/security-followup-dedup.js'],
        exports: [
            'parseFindings', 'groupFindingsByFile', 'getHighestSeverity', 'findCodeAgent',
            'buildTaskMessage', 'filterActionableFindings', 'processSecurityBulletin',
            'createSecurityFollowupHandler', 'formatFollowupSummary', 'wasRecentlyCreated',
            'recordTaskCreated', 'cleanupDedupMap', 'clearDedupMap', 'SEVERITY_LEVELS', 'SEVERITY_EMOJI',
        ],
    },
    {
        facade: 'memory/memory-manager.js',
        parts: ['memory/memory-store.js', 'memory/memory-context.js'],
        exports: [
            'loadMemory', 'saveMemory', 'addTask', 'completeTask', 'failTask', 'getTaskHistory',
            'getActiveTasks', 'getContext', 'updateContext', 'buildTaskContext', 'buildAgentContext',
            'addAgentWorkingMemory', 'clearAgentWorkingMemory', 'addAgentShortTerm', 'promoteAgentMemory',
            'setAgentPermanent', 'cleanupAgentMemory', 'autoPromoteAgentMemory', 'startupMemoryCleanup',
            'migrateAgentMemory',
        ],
    },
    {
        facade: 'lib/agent-context.js',
        parts: ['lib/agent-context-sources.js', 'lib/agent-context-ops.js', 'lib/agent-context-voices.js'],
        exports: [
            'buildEnrichedPrompt', 'buildAgentDataContext', 'buildSecretaryContext', 'buildSecurityContext',
            'buildJesterContext', 'buildStoryBotContext', 'buildCodeAgentContext', 'buildGenericContext',
            'formatEventsForPrompt', 'ANTI_HALLUCINATION_RULE',
        ],
    },
    {
        facade: 'bots/storefront.js',
        parts: ['bots/storefront-session.js', 'bots/storefront-records.js', 'bots/storefront-prompt.js'],
        exports: [
            'app', 'getOrCreateSession', 'buildPrompt', 'sanitizeInput', 'cleanExpiredSessions', 'sessions',
            'STOREFRONT_AGENT_CONFIG', 'loadDeliveryQuotes', 'saveDeliveryQuotes', 'logDeliveryQuoteToSlack',
            'DELIVERY_QUOTES_FILE', 'initializeCatalog', 'catalogInitialized',
        ],
    },
    {
        facade: 'lib/bridge-state.js',
        parts: ['lib/bridge-state-poll.js', 'lib/bridge-state-workspace.js'],
        // init is wrapped on purpose: it forwards to both parts and returns the facade.
        wrapped: ['init'],
        exports: [
            'init', 'loadState', 'saveState', 'getLastChecked', 'setLastChecked', 'loadProcessedTasks',
            'saveProcessedTasks', 'isTaskProcessed', 'markTaskProcessed', 'cleanupProcessedTasks',
            'loadChannelMap', 'saveChannelMap', 'getChannelId', 'setChannelId', 'loadActivations',
            'getActivation', 'setActivation', 'clearActivation', 'DEFAULT_CHANNEL_MAP_FILE',
            'DEFAULT_ACTIVATION_FILE',
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
