/**
 * lib/staff-tasks.js
 *
 * Staff task management for JT Pets store operations.
 * Handles daily recurring tasks posted to #store-tasks channel.
 *
 * Features:
 * - Create and post tasks with priority, assignee, and due time
 * - Track task completion via :white_check_mark: reactions
 * - Escalate overdue tasks to owner via secretary DM
 * - Daily recurring task scheduling from template
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): this file is now the facade over four modules
 * split on the concerns #10 names: lib/staff-tasks-store.js (files, state, queries),
 * lib/staff-tasks-time.js (time and store hours), lib/staff-tasks-slack.js (posting,
 * completing, escalating) and lib/staff-tasks-commands.js (ASK: parsing and rendering).
 * Every name it exported before is exported here.
 */

'use strict';

const store = require('./staff-tasks-store');
const time = require('./staff-tasks-time');
const slack = require('./staff-tasks-slack');
const commands = require('./staff-tasks-commands');

module.exports = {
  // Staff management
  loadStaff: store.loadStaff,
  getStaffByName: store.getStaffByName,
  getStaffBySlackId: store.getStaffBySlackId,
  getEscalationRecipients: store.getEscalationRecipients,

  // Template management
  loadDailyTemplate: store.loadDailyTemplate,

  // Task state management
  loadTasksState: store.loadTasksState,
  saveTasksState: store.saveTasksState,

  // Task CRUD
  formatTask: slack.formatTask,
  formatCompletedTask: slack.formatCompletedTask,
  createTask: slack.createTask,
  completeTask: slack.completeTask,

  // Task queries
  getDailyTasks: store.getDailyTasks,
  getOverdueTasks: store.getOverdueTasks,
  getCriticalOverdueTasks: store.getCriticalOverdueTasks,

  // Scheduling and escalation
  postDailyTasks: slack.postDailyTasks,
  escalateTask: slack.escalateTask,
  checkAndEscalateOverdue: slack.checkAndEscalateOverdue,
  isStoreHours: time.isStoreHours,

  // Time utilities
  parseTimeToMinutes: time.parseTimeToMinutes,
  getCurrentTimeMinutes: time.getCurrentTimeMinutes,
  normalizeTimeString: time.normalizeTimeString,

  // Command parsing
  parseAssignCommand: commands.parseAssignCommand,
  isStaffTaskCommand: commands.isStaffTaskCommand,
  parseStaffTaskCommandType: commands.parseStaffTaskCommandType,

  // Formatting
  formatDigestSummary: commands.formatDigestSummary,
  formatOverdueList: commands.formatOverdueList,
  formatTodayList: commands.formatTodayList,

  // Constants
  PRIORITY_EMOJI: store.PRIORITY_EMOJI,
  STORE_HOURS: time.STORE_HOURS,
  STAFF_FILE: store.STAFF_FILE,
  TEMPLATE_FILE: store.TEMPLATE_FILE,
  init: store.init,
  DEFAULT_TASKS_STATE_FILE: store.DEFAULT_TASKS_STATE_FILE,
  // A getter, not a snapshot, so init() is visible through the facade.
  get TASKS_STATE_FILE() { return store.getStateFile(); },
};
