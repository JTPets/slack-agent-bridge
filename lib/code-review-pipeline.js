'use strict';

/**
 * lib/code-review-pipeline.js
 *
 * 3-phase code review pipeline for task execution:
 *   Phase 1 (reviewTask):       Read codebase before executing to build context
 *   Phase 2 (buildPrompt):      Assemble enriched prompt with context + COMMANDMENTS + plan
 *   Phase 3 (validateOutput):   Run tests + checks after execution
 *
 * LOGIC CHANGE 2026-03-28: Initial implementation of code review pipeline.
 * Provides context-aware task execution to prevent duplicate work, broken patterns,
 * and missed tests. Claude gets plan + codebase context, not just raw instructions.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeFinding, buildVerdict } = require('./review-findings');
const { classifyTestRun, findingFor } = require('./test-verdict');

// Maximum number of characters to include per file in context
const MAX_FILE_CHARS = 4000;
// Maximum lines of repo structure to include
const MAX_STRUCTURE_LINES = 100;

/**
 * Run a command synchronously and return stdout/stderr.
 * Uses spawnSync (not exec) per security rules.
 *
 * @param {string} cmd - Command to run
 * @param {string[]} args - Command arguments
 * @param {string} cwd - Working directory
 * @param {number} [timeoutMs] - Timeout in ms (default 30000)
 * @returns {{ stdout: string, stderr: string, exitCode: number|null, error: Error|null }}
 */
function runCommand(cmd, args, cwd, timeoutMs = 30000) {
    const result = spawnSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: 'pipe',
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.status,
        error: result.error || null,
    };
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
    const context = {
        claudeMdRules: '',
        repoStructure: '',
        relevantFiles: {},
        existingPatterns: '',
        testConventions: '',
        alreadyDone: false,
        alreadyDoneEvidence: '',
        packageJson: {},
        gitLog: '',
        commandmentsContent: '',
    };

    // Read CLAUDE.md from repo
    try {
        const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
        if (fs.existsSync(claudeMdPath)) {
            context.claudeMdRules = fs.readFileSync(claudeMdPath, 'utf8');
        }
    } catch (err) {
        console.warn('[code-review-pipeline] Could not read CLAUDE.md:', err.message);
    }

    // Read COMMANDMENTS.md from repo (may or may not exist)
    try {
        const commandmentsPath = path.join(repoDir, 'COMMANDMENTS.md');
        if (fs.existsSync(commandmentsPath)) {
            context.commandmentsContent = fs.readFileSync(commandmentsPath, 'utf8');
        }
    } catch (err) {
        console.warn('[code-review-pipeline] Could not read COMMANDMENTS.md:', err.message);
    }

    // Read package.json for dependencies and test scripts
    try {
        const pkgPath = path.join(repoDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkgData = fs.readFileSync(pkgPath, 'utf8');
            try {
                context.packageJson = JSON.parse(pkgData);
            } catch (parseErr) {
                context.packageJson = {};
            }
        }
    } catch (err) {
        console.warn('[code-review-pipeline] Could not read package.json:', err.message);
    }

    // Get repo structure via find (JS files, excluding node_modules)
    const findResult = runCommand(
        'find',
        ['.', '-name', '*.js', '-not', '-path', './node_modules/*', '-not', '-path', './.git/*'],
        repoDir
    );
    if (findResult.exitCode === 0) {
        const files = findResult.stdout.split('\n').filter(Boolean).slice(0, MAX_STRUCTURE_LINES);
        context.repoStructure = files.join('\n');
    }

    // Get recent git history
    const gitLogResult = runCommand('git', ['log', '--oneline', '-20'], repoDir);
    if (gitLogResult.exitCode === 0 && gitLogResult.stdout) {
        context.gitLog = gitLogResult.stdout.trim();
    }

    // Read test conventions by sampling the first test file found
    try {
        const testDir = path.join(repoDir, 'tests');
        if (fs.existsSync(testDir)) {
            const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));
            if (testFiles.length > 0) {
                const sampleContent = fs.readFileSync(path.join(testDir, testFiles[0]), 'utf8');
                context.testConventions = sampleContent.slice(0, 800);
            }
        }
    } catch (err) {
        console.warn('[code-review-pipeline] Could not read test conventions:', err.message);
    }

    // Search for files related to task keywords to surface existing patterns
    if (task.instructions || task.description) {
        const taskText = task.instructions || task.description;
        // Extract meaningful keywords (longer than 5 chars, no common words)
        const stopWords = new Set(['function', 'should', 'create', 'update', 'implement', 'the', 'and', 'for', 'this', 'that', 'with']);
        const keywords = taskText
            .split(/\s+/)
            .map(w => w.replace(/[^a-zA-Z0-9_]/g, ''))
            .filter(w => w.length > 5 && !stopWords.has(w.toLowerCase()))
            .slice(0, 3);

        for (const keyword of keywords) {
            const grepResult = runCommand(
                'grep',
                ['-r', '-l', '--include=*.js', '--exclude-dir=node_modules', '--exclude-dir=.git', keyword, '.'],
                repoDir
            );
            if (grepResult.exitCode === 0 && grepResult.stdout.trim()) {
                const matchFiles = grepResult.stdout.trim().split('\n').filter(Boolean).slice(0, 3);
                for (const file of matchFiles) {
                    if (!context.relevantFiles[file]) {
                        try {
                            const filePath = path.join(repoDir, file);
                            const content = fs.readFileSync(filePath, 'utf8');
                            context.relevantFiles[file] = content.slice(0, MAX_FILE_CHARS);
                        } catch (readErr) {
                            // Ignore read errors for individual files
                        }
                    }
                }
            }
        }
    }

    // alreadyDone is intentionally left false - determining "already done" with confidence
    // requires deep semantic analysis that the LLM handles better with the provided context.
    // The context surfaces existing code so Claude can make this determination itself.

    return context;
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

    const testScript = context.packageJson?.scripts?.test || 'npm test';

    return {
        skip: false,
        testScript,
        hasClaudeMd: Boolean(context.claudeMdRules),
        hasCommandments: Boolean(context.commandmentsContent),
        hasTests: Boolean(context.testConventions),
        relevantFileCount: Object.keys(context.relevantFiles || {}).length,
    };
}

/**
 * Phase 2: Build the full enriched prompt for Claude.
 * Assembles in order: COMMANDMENTS → agent system prompt → production warning →
 * CLAUDE.md → memory/bulletin context → repo structure → relevant files →
 * skill content → execution plan → task instructions → quality checklist.
 *
 * @param {Object} task - Parsed task object
 * @param {Object} context - Context from reviewTask()
 * @param {Object} plan - Plan from createExecutionPlan()
 * @param {Object} [options] - Additional prompt components
 * @param {string} [options.commandmentsContent] - COMMANDMENTS.md content (from host repo)
 * @param {string} [options.agentSystemPrompt] - Agent personality/system prompt
 * @param {string} [options.productionWarning] - Production repo warning
 * @param {string} [options.skillContent] - SKILL.md content if applicable
 * @param {string} [options.memoryContext] - Task history context
 * @param {string} [options.bulletinContext] - Recent inter-agent bulletins
 * @param {string} [options.repoRef] - "repo (branch)" reference string
 * @returns {string} Complete assembled prompt
 */
function buildPrompt(task, context, plan, options = {}) {
    const {
        commandmentsContent = '',
        agentSystemPrompt = '',
        productionWarning = '',
        skillContent = '',
        memoryContext = '',
        bulletinContext = '',
        repoRef = '',
    } = options;

    const sections = [];

    // 1. COMMANDMENTS.md (host repo takes precedence; fallback to repo copy)
    const commandments = commandmentsContent || context.commandmentsContent || '';
    if (commandments) {
        sections.push('# COMMANDMENTS (Non-Negotiable Rules)\n' + commandments);
    }

    // 2. Agent system prompt (personality and expertise)
    if (agentSystemPrompt) {
        sections.push('# AGENT CONTEXT\n' + agentSystemPrompt);
    }

    // 3. Production warning (must appear prominently)
    if (productionWarning) {
        sections.push('# ⚠️ PRODUCTION REPO WARNING\n' + productionWarning);
    }

    // 4. CLAUDE.md rules from cloned repo
    if (context.claudeMdRules) {
        sections.push('# PROJECT RULES (CLAUDE.md)\n' + context.claudeMdRules);
    }

    // 5. Memory and bulletin context
    if (memoryContext) {
        sections.push(memoryContext);
    }
    if (bulletinContext) {
        sections.push(bulletinContext);
    }

    // 6. Codebase structure (so Claude knows what files exist)
    if (context.repoStructure) {
        sections.push('# CODEBASE STRUCTURE (JS files)\n' + context.repoStructure);
    }

    // 7. Recent git history (so Claude knows what was recently changed)
    if (context.gitLog) {
        sections.push('# RECENT GIT HISTORY\n' + context.gitLog);
    }

    // 8. Relevant existing files surfaced by keyword search
    const relevantEntries = Object.entries(context.relevantFiles);
    if (relevantEntries.length > 0) {
        const snippets = relevantEntries
            .map(([file, content]) => `## ${file}\n\`\`\`js\n${content}\n\`\`\``)
            .join('\n\n');
        sections.push('# RELEVANT EXISTING CODE\n' + snippets);
    }

    // 9. Skill template content
    if (skillContent) {
        sections.push('# SKILL TEMPLATE\n' + skillContent);
    }

    // 10. Repo reference
    if (repoRef) {
        sections.push(`You are working in a cloned repo: ${repoRef}.\nYour working directory is the repo root.`);
    }

    // 11. Commit/push instruction (skip for production repos which handle this differently)
    if (!productionWarning && repoRef) {
        sections.push('When done, commit and push your changes if you made any code changes.');
    }

    // 12. Original task instructions
    const taskText = task.instructions || task.description;
    if (taskText) {
        sections.push('# TASK\n' + taskText);
    }

    // 13. Quality checklist
    sections.push(`# QUALITY CHECKLIST (required before committing)
- Add a LOGIC CHANGE comment with today's date for every logic change: // LOGIC CHANGE YYYY-MM-DD: ...
- Run npm test before committing — ALL tests must pass
- Add a unit test for every new exported function (no new function ships without a test)
- Add a regression test for every bug fix
- No debugging console.log statements left in production code
- If new env vars added, document them in CLAUDE.md and .env.example
- No hardcoded secrets — all credentials via environment variables
- Temp directories cleaned up in finally blocks, not just success paths`);

    return sections.filter(Boolean).join('\n\n');
}

/**
 * Phase 3: Validate output after task execution.
 * Runs npm test, checks changed files for LOGIC CHANGE comments and debug logs.
 * Should be called after the LLM finishes but before reporting success.
 *
 * LOGIC CHANGE 2026-09-14: The result now carries `findings` (structured, each with
 * a stable ruleId from lib/review-findings.js, a file, a line and a severity) and a
 * `verdict` summarising them. `issues` and `warnings` are kept for every existing
 * caller, but they are now GENERATED from the findings rather than typed at the site
 * that detects the problem - so the sentence a human reads and the data a spawner
 * compares cannot drift apart. See docs/AUTONOMOUS-LOOP-DESIGN.md decision D6: "the
 * same finding recurred" is a stop condition, and it is unanswerable from prose.
 *
 * @param {string} repoDir - Absolute path to repo directory
 * @param {Object} plan - Execution plan from createExecutionPlan()
 * @returns {Object} Validation result, including `findings` and `verdict`
 */
function validateOutput(repoDir, plan) {
    const findings = [];
    const result = {
        passed: true,
        testsPassed: 0,
        testsFailed: 0,
        issues: [],
        warnings: [],
        changedFiles: [],
        testOutput: '',
        testRun: null,
        findings,
        verdict: null,
    };

    // Run the repo's test command with a 5 minute timeout.
    //
    // LOGIC CHANGE 2026-09-14: the outcome is classified by lib/test-verdict.js
    // instead of being branched on here. The old code read `exitCode !== 0` as "the
    // suite failed" and `exitCode === 0` as "the suite passed", and both readings
    // are wrong in the cases that matter: a missing runner exits 127 having run
    // nothing and was reported as "1 failed", while a command that exits 0 without
    // running anything was reported as a pass with zero tests. A pass now requires
    // exit 0 AND a positive parsed assertion count.
    const testScript = plan?.testScript || 'npm test';
    const [testCmd, ...testArgs] = testScript.split(' ');
    const testResult = runCommand(testCmd, testArgs, repoDir, 300000);

    result.testOutput = (testResult.stdout + testResult.stderr).slice(-3000);

    const testRun = classifyTestRun({
        command: testScript,
        exitCode: testResult.exitCode,
        error: testResult.error,
        stdout: testResult.stdout,
        stderr: testResult.stderr,
    });
    result.testRun = testRun;
    result.testsPassed = testRun.assertions ? testRun.assertions.passed : 0;
    result.testsFailed = testRun.assertions ? testRun.assertions.failed : 0;
    // `passed` is the test gate, and it is now green only when assertions ran.
    result.passed = testRun.green;

    const testFinding = findingFor(testRun);
    if (testFinding) findings.push(testFinding);

    // Check which files were modified since last commit
    const diffResult = runCommand('git', ['diff', '--name-only', 'HEAD'], repoDir);
    if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
        result.changedFiles = diffResult.stdout.trim().split('\n').filter(Boolean);
    } else {
        // Try staged + unstaged changes if HEAD diff is empty (task may have committed)
        const stagedResult = runCommand('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], repoDir);
        if (stagedResult.exitCode === 0 && stagedResult.stdout.trim()) {
            result.changedFiles = stagedResult.stdout.trim().split('\n').filter(Boolean);
        }
    }

    // Check changed JS files for LOGIC CHANGE comments and debug console.log
    const changedJsFiles = result.changedFiles.filter(f =>
        f.endsWith('.js') && !f.includes('test') && !f.includes('.test.')
    );

    for (const file of changedJsFiles) {
        const filePath = path.join(repoDir, file);
        try {
            if (!fs.existsSync(filePath)) continue;
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.split('\n');

            if (!content.includes('LOGIC CHANGE')) {
                // line stays null: the finding is about the whole file, and inventing
                // a line number to satisfy a field shape would be a lie a reader acts on.
                findings.push(makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file }));
            }

            const debugLine = firstMatchingLine(lines, /console\.log\s*\(/);
            if (debugLine !== null) {
                findings.push(makeFinding({
                    ruleId: 'DEBUG_LOGGING_PRESENT',
                    file,
                    line: debugLine,
                    detail: 'remove debug logging before shipping',
                }));
            }

            // LOGIC CHANGE 2026-09-14: was one aggregate warning naming no file; a
            // finding that cannot say where it is cannot become a fix task (D4).
            const envLine = firstMatchingLine(lines, /process\.env\.[A-Z0-9_]+/);
            if (envLine !== null) {
                findings.push(makeFinding({
                    ruleId: 'ENV_VAR_POSSIBLY_UNDOCUMENTED',
                    file,
                    line: envLine,
                    detail: 'verify CLAUDE.md and README.md document it',
                }));
            }
        } catch (readErr) {
            // Ignore individual file read errors
        }
    }

    // Verdict, and the human-readable arrays generated from it. Every existing caller
    // reads `issues`/`warnings`/`passed`; none of them has to change, but the strings
    // they read are now rendered from the findings rather than written beside them.
    result.verdict = buildVerdict(findings);
    result.issues = result.verdict.blocking.map(f => f.message);
    result.warnings = result.verdict.advisory.map(f => f.message);
    // Any blocking finding fails the gate, not only a test one. Today every blocking
    // rule is a test rule, so this is equivalent; it is written this way so that
    // adding a blocking rule cannot leave `passed` true beside it.
    result.passed = result.verdict.blocking.length === 0;

    return result;
}

/**
 * 1-based line number of the first line matching `pattern`, or null.
 *
 * @param {string[]} lines
 * @param {RegExp} pattern
 * @returns {number|null}
 */
function firstMatchingLine(lines, pattern) {
    for (let i = 0; i < lines.length; i += 1) {
        if (pattern.test(lines[i])) return i + 1;
    }
    return null;
}

module.exports = {
    reviewTask,
    createExecutionPlan,
    buildPrompt,
    validateOutput,
    // Exported for testing
    runCommand,
};
