/**
 * lib/staff-tasks-store.js
 *
 * The staff-task files: staff.json, the daily template, and the state file (with the
 * init() override tests use), plus the read-only queries over today's state.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/staff-tasks.js unchanged, on
 * the four concerns #10 names (staff/template/state, time parsing, Slack side, command
 * recognition and rendering). lib/staff-tasks.js re-exports every name.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { getCurrentTimeMinutes, parseTimeToMinutes } = require('./staff-tasks-time');

// Path to staff and template files
const STAFF_FILE = path.join(__dirname, '..', 'agents', 'shared', 'staff.json');
const TEMPLATE_FILE = path.join(__dirname, '..', 'agents', 'shared', 'daily-tasks-template.json');
// LOGIC CHANGE 2026-10-04 (WORK-TODO #24): overridable through init({ stateFile }), as
// lib/bulletin-board.js and lib/watercooler.js are, so a suite can work on a temp file
// instead of the live data/staff-tasks-state.json. Unset, the path is unchanged.
const DEFAULT_TASKS_STATE_FILE = path.join(__dirname, '..', 'data', 'staff-tasks-state.json');
let TASKS_STATE_FILE = DEFAULT_TASKS_STATE_FILE;

/**
 * Point the module at a different state file (tests), or back at the default.
 * @param {{ stateFile?: string }} [options]
 * @returns {string} The file now in use.
 */
function init(options = {}) {
  TASKS_STATE_FILE = options.stateFile || DEFAULT_TASKS_STATE_FILE;
  return TASKS_STATE_FILE;
}

// LOGIC CHANGE 2026-10-04 (WORK-TODO #33): the store's day is a Toronto day, not a UTC one.
const { dayKey, STORE_TIME_ZONE } = require('./time-format');

// Priority emoji mapping
const PRIORITY_EMOJI = {
  high: ':red_circle:',
  medium: ':large_yellow_circle:',
  low: ':white_circle:',
};

/**
 * Load staff members from agents/shared/staff.json
 * @returns {Array<{name: string, slackId: string, role: string, canReceiveEscalations?: boolean}>}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadStaff().
// JSON.parse errors now reset to [] instead of crashing.
function loadStaff() {
  try {
    const data = fs.readFileSync(STAFF_FILE, 'utf8');
    if (!data || !data.trim()) return [];
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      console.warn('[staff-tasks] staff.json is not an array, resetting to []');
      return [];
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[staff-tasks] Corrupted staff.json: ${err.message}. Resetting to [].`);
    return [];
  }
}

/**
 * Get staff member by name (case-insensitive)
 * @param {string} name - Staff member name
 * @returns {Object|null} Staff member object or null
 */
function getStaffByName(name) {
  const staff = loadStaff();
  const lower = name.toLowerCase().trim();
  return staff.find(s => s.name.toLowerCase() === lower) || null;
}

/**
 * Get staff member by Slack ID
 * @param {string} slackId - Slack user ID
 * @returns {Object|null} Staff member object or null
 */
function getStaffBySlackId(slackId) {
  const staff = loadStaff();
  return staff.find(s => s.slackId === slackId) || null;
}

/**
 * Get owner(s) who can receive escalations
 * @returns {Array<Object>} Staff members with canReceiveEscalations=true
 */
function getEscalationRecipients() {
  const staff = loadStaff();
  return staff.filter(s => s.canReceiveEscalations === true);
}

/**
 * Load daily tasks template from agents/shared/daily-tasks-template.json
 * @returns {{tasks: Array<{time: string, description: string, priority: string, assignee: string|null, category: string}>}}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadDailyTemplate().
function loadDailyTemplate() {
  try {
    const data = fs.readFileSync(TEMPLATE_FILE, 'utf8');
    if (!data || !data.trim()) return { tasks: [] };
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[staff-tasks] daily-tasks-template.json has unexpected format, resetting');
      return { tasks: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { tasks: [] };
    console.warn(`[staff-tasks] Corrupted daily-tasks-template.json: ${err.message}. Resetting.`);
    return { tasks: [] };
  }
}

/**
 * Load current tasks state from data/staff-tasks-state.json
 * @returns {{date: string, tasks: Array<Object>}}
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadTasksState().
function loadTasksState() {
  try {
    const data = fs.readFileSync(TASKS_STATE_FILE, 'utf8');
    if (!data || !data.trim()) return { date: null, tasks: [] };
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[staff-tasks] staff-tasks-state.json has unexpected format, resetting');
      return { date: null, tasks: [] };
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return { date: null, tasks: [] };
    console.warn(`[staff-tasks] Corrupted staff-tasks-state.json: ${err.message}. Resetting.`);
    return { date: null, tasks: [] };
  }
}

/**
 * Save tasks state to data/staff-tasks-state.json
 * @param {Object} state - State object to save
 */
function saveTasksState(state) {
  const dataDir = path.dirname(TASKS_STATE_FILE);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(TASKS_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/**
 * Get all tasks for today from state
 * @returns {Array<Object>} Today's tasks
 */
function getDailyTasks() {
  const state = loadTasksState();
  const today = dayKey(new Date(), STORE_TIME_ZONE);

  if (state.date !== today) {
    return [];
  }

  return state.tasks;
}

/**
 * Get overdue tasks (past due time and not completed)
 * @returns {Array<Object>} Overdue tasks
 */
function getOverdueTasks() {
  const tasks = getDailyTasks();
  const currentMinutes = getCurrentTimeMinutes();

  return tasks.filter(task => {
    if (task.completed) return false;
    if (!task.dueTime) return false;

    const dueMinutes = parseTimeToMinutes(task.dueTime);
    return currentMinutes > dueMinutes;
  });
}

/**
 * Get critical overdue tasks (high priority, overdue by 1+ hours)
 * @returns {Array<Object>} Critical overdue tasks
 */
function getCriticalOverdueTasks() {
  const tasks = getDailyTasks();
  const currentMinutes = getCurrentTimeMinutes();

  return tasks.filter(task => {
    if (task.completed) return false;
    if (!task.dueTime) return false;
    if (task.priority !== 'high') return false;

    const dueMinutes = parseTimeToMinutes(task.dueTime);
    return currentMinutes > dueMinutes + 60; // 1+ hour overdue
  });
}

module.exports = {
  init,
  getStateFile: () => TASKS_STATE_FILE,
  DEFAULT_TASKS_STATE_FILE, STAFF_FILE, TEMPLATE_FILE, PRIORITY_EMOJI,
  loadStaff, getStaffByName, getStaffBySlackId, getEscalationRecipients,
  loadDailyTemplate, loadTasksState, saveTasksState,
  getDailyTasks, getOverdueTasks, getCriticalOverdueTasks,
};
