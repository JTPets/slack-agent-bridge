/**
 * tests/owner-tasks.test.js
 *
 * Unit tests for lib/owner-tasks.js
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

  describe('loadChecklists', () => {
    test('loads checklists from file', () => {
      const checklists = ownerTasks.loadChecklists();
      expect(checklists).toHaveProperty('bridge');
      expect(checklists.bridge.name).toBe('Bridge Agent');
    });

    test('returns empty object if file does not exist', () => {
      // Make readFileSync throw ENOENT
      const realChecklistsPath = path.join(__dirname, '..', 'agents', 'activation-checklists.json');
      fs.readFileSync = jest.fn((filePath) => {
        if (filePath === realChecklistsPath) {
          const err = new Error('File not found');
          err.code = 'ENOENT';
          throw err;
        }
        return originalReadFileSync.call(fs, filePath);
      });

      const checklists = ownerTasks.loadChecklists();
      expect(checklists).toEqual({});
    });
  });

  describe('getPendingTasks', () => {
    test('returns all uncompleted tasks sorted by priority', () => {
      const pending = ownerTasks.getPendingTasks();

      // Should have 4 pending tasks (2 from bridge, 2 from secretary)
      expect(pending.length).toBe(4);

      // High priority should come first
      expect(pending[0].priority).toBe('high');
      expect(pending[1].priority).toBe('high');

      // Then medium
      expect(pending[2].priority).toBe('medium');

      // Then low
      expect(pending[3].priority).toBe('low');
    });

    test('includes agent name and task index', () => {
      const pending = ownerTasks.getPendingTasks();

      const bridgeTask = pending.find(t => t.agentId === 'bridge' && t.description === 'Task 2 high priority');
      expect(bridgeTask).toBeDefined();
      expect(bridgeTask.agentName).toBe('Bridge Agent');
      expect(bridgeTask.taskIndex).toBe(1);
    });

    test('returns empty array when all tasks are complete', () => {
      // Update mock to have all tasks completed
      mockFileContents = {
        bridge: {
          name: 'Bridge',
          tasks: [
            { description: 'Done', completed: true },
          ],
        },
      };

      const pending = ownerTasks.getPendingTasks();
      expect(pending).toEqual([]);
    });
  });

  describe('completeTask', () => {
    test('marks task as completed', () => {
      const result = ownerTasks.completeTask('bridge', 1);
      expect(result).toBe(true);

      const checklists = ownerTasks.loadChecklists();
      expect(checklists.bridge.tasks[1].completed).toBe(true);
      expect(checklists.bridge.tasks[1].completedAt).toBeDefined();
    });

    test('returns false for invalid agent', () => {
      const result = ownerTasks.completeTask('nonexistent', 0);
      expect(result).toBe(false);
    });

    test('returns false for invalid task index', () => {
      const result = ownerTasks.completeTask('bridge', 99);
      expect(result).toBe(false);
    });

    test('returns false for negative task index', () => {
      const result = ownerTasks.completeTask('bridge', -1);
      expect(result).toBe(false);
    });
  });

  describe('getAgentReadiness', () => {
    test('returns readiness stats for agent', () => {
      const readiness = ownerTasks.getAgentReadiness('bridge');

      expect(readiness.total).toBe(3);
      expect(readiness.completed).toBe(1);
      expect(readiness.percentage).toBe(33); // 1/3 = 33%
    });

    test('returns null for non-existent agent', () => {
      const readiness = ownerTasks.getAgentReadiness('nonexistent');
      expect(readiness).toBeNull();
    });

    test('returns 100% for agent with no tasks', () => {
      mockFileContents = {
        empty: {
          name: 'Empty',
          tasks: [],
        },
      };

      const readiness = ownerTasks.getAgentReadiness('empty');
      expect(readiness.percentage).toBe(100);
    });
  });

  describe('getAllAgentReadiness', () => {
    test('returns readiness for all agents', () => {
      const summary = ownerTasks.getAllAgentReadiness();

      expect(summary.bridge).toBeDefined();
      expect(summary.secretary).toBeDefined();
      expect(summary._meta).toBeUndefined(); // Should exclude metadata

      expect(summary.bridge.percentage).toBe(33);
      expect(summary.secretary.percentage).toBe(0); // 0/2
    });
  });

  describe('addTask', () => {
    test('adds task to agent checklist', () => {
      const result = ownerTasks.addTask('bridge', 'New task from ACTION REQUIRED', 'high');
      expect(result).toBe(true);

      const checklists = ownerTasks.loadChecklists();
      const lastTask = checklists.bridge.tasks[checklists.bridge.tasks.length - 1];
      expect(lastTask.description).toBe('New task from ACTION REQUIRED');
      expect(lastTask.completed).toBe(false);
      expect(lastTask.priority).toBe('high');
      expect(lastTask.source).toBe('action_required');
    });

    test('prevents duplicate tasks', () => {
      ownerTasks.addTask('bridge', 'Unique task');
      const result = ownerTasks.addTask('bridge', 'Unique task');
      expect(result).toBe(false);
    });

    test('prevents duplicate tasks case-insensitively', () => {
      ownerTasks.addTask('bridge', 'Case Test');
      const result = ownerTasks.addTask('bridge', 'case test');
      expect(result).toBe(false);
    });

    test('returns false for non-existent agent', () => {
      const result = ownerTasks.addTask('nonexistent', 'Task');
      expect(result).toBe(false);
    });

    test('defaults priority to medium', () => {
      ownerTasks.addTask('bridge', 'Default priority task');

      const checklists = ownerTasks.loadChecklists();
      const lastTask = checklists.bridge.tasks[checklists.bridge.tasks.length - 1];
      expect(lastTask.priority).toBe('medium');
    });
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
      expect(formatted).toContain('All tasks are complete');
    });

    test('includes agent names in task output', () => {
      const formatted = ownerTasks.formatPendingTasks();

      expect(formatted).toContain('[Bridge Agent]');
      expect(formatted).toContain('[Secretary]');
    });
  });

  describe('saveChecklists', () => {
    test('updates lastUpdated in metadata', () => {
      const checklists = ownerTasks.loadChecklists();
      expect(checklists._meta.lastUpdated).toBeNull();

      ownerTasks.saveChecklists(checklists);

      const updated = ownerTasks.loadChecklists();
      expect(updated._meta.lastUpdated).toBeDefined();
      expect(new Date(updated._meta.lastUpdated)).toBeInstanceOf(Date);
    });
  });
});

// LOGIC CHANGE 2026-03-27: Added tests for owner-tasks.json CRUD functions.
describe('owner-tasks.json functions', () => {
  let ownerTasksTempDir;
  let mockOwnerTasksData;
  let ownerTasksModule;

  beforeAll(() => {
    ownerTasksTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-tasks-json-test-'));
  });

  beforeEach(() => {
    // Reset mock data
    mockOwnerTasksData = {
      tasks: [],
      completed: [],
      _meta: { version: 1 },
    };

    // Clear module cache
    delete require.cache[require.resolve('../lib/owner-tasks')];

    // Mock fs for owner-tasks.json path
    const realOwnerTasksPath = path.join(__dirname, '..', 'agents', 'shared', 'owner-tasks.json');
    const realChecklistsPath = path.join(__dirname, '..', 'agents', 'activation-checklists.json');
    const realHistoryPath = path.join(__dirname, '..', 'memory', 'history.json');
    const realEscalationsPath = path.join(__dirname, '..', 'agents', 'shared', 'escalations.json');

    fs.readFileSync = jest.fn((filePath, encoding) => {
      if (filePath === realOwnerTasksPath) {
        return JSON.stringify(mockOwnerTasksData);
      }
      if (filePath === realChecklistsPath) {
        return JSON.stringify(mockChecklists);
      }
      if (filePath === realHistoryPath || filePath === realEscalationsPath) {
        const err = new Error('File not found');
        err.code = 'ENOENT';
        throw err;
      }
      return originalReadFileSync.call(fs, filePath, encoding);
    });

    fs.writeFileSync = jest.fn((filePath, data, encoding) => {
      if (filePath === realOwnerTasksPath) {
        mockOwnerTasksData = JSON.parse(data);
        return;
      }
      if (filePath === realChecklistsPath) {
        mockFileContents = JSON.parse(data);
        return;
      }
      return originalWriteFileSync.call(fs, filePath, data, encoding);
    });

    fs.existsSync = jest.fn((filePath) => {
      if (filePath.includes('agents/shared')) {
        return true;
      }
      return originalExistsSync.call(fs, filePath);
    });

    fs.mkdirSync = jest.fn();

    ownerTasksModule = require('../lib/owner-tasks');
  });

  afterEach(() => {
    fs.readFileSync = originalReadFileSync;
    fs.writeFileSync = originalWriteFileSync;
    fs.existsSync = originalExistsSync;
  });

  afterAll(() => {
    fs.rmSync(ownerTasksTempDir, { recursive: true, force: true });
  });

  describe('loadOwnerTasks', () => {
    test('loads owner tasks from file', () => {
      mockOwnerTasksData = {
        tasks: [{ id: 'task-1', description: 'Test task' }],
        completed: [],
        _meta: { version: 1 },
      };

      const data = ownerTasksModule.loadOwnerTasks();
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].description).toBe('Test task');
    });

    test('returns default structure if file does not exist', () => {
      const realOwnerTasksPath = path.join(__dirname, '..', 'agents', 'shared', 'owner-tasks.json');
      fs.readFileSync = jest.fn((filePath) => {
        if (filePath === realOwnerTasksPath) {
          const err = new Error('File not found');
          err.code = 'ENOENT';
          throw err;
        }
        return originalReadFileSync.call(fs, filePath);
      });

      const data = ownerTasksModule.loadOwnerTasks();
      expect(data).toEqual({ tasks: [], completed: [], _meta: { version: 1 } });
    });
  });

  describe('addOwnerTask', () => {
    test('adds a task with id, description, category, priority, and createdAt', () => {
      const task = ownerTasksModule.addOwnerTask('Test task', 'env', 'high');

      expect(task).not.toBeNull();
      expect(task.id).toMatch(/^task-\d+-[a-z0-9]+$/);
      expect(task.description).toBe('Test task');
      expect(task.category).toBe('env');
      expect(task.priority).toBe('high');
      expect(task.createdAt).toBeDefined();
    });

    test('defaults category to general and priority to medium', () => {
      const task = ownerTasksModule.addOwnerTask('Default task');

      expect(task.category).toBe('general');
      expect(task.priority).toBe('medium');
    });

    test('prevents duplicate tasks', () => {
      ownerTasksModule.addOwnerTask('Unique task');
      const duplicate = ownerTasksModule.addOwnerTask('Unique task');

      expect(duplicate).toBeNull();
    });

    test('prevents duplicate tasks case-insensitively', () => {
      ownerTasksModule.addOwnerTask('Case Test');
      const duplicate = ownerTasksModule.addOwnerTask('case test');

      expect(duplicate).toBeNull();
    });
  });

  describe('completeOwnerTask', () => {
    test('moves task from tasks to completed array', () => {
      ownerTasksModule.addOwnerTask('Task to complete');
      const data = ownerTasksModule.loadOwnerTasks();
      const taskId = data.tasks[0].id;

      const result = ownerTasksModule.completeOwnerTask(taskId);

      expect(result).toBe(true);
      const updated = ownerTasksModule.loadOwnerTasks();
      expect(updated.tasks).toHaveLength(0);
      expect(updated.completed).toHaveLength(1);
      expect(updated.completed[0].completedAt).toBeDefined();
    });

    test('returns false for non-existent task ID', () => {
      const result = ownerTasksModule.completeOwnerTask('non-existent-id');
      expect(result).toBe(false);
    });
  });

  describe('getOwnerTasks', () => {
    test('returns tasks sorted by priority', () => {
      mockOwnerTasksData = {
        tasks: [
          { id: 'task-1', description: 'Low', priority: 'low' },
          { id: 'task-2', description: 'High', priority: 'high' },
          { id: 'task-3', description: 'Immediate', priority: 'immediate' },
          { id: 'task-4', description: 'Medium', priority: 'medium' },
        ],
        completed: [],
        _meta: { version: 1 },
      };

      const tasks = ownerTasksModule.getOwnerTasks();

      expect(tasks[0].priority).toBe('immediate');
      expect(tasks[1].priority).toBe('high');
      expect(tasks[2].priority).toBe('medium');
      expect(tasks[3].priority).toBe('low');
    });
  });

  describe('getCompletedOwnerTasks', () => {
    test('returns most recent completed tasks first', () => {
      mockOwnerTasksData = {
        tasks: [],
        completed: [
          { id: 'task-1', description: 'First', completedAt: '2026-03-25T10:00:00Z' },
          { id: 'task-2', description: 'Second', completedAt: '2026-03-26T10:00:00Z' },
          { id: 'task-3', description: 'Third', completedAt: '2026-03-27T10:00:00Z' },
        ],
        _meta: { version: 1 },
      };

      const completed = ownerTasksModule.getCompletedOwnerTasks(2);

      expect(completed).toHaveLength(2);
      expect(completed[0].description).toBe('Third');
      expect(completed[1].description).toBe('Second');
    });

    test('defaults limit to 10', () => {
      mockOwnerTasksData = {
        tasks: [],
        completed: Array.from({ length: 15 }, (_, i) => ({
          id: `task-${i}`,
          description: `Task ${i}`,
          completedAt: new Date().toISOString(),
        })),
        _meta: { version: 1 },
      };

      const completed = ownerTasksModule.getCompletedOwnerTasks();
      expect(completed).toHaveLength(10);
    });
  });

  describe('loadEscalations', () => {
    test('returns empty array if file does not exist', () => {
      const escalations = ownerTasksModule.loadEscalations();
      expect(escalations).toEqual([]);
    });
  });

  describe('scanRecentActionRequired', () => {
    test('returns empty array if history file does not exist', () => {
      const actions = ownerTasksModule.scanRecentActionRequired();
      expect(actions).toEqual([]);
    });
  });
});
