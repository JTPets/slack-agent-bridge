'use strict';

/**
 * lib/review-findings.js
 *
 * Structured findings for the code-review pipeline's Phase 3 verdict.
 *
 * LOGIC CHANGE 2026-09-14: New module. Part two of the autonomous-loop
 * prerequisites (docs/AUTONOMOUS-LOOP-DESIGN.md section 4).
 *
 * WHAT THIS REPLACES. `validateOutput()` in lib/code-review-pipeline.js already
 * returned a value to its caller rather than only posting. What it returned was:
 *
 *   { passed, testsPassed, testsFailed, issues: string[], warnings: string[],
 *     changedFiles: string[], testOutput: string }
 *
 * `issues` and `warnings` are ENGLISH SENTENCES. That is the defect. Decision D6
 * of the loop design makes "the same finding recurred" a stop condition, and two
 * renderings of one rule drift apart the moment the sentence mentions anything
 * variable:
 *
 *   "No LOGIC CHANGE comment found in modified file: lib/foo.js"
 *   "No LOGIC CHANGE comment found in modified file: lib/bar.js"
 *
 * Same rule, different strings. A string comparison says "converging"; the truth
 * is "identical warning, second time". So a finding is comparable by `ruleId` and
 * by nothing else, and `ruleId` comes from a closed catalogue in this file rather
 * than being invented at the call site.
 *
 * The prose is kept - it is what a human reads in Slack - but it is now GENERATED
 * from the finding, never typed beside it. Same discipline as
 * lib/git-identifiers.js, where the rejection message is generated from the same
 * character list the pattern is built around.
 */

/** Severity ordering. `blocking` fails the verdict; `advisory` does not. */
const SEVERITY = {
    BLOCKING: 'blocking',
    ADVISORY: 'advisory',
};

/**
 * The closed catalogue of rule identifiers.
 *
 * Adding a rule means adding a row here. A `ruleId` that is not in this table is
 * refused by `makeFinding()` - an invented identifier would compare equal to
 * nothing and silently defeat D6, which is the failure this module exists to
 * prevent, so it throws rather than being tolerated.
 *
 * IDs are stable and never reused. They are the comparison key across
 * generations of a spawned-task chain, so renaming one breaks every lineage
 * record that already cites it.
 */
const RULES = {
    // --- test gate (the detail of these is owned by lib/test-verdict.js) ---
    TEST_SUITE_FAILED: {
        severity: SEVERITY.BLOCKING,
        summary: 'The test suite ran and reported failures',
    },
    TEST_RUNNER_ABSENT: {
        severity: SEVERITY.BLOCKING,
        summary: 'The test runner could not be started, so no assertion executed',
    },
    TEST_SUITE_NO_ASSERTIONS: {
        severity: SEVERITY.BLOCKING,
        summary: 'The test command exited 0 without running any assertion',
    },
    TEST_SUITE_TIMED_OUT: {
        severity: SEVERITY.BLOCKING,
        summary: 'The test command was killed before it finished',
    },

    // --- repository conventions checked on changed files ---
    LOGIC_CHANGE_COMMENT_MISSING: {
        severity: SEVERITY.ADVISORY,
        summary: 'A modified non-test file carries no LOGIC CHANGE comment',
    },
    DEBUG_LOGGING_PRESENT: {
        severity: SEVERITY.ADVISORY,
        summary: 'A modified non-test file contains console.log',
    },
    ENV_VAR_POSSIBLY_UNDOCUMENTED: {
        severity: SEVERITY.ADVISORY,
        summary: 'A modified file reads process.env - verify the variable is documented',
    },
};

/** Verdict statuses. */
const VERDICT = {
    CLEAN: 'clean',      // no findings at all
    ADVISORY: 'advisory', // findings, none blocking - may still merge under D1
    BLOCKED: 'blocked',   // at least one blocking finding
};

/**
 * The lineage a spawned fix task must carry.
 *
 * Declared here, as data, so that it is one thing rather than a paragraph in a
 * document and a differently-shaped object in whatever eventually spawns tasks.
 * NOTHING IN THIS REPOSITORY SPAWNS TASKS - see docs/AUTONOMOUS-LOOP-DESIGN.md
 * section 4. This is the shape such a spawner would have to produce, and
 * `describeSpawnedTask()` below produces it from a finding, so the contract is
 * executable rather than aspirational.
 *
 * @see docs/AUTONOMOUS-LOOP-DESIGN.md decision D4
 */
const SPAWNED_TASK_LINEAGE_FIELDS = Object.freeze([
    'originatingTaskId', // the task whose review produced the finding
    'ruleId',            // the finding's stable identifier - the D6 comparison key
    'generation',        // 0 for an owner-submitted task, +1 per spawn; capped at 2 (D5)
    'findingRef',        // { file, line, severity } as the review reported it
]);

/** Generation cap from decision D5. A finding at this generation escalates instead. */
const MAX_GENERATION = 2;

/**
 * Build one finding.
 *
 * @param {object} options
 * @param {string} options.ruleId - Must be a key of RULES.
 * @param {string|null} [options.file] - Repo-relative path, or null when the
 *   finding is about the run rather than a file (the test-gate rules).
 * @param {number|null} [options.line] - 1-based line, or null when the finding is
 *   about the whole file. Never faked: a rule that has no line says null.
 * @param {string} [options.detail] - Extra context for the human-readable text.
 * @returns {{ ruleId: string, severity: string, file: string|null, line: number|null,
 *   summary: string, detail: string, message: string }}
 */
function makeFinding({ ruleId, file = null, line = null, detail = '' } = {}) {
    const rule = RULES[ruleId];
    if (!rule) {
        throw new Error(
            `[review-findings] Unknown ruleId "${ruleId}". Add it to RULES; an ` +
            'ad-hoc identifier compares equal to nothing and defeats recurrence detection.'
        );
    }
    if (line !== null && (!Number.isInteger(line) || line < 1)) {
        throw new Error(`[review-findings] ${ruleId}: line must be a positive integer or null, got ${line}`);
    }

    const finding = {
        ruleId,
        severity: rule.severity,
        file,
        line,
        summary: rule.summary,
        detail: String(detail || ''),
    };
    // Generated from the fields above, never typed beside them. Computed eagerly so
    // the finding stays a plain object: it is spread, JSON-serialised into the queue
    // and compared, and a getter survives none of those the same way a value does.
    finding.message = renderFinding(finding);
    return finding;
}

/**
 * Render a finding as the line a human reads. Generated from the finding's own
 * fields so the prose cannot disagree with the data it describes.
 *
 * @param {object} finding
 * @returns {string}
 */
function renderFinding(finding) {
    const where = finding.file
        ? `${finding.file}${finding.line ? `:${finding.line}` : ''}`
        : '(no file)';
    const tail = finding.detail ? ` — ${finding.detail}` : '';
    return `[${finding.ruleId}] ${where}: ${finding.summary}${tail}`;
}

/**
 * Build the verdict from a list of findings.
 *
 * @param {Array<object>} findings
 * @returns {{ status: string, findings: Array<object>, blocking: Array<object>,
 *   advisory: Array<object>, ruleIds: string[] }}
 */
function buildVerdict(findings = []) {
    const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCKING);
    const advisory = findings.filter((f) => f.severity === SEVERITY.ADVISORY);

    let status = VERDICT.CLEAN;
    if (blocking.length > 0) status = VERDICT.BLOCKED;
    else if (advisory.length > 0) status = VERDICT.ADVISORY;

    return {
        status,
        findings,
        blocking,
        advisory,
        // Sorted + deduped, so two runs that found the same rules produce the same
        // key regardless of the order the checks happened to run in.
        ruleIds: [...new Set(findings.map((f) => f.ruleId))].sort(),
    };
}

/**
 * Two findings are the same finding when their rule identifiers match.
 *
 * Deliberately NOT keyed on file or line. D6 asks "did the fix produce the
 * identical warning?" - a fix that moves the same defect from lib/foo.js to
 * lib/bar.js has not converged, and keying on the location would read that as
 * progress. Location lives on the finding for the human; it is not the identity.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameFinding(a, b) {
    return Boolean(a && b && a.ruleId && a.ruleId === b.ruleId);
}

/**
 * Decision D6: does this verdict repeat a rule that already spawned a task?
 *
 * @param {object} verdict - From buildVerdict()
 * @param {string[]} priorRuleIds - Rule ids already spawned in this lineage
 * @returns {{ recurred: boolean, ruleIds: string[] }}
 */
function findRecurrence(verdict, priorRuleIds = []) {
    const prior = new Set(priorRuleIds);
    const ruleIds = (verdict?.ruleIds || []).filter((id) => prior.has(id));
    return { recurred: ruleIds.length > 0, ruleIds };
}

/**
 * Decision D5/D6 combined: what should happen to this finding next?
 *
 * Pure. Returns a recommendation; it spawns nothing and posts nothing.
 *
 * @param {object} options
 * @param {object} options.finding
 * @param {number} options.generation - Generation of the task being reviewed
 * @param {string[]} [options.priorRuleIds] - Rule ids already seen in this lineage
 * @returns {{ action: 'spawn'|'escalate', reason: string }}
 */
function nextAction({ finding, generation, priorRuleIds = [] }) {
    if (priorRuleIds.includes(finding.ruleId)) {
        return {
            action: 'escalate',
            reason: `${finding.ruleId} already produced a fix task in this lineage; a fix that ` +
                'produces the identical finding is not converging (D6)',
        };
    }
    if (generation >= MAX_GENERATION) {
        return {
            action: 'escalate',
            reason: `generation ${generation} is at the cap of ${MAX_GENERATION} (D5)`,
        };
    }
    return { action: 'spawn', reason: `generation ${generation} -> ${generation + 1}` };
}

/**
 * Produce the lineage a spawned task must carry, from a finding.
 *
 * This does NOT spawn a task and nothing in this repository calls it in
 * production. It exists so that the shape in SPAWNED_TASK_LINEAGE_FIELDS is
 * testable rather than described.
 *
 * @param {object} options
 * @param {object} options.finding
 * @param {string} options.originatingTaskId
 * @param {number} options.generation - Generation of the ORIGINATING task
 * @returns {object} Lineage carrying exactly SPAWNED_TASK_LINEAGE_FIELDS
 */
function describeSpawnedTask({ finding, originatingTaskId, generation }) {
    if (!finding || !RULES[finding.ruleId]) {
        throw new Error('[review-findings] describeSpawnedTask requires a finding with a known ruleId');
    }
    if (!originatingTaskId) {
        throw new Error('[review-findings] describeSpawnedTask requires originatingTaskId — lineage without it cannot be reconstructed');
    }
    return {
        originatingTaskId,
        ruleId: finding.ruleId,
        generation: generation + 1,
        findingRef: { file: finding.file, line: finding.line, severity: finding.severity },
    };
}

module.exports = {
    SEVERITY,
    RULES,
    VERDICT,
    MAX_GENERATION,
    SPAWNED_TASK_LINEAGE_FIELDS,
    makeFinding,
    renderFinding,
    buildVerdict,
    sameFinding,
    findRecurrence,
    nextAction,
    describeSpawnedTask,
};
