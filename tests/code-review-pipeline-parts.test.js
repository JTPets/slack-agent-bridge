'use strict';

/**
 * tests/code-review-pipeline-parts.test.js
 *
 * WORK-TODO #10, B37 (2026-11-25): each phase lib/code-review-pipeline.js was split
 * into, tested on its own against a REAL git repository in a temp dir (the facade's
 * behaviour is tests/code-review-pipeline.test.js, unchanged).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runCommand } = require('../lib/pipeline-command');
const context = require('../lib/review-context');
const { buildPrompt } = require('../lib/review-prompt');
const validate = require('../lib/review-validate');

let repo;
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'b37-pipeline-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, 'lib'));
    fs.writeFileSync(path.join(repo, 'package.json'), '{"scripts":{"test":"node --version"}}');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# rules');
    fs.writeFileSync(path.join(repo, 'lib', 'widgetry.js'), '// widgetry\nmodule.exports = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
});

afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(repo, { recursive: true, force: true });
});

describe('lib/pipeline-command.js', () => {
    test('runs an argv array and reports a missing binary as an error, not a throw', () => {
        expect(runCommand('git', ['rev-parse', '--is-inside-work-tree'], repo).stdout.trim()).toBe('true');
        expect(runCommand('no-such-binary-b37', [], repo).error).toBeTruthy();
    });
});

describe('lib/review-context.js (Phase 1)', () => {
    test('reads the repo docs, finds files by keyword, and a missing file is empty, not an error', () => {
        expect(context.readOptional(repo, 'CLAUDE.md')).toBe('# rules');
        expect(context.readOptional(repo, 'COMMANDMENTS.md')).toBe('');
        expect(context.taskKeywords('update the widgetry module function please now')).toEqual(['widgetry', 'module', 'please']);
        const ctx = context.reviewTask({ instructions: 'touch widgetry' }, repo);
        expect(Object.keys(ctx.relevantFiles)).toEqual(['./lib/widgetry.js']);
        expect(ctx.packageJson.scripts.test).toBe('node --version');
        expect(context.createExecutionPlan({}, ctx).testScript).toBe('node --version');
    });

    test('with no test script, the plan uses Phase 3\'s default command', () => {
        expect(context.createExecutionPlan({}, { packageJson: {}, relevantFiles: {} }).testScript)
            .toBe(validate.DEFAULT_TEST_SCRIPT);
    });
});

describe('lib/review-prompt.js (Phase 2)', () => {
    test('puts the project rules before the task and ends with the checklist', () => {
        const text = buildPrompt({ instructions: 'do x' }, { claudeMdRules: 'R', relevantFiles: {} }, {});
        expect(text.indexOf('# PROJECT RULES')).toBeLessThan(text.indexOf('# TASK\ndo x'));
        expect(text.trim().split('\n\n').pop()).toMatch(/^# QUALITY CHECKLIST/);
    });
});

describe('lib/review-validate.js (Phase 3)', () => {
    test('changed files: the working tree first, else the last commit', () => {
        expect(validate.changedFilesOf(repo)).toEqual([]);
        fs.appendFileSync(path.join(repo, 'lib', 'widgetry.js'), 'console.log(process.env.FOO_BAR);\n');
        expect(validate.changedFilesOf(repo)).toEqual(['lib/widgetry.js']);
    });

    test('a changed file is checked for each rule, with the line where it applies', () => {
        fs.appendFileSync(path.join(repo, 'lib', 'widgetry.js'), 'console.log(process.env.FOO_BAR);\n');
        const found = validate.checkChangedFile(repo, 'lib/widgetry.js');
        expect(found.map((f) => [f.ruleId, f.line])).toEqual([
            ['LOGIC_CHANGE_COMMENT_MISSING', null],
            ['DEBUG_LOGGING_PRESENT', 3],
            ['ENV_VAR_POSSIBLY_UNDOCUMENTED', 3],
        ]);
        expect(validate.checkChangedFile(repo, 'lib/gone.js')).toEqual([]);
    });

    test('a command that prints no test count is not a pass', () => {
        const gate = validate.runTestGate(repo, { testScript: 'node --version' });
        expect(gate.testCommand).toBe('node --version');
        expect(gate.testRun.green).toBe(false);
        expect(validate.validateOutput(repo, { testScript: 'node --version' }).passed).toBe(false);
    });
});
