'use strict';

const fs = require('fs');
const path = require('path');

const TASKS_FILE = path.join(__dirname, 'tasks.json');
const CONTEXT_FILE = path.join(__dirname, 'context.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

function loadMemory(file) {
    try {
        const data = fs.readFileSync(file, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return file.includes('tasks') || file.includes('history') ? [] : {};
        }
        throw err;
    }
}

function saveMemory(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function addTask(task) {
    const tasks = loadMemory(TASKS_FILE);
    const newTask = {
        id: Date.now().toString(),
        created: new Date().toISOString(),
        status: 'active',
        ...task
    };
    tasks.push(newTask);
    saveMemory(TASKS_FILE, tasks);
    return newTask;
}

function completeTask(id, outcome) {
    const tasks = loadMemory(TASKS_FILE);
    const history = loadMemory(HISTORY_FILE);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = tasks.splice(idx, 1)[0];
    task.status = 'completed';
    task.outcome = outcome;
    task.completedAt = new Date().toISOString();
    history.push(task);

    saveMemory(TASKS_FILE, tasks);
    saveMemory(HISTORY_FILE, history);
    return task;
}

function failTask(id, error) {
    const tasks = loadMemory(TASKS_FILE);
    const history = loadMemory(HISTORY_FILE);
    const idx = tasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = tasks.splice(idx, 1)[0];
    task.status = 'failed';
    task.error = error;
    task.failedAt = new Date().toISOString();
    history.push(task);

    saveMemory(TASKS_FILE, tasks);
    saveMemory(HISTORY_FILE, history);
    return task;
}

function getActiveTasks() {
    return loadMemory(TASKS_FILE).filter(t => t.status === 'active');
}

function getContext() {
    return loadMemory(CONTEXT_FILE);
}

function updateContext(key, value) {
    const context = loadMemory(CONTEXT_FILE);
    context[key] = value;
    saveMemory(CONTEXT_FILE, context);
    return context;
}

// LOGIC CHANGE 2026-03-26: Added buildTaskContext() to provide CC with historical
// context from previous tasks, enabling it to avoid duplicate work and build on
// previous results. Returns a formatted string for prepending to task prompts.
function buildTaskContext() {
    try {
        // Load context.json (owner info, preferences)
        const context = loadMemory(CONTEXT_FILE);

        // Load history.json and get last 10 entries (most recent first)
        const history = loadMemory(HISTORY_FILE);
        const recentHistory = history.slice(-10).reverse();

        // Load all active tasks from tasks.json
        const activeTasks = loadMemory(TASKS_FILE).filter(t => t.status === 'active');

        // Check if we have any meaningful data
        const hasContext = context && Object.keys(context).length > 0;
        const hasHistory = recentHistory.length > 0;
        const hasActiveTasks = activeTasks.length > 0;

        if (!hasContext && !hasHistory && !hasActiveTasks) {
            return 'AGENT CONTEXT:\nNo task history available.';
        }

        // Build context string
        let result = 'AGENT CONTEXT:\n';

        // Add owner info from context.json
        if (hasContext) {
            if (context.owner) result += `Owner: ${context.owner}\n`;
            if (context.timezone) result += `Timezone: ${context.timezone}\n`;
        }

        // Add recent task history
        if (hasHistory) {
            result += '\nRECENT TASK HISTORY (last 10):\n';
            for (const task of recentHistory) {
                const timestamp = task.completedAt || task.failedAt || task.created;
                const status = task.status || 'unknown';
                const desc = task.description || 'No description';
                const repo = task.repo ? ` (repo: ${task.repo})` : '';
                result += `- [${timestamp}] [${status}] ${desc}${repo}\n`;
            }
        }

        // Add currently active tasks
        if (hasActiveTasks) {
            result += '\nCURRENTLY ACTIVE TASKS:\n';
            for (const task of activeTasks) {
                const desc = task.description || 'No description';
                const started = task.created || 'unknown';
                result += `- ${desc} (started: ${started})\n`;
            }
        }

        result += '\nUse this context to avoid duplicate work and build on previous results.';

        return result;
    } catch (err) {
        // If anything fails, return minimal string - never block task execution
        return 'AGENT CONTEXT:\nNo task history available.';
    }
}

module.exports = {
    loadMemory,
    saveMemory,
    addTask,
    completeTask,
    failTask,
    getActiveTasks,
    getContext,
    updateContext,
    buildTaskContext
};
