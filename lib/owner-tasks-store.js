/**
 * lib/owner-tasks-store.js
 *
 * The activation-checklist STORE: the only reader and writer of
 * `agents/activation-checklists.json`, plus the CRUD and readiness maths over it.
 *
 * LOGIC CHANGE 2026-09-15: Extracted verbatim from `lib/owner-tasks.js` (WORK-TODO
 * #10). The concern boundary is store vs. presentation: nothing here renders a string
 * for a human or recognises a command — `lib/owner-tasks.js` keeps those and now reads
 * through this module.
 *
 * The dependency runs one way, store <- view, deliberately: the reverse would be a
 * cycle, and `tests/integration.test.js` guards against those. Every name this module
 * owns is re-exported by `lib/owner-tasks.js`, so no caller moved and the public
 * surface is unchanged.
 */

const fs = require('fs');
const path = require('path');

// Path to activation checklists
const CHECKLISTS_PATH = path.join(__dirname, '..', 'agents', 'activation-checklists.json');

/**
 * Load the activation checklists from disk.
 * Returns empty object if file doesn't exist.
 *
 * @returns {Object} Checklists object
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadChecklists().
// JSON.parse errors (corrupted file, empty file) now reset to {} instead of crashing.
function loadChecklists() {
  try {
    const data = fs.readFileSync(CHECKLISTS_PATH, 'utf8');
    if (!data || !data.trim()) {
      console.warn('[owner-tasks] activation-checklists.json is empty, resetting to {}');
      return {};
    }
    const parsed = JSON.parse(data);
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[owner-tasks] activation-checklists.json has unexpected format, resetting to {}');
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {};
    }
    console.warn(`[owner-tasks] Corrupted activation-checklists.json: ${err.message}. Resetting to {}.`);
    return {};
  }
}

/**
 * Save the activation checklists to disk.
 *
 * @param {Object} checklists - Checklists object to save
 */
function saveChecklists(checklists) {
  // Update metadata
  if (checklists._meta) {
    checklists._meta.lastUpdated = new Date().toISOString();
  }
  fs.writeFileSync(CHECKLISTS_PATH, JSON.stringify(checklists, null, 2), 'utf8');
}

/**
 * Get all pending (uncompleted) tasks across all agents.
 * Returns tasks sorted by priority (high first).
 *
 * @returns {Array<{ agentId: string, agentName: string, taskIndex: number, description: string, priority: string }>}
 */
function getPendingTasks() {
  const checklists = loadChecklists();
  const pendingTasks = [];

  for (const [agentId, agent] of Object.entries(checklists)) {
    // Skip metadata
    if (agentId === '_meta') continue;

    const agentName = agent.name || agentId;
    const tasks = agent.tasks || [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (!task.completed) {
        pendingTasks.push({
          agentId,
          agentName,
          taskIndex: i,
          description: task.description,
          priority: task.priority || 'medium',
        });
      }
    }
  }

  // Sort by priority: high > medium > low
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  pendingTasks.sort((a, b) => {
    const aOrder = priorityOrder[a.priority] ?? 1;
    const bOrder = priorityOrder[b.priority] ?? 1;
    return aOrder - bOrder;
  });

  return pendingTasks;
}

/**
 * Mark a task as completed.
 *
 * @param {string} agentId - Agent ID (e.g., 'bridge', 'secretary')
 * @param {number} taskIndex - Index of the task in the agent's task array
 * @returns {boolean} True if task was found and marked complete
 */
function completeTask(agentId, taskIndex) {
  const checklists = loadChecklists();

  if (!checklists[agentId]) {
    return false;
  }

  const tasks = checklists[agentId].tasks || [];
  if (taskIndex < 0 || taskIndex >= tasks.length) {
    return false;
  }

  tasks[taskIndex].completed = true;
  tasks[taskIndex].completedAt = new Date().toISOString();
  saveChecklists(checklists);
  return true;
}

// LOGIC CHANGE 2026-03-28: Added completeChecklistItem() to mark tasks done by description.
// Allows programmatic completion of checklist items without knowing the index.
/**
 * Mark a checklist item as completed by matching its description.
 * Uses case-insensitive partial matching to find the task.
 *
 * @param {string} agentId - Agent ID (e.g., 'bridge', 'secretary')
 * @param {string} itemDescription - Full or partial task description to match
 * @returns {{ success: boolean, matched?: string, error?: string }} Result object
 */
function completeChecklistItem(agentId, itemDescription) {
  if (!agentId || !itemDescription) {
    return { success: false, error: 'agentId and itemDescription are required' };
  }

  const checklists = loadChecklists();

  if (!checklists[agentId]) {
    return { success: false, error: `Agent '${agentId}' not found in checklists` };
  }

  const tasks = checklists[agentId].tasks || [];
  const searchLower = itemDescription.trim().toLowerCase();

  // Find matching task (case-insensitive partial match)
  const matchIndex = tasks.findIndex(t =>
    t.description.toLowerCase().includes(searchLower)
  );

  if (matchIndex === -1) {
    return { success: false, error: `No task matching '${itemDescription}' found for agent '${agentId}'` };
  }

  const task = tasks[matchIndex];

  // Already completed?
  if (task.completed) {
    return { success: true, matched: task.description, note: 'Task was already completed' };
  }

  task.completed = true;
  task.completedAt = new Date().toISOString();
  saveChecklists(checklists);

  return { success: true, matched: task.description };
}

/**
 * Get the activation readiness percentage for an agent.
 *
 * @param {string} agentId - Agent ID (e.g., 'bridge', 'secretary')
 * @returns {{ total: number, completed: number, percentage: number } | null} Readiness stats or null if agent not found
 */
function getAgentReadiness(agentId) {
  const checklists = loadChecklists();

  if (!checklists[agentId]) {
    return null;
  }

  const tasks = checklists[agentId].tasks || [];
  const total = tasks.length;
  const completed = tasks.filter(t => t.completed).length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 100;

  return { total, completed, percentage };
}

/**
 * Get readiness summary for all agents.
 *
 * @returns {Object<string, { name: string, status: string, total: number, completed: number, percentage: number }>}
 */
function getAllAgentReadiness() {
  const checklists = loadChecklists();
  const summary = {};

  for (const [agentId, agent] of Object.entries(checklists)) {
    if (agentId === '_meta') continue;

    const tasks = agent.tasks || [];
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    const percentage = total > 0 ? Math.round((completed / total) * 100) : 100;

    summary[agentId] = {
      name: agent.name || agentId,
      status: agent.status || 'unknown',
      total,
      completed,
      percentage,
    };
  }

  return summary;
}

/**
 * Add a new task to an agent's checklist.
 * Used for auto-adding ACTION REQUIRED items from task output.
 *
 * @param {string} agentId - Agent ID (e.g., 'bridge')
 * @param {string} description - Task description
 * @param {string} [priority='medium'] - Task priority
 * @returns {boolean} True if task was added
 */
function addTask(agentId, description, priority = 'medium') {
  const checklists = loadChecklists();

  if (!checklists[agentId]) {
    return false;
  }

  // Check for duplicate (case-insensitive, trimmed)
  const normalizedDesc = description.trim().toLowerCase();
  const isDuplicate = (checklists[agentId].tasks || []).some(
    t => t.description.trim().toLowerCase() === normalizedDesc
  );

  if (isDuplicate) {
    return false;
  }

  checklists[agentId].tasks = checklists[agentId].tasks || [];
  checklists[agentId].tasks.push({
    description: description.trim(),
    completed: false,
    priority,
    addedAt: new Date().toISOString(),
    source: 'action_required',
  });

  saveChecklists(checklists);
  return true;
}

module.exports = {
  CHECKLISTS_PATH,
  loadChecklists,
  saveChecklists,
  getPendingTasks,
  completeTask,
  completeChecklistItem,
  getAgentReadiness,
  getAllAgentReadiness,
  addTask,
};
