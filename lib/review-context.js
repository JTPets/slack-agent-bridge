'use strict';

/**
 * lib/review-context.js
 *
 * Phase 1 of the code-review pipeline: read a scratch clone before the model runs, and
 * plan the run. reviewTask is the hub; each step is one function below (the repo's own
 * docs, its JS file list, its recent history, a sample test, and files that mention the
 * task's keywords). createExecutionPlan turns the context into the plan Phase 2 and 3 read.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved out of lib/code-review-pipeline.js,
 * which re-exports reviewTask and createExecutionPlan. reviewTask was one 140-line body;
 * it is now the list of its steps. The three copies of "read this file if it exists, warn
 * if reading fails" are one helper, readOptional. The context object and every warning
 * are unchanged.
 */

const fs = require('fs');
const path = require('path');
const { runCommand } = require('./pipeline-command');
const { DEFAULT_TEST_SCRIPT } = require('./review-validate');

// Maximum number of characters to include per file in context
const MAX_FILE_CHARS = 4000;
// Maximum lines of repo structure to include
const MAX_STRUCTURE_LINES = 100;

// Words that carry no signal about what code a task touches.
const STOP_WORDS = new Set(['function', 'should', 'create', 'update', 'implement', 'the', 'and', 'for', 'this', 'that', 'with']);

/**
 * A file at the root of the clone, or '' when it is absent. A failed read is logged
 * with the file's name and also gives ''.
 *
 * @param {string} repoDir
 * @param {string} name
 * @returns {string}
 */
function readOptional(repoDir, name) {
    try {
        const filePath = path.join(repoDir, name);
        if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        console.warn(`[code-review-pipeline] Could not read ${name}:`, err.message);
    }
    return '';
}

/** package.json as an object; {} when it is absent or does not parse. */
function readPackageJson(repoDir) {
    const raw = readOptional(repoDir, 'package.json');
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch (parseErr) {
        return {};
    }
}

/** The clone's JS files (no node_modules, no .git), at most MAX_STRUCTURE_LINES. */
function listJsFiles(repoDir) {
    const findResult = runCommand(
        'find',
        ['.', '-name', '*.js', '-not', '-path', './node_modules/*', '-not', '-path', './.git/*'],
        repoDir
    );
    if (findResult.exitCode !== 0) return '';
    return findResult.stdout.split('\n').filter(Boolean).slice(0, MAX_STRUCTURE_LINES).join('\n');
}

/** `git log --oneline -20`, or '' when git gives nothing. */
function recentGitLog(repoDir) {
    const gitLogResult = runCommand('git', ['log', '--oneline', '-20'], repoDir);
    return gitLogResult.exitCode === 0 && gitLogResult.stdout ? gitLogResult.stdout.trim() : '';
}

/** The first 800 characters of the first tests/*.test.js, to show the model the conventions. */
function sampleTestConventions(repoDir) {
    try {
        const testDir = path.join(repoDir, 'tests');
        if (fs.existsSync(testDir)) {
            const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));
            if (testFiles.length > 0) {
                return fs.readFileSync(path.join(testDir, testFiles[0]), 'utf8').slice(0, 800);
            }
        }
    } catch (err) {
        console.warn('[code-review-pipeline] Could not read test conventions:', err.message);
    }
    return '';
}

/** Up to three keywords from the task text: longer than 5 characters, not a stop word. */
function taskKeywords(taskText) {
    return taskText
        .split(/\s+/)
        .map(w => w.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter(w => w.length > 5 && !STOP_WORDS.has(w.toLowerCase()))
        .slice(0, 3);
}

/**
 * Files that mention one of the task's keywords (three per keyword), each cut to
 * MAX_FILE_CHARS, keyed by path, to surface existing patterns.
 *
 * @param {Object} task
 * @param {string} repoDir
 * @returns {Object<string, string>}
 */
function findRelevantFiles(task, repoDir) {
    const relevantFiles = {};
    const taskText = task.instructions || task.description;
    if (!taskText) return relevantFiles;

    for (const keyword of taskKeywords(taskText)) {
        const grepResult = runCommand(
            'grep',
            ['-r', '-l', '--include=*.js', '--exclude-dir=node_modules', '--exclude-dir=.git', keyword, '.'],
            repoDir
        );
        if (grepResult.exitCode !== 0 || !grepResult.stdout.trim()) continue;
        const matchFiles = grepResult.stdout.trim().split('\n').filter(Boolean).slice(0, 3);
        for (const file of matchFiles) {
            if (relevantFiles[file]) continue;
            try {
                relevantFiles[file] = fs.readFileSync(path.join(repoDir, file), 'utf8').slice(0, MAX_FILE_CHARS);
            } catch (readErr) {
                // Ignore read errors for individual files
            }
        }
    }
    return relevantFiles;
}

/**
 * Phase 1: Review the repository before executing a task.
 * Reads CLAUDE.md, package.json, repo structure, and searches for existing implementations.
 *
 * @param {Object} task - Parsed task object from task-parser.js
 * @param {string} repoDir - Absolute path to the cloned repository
 * @returns {Object} Context object with codebase information
 */
function reviewTask(task, repoDir) {
    return {
        claudeMdRules: readOptional(repoDir, 'CLAUDE.md'),
        repoStructure: listJsFiles(repoDir),
        relevantFiles: findRelevantFiles(task, repoDir),
        existingPatterns: '',
        testConventions: sampleTestConventions(repoDir),
        // alreadyDone is intentionally left false - determining "already done" with confidence
        // requires deep semantic analysis that the LLM handles better with the provided context.
        // The context surfaces existing code so Claude can make this determination itself.
        alreadyDone: false,
        alreadyDoneEvidence: '',
        packageJson: readPackageJson(repoDir),
        gitLog: recentGitLog(repoDir),
        // COMMANDMENTS.md from the repo (may or may not exist)
        commandmentsContent: readOptional(repoDir, 'COMMANDMENTS.md'),
    };
}

/**
 * Create an execution plan for the task based on reviewed context.
 * If the task appears already done, returns { skip: true, reason: ... }.
 *
 * @param {Object} task - Parsed task object
 * @param {Object} context - Context from reviewTask()
 * @returns {Object} Execution plan
 */
function createExecutionPlan(task, context) {
    if (context.alreadyDone) {
        return { skip: true, reason: context.alreadyDoneEvidence };
    }

    const testScript = context.packageJson?.scripts?.test || DEFAULT_TEST_SCRIPT;

    return {
        skip: false,
        testScript,
        hasClaudeMd: Boolean(context.claudeMdRules),
        hasCommandments: Boolean(context.commandmentsContent),
        hasTests: Boolean(context.testConventions),
        relevantFileCount: Object.keys(context.relevantFiles || {}).length,
    };
}

module.exports = {
    reviewTask,
    createExecutionPlan,
    readOptional,
    findRelevantFiles,
    taskKeywords,
};
