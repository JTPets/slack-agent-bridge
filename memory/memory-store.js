'use strict';

// memory/memory-store.js
//
// The legacy task memory files (tasks.json, context.json, history.json under memory/):
// tolerant load/save, the task lifecycle writes, history and context reads, and the lazy
// handle on lib/memory-tiers.js the tiered wrappers use.
//
// LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of memory/memory-manager.js
// unchanged, on the boundary #10 names (task/context storage vs. the prompt-context
// builders, which are rendering). memory/memory-manager.js re-exports every name.

const fs = require('fs');
const path = require('path');

// Legacy file paths for backward compatibility
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const CONTEXT_FILE = path.join(__dirname, 'context.json');
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Lazy-load memory-tiers to avoid circular dependencies
let memoryTiers = null;
function getTiers() {
    if (!memoryTiers) {
        memoryTiers = require('../lib/memory-tiers');
    }
    return memoryTiers;
}

// Get base directory for the project
function getBaseDir() {
    return path.join(__dirname, '..');
}

// LOGIC CHANGE 2026-03-27: loadMemory now catches JSON.parse errors (corruption,
// empty files, wrong format). Resets to default value and logs a warning instead
// of crashing. This fixes "tasks.push is not a function" and similar corruption bugs.
function loadMemory(file) {
    const defaultValue = file.includes('tasks') || file.includes('history') ? [] : {};
    try {
        const data = fs.readFileSync(file, 'utf8');
        if (!data || !data.trim()) {
            console.warn(`[memory-manager] Empty file detected: ${file}, resetting to default`);
            saveMemory(file, defaultValue);
            return defaultValue;
        }
        const parsed = JSON.parse(data);
        // LOGIC CHANGE 2026-03-27: Validate that array files actually contain arrays.
        // Fixes "tasks.push is not a function" when tasks.json is corrupted to an object.
        if (Array.isArray(defaultValue) && !Array.isArray(parsed)) {
            console.warn(`[memory-manager] Expected array in ${file}, got ${typeof parsed}. Resetting to default.`);
            saveMemory(file, defaultValue);
            return defaultValue;
        }
        return parsed;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return defaultValue;
        }
        // JSON parse error or other corruption
        console.warn(`[memory-manager] Corrupted file ${file}: ${err.message}. Resetting to default.`);
        try {
            saveMemory(file, defaultValue);
        } catch (saveErr) {
            console.error(`[memory-manager] Failed to reset ${file}:`, saveErr.message);
        }
        return defaultValue;
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

// LOGIC CHANGE 2026-10-04 (WORK-TODO #9): newest-first read of finished tasks, for the
// `history` verb (lib/task-history.js). history.json is append-only and is written by
// completeTask/failTask above, so this is every task this checkout has finished.
function getTaskHistory(limit = 10) {
    const history = loadMemory(HISTORY_FILE);
    return limit > 0 ? history.slice(-limit).reverse() : [];
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

module.exports = {
    TASKS_FILE, CONTEXT_FILE, HISTORY_FILE, getTiers, getBaseDir,
    loadMemory, saveMemory, addTask, completeTask, failTask, getTaskHistory, getActiveTasks,
    getContext, updateContext,
};
