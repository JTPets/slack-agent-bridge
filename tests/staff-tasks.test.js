/**
 * tests/staff-tasks.test.js
 *
 * Unit tests for lib/staff-tasks.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Mock the staff and template files before requiring the module
const MOCK_STAFF = [
  { name: 'John', slackId: 'U02QKNHHU7J', role: 'owner', canReceiveEscalations: true },
  { name: 'Alice', slackId: 'U12345ALICE', role: 'staff', canReceiveEscalations: false },
];

const MOCK_TEMPLATE = {
  _meta: { description: 'Test template' },
  tasks: [
    { time: '09:00', description: 'Open store', priority: 'high', assignee: null, category: 'opening' },
    { time: '12:00', description: 'Lunch check', priority: 'medium', assignee: null, category: 'inventory' },
    { time: '17:00', description: 'Close store', priority: 'high', assignee: null, category: 'closing' },
  ],
};

// Create temp directory for test files
const TEST_DIR = path.join(__dirname, '..', 'test-data-staff-tasks');
const TEST_STAFF_FILE = path.join(TEST_DIR, 'staff.json');
const TEST_TEMPLATE_FILE = path.join(TEST_DIR, 'daily-tasks-template.json');
const TEST_STATE_FILE = path.join(TEST_DIR, 'staff-tasks-state.json');

beforeAll(() => {
  // Create test directory
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
  // Write mock files
  fs.writeFileSync(TEST_STAFF_FILE, JSON.stringify(MOCK_STAFF, null, 2));
  fs.writeFileSync(TEST_TEMPLATE_FILE, JSON.stringify(MOCK_TEMPLATE, null, 2));
});

afterAll(() => {
  // Cleanup test directory
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

// Now require the module (after setting up mocks)
const staffTasks = require('../lib/staff-tasks');

describe('staff-tasks', () => {
  // LOGIC CHANGE 2026-03-28: Suppress expected console.warn output from error-path tests.
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('loadStaff', () => {
    it('should load staff from file', () => {
      const staff = staffTasks.loadStaff();
      expect(Array.isArray(staff)).toBe(true);
    });
  });

  describe('getStaffByName', () => {
    it('should find staff by name (case-insensitive)', () => {
      const staff = staffTasks.getStaffByName('john');
      expect(staff).toBeTruthy();
      expect(staff.slackId).toBe('U02QKNHHU7J');
    });

    it('should return null for unknown name', () => {
      const staff = staffTasks.getStaffByName('Unknown');
      expect(staff).toBeNull();
    });
  });

  describe('getStaffBySlackId', () => {
    it('should find staff by Slack ID', () => {
      const staff = staffTasks.getStaffBySlackId('U02QKNHHU7J');
      expect(staff).toBeTruthy();
      expect(staff.name).toBe('John');
    });

    it('should return null for unknown ID', () => {
      const staff = staffTasks.getStaffBySlackId('UUNKNOWN');
      expect(staff).toBeNull();
    });
  });

  describe('getEscalationRecipients', () => {
    it('should return staff with canReceiveEscalations=true', () => {
      const recipients = staffTasks.getEscalationRecipients();
      expect(recipients.length).toBeGreaterThan(0);
      expect(recipients.every(r => r.canReceiveEscalations === true)).toBe(true);
    });
  });

  describe('formatTask', () => {
    it('should format basic task with priority emoji', () => {
      const result = staffTasks.formatTask({
        description: 'Test task',
        priority: 'high',
      });
      expect(result).toContain('[ ]');
      expect(result).toContain(':red_circle:');
      expect(result).toContain('Test task');
    });

    it('should include assignee when provided', () => {
      const result = staffTasks.formatTask({
        description: 'Test task',
        assignee: 'Alice',
      });
      expect(result).toContain('Assigned: @Alice');
    });

    it('should format Slack ID assignee with mention syntax', () => {
      const result = staffTasks.formatTask({
        description: 'Test task',
        assignee: 'U12345ALICE',
      });
      expect(result).toContain('Assigned: <@U12345ALICE>');
    });

    it('should include due time when provided', () => {
      const result = staffTasks.formatTask({
        description: 'Test task',
        dueTime: '14:00',
      });
      expect(result).toContain('Due: 14:00');
    });

    it('should use medium priority emoji by default', () => {
      const result = staffTasks.formatTask({
        description: 'Test task',
      });
      expect(result).toContain(':large_yellow_circle:');
    });
  });

  describe('formatCompletedTask', () => {
    it('should replace [ ] with [x]', () => {
      const original = '[ ] :red_circle: Test task | Due: 14:00';
      const completed = staffTasks.formatCompletedTask(original);
      expect(completed).toBe('[x] :red_circle: Test task | Due: 14:00');
    });
  });

  describe('parseTimeToMinutes', () => {
    it('should parse HH:MM to minutes since midnight', () => {
      expect(staffTasks.parseTimeToMinutes('09:00')).toBe(540);
      expect(staffTasks.parseTimeToMinutes('12:30')).toBe(750);
      expect(staffTasks.parseTimeToMinutes('00:00')).toBe(0);
      expect(staffTasks.parseTimeToMinutes('23:59')).toBe(1439);
    });
  });

  describe('normalizeTimeString', () => {
    it('should normalize 12h times with am/pm', () => {
      expect(staffTasks.normalizeTimeString('9am')).toBe('09:00');
      expect(staffTasks.normalizeTimeString('9:30am')).toBe('09:30');
      expect(staffTasks.normalizeTimeString('12pm')).toBe('12:00');
      expect(staffTasks.normalizeTimeString('1pm')).toBe('13:00');
      expect(staffTasks.normalizeTimeString('11:45pm')).toBe('23:45');
    });

    it('should handle 24h times', () => {
      expect(staffTasks.normalizeTimeString('14:30')).toBe('14:30');
      expect(staffTasks.normalizeTimeString('09:00')).toBe('09:00');
    });

    it('should handle midnight edge cases', () => {
      expect(staffTasks.normalizeTimeString('12am')).toBe('00:00');
      expect(staffTasks.normalizeTimeString('12:30am')).toBe('00:30');
    });
  });

  describe('parseAssignCommand', () => {
    it('should parse basic assign command', () => {
      const result = staffTasks.parseAssignCommand('assign restock shelves to Alice');
      expect(result).toEqual({
        task: 'restock shelves',
        assignee: 'Alice',
        dueTime: null,
      });
    });

    it('should parse assign command with time', () => {
      const result = staffTasks.parseAssignCommand('assign restock shelves to Alice by 2pm');
      expect(result).toEqual({
        task: 'restock shelves',
        assignee: 'Alice',
        dueTime: '14:00',
      });
    });

    it('should parse assign command with 24h time', () => {
      const result = staffTasks.parseAssignCommand('assign check freezer to John by 14:30');
      expect(result).toEqual({
        task: 'check freezer',
        assignee: 'John',
        dueTime: '14:30',
      });
    });

    it('should return null for invalid format', () => {
      expect(staffTasks.parseAssignCommand('invalid command')).toBeNull();
      expect(staffTasks.parseAssignCommand('assign something')).toBeNull();
    });
  });

  describe('isStaffTaskCommand', () => {
    it('should detect assign commands', () => {
      expect(staffTasks.isStaffTaskCommand('assign task to Alice')).toBe(true);
      expect(staffTasks.isStaffTaskCommand('Assign clean shelves to Bob by 3pm')).toBe(true);
    });

    it('should detect overdue queries', () => {
      expect(staffTasks.isStaffTaskCommand('what tasks are overdue')).toBe(true);
      expect(staffTasks.isStaffTaskCommand('overdue tasks')).toBe(true);
      expect(staffTasks.isStaffTaskCommand('what tasks are overdue?')).toBe(true);
    });

    it('should detect today task queries', () => {
      expect(staffTasks.isStaffTaskCommand('store tasks today')).toBe(true);
      expect(staffTasks.isStaffTaskCommand("today's store tasks")).toBe(true);
      expect(staffTasks.isStaffTaskCommand('staff tasks today')).toBe(true);
    });

    it('should return false for non-staff commands', () => {
      expect(staffTasks.isStaffTaskCommand('what is the weather')).toBe(false);
      expect(staffTasks.isStaffTaskCommand('help me with code')).toBe(false);
    });
  });

  describe('parseStaffTaskCommandType', () => {
    it('should return assign for assign commands', () => {
      expect(staffTasks.parseStaffTaskCommandType('assign task to Alice')).toBe('assign');
    });

    it('should return overdue for overdue queries', () => {
      expect(staffTasks.parseStaffTaskCommandType('what tasks are overdue')).toBe('overdue');
    });

    it('should return today for today queries', () => {
      expect(staffTasks.parseStaffTaskCommandType('store tasks today')).toBe('today');
    });

    it('should return null for unknown commands', () => {
      expect(staffTasks.parseStaffTaskCommandType('random text')).toBeNull();
    });
  });

  describe('isStoreHours', () => {
    it('should be a function', () => {
      expect(typeof staffTasks.isStoreHours).toBe('function');
    });

    // Note: Actual store hours check depends on system time, so we just verify it returns boolean
    it('should return boolean', () => {
      const result = staffTasks.isStoreHours();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('PRIORITY_EMOJI', () => {
    it('should have correct emoji mappings', () => {
      expect(staffTasks.PRIORITY_EMOJI.high).toBe(':red_circle:');
      expect(staffTasks.PRIORITY_EMOJI.medium).toBe(':large_yellow_circle:');
      expect(staffTasks.PRIORITY_EMOJI.low).toBe(':white_circle:');
    });
  });

  describe('STORE_HOURS', () => {
    it('should have open and close times', () => {
      expect(staffTasks.STORE_HOURS.open).toBe(9);
      expect(staffTasks.STORE_HOURS.close).toBe(21);
    });
  });

  describe('loadDailyTemplate', () => {
    it('should load template from file', () => {
      const template = staffTasks.loadDailyTemplate();
      expect(template).toBeTruthy();
      expect(Array.isArray(template.tasks)).toBe(true);
    });
  });

  describe('loadTasksState and saveTasksState', () => {
    const testState = {
      date: '2026-03-27',
      tasks: [
        { messageTs: '123.456', description: 'Test', completed: false },
      ],
    };

    beforeEach(() => {
      // Clear state file before each test
      try {
        fs.unlinkSync(staffTasks.TASKS_STATE_FILE);
      } catch {
        // File may not exist
      }
    });

    it('should return empty state when file does not exist', () => {
      const state = staffTasks.loadTasksState();
      expect(state.date).toBeNull();
      expect(state.tasks).toEqual([]);
    });
  });

  describe('getDailyTasks', () => {
    it('should return array', () => {
      const tasks = staffTasks.getDailyTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe('getOverdueTasks', () => {
    it('should return array', () => {
      const tasks = staffTasks.getOverdueTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe('getCriticalOverdueTasks', () => {
    it('should return array', () => {
      const tasks = staffTasks.getCriticalOverdueTasks();
      expect(Array.isArray(tasks)).toBe(true);
    });
  });

  describe('formatOverdueList', () => {
    it('should return string', () => {
      const result = staffTasks.formatOverdueList();
      expect(typeof result).toBe('string');
    });

    it('should indicate no overdue tasks when list is empty', () => {
      const result = staffTasks.formatOverdueList();
      // When no tasks, should show success message
      expect(result).toContain('No overdue tasks');
    });
  });

  describe('formatTodayList', () => {
    it('should return string', () => {
      const result = staffTasks.formatTodayList();
      expect(typeof result).toBe('string');
    });
  });

  describe('formatDigestSummary', () => {
    it('should return null when no tasks', () => {
      const result = staffTasks.formatDigestSummary();
      // With no tasks for today, should return null
      expect(result).toBeNull();
    });
  });
});
