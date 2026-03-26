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

module.exports = {
    loadMemory,
    saveMemory,
    addTask,
    completeTask,
    failTask,
    getActiveTasks,
    getContext,
    updateContext
};
