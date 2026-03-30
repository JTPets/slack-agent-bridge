/**
 * tests/integration.test.js
 *
 * Integration tests that verify critical paths work together.
 * Run with: npm test
 *
 * These tests verify:
 * - Config loads all required env vars (with mocks)
 * - Task parser + LLM runner + Slack client wire together
 * - Agent registry loads and returns valid agents
 * - Memory tiers can read/write/cleanup
 * - No circular dependencies between lib/ modules
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Set minimal required env vars before loading any modules
beforeAll(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    process.env.BRIDGE_CHANNEL_ID = 'C_BRIDGE_TEST';
    process.env.OPS_CHANNEL_ID = 'C_OPS_TEST';
    process.env.WORK_DIR = '/tmp/integration-test-work';
    process.env.CLAUDE_BIN = '/usr/bin/echo';
    process.env.LOCAL_REPO_DIR = '/tmp';
    process.env.ALLOWED_USER_IDS = 'U_TEST_USER';
});

describe('Config integration', () => {
    test('loadConfig returns frozen config object with all required fields', () => {
        const { loadConfig } = require('../lib/config');
        const config = loadConfig();

        expect(Object.isFrozen(config)).toBe(true);
        expect(config.SLACK_BOT_TOKEN).toBe('xoxb-test-token');
        expect(config.BRIDGE_CHANNEL).toBe('C_BRIDGE_TEST');
        expect(config.OPS_CHANNEL).toBe('C_OPS_TEST');
        expect(config.GITHUB_ORG).toBe('jtpets');
        expect(config.POLL_INTERVAL).toBeGreaterThan(0);
        expect(config.MAX_TURNS).toBeGreaterThan(0);
        expect(config.TASK_TIMEOUT).toBeGreaterThan(0);
        expect(Array.isArray(config.ALLOWED_USER_IDS)).toBe(true);
    });

    test('getMissingVars returns empty array when all required vars present', () => {
        const { loadConfig, getMissingVars } = require('../lib/config');
        const config = loadConfig();

        const missing = getMissingVars(config);
        expect(missing).toEqual([]);
    });

    test('getMissingVars detects missing required vars', () => {
        const { getMissingVars } = require('../lib/config');

        const incompleteConfig = {
            SLACK_BOT_TOKEN: null,
            BRIDGE_CHANNEL: 'C123',
            OPS_CHANNEL: null,
        };

        const missing = getMissingVars(incompleteConfig);
        expect(missing).toContain('SLACK_BOT_TOKEN');
        expect(missing).toContain('OPS_CHANNEL_ID');
        expect(missing).not.toContain('BRIDGE_CHANNEL_ID');
    });

    test('isUserAuthorized correctly checks user IDs', () => {
        const { isUserAuthorized } = require('../lib/config');

        // Test with explicit allowed IDs
        expect(isUserAuthorized('U_TEST_USER', ['U_TEST_USER', 'U_OTHER'])).toBe(true);
        expect(isUserAuthorized('U_UNKNOWN', ['U_TEST_USER', 'U_OTHER'])).toBe(false);
    });
});

describe('Task parser + LLM runner integration', () => {
    test('parseTask output can be used to build LLM prompt', () => {
        const { parseTask } = require('../lib/task-parser');

        const taskText = `TASK: Fix the bug
REPO: jtpets/test-repo
BRANCH: feature/fix
TURNS: 25
INSTRUCTIONS: Please fix the null pointer exception in main.js`;

        const task = parseTask(taskText);

        expect(task.description).toBe('Fix the bug');
        expect(task.repo).toBe('jtpets/test-repo');
        expect(task.branch).toBe('feature/fix');
        expect(task.turns).toBe(25);
        expect(task.instructions).toContain('null pointer exception');

        // Verify task object has all expected fields for building LLM prompt
        expect(task).toHaveProperty('description');
        expect(task).toHaveProperty('repo');
        expect(task).toHaveProperty('branch');
        expect(task).toHaveProperty('instructions');
        expect(task).toHaveProperty('turns');
        expect(task).toHaveProperty('skill');
        expect(task).toHaveProperty('raw');
    });

    test('LLM runner config is accessible', () => {
        const llmRunner = require('../lib/llm-runner');

        expect(llmRunner.DEFAULT_PROVIDER).toBe('claude');
        expect(typeof llmRunner.DEFAULT_MAX_TURNS).toBe('number');
        expect(typeof llmRunner.DEFAULT_TIMEOUT).toBe('number');
    });

    test('RateLimitError and BandwidthExhaustedError are constructable', () => {
        const { RateLimitError, BandwidthExhaustedError } = require('../lib/llm-runner');

        const rateLimitErr = new RateLimitError('Test rate limit');
        expect(rateLimitErr.isRateLimit).toBe(true);
        expect(rateLimitErr.name).toBe('RateLimitError');

        const bandwidthErr = new BandwidthExhaustedError('Test bandwidth');
        expect(bandwidthErr.isBandwidthExhausted).toBe(true);
        expect(bandwidthErr.isRateLimit).toBe(true);
        expect(bandwidthErr.name).toBe('BandwidthExhaustedError');
    });
});

describe('Slack client integration', () => {
    test('createSlackClient creates client with expected methods', () => {
        const { createSlackClient } = require('../lib/slack-client');

        const client = createSlackClient('xoxb-test-token');

        expect(client).toHaveProperty('client');
        expect(client).toHaveProperty('normalizeChannelName');
        expect(client).toHaveProperty('validateChannelName');
        expect(client).toHaveProperty('createChannel');
        expect(client).toHaveProperty('inviteBotToChannel');
        expect(client).toHaveProperty('setChannelTopic');
        expect(client).toHaveProperty('findChannelByName');
        expect(client).toHaveProperty('ensureChannel');
    });

    test('normalizeChannelName handles various inputs', () => {
        const { createSlackClient } = require('../lib/slack-client');
        const client = createSlackClient('xoxb-test-token');

        expect(client.normalizeChannelName('#my-channel')).toBe('my-channel');
        expect(client.normalizeChannelName('My Channel Name')).toBe('my-channel-name');
        expect(client.normalizeChannelName('UPPER_CASE')).toBe('upper_case');
        expect(client.normalizeChannelName('with spaces')).toBe('with-spaces');
        expect(client.normalizeChannelName('---leading')).toBe('leading');
    });

    test('validateChannelName returns validation results', () => {
        const { createSlackClient } = require('../lib/slack-client');
        const client = createSlackClient('xoxb-test-token');

        expect(client.validateChannelName('valid-channel').valid).toBe(true);
        expect(client.validateChannelName('').valid).toBe(false);
        expect(client.validateChannelName('a'.repeat(100)).valid).toBe(false);
    });
});

describe('Agent registry integration', () => {
    test('loadAgents returns an array', () => {
        const { loadAgents } = require('../lib/agent-registry');

        const agents = loadAgents();
        expect(Array.isArray(agents)).toBe(true);
    });

    test('getAgent returns null for non-existent agent', () => {
        const { getAgent } = require('../lib/agent-registry');

        const agent = getAgent('non-existent-agent-xyz');
        expect(agent).toBeNull();
    });

    test('registryExists returns boolean', () => {
        const { registryExists } = require('../lib/agent-registry');

        const exists = registryExists();
        expect(typeof exists).toBe('boolean');
    });

    test('isProductionRepo returns boolean', () => {
        const { isProductionRepo } = require('../lib/agent-registry');

        const result = isProductionRepo('jtpets/some-repo');
        expect(typeof result).toBe('boolean');
    });

    test('getActiveAgents returns agents without planned status', () => {
        const { getActiveAgents, loadAgents } = require('../lib/agent-registry');

        const activeAgents = getActiveAgents();
        expect(Array.isArray(activeAgents)).toBe(true);

        // Verify none have status: 'planned'
        for (const agent of activeAgents) {
            expect(agent.status).not.toBe('planned');
        }
    });
});

describe('Memory tiers integration', () => {
    let testDir;

    beforeEach(() => {
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
    });

    afterEach(() => {
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    test('memory tiers can create and read entries', () => {
        const memoryTiers = require('../lib/memory-tiers');

        const agentId = 'test-agent';

        // Add working memory
        const entry = memoryTiers.addWorkingMemory(agentId, testDir, {
            content: 'Test working memory',
            source: 'test',
        });

        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('content');
        expect(entry).toHaveProperty('created');
        expect(entry.content).toBe('Test working memory');

        // Read it back
        const memory = memoryTiers.getRelevantMemory(agentId, testDir);
        expect(memory.working.length).toBeGreaterThan(0);
        expect(memory.working[0].content).toBe('Test working memory');
    });

    test('memory tiers can add short-term entries with TTL', () => {
        const memoryTiers = require('../lib/memory-tiers');

        const agentId = 'test-agent';

        const entry = memoryTiers.addShortTerm(agentId, testDir, {
            content: { data: 'short term data' },
            source: 'test',
        }, 48);

        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('ttl');
        expect(entry.ttl).toBeGreaterThan(0);
    });

    test('memory tiers can add permanent context', () => {
        const memoryTiers = require('../lib/memory-tiers');

        const agentId = 'test-agent';

        const context = memoryTiers.addPermanent(agentId, testDir, 'test_key', 'test_value');

        expect(context.test_key).toBe('test_value');
        expect(context._lastUpdated).toBeDefined();
    });

    test('memory tiers cleanup removes expired entries', () => {
        const memoryTiers = require('../lib/memory-tiers');

        const agentId = 'test-agent';

        // Add a short-term entry
        memoryTiers.addShortTerm(agentId, testDir, {
            content: 'This will not expire immediately',
            source: 'test',
        }, 48);

        // Run cleanup (should not remove anything since TTL hasn't expired)
        const result = memoryTiers.cleanupMemory(agentId, testDir);

        expect(result).toHaveProperty('expiredCount');
        expect(result).toHaveProperty('archivedCount');
        expect(result.expiredCount).toBe(0);
    });

    test('isExpired correctly identifies expired entries', () => {
        const { isExpired, createEntry } = require('../lib/memory-tiers');

        // Entry with no TTL should not expire
        const noTtlEntry = createEntry('test', 'test', 0);
        expect(isExpired(noTtlEntry)).toBe(false);

        // Entry with future TTL should not be expired
        const futureEntry = createEntry('test', 'test', 24);
        expect(isExpired(futureEntry)).toBe(false);

        // Entry with past TTL (manually set created time)
        const pastEntry = createEntry('test', 'test', 1);
        pastEntry.created = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
        expect(isExpired(pastEntry)).toBe(true);
    });
});

describe('No circular dependencies', () => {
    // These tests verify that modules can be loaded in isolation without
    // causing circular dependency issues

    test('all lib modules can be required independently', () => {
        // Clear require cache to ensure fresh loads
        const modulePaths = [
            '../lib/config',
            '../lib/task-parser',
            '../lib/llm-runner',
            '../lib/slack-client',
            '../lib/agent-registry',
            '../lib/memory-tiers',
            '../lib/owner-tasks',
            '../lib/notify-owner',
            '../lib/integrations/google-calendar',
        ];

        // Require all modules - if there are circular dependencies, this will fail
        for (const modulePath of modulePaths) {
            expect(() => {
                const resolved = require.resolve(modulePath);
                delete require.cache[resolved];
                require(modulePath);
            }).not.toThrow();
        }
    });

    test('memory-manager can load memory-tiers without issues', () => {
        // This specifically tests the lazy-load pattern in memory-manager
        expect(() => {
            const memoryManager = require('../memory/memory-manager');
            // Call a function that triggers the lazy load
            memoryManager.buildTaskContext();
        }).not.toThrow();
    });
});

describe('Owner tasks integration', () => {
    test('extractActionRequired finds ACTION REQUIRED in text', () => {
        const { extractActionRequired } = require('../lib/owner-tasks');

        const text = 'Task completed.\nACTION REQUIRED: Add API key to .env\nDone.';
        const action = extractActionRequired(text);

        expect(action).toBe('Add API key to .env');
    });

    test('extractActionRequired returns null when not found', () => {
        const { extractActionRequired } = require('../lib/owner-tasks');

        const text = 'Task completed. Everything is fine.';
        const action = extractActionRequired(text);

        expect(action).toBeNull();
    });

    test('isOwnerTasksQuery detects owner task queries', () => {
        const { isOwnerTasksQuery } = require('../lib/owner-tasks');

        expect(isOwnerTasksQuery('what do I need to do')).toBe(true);
        expect(isOwnerTasksQuery('my tasks')).toBe(true);
        expect(isOwnerTasksQuery('pending tasks')).toBe(true);
        expect(isOwnerTasksQuery('action items')).toBe(true);
        expect(isOwnerTasksQuery('random question')).toBe(false);
    });
});

describe('Notify owner integration', () => {
    test('PRIORITY constants are defined', () => {
        const { PRIORITY } = require('../lib/notify-owner');

        expect(PRIORITY.CRITICAL).toBe('critical');
        expect(PRIORITY.HIGH).toBe('high');
        expect(PRIORITY.LOW).toBe('low');
    });

    test('getSecretaryStatus returns expected shape', () => {
        const { getSecretaryStatus } = require('../lib/notify-owner');

        const status = getSecretaryStatus();

        expect(status).toHaveProperty('active');
        expect(status).toHaveProperty('channelId');
        expect(typeof status.active).toBe('boolean');
    });
});

describe('Google Calendar integration', () => {
    test('getCalendarIds parses env var correctly', () => {
        const { getCalendarIds } = require('../lib/integrations/google-calendar');

        // Test with default
        const ids = getCalendarIds();
        expect(Array.isArray(ids)).toBe(true);
        expect(ids.length).toBeGreaterThan(0);
    });

    test('getTodayRange returns valid date range', () => {
        const { getTodayRange } = require('../lib/integrations/google-calendar');

        const range = getTodayRange();

        expect(range).toHaveProperty('start');
        expect(range).toHaveProperty('end');
        expect(new Date(range.start).getTime()).toBeLessThan(new Date(range.end).getTime());
    });

    test('getYesterdayRange returns valid date range', () => {
        const { getYesterdayRange } = require('../lib/integrations/google-calendar');

        const range = getYesterdayRange();

        expect(range).toHaveProperty('start');
        expect(range).toHaveProperty('end');
        expect(new Date(range.start).getTime()).toBeLessThan(new Date(range.end).getTime());
    });

    test('transformEvent transforms calendar event', () => {
        const { transformEvent } = require('../lib/integrations/google-calendar');

        const event = {
            summary: 'Test Meeting',
            start: { dateTime: '2026-03-27T10:00:00-04:00' },
            end: { dateTime: '2026-03-27T11:00:00-04:00' },
            status: 'confirmed',
            recurringEventId: null,
        };

        const transformed = transformEvent(event);

        expect(transformed.title).toBe('Test Meeting');
        expect(transformed.start).toBe('2026-03-27T10:00:00-04:00');
        expect(transformed.status).toBe('confirmed');
        expect(transformed.recurring).toBe(false);
    });
});

// LOGIC CHANGE 2026-03-30: Regression test for silent processConversation catch.
// The gemini-2.5-flash outage went undetected for 2 days because processConversation
// caught all errors and only logged them — no Slack post. Verify the source now
// posts to OPS_CHANNEL on failure.
describe('processConversation error reporting regression', () => {
    test('bridge-agent.js processConversation catch block posts to ops channel on failure', () => {
        const bridgeSrc = fs.readFileSync(
            path.join(__dirname, '../bridge-agent.js'),
            'utf8'
        );
        // The catch block must include a postMessage call to OPS_CHANNEL
        expect(bridgeSrc).toMatch(/ASK handler failed.*OPS_CHANNEL|postMessage[\s\S]{0,200}OPS_CHANNEL[\s\S]{0,200}ASK handler failed/);
        // The old "do not post to ops channel" comment must be gone
        expect(bridgeSrc).not.toContain('Log errors but do not post to ops channel');
    });
});

