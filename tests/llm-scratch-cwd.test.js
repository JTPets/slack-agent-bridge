'use strict';

/**
 * tests/llm-scratch-cwd.test.js
 *
 * WORK-TODO #82: no model run is started in WORK_DIR. A task with no REPO: and every
 * ASK: answer used to run there, and WORK_DIR holds every scratch and preserved clone,
 * the update-gate checkout, the task queue and the HIGH notices; a read-only agent is
 * confined to its cwd, so that tree was what it could read. Two halves: THE enumerating
 * guard over every production file (no runLLM / runWithFallback call passes
 * `cwd: WORK_DIR`), and the two bridge-agent.js sites, read from source, making their
 * own empty directory and removing it in a finally.
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, stripComments } = require('./helpers/source-scan');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

/** Line numbers of runLLM/runWithFallback calls whose options name WORK_DIR as cwd. */
function workDirRuns(src) {
  const code = stripComments(src, { blankStrings: false });
  const hits = [];
  const re = /\b(runLLM|runWithFallback)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')' && --depth === 0) break;
    }
    if (/\bcwd\s*:\s*(WORK_DIR|workDir|config\.WORK_DIR|process\.env\.WORK_DIR)\b/.test(code.slice(m.index, i + 1))) {
      hits.push(code.slice(0, m.index).split('\n').length);
    }
  }
  return hits;
}

describe('no model run starts in WORK_DIR', () => {
  test('every production file, enumerated from disk', () => {
    const offenders = [];
    for (const f of listSourceFiles()) {
      for (const line of workDirRuns(fs.readFileSync(f, 'utf8'))) offenders.push(`${f}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  test('negative control: the pre-#82 conversation call is caught, a temp dir is not', () => {
    expect(workDirRuns('const r = await runWithFallback(prompt, {\n  cwd: WORK_DIR,\n  maxTurns,\n});')).toEqual([1]);
    expect(workDirRuns('await runLLM(p, { cwd: askCwd, maxTurns: 1 });')).toEqual([]);
  });

  test('a task with no repo gets its own empty directory, removed in the finally', () => {
    // LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): made by lib/task-workspace.js
    // prepareWorkspace, removed by its cleanupWorkspace from processTask's finally.
    const { functionBody, hubBody, spokeSource } = require('./helpers/task-path-sources');
    const ws = spokeSource('task-workspace');
    const prepare = functionBody(ws, 'prepareWorkspace');
    const make = prepare.indexOf("run.scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-task-'));");
    expect(make).toBeGreaterThan(0);
    expect(prepare.slice(make - 200, make)).toContain('if (!task.repo) {');
    expect(functionBody(ws, 'cleanupWorkspace')).toContain('fs.rmSync(run.scratchCwd, { recursive: true, force: true });');
    const hub = hubBody(SRC);
    expect(hub.indexOf('await cleanupWorkspace(run, deps);')).toBeGreaterThan(hub.indexOf('\n  } finally {'));
  });

  test('an ASK: answer runs in its own directory, removed whatever the run does', () => {
    const at = SRC.indexOf("const askCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ask-'));");
    expect(at).toBeGreaterThan(0);
    const after = SRC.slice(at, at + 1500);
    expect(after).toMatch(/try \{\s*result = await runWithFallback\(prompt, \{\s*cwd: askCwd,/);
    expect(after).toMatch(/\} finally \{\s*try \{\s*fs\.rmSync\(askCwd, \{ recursive: true, force: true \}\);/);
  });
});
