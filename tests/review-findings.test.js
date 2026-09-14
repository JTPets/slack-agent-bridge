'use strict';

/**
 * tests/review-findings.test.js
 *
 * Guard for lib/review-findings.js and for the structured verdict that
 * validateOutput() now returns.
 *
 * LOGIC CHANGE 2026-09-14: New file. Part two of the autonomous-loop
 * prerequisites. The load-bearing test here is the recurrence pair: it fails
 * against the pre-change behaviour, where a finding was an English sentence and
 * "the same finding recurred" could only be asked by string comparison.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
    RULES,
    SEVERITY,
    VERDICT,
    MAX_GENERATION,
    SPAWNED_TASK_LINEAGE_FIELDS,
    makeFinding,
    buildVerdict,
    sameFinding,
    findRecurrence,
    nextAction,
    describeSpawnedTask,
} = require('../lib/review-findings');

const { validateOutput } = require('../lib/code-review-pipeline');

describe('a finding is structured data, not a sentence', () => {
    test('every finding carries a ruleId, a severity, a file and a line', () => {
        const f = makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'lib/foo.js', line: 12 });
        expect(f.ruleId).toBe('DEBUG_LOGGING_PRESENT');
        expect(f.severity).toBe(SEVERITY.ADVISORY);
        expect(f.file).toBe('lib/foo.js');
        expect(f.line).toBe(12);
        // The prose is generated FROM those fields, so it cannot disagree with them.
        expect(f.message).toContain('DEBUG_LOGGING_PRESENT');
        expect(f.message).toContain('lib/foo.js:12');
    });

    test('a finding with no meaningful line says null rather than faking one', () => {
        const f = makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file: 'lib/foo.js' });
        expect(f.line).toBeNull();
        expect(f.message).toContain('lib/foo.js:');
        expect(f.message).not.toMatch(/lib\/foo\.js:\d/);
    });

    test('an unknown ruleId throws instead of becoming an uncomparable finding', () => {
        expect(() => makeFinding({ ruleId: 'SOMETHING_I_JUST_MADE_UP' })).toThrow(/Unknown ruleId/);
    });

    test('a non-positive or fractional line is refused', () => {
        expect(() => makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 0 })).toThrow(/positive integer/);
        expect(() => makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 1.5 })).toThrow(/positive integer/);
    });

    test('every catalogued rule declares a known severity and a summary', () => {
        const severities = new Set(Object.values(SEVERITY));
        expect(Object.keys(RULES).length).toBeGreaterThan(3);
        for (const [id, rule] of Object.entries(RULES)) {
            expect(severities.has(rule.severity)).toBe(true);
            expect(typeof rule.summary).toBe('string');
            expect(rule.summary.length).toBeGreaterThan(10);
            // makeFinding must accept every catalogued id - a rule nothing can build
            // is a rule nothing can report.
            expect(() => makeFinding({ ruleId: id })).not.toThrow();
        }
    });
});

describe('the verdict summarises findings by severity', () => {
    test('no findings is clean', () => {
        expect(buildVerdict([]).status).toBe(VERDICT.CLEAN);
    });

    test('an advisory finding alone is advisory, not blocked', () => {
        const v = buildVerdict([makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 1 })]);
        expect(v.status).toBe(VERDICT.ADVISORY);
        expect(v.blocking).toEqual([]);
    });

    test('one blocking finding blocks regardless of how many advisories accompany it', () => {
        const v = buildVerdict([
            makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 1 }),
            makeFinding({ ruleId: 'TEST_RUNNER_ABSENT' }),
        ]);
        expect(v.status).toBe(VERDICT.BLOCKED);
        expect(v.blocking.map(f => f.ruleId)).toEqual(['TEST_RUNNER_ABSENT']);
    });

    test('ruleIds are sorted and deduped so two runs produce the same key', () => {
        const a = buildVerdict([
            makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 1 }),
            makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file: 'b.js' }),
            makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'c.js', line: 9 }),
        ]);
        const b = buildVerdict([
            makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file: 'z.js' }),
            makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'q.js', line: 4 }),
        ]);
        expect(a.ruleIds).toEqual(b.ruleIds);
    });
});

describe('recurrence is answered by rule identifier, never by prose (D6)', () => {
    // THE test for part two. Under the pre-change behaviour a finding was a
    // sentence naming its file, so these two - the same rule, twice, on different
    // files - compared UNEQUAL and the loop would have read "converging".
    const first = makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file: 'lib/foo.js' });
    const second = makeFinding({ ruleId: 'LOGIC_CHANGE_COMMENT_MISSING', file: 'lib/bar.js' });

    test('the two renderings really are different strings', () => {
        expect(first.message).not.toBe(second.message);
    });

    test('and they are nonetheless the same finding', () => {
        expect(sameFinding(first, second)).toBe(true);
    });

    test('a different rule on the same file is NOT the same finding', () => {
        const other = makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'lib/foo.js', line: 3 });
        expect(sameFinding(first, other)).toBe(false);
    });

    test('findRecurrence reports which rules came back', () => {
        const verdict = buildVerdict([second, makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'x.js', line: 2 })]);
        const r = findRecurrence(verdict, ['LOGIC_CHANGE_COMMENT_MISSING']);
        expect(r.recurred).toBe(true);
        expect(r.ruleIds).toEqual(['LOGIC_CHANGE_COMMENT_MISSING']);
    });

    test('a verdict with no prior rules has not recurred', () => {
        expect(findRecurrence(buildVerdict([first]), []).recurred).toBe(false);
    });
});

describe('the rework path is bounded (D5 and D6)', () => {
    const finding = makeFinding({ ruleId: 'DEBUG_LOGGING_PRESENT', file: 'a.js', line: 1 });

    test('generation 0 and 1 spawn', () => {
        expect(nextAction({ finding, generation: 0 }).action).toBe('spawn');
        expect(nextAction({ finding, generation: 1 }).action).toBe('spawn');
    });

    test('generation at the cap escalates instead of spawning', () => {
        const r = nextAction({ finding, generation: MAX_GENERATION });
        expect(r.action).toBe('escalate');
        expect(r.reason).toContain('cap');
    });

    test('a repeated rule escalates even below the cap', () => {
        const r = nextAction({ finding, generation: 0, priorRuleIds: ['DEBUG_LOGGING_PRESENT'] });
        expect(r.action).toBe('escalate');
        expect(r.reason).toContain('not converging');
    });
});

describe('what a spawned task would have to carry', () => {
    const finding = makeFinding({ ruleId: 'TEST_SUITE_FAILED', detail: '2 failed, 0 passed' });

    test('the lineage has exactly the declared fields', () => {
        const lineage = describeSpawnedTask({ finding, originatingTaskId: 'task-1', generation: 0 });
        expect(Object.keys(lineage).sort()).toEqual([...SPAWNED_TASK_LINEAGE_FIELDS].sort());
    });

    test('generation increments from the originating task', () => {
        expect(describeSpawnedTask({ finding, originatingTaskId: 't', generation: 1 }).generation).toBe(2);
    });

    test('the finding reference carries file, line and severity', () => {
        const { findingRef } = describeSpawnedTask({ finding, originatingTaskId: 't', generation: 0 });
        expect(Object.keys(findingRef).sort()).toEqual(['file', 'line', 'severity']);
        expect(findingRef.severity).toBe(SEVERITY.BLOCKING);
    });

    test('lineage without an originating task is refused', () => {
        expect(() => describeSpawnedTask({ finding, generation: 0 })).toThrow(/originatingTaskId/);
    });

    test('nothing in production spawns tasks yet — this contract has no caller', () => {
        // Anti-drift: if a spawner lands, this test is the reminder that the loop
        // design (docs/AUTONOMOUS-LOOP-DESIGN.md section 4, part five) says merge
        // state must exist first. Change it deliberately, with the design.
        const hits = spawnSync('grep', [
            '-rln', '--include=*.js', '--exclude-dir=node_modules', '--exclude-dir=tests',
            'describeSpawnedTask', path.join(__dirname, '..'),
        ], { encoding: 'utf8' });
        const files = (hits.stdout || '').split('\n').filter(Boolean).map(f => path.basename(f));
        expect(files).toEqual(['review-findings.js']);
    });
});

describe('validateOutput returns the structured verdict', () => {
    let repoDir;

    beforeAll(() => {
        repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-findings-'));
        spawnSync('git', ['init', '-q'], { cwd: repoDir });
        spawnSync('git', ['config', 'user.email', 't@example.com'], { cwd: repoDir });
        spawnSync('git', ['config', 'user.name', 'T'], { cwd: repoDir });
        fs.writeFileSync(path.join(repoDir, 'seed.txt'), 'seed\n');
        spawnSync('git', ['add', '.'], { cwd: repoDir });
        spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoDir });
        // A changed file with no LOGIC CHANGE comment, a console.log on line 2 and a
        // process.env read on line 3.
        fs.writeFileSync(
            path.join(repoDir, 'thing.js'),
            "'use strict';\nconsole.log('debug');\nconst x = process.env.SOME_NEW_VAR;\nmodule.exports = x;\n"
        );
        spawnSync('git', ['add', '.'], { cwd: repoDir });
        spawnSync('git', ['commit', '-q', '-m', 'change'], { cwd: repoDir });
    });

    afterAll(() => {
        if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
    });

    test('findings name the file and the exact line the problem is on', () => {
        const result = validateOutput(repoDir, { testScript: 'true' });
        const byRule = Object.fromEntries(result.findings.map(f => [f.ruleId, f]));

        expect(byRule.DEBUG_LOGGING_PRESENT).toBeDefined();
        expect(byRule.DEBUG_LOGGING_PRESENT.file).toBe('thing.js');
        expect(byRule.DEBUG_LOGGING_PRESENT.line).toBe(2);

        expect(byRule.ENV_VAR_POSSIBLY_UNDOCUMENTED).toBeDefined();
        expect(byRule.ENV_VAR_POSSIBLY_UNDOCUMENTED.file).toBe('thing.js');
        expect(byRule.ENV_VAR_POSSIBLY_UNDOCUMENTED.line).toBe(3);

        expect(byRule.LOGIC_CHANGE_COMMENT_MISSING).toBeDefined();
        expect(byRule.LOGIC_CHANGE_COMMENT_MISSING.file).toBe('thing.js');
    });

    test('the verdict is present and its advisory list matches result.warnings', () => {
        const result = validateOutput(repoDir, { testScript: 'true' });
        expect(result.verdict).not.toBeNull();
        expect(result.warnings).toEqual(result.verdict.advisory.map(f => f.message));
        expect(result.issues).toEqual(result.verdict.blocking.map(f => f.message));
    });

    test('warnings are generated from findings, so no warning exists without one', () => {
        const result = validateOutput(repoDir, { testScript: 'true' });
        expect(result.warnings.length).toBe(result.verdict.advisory.length);
        for (const w of result.warnings) {
            expect(w).toMatch(/^\[[A-Z_]+\]/);
        }
    });
});
