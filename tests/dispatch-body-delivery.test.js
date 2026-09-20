/**
 * tests/dispatch-body-delivery.test.js
 *
 * THE regression guard for the 2026-09-20 "dispatch body never reached the executor"
 * failure. A dispatch was sent whose body was a numbered list of six items with file
 * paths, leads and a definition of done; the executor received only the one-line
 * `TASK:` description and correctly reported that it had been handed no payload.
 *
 * The loss was in `parseTask`. `TASK:`/`REPO:`/`BRANCH:`/`TURNS:`/`SKILL:` each capture
 * the remainder of their OWN LINE only; `INSTRUCTIONS:` is the one label whose capture
 * is multiline. A body written without an `INSTRUCTIONS:` label therefore parsed to
 * `instructions: ''` with `errors: []` — nothing rejected, nothing reported — and the
 * prompt builders fell back to `task.instructions || task.description`
 * (lib/code-review-pipeline.js:302, bridge-agent.js:684/693-694), so the one-line
 * description was the whole payload.
 *
 * Two halves are pinned here, because either alone is insufficient:
 *
 *   1. The SILENCE is the defect, not the truncation. `errors` must be non-empty, so
 *      `processTask` (bridge-agent.js:561) refuses the task and posts the reason to
 *      Slack instead of running an amputated prompt.
 *   2. The END-TO-END path must actually deliver. A sentinel string in a well-formed
 *      body is followed from the raw Slack message text, through `parseTask` and
 *      `buildPrompt`, to the bytes `runClaudeAdapter` writes on the child's stdin —
 *      spawning a REAL process against a stub binary, because a mocked child_process
 *      accepts any payload and proves nothing about delivery (the same reason
 *      tests/llm-runner-prompt-size.test.js spawns for real).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseTask, findUnclaimedLines } = require('../lib/task-parser');
const { buildPrompt } = require('../lib/code-review-pipeline');
const { runClaudeAdapter } = require('../lib/llm-runner');

const SENTINEL = 'PROBE-SENTINEL-7f3a9c2e-BODY-ARRIVED';

const EMPTY_CONTEXT = {
  claudeMdRules: '',
  repoStructure: '',
  relevantFiles: {},
  gitLog: '',
  commandmentsContent: '',
};
const PLAN = { skip: false, testScript: 'npm test' };

/** The observed dispatch shape: a TASK: one-liner, then body, no INSTRUCTIONS: label. */
const BODY_WITHOUT_LABEL = `REPO: jtpets/slack-agent-bridge
TURNS: 100

TASK: probe the dispatch body path
Echo the sentinel below verbatim.

${SENTINEL}
`;

/** The identical body with the label the parser requires. */
const BODY_WITH_LABEL = `REPO: jtpets/slack-agent-bridge
TURNS: 100

TASK: probe the dispatch body path
INSTRUCTIONS: Echo the sentinel below verbatim.

${SENTINEL}
`;

/**
 * Spawn for real against a stub that copies stdin to stdout, and return exactly what
 * the child received. `runClaudeAdapter` resolves with the child's stdout, so the
 * resolved value IS the delivered prompt.
 */
async function deliverToCli(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-body-probe-'));
  try {
    const bin = path.join(dir, 'claude-stub');
    fs.writeFileSync(bin, '#!/bin/sh\ncat\n');
    fs.chmodSync(bin, 0o755);
    const result = await runClaudeAdapter(prompt, {
      claudeBin: bin,
      cwd: dir,
      maxTurns: 5,
      timeout: 20000,
    });
    return result.output;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('a dispatch body with no INSTRUCTIONS: label is refused, not silently dropped', () => {
  test('the observed shape is reported instead of parsing clean', () => {
    const task = parseTask(BODY_WITHOUT_LABEL);

    // Without the fix this array is EMPTY - that silence is the whole defect.
    expect(task.errors.length).toBeGreaterThan(0);
    const message = task.errors.find((e) => e.includes('INSTRUCTIONS: label is missing'));
    expect(message).toBeDefined();
    // The operator must be able to act on it: it names how much was lost, where the
    // first lost line was, and the remedy.
    expect(message).toContain('2 line(s)');
    expect(message).toContain('line 5');
    expect(message).toContain('Echo the sentinel below verbatim.');
    expect(message).toContain('INSTRUCTIONS:');
  });

  test('the other fields still parse, so the report names the body and nothing else', () => {
    const task = parseTask(BODY_WITHOUT_LABEL);
    expect(task.description).toBe('probe the dispatch body path');
    expect(task.repo).toBe('jtpets/slack-agent-bridge');
    expect(task.turns).toBe(100);
    expect(task.errors).toHaveLength(1);
  });

  test('a bare one-line TASK: with no body is UNAFFECTED', () => {
    // The description-fallback is deliberate and still used; this must not start
    // refusing tasks that never had a body to lose.
    const task = parseTask('TASK: run the nightly audit');
    expect(task.errors).toEqual([]);
    expect(task.description).toBe('run the nightly audit');
  });

  test('a header-only message with no body line is UNAFFECTED', () => {
    const task = parseTask('TASK: t\nREPO: jtpets/slack-agent-bridge\nBRANCH: main\nTURNS: 50');
    expect(task.errors).toEqual([]);
  });

  test('a Slack banner ABOVE the header block is not reported', () => {
    // lib/security-followup.js:205 opens its message with a banner line before TASK:.
    // That is presentation, not a dropped body, and tests/integration.test.js asserts
    // that generator parses with no rejected fields.
    const task = parseTask(
      ':warning: *Security Remediation Required*\n\nTASK: t\nREPO: jtpets/x\nINSTRUCTIONS: go'
    );
    expect(task.errors).toEqual([]);
  });
});

describe('findUnclaimedLines — the claim rule itself', () => {
  test('INSTRUCTIONS: claims every line after it, including field-label-shaped ones', () => {
    expect(
      findUnclaimedLines('TASK: t\nINSTRUCTIONS: go\nthis is body\nso is this\nREPO: not-a-field')
    ).toEqual([]);
  });

  test('blank lines carry nothing and are never reported', () => {
    expect(findUnclaimedLines('TASK: t\n\n\n\n')).toEqual([]);
  });

  test('single-line labels claim their own line only', () => {
    expect(findUnclaimedLines('TASK: t\nREPO: jtpets/x\nstray')).toEqual([
      { line: 3, text: 'stray' },
    ]);
  });

  test('a lowercase label line is treated as claimed, so matchField owns that report', () => {
    // Otherwise `repo: x` yields two overlapping errors for one mistake.
    expect(findUnclaimedLines('TASK: t\nrepo: jtpets/x')).toEqual([]);
    expect(
      parseTask('TASK: t\nrepo: jtpets/x').errors.filter((e) => e.includes('INSTRUCTIONS'))
    ).toEqual([]);
  });

  test('reports every dropped line, with 1-based line numbers', () => {
    expect(findUnclaimedLines('TASK: t\nalpha\n\nbeta')).toEqual([
      { line: 2, text: 'alpha' },
      { line: 4, text: 'beta' },
    ]);
  });
});

describe('end-to-end: a sentinel in the body reaches the CLI on stdin', () => {
  test('a well-formed body delivers every byte to the spawned process', async () => {
    const task = parseTask(BODY_WITH_LABEL);
    expect(task.errors).toEqual([]);

    const prompt = buildPrompt(task, EMPTY_CONTEXT, PLAN, {
      repoRef: 'jtpets/slack-agent-bridge (branch: main)',
    });
    expect(prompt).toContain(SENTINEL);

    const delivered = await deliverToCli(prompt);
    expect(delivered).toContain(SENTINEL);
    // Not merely "contains": the child received the prompt in full.
    expect(delivered).toBe(prompt);
  }, 30000);

  test('the unlabelled body never reaches the prompt — the loss is at the parser hop', async () => {
    const task = parseTask(BODY_WITHOUT_LABEL);
    const prompt = buildPrompt(task, EMPTY_CONTEXT, PLAN, {
      repoRef: 'jtpets/slack-agent-bridge (branch: main)',
    });

    // This is the failure being guarded, pinned so the hop cannot be misattributed to
    // the transport: buildPrompt is where the body is already gone, and the stdin
    // delivery below is faithful to whatever it is handed.
    expect(prompt).not.toContain(SENTINEL);
    expect(prompt).toContain('probe the dispatch body path');

    const delivered = await deliverToCli(prompt);
    expect(delivered).toBe(prompt);
    expect(delivered).not.toContain(SENTINEL);
  }, 30000);
});
