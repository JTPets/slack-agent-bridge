/**
 * tests/smoke.test.js
 *
 * Smoke tests that verify the bot can load without crashing.
 * Run with: npm run test:smoke
 *
 * These tests catch:
 * - Missing requires/imports
 * - Broken module references
 * - Startup crashes
 * - Missing dotenv setup
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Set minimal required env vars before loading any modules
beforeAll(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.BRIDGE_CHANNEL_ID = 'C_BRIDGE_TEST';
    process.env.OPS_CHANNEL_ID = 'C_OPS_TEST';
    process.env.WORK_DIR = '/tmp/smoke-test-work';
    process.env.CLAUDE_BIN = '/usr/bin/echo'; // Use echo as a harmless stub
    process.env.LOCAL_REPO_DIR = '/tmp'; // For auto-update.js validation
});

describe('Executable file loading', () => {
    // Note: We cannot actually require bridge-agent.js, auto-update.js, etc.
    // because they start polling loops and call process.exit on validation failure.
    // Instead, we verify they exist and have correct dotenv setup.

    test('bridge-agent.js exists', () => {
        const filePath = path.join(__dirname, '..', 'bridge-agent.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('auto-update.js exists', () => {
        const filePath = path.join(__dirname, '..', 'auto-update.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('morning-digest.js exists', () => {
        const filePath = path.join(__dirname, '..', 'morning-digest.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('security-review.js exists', () => {
        const filePath = path.join(__dirname, '..', 'security-review.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('bots/storefront.js exists', () => {
        const filePath = path.join(__dirname, '..', 'bots', 'storefront.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });
});

describe('dotenv is first require in executable files', () => {
    // Check that dotenv.config() is called before any other requires (except strict mode)
    // This ensures PM2 restarts properly load env vars

    function checkDotenvFirst(filename) {
        const filePath = path.join(__dirname, '..', filename);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');

        // Find the line number of the first require('dotenv').config()
        const dotenvLineIndex = lines.findIndex(line =>
            line.includes("require('dotenv').config()") ||
            line.includes('require("dotenv").config()')
        );
        expect(dotenvLineIndex).toBeGreaterThanOrEqual(0);

        // Find the first non-comment, non-shebang, non-strict require that isn't dotenv
        // It should come AFTER the dotenv line
        let foundOtherRequire = false;
        for (let i = 0; i < dotenvLineIndex; i++) {
            const line = lines[i].trim();
            // Skip comments, shebang, 'use strict', and empty lines
            if (
                line.startsWith('//') ||
                line.startsWith('#!') ||
                line.startsWith('/*') ||
                line.startsWith('*') ||
                line === "'use strict';" ||
                line === '"use strict";' ||
                line === ''
            ) {
                continue;
            }
            // If we find a require before dotenv, that's a problem
            if (line.includes('require(')) {
                foundOtherRequire = true;
                break;
            }
        }
        expect(foundOtherRequire).toBe(false);
    }

    test('bridge-agent.js has dotenv first', () => {
        checkDotenvFirst('bridge-agent.js');
    });

    test('auto-update.js has dotenv first', () => {
        checkDotenvFirst('auto-update.js');
    });

    test('morning-digest.js has dotenv first', () => {
        checkDotenvFirst('morning-digest.js');
    });

    test('security-review.js has dotenv first', () => {
        checkDotenvFirst('security-review.js');
    });

    test('bots/storefront.js has dotenv first', () => {
        checkDotenvFirst('bots/storefront.js');
    });
});

describe('lib/ modules load without errors', () => {
    test('lib/config.js loads and exports expected functions', () => {
        const config = require('../lib/config');

        expect(config).toHaveProperty('config');
        expect(config).toHaveProperty('loadConfig');
        expect(config).toHaveProperty('validate');
        expect(config).toHaveProperty('getMissingVars');
        expect(config).toHaveProperty('isUserAuthorized');

        expect(typeof config.loadConfig).toBe('function');
        expect(typeof config.validate).toBe('function');
        expect(typeof config.getMissingVars).toBe('function');
        expect(typeof config.isUserAuthorized).toBe('function');
    });

    test('lib/task-parser.js loads and exports expected functions', () => {
        const taskParser = require('../lib/task-parser');

        expect(taskParser).toHaveProperty('parseTask');
        expect(taskParser).toHaveProperty('isTaskMessage');
        expect(taskParser).toHaveProperty('isConversationMessage');
        expect(taskParser).toHaveProperty('isStatusQuery');
        expect(taskParser).toHaveProperty('isCreateChannelCommand');
        expect(taskParser).toHaveProperty('parseCreateChannelCommand');
        expect(taskParser).toHaveProperty('alreadyProcessed');
        expect(taskParser).toHaveProperty('EMOJI_DONE');
        expect(taskParser).toHaveProperty('EMOJI_FAILED');
        expect(taskParser).toHaveProperty('DEFAULT_TURNS');
        expect(taskParser).toHaveProperty('MIN_TURNS');
        expect(taskParser).toHaveProperty('MAX_TURNS');

        expect(typeof taskParser.parseTask).toBe('function');
        expect(typeof taskParser.isTaskMessage).toBe('function');
    });

    test('lib/llm-runner.js loads and exports expected functions', () => {
        const llmRunner = require('../lib/llm-runner');

        expect(llmRunner).toHaveProperty('runLLM');
        expect(llmRunner).toHaveProperty('runClaudeAdapter');
        expect(llmRunner).toHaveProperty('runOpenAIAdapter');
        expect(llmRunner).toHaveProperty('runOllamaAdapter');
        expect(llmRunner).toHaveProperty('isRateLimitError');
        expect(llmRunner).toHaveProperty('RateLimitError');
        expect(llmRunner).toHaveProperty('BandwidthExhaustedError');
        expect(llmRunner).toHaveProperty('isBandwidthExhausted');
        expect(llmRunner).toHaveProperty('DEFAULT_PROVIDER');
        expect(llmRunner).toHaveProperty('DEFAULT_MAX_TURNS');
        expect(llmRunner).toHaveProperty('DEFAULT_TIMEOUT');

        expect(typeof llmRunner.runLLM).toBe('function');
        expect(typeof llmRunner.isRateLimitError).toBe('function');
    });

    test('lib/slack-client.js loads and exports expected functions', () => {
        const slackClient = require('../lib/slack-client');

        expect(slackClient).toHaveProperty('createSlackClient');
        expect(slackClient).toHaveProperty('CHANNEL_NAME_MAX_LENGTH');
        expect(slackClient).toHaveProperty('CHANNEL_NAME_PATTERN');

        expect(typeof slackClient.createSlackClient).toBe('function');
        expect(typeof slackClient.CHANNEL_NAME_MAX_LENGTH).toBe('number');
    });

    test('lib/agent-registry.js loads and exports expected functions', () => {
        const agentRegistry = require('../lib/agent-registry');

        expect(agentRegistry).toHaveProperty('loadAgents');
        expect(agentRegistry).toHaveProperty('getAgent');
        expect(agentRegistry).toHaveProperty('getAgentByChannel');
        expect(agentRegistry).toHaveProperty('getActiveAgents');
        expect(agentRegistry).toHaveProperty('registryExists');
        expect(agentRegistry).toHaveProperty('getAgentMemoryDir');
        expect(agentRegistry).toHaveProperty('getProductionAgentForRepo');
        expect(agentRegistry).toHaveProperty('isProductionRepo');
        expect(agentRegistry).toHaveProperty('saveAgents');
        expect(agentRegistry).toHaveProperty('updateAgent');
        expect(agentRegistry).toHaveProperty('activateAgent');
        expect(agentRegistry).toHaveProperty('getAgentsNeedingActivation');

        expect(typeof agentRegistry.loadAgents).toBe('function');
        expect(typeof agentRegistry.getAgent).toBe('function');
    });

    test('lib/memory-tiers.js loads and exports expected functions', () => {
        const memoryTiers = require('../lib/memory-tiers');

        expect(memoryTiers).toHaveProperty('MEMORY_FILES');
        expect(memoryTiers).toHaveProperty('DEFAULT_SHORT_TERM_TTL');
        expect(memoryTiers).toHaveProperty('DEFAULT_LONG_TERM_DECAY_DAYS');
        expect(memoryTiers).toHaveProperty('AUTO_PROMOTE_THRESHOLD');
        expect(memoryTiers).toHaveProperty('createEntry');
        expect(memoryTiers).toHaveProperty('getAgentMemoryPath');
        expect(memoryTiers).toHaveProperty('ensureMemoryDir');
        expect(memoryTiers).toHaveProperty('loadMemoryFile');
        expect(memoryTiers).toHaveProperty('saveMemoryFile');
        expect(memoryTiers).toHaveProperty('isExpired');
        expect(memoryTiers).toHaveProperty('shouldDecay');
        expect(memoryTiers).toHaveProperty('addWorkingMemory');
        expect(memoryTiers).toHaveProperty('clearWorkingMemory');
        expect(memoryTiers).toHaveProperty('addShortTerm');
        expect(memoryTiers).toHaveProperty('promoteToLongTerm');
        expect(memoryTiers).toHaveProperty('addPermanent');
        expect(memoryTiers).toHaveProperty('getRelevantMemory');
        expect(memoryTiers).toHaveProperty('cleanupMemory');
        expect(memoryTiers).toHaveProperty('autoPromote');
        expect(memoryTiers).toHaveProperty('startupCleanup');
        expect(memoryTiers).toHaveProperty('migrateToTiers');
        expect(memoryTiers).toHaveProperty('touchEntry');

        expect(typeof memoryTiers.addWorkingMemory).toBe('function');
        expect(typeof memoryTiers.cleanupMemory).toBe('function');
    });

    test('lib/owner-tasks.js loads and exports expected functions', () => {
        const ownerTasks = require('../lib/owner-tasks');

        expect(ownerTasks).toHaveProperty('loadChecklists');
        expect(ownerTasks).toHaveProperty('saveChecklists');
        expect(ownerTasks).toHaveProperty('getPendingTasks');
        expect(ownerTasks).toHaveProperty('completeTask');
        expect(ownerTasks).toHaveProperty('getAgentReadiness');
        expect(ownerTasks).toHaveProperty('getAllAgentReadiness');
        expect(ownerTasks).toHaveProperty('addTask');
        expect(ownerTasks).toHaveProperty('extractActionRequired');
        expect(ownerTasks).toHaveProperty('formatPendingTasks');
        expect(ownerTasks).toHaveProperty('isOwnerTasksQuery');
        expect(ownerTasks).toHaveProperty('CHECKLISTS_PATH');

        expect(typeof ownerTasks.getPendingTasks).toBe('function');
        expect(typeof ownerTasks.extractActionRequired).toBe('function');
    });

    test('lib/notify-owner.js loads and exports expected functions', () => {
        const notifyOwner = require('../lib/notify-owner');

        expect(notifyOwner).toHaveProperty('init');
        expect(notifyOwner).toHaveProperty('PRIORITY');
        expect(notifyOwner).toHaveProperty('notifyOwner');
        expect(notifyOwner).toHaveProperty('notifyChannel');
        expect(notifyOwner).toHaveProperty('taskFailed');
        expect(notifyOwner).toHaveProperty('taskCompleted');
        expect(notifyOwner).toHaveProperty('actionRequired');
        expect(notifyOwner).toHaveProperty('processActionRequired');
        expect(notifyOwner).toHaveProperty('rateLimitHit');
        expect(notifyOwner).toHaveProperty('rateLimitCleared');
        expect(notifyOwner).toHaveProperty('getSecretaryStatus');

        expect(typeof notifyOwner.init).toBe('function');
        expect(typeof notifyOwner.taskFailed).toBe('function');
    });

    test('lib/validate.js exists (runs as script, not module)', () => {
        // validate.js is a script, not a module to require
        // Just verify it exists
        const filePath = path.join(__dirname, '..', 'lib', 'validate.js');
        expect(fs.existsSync(filePath)).toBe(true);
    });

    test('lib/integrations/google-calendar.js loads and exports expected functions', () => {
        const googleCalendar = require('../lib/integrations/google-calendar');

        expect(googleCalendar).toHaveProperty('getTodayEvents');
        expect(googleCalendar).toHaveProperty('getYesterdayEvents');
        expect(googleCalendar).toHaveProperty('listCalendars');
        expect(googleCalendar).toHaveProperty('getAllTodayEvents');
        expect(googleCalendar).toHaveProperty('getAllYesterdayEvents');
        expect(googleCalendar).toHaveProperty('getCalendarIds');
        expect(googleCalendar).toHaveProperty('transformEvent');
        expect(googleCalendar).toHaveProperty('getTodayRange');
        expect(googleCalendar).toHaveProperty('getYesterdayRange');

        expect(typeof googleCalendar.getTodayEvents).toBe('function');
        expect(typeof googleCalendar.getCalendarIds).toBe('function');
    });

    test('lib/integrations/holidays.js loads and exports expected functions', () => {
        const holidays = require('../lib/integrations/holidays');

        expect(holidays).toHaveProperty('getTodayHoliday');
        expect(holidays).toHaveProperty('getTodayPetAwareness');
        expect(holidays).toHaveProperty('getActivePetAwareness');
        expect(holidays).toHaveProperty('getUpcomingHolidays');
        expect(holidays).toHaveProperty('getUpcomingPetAwareness');
        expect(holidays).toHaveProperty('isHoliday');
        expect(holidays).toHaveProperty('getTodaySpecialDates');
        expect(holidays).toHaveProperty('PET_AWARENESS_DATES');
        expect(holidays).toHaveProperty('filterOntarioHolidays');
        expect(holidays).toHaveProperty('parseDate');
        expect(holidays).toHaveProperty('formatDate');
        expect(holidays).toHaveProperty('clearCache');
        expect(holidays).toHaveProperty('CACHE_TTL_MS');

        expect(typeof holidays.getTodayHoliday).toBe('function');
        expect(typeof holidays.isHoliday).toBe('function');
        expect(Array.isArray(holidays.PET_AWARENESS_DATES)).toBe(true);
    });
});

describe('memory/memory-manager.js loads without errors', () => {
    test('memory/memory-manager.js loads and exports expected functions', () => {
        const memoryManager = require('../memory/memory-manager');

        // Legacy functions
        expect(memoryManager).toHaveProperty('loadMemory');
        expect(memoryManager).toHaveProperty('saveMemory');
        expect(memoryManager).toHaveProperty('addTask');
        expect(memoryManager).toHaveProperty('completeTask');
        expect(memoryManager).toHaveProperty('failTask');
        expect(memoryManager).toHaveProperty('getActiveTasks');
        expect(memoryManager).toHaveProperty('getContext');
        expect(memoryManager).toHaveProperty('updateContext');
        expect(memoryManager).toHaveProperty('buildTaskContext');

        // Per-agent tiered memory functions
        expect(memoryManager).toHaveProperty('buildAgentContext');
        expect(memoryManager).toHaveProperty('addAgentWorkingMemory');
        expect(memoryManager).toHaveProperty('clearAgentWorkingMemory');
        expect(memoryManager).toHaveProperty('addAgentShortTerm');
        expect(memoryManager).toHaveProperty('promoteAgentMemory');
        expect(memoryManager).toHaveProperty('setAgentPermanent');
        expect(memoryManager).toHaveProperty('cleanupAgentMemory');
        expect(memoryManager).toHaveProperty('autoPromoteAgentMemory');
        expect(memoryManager).toHaveProperty('startupMemoryCleanup');
        expect(memoryManager).toHaveProperty('migrateAgentMemory');

        expect(typeof memoryManager.addTask).toBe('function');
        expect(typeof memoryManager.buildTaskContext).toBe('function');
    });
});

describe('bots/storefront.js module exports', () => {
    test('bots/storefront.js exports expected items', () => {
        const storefront = require('../bots/storefront');

        expect(storefront).toHaveProperty('app');
        expect(storefront).toHaveProperty('getOrCreateSession');
        expect(storefront).toHaveProperty('buildPrompt');
        expect(storefront).toHaveProperty('sanitizeInput');
        expect(storefront).toHaveProperty('cleanExpiredSessions');
        expect(storefront).toHaveProperty('sessions');
        expect(storefront).toHaveProperty('STOREFRONT_AGENT_CONFIG');

        expect(typeof storefront.getOrCreateSession).toBe('function');
        expect(typeof storefront.buildPrompt).toBe('function');
        expect(typeof storefront.sanitizeInput).toBe('function');
    });
});
