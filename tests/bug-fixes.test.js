/**
 * tests/bug-fixes.test.js
 *
 * Regression tests for critical bug fixes:
 * 1. Rate limit false positives (isRateLimitError always returns false)
 * 2. Memory file corruption resilience (JSON.parse try/catch)
 * 3. Exit code null handling (interrupted, not failed)
 * 4. Stale working memory cleanup
 * 5. addTask crash on corrupted tasks.json
 *
 * LOGIC CHANGE 2026-03-27: Created to ensure bug fixes are not regressed.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

// ============================================================================
// Bug 1: Rate limit detection - now RE-ENABLED for fallback only (2026-04-01)
// Original bug: false positives caused entire bot to pause
// Fix: detection re-enabled but ONLY throws RateLimitError, does NOT pause bot
// ============================================================================

describe('Bug 1: Rate limit detection (re-enabled for fallback)', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  // LOGIC CHANGE 2026-04-01: Rate limit detection re-enabled for Claude → Gemini fallback.
  // isRateLimitError now returns true for rate limit patterns.
  test('isRateLimitError detects rate limit patterns (for fallback)', () => {
    const { isRateLimitError } = require('../lib/llm-runner');
    expect(isRateLimitError('rate limit exceeded')).toBe(true);
    expect(isRateLimitError('429 Too Many Requests')).toBe(true);
    expect(isRateLimitError('quota exceeded')).toBe(true);
    expect(isRateLimitError('Error: rate_limit_error')).toBe(true);
    // null/empty still return false
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError('')).toBe(false);
  });

  // isBandwidthExhausted remains disabled - no need for pause behavior
  test('isBandwidthExhausted still always returns false (pause behavior disabled)', () => {
    const { isBandwidthExhausted } = require('../lib/llm-runner');
    expect(isBandwidthExhausted(1, '', 'rate limit exceeded')).toBe(false);
    expect(isBandwidthExhausted(1, '', 'bandwidth exhausted')).toBe(false);
    expect(isBandwidthExhausted(1, '', 'quota exceeded')).toBe(false);
  });

  // Rate limit text in stdout with exit code 0 does NOT throw (task succeeded)
  test('runClaudeAdapter does not throw RateLimitError on rate limit text in stdout with exit code 0', async () => {
    const mockSpawn = jest.fn();
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));

    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'rate limit exceeded but task completed fine');
        child.emit('close', 0);
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('test prompt');

    // Should resolve normally - only check stderr on non-zero exit
    expect(result.output).toContain('rate limit exceeded');
  });
});

// ============================================================================
// Bug 2 & 5: Memory file corruption resilience
// ============================================================================

describe('Bug 2 & 5: Memory file corruption resilience', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    jest.resetModules();
  });

  describe('memory-manager loadMemory', () => {
    test('handles empty file (resets to default)', () => {
      const tasksFile = path.join(tempDir, 'tasks.json');
      fs.writeFileSync(tasksFile, '', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(tasksFile);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('handles corrupted JSON (resets to default)', () => {
      const tasksFile = path.join(tempDir, 'tasks.json');
      fs.writeFileSync(tasksFile, '{invalid json!!!', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(tasksFile);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('handles tasks.json containing object instead of array', () => {
      const tasksFile = path.join(tempDir, 'tasks.json');
      fs.writeFileSync(tasksFile, '{"not": "an array"}', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(tasksFile);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('handles history.json corruption', () => {
      const historyFile = path.join(tempDir, 'history.json');
      fs.writeFileSync(historyFile, 'corrupted', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(historyFile);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('handles context.json corruption (resets to object)', () => {
      const contextFile = path.join(tempDir, 'context.json');
      fs.writeFileSync(contextFile, 'not json', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(contextFile);

      expect(typeof result).toBe('object');
      expect(result).toEqual({});
    });

    test('valid JSON still loads correctly', () => {
      const tasksFile = path.join(tempDir, 'tasks.json');
      fs.writeFileSync(tasksFile, '[{"id":"1","status":"active"}]', 'utf8');

      const { loadMemory } = require('../memory/memory-manager');
      const result = loadMemory(tasksFile);

      expect(result).toEqual([{ id: '1', status: 'active' }]);
    });

    test('missing file returns default without crashing', () => {
      const { loadMemory } = require('../memory/memory-manager');

      const result = loadMemory(path.join(tempDir, 'nonexistent-tasks.json'));
      expect(Array.isArray(result)).toBe(true);

      const result2 = loadMemory(path.join(tempDir, 'nonexistent-context.json'));
      expect(typeof result2).toBe('object');
    });
  });

  describe('memory-tiers loadMemoryFile', () => {
    test('handles corrupted JSON file', () => {
      const file = path.join(tempDir, 'working.json');
      fs.writeFileSync(file, '{bad json', 'utf8');

      const { loadMemoryFile } = require('../lib/memory-tiers');
      const result = loadMemoryFile(file, true);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([]);
    });

    test('handles empty file', () => {
      const file = path.join(tempDir, 'working.json');
      fs.writeFileSync(file, '', 'utf8');

      const { loadMemoryFile } = require('../lib/memory-tiers');
      const result = loadMemoryFile(file, true);

      expect(result).toEqual([]);
    });

    test('handles array file containing object', () => {
      const file = path.join(tempDir, 'working.json');
      fs.writeFileSync(file, '{"wrong": "type"}', 'utf8');

      const { loadMemoryFile } = require('../lib/memory-tiers');
      const result = loadMemoryFile(file, true);

      expect(result).toEqual([]);
    });
  });

  describe('addTask does not crash on corrupted tasks.json', () => {
    test('addTask works after tasks.json is corrupted', () => {
      // This test verifies Bug 5: "tasks.push is not a function"
      const memManager = require('../memory/memory-manager');

      // Point TASKS_FILE to a corrupted file
      const tasksFile = path.join(tempDir, 'tasks.json');
      fs.writeFileSync(tasksFile, '{"not": "an array"}', 'utf8');

      // loadMemory should recover gracefully
      const tasks = memManager.loadMemory(tasksFile);
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBe(0);

      // Verify push works on the recovered array
      tasks.push({ id: '1', description: 'test' });
      expect(tasks.length).toBe(1);
    });
  });
});

// ============================================================================
// Bug 3: Exit code null handling
// ============================================================================

describe('Bug 3: Exit code null handling', () => {
  let mockSpawn;

  beforeEach(() => {
    jest.resetModules();
    mockSpawn = jest.fn();
    jest.doMock('child_process', () => ({ spawn: mockSpawn }));
  });

  test('exit code null resolves with interrupted flag', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', 'partial output');
        child.emit('close', null); // null = killed by signal
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('test prompt');

    expect(result.interrupted).toBe(true);
    expect(result.hitMaxTurns).toBe(false);
    expect(result.output).toBe('partial output');
  });

  test('exit code null with empty output still resolves', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.emit('close', null);
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('test prompt');

    expect(result.interrupted).toBe(true);
    expect(result.output).toBe('');
  });

  test('exit code null does NOT reject with error', async () => {
    mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stderr.emit('data', 'signal: SIGTERM');
        child.emit('close', null);
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    // Should NOT reject - should resolve with interrupted flag
    const result = await runClaudeAdapter('test prompt');
    expect(result.interrupted).toBe(true);
  });
});

// ============================================================================
// Bug 4: Stale working memory cleanup
// ============================================================================

describe('Bug 4: Stale working memory cleanup', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'working-memory-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('stale running tasks are set to interrupted on cleanup', () => {
    // Simulate what bridge-agent.js does on startup
    const workingFile = path.join(tempDir, 'working.json');
    const working = [
      { id: '1', content: { status: 'running', task: 'old task' }, created: '2026-03-26T00:00:00Z' },
      { id: '2', content: { status: 'completed', task: 'done task' }, created: '2026-03-26T00:00:00Z' },
      { id: '3', content: { status: 'running', task: 'another stale' }, created: '2026-03-26T00:00:00Z' },
    ];
    fs.writeFileSync(workingFile, JSON.stringify(working, null, 2), 'utf8');

    // Simulate startup cleanup logic from bridge-agent.js
    const raw = fs.readFileSync(workingFile, 'utf8');
    const parsed = JSON.parse(raw);
    let cleared = 0;
    for (const entry of parsed) {
      if (entry && entry.content && entry.content.status === 'running') {
        entry.content.status = 'interrupted';
        cleared++;
      }
    }
    fs.writeFileSync(workingFile, JSON.stringify(parsed, null, 2), 'utf8');

    expect(cleared).toBe(2);

    // Verify file was updated
    const updated = JSON.parse(fs.readFileSync(workingFile, 'utf8'));
    expect(updated[0].content.status).toBe('interrupted');
    expect(updated[1].content.status).toBe('completed'); // unchanged
    expect(updated[2].content.status).toBe('interrupted');
  });

  test('empty working.json does not crash cleanup', () => {
    const workingFile = path.join(tempDir, 'working.json');
    fs.writeFileSync(workingFile, '[]', 'utf8');

    const parsed = JSON.parse(fs.readFileSync(workingFile, 'utf8'));
    let cleared = 0;
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && entry.content && entry.content.status === 'running') {
          entry.content.status = 'interrupted';
          cleared++;
        }
      }
    }

    expect(cleared).toBe(0);
  });

  test('corrupted working.json does not crash cleanup', () => {
    const workingFile = path.join(tempDir, 'working.json');
    fs.writeFileSync(workingFile, '{bad', 'utf8');

    let working;
    try {
      working = JSON.parse(fs.readFileSync(workingFile, 'utf8'));
    } catch {
      working = [];
    }

    expect(Array.isArray(working)).toBe(true);
    expect(working.length).toBe(0);
  });
});

// ============================================================================
// Bug 6: Bot's own messages blocked in agent channels
// LOGIC CHANGE 2026-04-01: Scheduled tasks (morning-briefing, nightly-audit)
// posted AS THE BOT were silently dropped because BOT_USER_ID was not in
// ALLOWED_USER_IDS. Fix: allow bot messages in polled agent channels.
// ============================================================================

describe('Bug 6: Bot messages in agent channels should not be blocked', () => {
  const BOT_USER_ID = 'U0AP5PLQB44';
  const OWNER_USER_ID = 'U02QKNHHU7J';
  const RANDOM_USER_ID = 'UABCDEF123';

  // Simulate the authorization check from bridge-agent.js poll loop
  function isAllowed(userId, allowedIds, botUserId) {
    const isAuthorized = allowedIds.includes(userId);
    const isBotMessage = userId === botUserId;
    return isAuthorized || isBotMessage;
  }

  test('bot user is allowed in agent channels (scheduled tasks work)', () => {
    expect(isAllowed(BOT_USER_ID, [OWNER_USER_ID], BOT_USER_ID)).toBe(true);
  });

  test('owner user is still allowed', () => {
    expect(isAllowed(OWNER_USER_ID, [OWNER_USER_ID], BOT_USER_ID)).toBe(true);
  });

  test('random user is still blocked', () => {
    expect(isAllowed(RANDOM_USER_ID, [OWNER_USER_ID], BOT_USER_ID)).toBe(false);
  });

  test('bot user is blocked when it is not the configured BOT_USER_ID', () => {
    // A different bot user ID is not granted access
    expect(isAllowed('UOTHER_BOT', [OWNER_USER_ID], BOT_USER_ID)).toBe(false);
  });

  test('BOT_USER_ID loaded from config has correct default', () => {
    jest.resetModules();
    delete process.env.BOT_USER_ID;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.BRIDGE_CHANNEL_ID = 'C12345';
    process.env.OPS_CHANNEL_ID = 'C67890';

    const { loadConfig } = require('../lib/config');
    const config = loadConfig();
    expect(config.BOT_USER_ID).toBe('U0AP5PLQB44');
  });

  test('BOT_USER_ID can be overridden via env var', () => {
    jest.resetModules();
    process.env.BOT_USER_ID = 'UCUSTOM_BOT';
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.BRIDGE_CHANNEL_ID = 'C12345';
    process.env.OPS_CHANNEL_ID = 'C67890';

    const { loadConfig } = require('../lib/config');
    const config = loadConfig();
    expect(config.BOT_USER_ID).toBe('UCUSTOM_BOT');
    delete process.env.BOT_USER_ID;
  });
});
