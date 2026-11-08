/**
 * tests/owner-tasks.test.js
 *
 * Unit tests for the view half of lib/owner-tasks.js (extractActionRequired,
 * isOwnerTasksQuery, formatPendingTasks).
 * Split 2026-11-08 (WORK-TODO #10 Wave T): the store's tests are tests/owner-tasks-store.test.js,
 * the view's are tests/owner-tasks.test.js. Both require the facade lib/owner-tasks.js.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Create a mock checklists file
const mockChecklists = {
  bridge: {
    name: 'Bridge Agent',
    status: 'active',
    tasks: [
      { description: 'Task 1 completed', completed: true },
      { description: 'Task 2 high priority', completed: false, priority: 'high' },
      { description: 'Task 3 medium priority', completed: false, priority: 'medium' },
    ],
  },
  secretary: {
    name: 'Secretary',
    status: 'planned',
    tasks: [
      { description: 'Secretary task 1', completed: false, priority: 'high' },
      { description: 'Secretary task 2', completed: false, priority: 'low' },
    ],
  },
  _meta: {
    version: 1,
    lastUpdated: null,
  },
};

// We need to mock before requiring the module to intercept file operations
let tempDir;
let testChecklistsPath;
let ownerTasks;
let originalReadFileSync;
let originalWriteFileSync;
let originalExistsSync;
let mockFileContents;

describe('owner-tasks', () => {
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-tasks-test-'));
    testChecklistsPath = path.join(tempDir, 'activation-checklists.json');

    // Save original fs methods
    originalReadFileSync = fs.readFileSync;
    originalWriteFileSync = fs.writeFileSync;
    originalExistsSync = fs.existsSync;
  });

  beforeEach(() => {
    // Reset mock file contents
    mockFileContents = JSON.parse(JSON.stringify(mockChecklists));

    // Clear module cache to get fresh module
    delete require.cache[require.resolve('../lib/owner-tasks')];

    // Mock fs methods for the checklists path
    const realChecklistsPath = path.join(__dirname, '..', 'agents', 'activation-checklists.json');

    fs.readFileSync = jest.fn((filePath, encoding) => {
      if (filePath === realChecklistsPath) {
        return JSON.stringify(mockFileContents);
      }
      return originalReadFileSync.call(fs, filePath, encoding);
    });

    fs.writeFileSync = jest.fn((filePath, data, encoding) => {
      if (filePath === realChecklistsPath) {
        mockFileContents = JSON.parse(data);
        return;
      }
      return originalWriteFileSync.call(fs, filePath, data, encoding);
    });

    // Require module after mocking
    ownerTasks = require('../lib/owner-tasks');
  });

  afterEach(() => {
    // Restore fs methods
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.existsSync = originalExistsSync;
  });

  afterAll(() => {
    // Cleanup temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('extractActionRequired', () => {
    test('extracts action item from output', () => {
      const output = 'Task completed successfully.\nACTION REQUIRED: Add API_KEY to .env\nDone.';
      const action = ownerTasks.extractActionRequired(output);
      expect(action).toBe('Add API_KEY to .env');
    });

    test('handles case-insensitive match', () => {
      const output = 'action required: Update config file';
      const action = ownerTasks.extractActionRequired(output);
      expect(action).toBe('Update config file');
    });

    test('returns null if no action required', () => {
      const output = 'Task completed successfully with no issues.';
      const action = ownerTasks.extractActionRequired(output);
      expect(action).toBeNull();
    });

    test('returns null for empty input', () => {
      expect(ownerTasks.extractActionRequired('')).toBeNull();
      expect(ownerTasks.extractActionRequired(null)).toBeNull();
      expect(ownerTasks.extractActionRequired(undefined)).toBeNull();
    });

    test('extracts only the first line after ACTION REQUIRED:', () => {
      const output = 'ACTION REQUIRED: First action\nSecond line not included';
      const action = ownerTasks.extractActionRequired(output);
      expect(action).toBe('First action');
    });
  });

  describe('isOwnerTasksQuery', () => {
    test('detects "what do I need to do"', () => {
      expect(ownerTasks.isOwnerTasksQuery('what do I need to do')).toBe(true);
      expect(ownerTasks.isOwnerTasksQuery('What do I need to do?')).toBe(true);
    });

    test('detects "my tasks"', () => {
      expect(ownerTasks.isOwnerTasksQuery('my tasks')).toBe(true);
      expect(ownerTasks.isOwnerTasksQuery('my task')).toBe(true);
    });

    test('detects "pending tasks"', () => {
      expect(ownerTasks.isOwnerTasksQuery('pending tasks')).toBe(true);
      expect(ownerTasks.isOwnerTasksQuery('show pending tasks')).toBe(true);
    });

    test('detects "action items"', () => {
      expect(ownerTasks.isOwnerTasksQuery('action items')).toBe(true);
      expect(ownerTasks.isOwnerTasksQuery('my action item')).toBe(true);
    });

    test('detects "activation checklist"', () => {
      expect(ownerTasks.isOwnerTasksQuery('show activation checklist')).toBe(true);
    });

    test('detects "what\'s left to do"', () => {
      expect(ownerTasks.isOwnerTasksQuery("what's left to do")).toBe(true);
      expect(ownerTasks.isOwnerTasksQuery('whats left to do')).toBe(true);
    });

    test('returns false for unrelated queries', () => {
      expect(ownerTasks.isOwnerTasksQuery('what is the weather')).toBe(false);
      expect(ownerTasks.isOwnerTasksQuery('how do I deploy')).toBe(false);
      expect(ownerTasks.isOwnerTasksQuery('queue status')).toBe(false); // This is for isStatusQuery
    });

    test('returns false for empty input', () => {
      expect(ownerTasks.isOwnerTasksQuery('')).toBe(false);
      expect(ownerTasks.isOwnerTasksQuery(null)).toBe(false);
      expect(ownerTasks.isOwnerTasksQuery(undefined)).toBe(false);
    });
  });

  describe('formatPendingTasks', () => {
    test('formats pending tasks grouped by priority', () => {
      const formatted = ownerTasks.formatPendingTasks();

      expect(formatted).toContain('Your pending tasks');
      expect(formatted).toContain('High Priority');
      expect(formatted).toContain('Medium Priority');
      expect(formatted).toContain('Low Priority');
      expect(formatted).toContain('Agent Readiness');
    });

    test('shows completion message when all done', () => {
      mockFileContents = {
        bridge: {
          name: 'Bridge',
          tasks: [
            { description: 'Done', completed: true },
          ],
        },
      };

      const formatted = ownerTasks.formatPendingTasks();
      expect(formatted).toContain('All agent activation tasks are complete');
    });

    test('includes agent names in task output', () => {
      const formatted = ownerTasks.formatPendingTasks();

      expect(formatted).toContain('[Bridge Agent]');
      expect(formatted).toContain('[Secretary]');
    });
  });
});
