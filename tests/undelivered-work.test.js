/**
 * tests/undelivered-work.test.js
 *
 * Regression tests for the 2026-09-13 "cleanup deletes undelivered work" defect.
 *
 * What broke: processTask's finally block deleted the scratch clone
 * unconditionally. When the clone was READ-ONLY (or a push otherwise never
 * happened), the agent's commits lived only in that clone — and cleanup erased
 * them. Three tasks committed locally and were lost this way (see cloneRepo).
 *
 * The fix: cleanup now gates on detectUndeliveredWork(dir). A clone is only
 * deleted once its work has been DELIVERED (pushed to the remote); otherwise it
 * is preserved and #sqtools-ops is alerted.
 *
 * These tests pin two things:
 *   1. detectUndeliveredWork correctly classifies delivered vs undelivered work,
 *      including the single-branch-refspec case that a naive `git log
 *      --not --remotes` check gets wrong.
 *   2. The finally block actually gates cleanupDir on it — a check nobody
 *      consults is the same data-loss defect wearing a function name.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BRIDGE_AGENT_PATH = path.join(__dirname, '..', 'bridge-agent.js');
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

/**
 * detectUndeliveredWork is defined inside bridge-agent.js, which exports nothing
 * and starts a poll loop on require. Lift the function out by source text and
 * evaluate it against an injected execSync so its real branching logic runs.
 */
const factory = (() => {
  const start = source.indexOf('function detectUndeliveredWork(dir) {');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', start) + 3;
  const body = source.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('execSync', 'process', `${body}\nreturn detectUndeliveredWork;`);
})();

/**
 * Build a fake execSync that answers the git commands detectUndeliveredWork runs,
 * driven by a scenario description.
 */
function makeExecSync(scenario) {
  return (cmd) => {
    if (cmd.includes('rev-parse --is-inside-work-tree')) {
      if (!scenario.isRepo) throw new Error('not a git repository');
      return 'true';
    }
    if (cmd.includes('status --porcelain')) {
      if (scenario.statusThrows) throw new Error('status failed');
      return scenario.status || '';
    }
    if (cmd.includes('rev-parse HEAD')) return scenario.head || '';
    if (cmd.includes('for-each-ref')) return (scenario.branchTips || []).join('\n');
    if (cmd.includes('ls-remote')) {
      if (scenario.remoteUnreachable) throw new Error('could not read from remote');
      return (scenario.remote || []).map((s) => `${s}\trefs/heads/x`).join('\n');
    }
    if (cmd.includes('log') && cmd.includes('--not --remotes')) {
      if (scenario.logThrows) throw new Error('log failed');
      return scenario.unpushed || '';
    }
    throw new Error('unexpected git command in test: ' + cmd);
  };
}

function detectWith(scenario) {
  const detect = factory(makeExecSync(scenario), { env: {} });
  return detect('/fake/dir');
}

describe('detectUndeliveredWork', () => {
  test('clean clone with HEAD on the remote is delivered', () => {
    const result = detectWith({
      isRepo: true,
      status: '',
      head: 'AAA',
      branchTips: ['AAA'],
      remote: ['AAA'],
    });
    expect(result.undelivered).toBe(false);
  });

  test('uncommitted changes count as undelivered', () => {
    const result = detectWith({
      isRepo: true,
      status: ' M bridge-agent.js',
      head: 'AAA',
      branchTips: ['AAA'],
      remote: ['AAA'],
    });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/uncommitted/i);
  });

  test('a local commit not on the remote is undelivered (the lost-work case)', () => {
    // Agent committed locally but the push never landed: HEAD is a new SHA the
    // remote has never seen. This is exactly the scenario that lost three tasks.
    const result = detectWith({
      isRepo: true,
      status: '',
      head: 'BBB',
      branchTips: ['BBB'],
      remote: ['AAA'],
    });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/not found on the remote/i);
  });

  test('work pushed to a new feature branch is delivered (single-branch refspec case)', () => {
    // The clone tracks only origin/<branch>, so a pushed feature branch never
    // gets a local origin/feature ref. ls-remote still reports the tip SHA, so
    // tip-matching sees it as delivered — where `git log --not --remotes` would
    // wrongly flag it as undelivered.
    const result = detectWith({
      isRepo: true,
      status: '',
      head: 'BBB', // pushed feature branch tip
      branchTips: ['BBB', 'AAA'],
      remote: ['AAA', 'BBB'], // remote now has both
    });
    expect(result.undelivered).toBe(false);
  });

  test('a directory that is not a git repo has nothing to lose', () => {
    const result = detectWith({ isRepo: false });
    expect(result.undelivered).toBe(false);
  });

  test('unreachable remote with local commits preserves (conservative)', () => {
    const result = detectWith({
      isRepo: true,
      status: '',
      head: 'BBB',
      branchTips: ['BBB'],
      remoteUnreachable: true,
      unpushed: 'BBB local work',
    });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/remote unreachable/i);
  });

  test('unreachable remote with no local commits still cleans up', () => {
    const result = detectWith({
      isRepo: true,
      status: '',
      head: 'AAA',
      branchTips: ['AAA'],
      remoteUnreachable: true,
      unpushed: '',
    });
    expect(result.undelivered).toBe(false);
  });

  test('unreadable git status errs toward preserving', () => {
    const result = detectWith({ isRepo: true, statusThrows: true });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/unknown/i);
  });

  test('the for-each-ref format is shell-quoted', () => {
    // execSync runs through /bin/sh; an unquoted %(objectname) makes sh treat the
    // parentheses as a subshell and the command fails, silently degrading every
    // check to "delivery status unknown". Quoting is load-bearing, not cosmetic.
    expect(source).toMatch(/for-each-ref --format='%\(objectname\)' refs\/heads/);
    expect(source).not.toMatch(/for-each-ref --format=%\(objectname\) refs\/heads/);
  });
});

describe('cleanup gating wiring', () => {
  test('the finally block consults detectUndeliveredWork before cleanupDir', () => {
    // A delivery check nobody calls is the same silent data-loss defect.
    const finallyIdx = source.indexOf('await heartbeat.stop(taskSuccess);');
    expect(finallyIdx).toBeGreaterThan(-1);
    const region = source.slice(finallyIdx, finallyIdx + 2000);
    const checkIdx = region.indexOf('detectUndeliveredWork(taskDir)');
    const cleanupIdx = region.indexOf('cleanupDir(taskDir)');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(-1);
    // cleanup must come after (i.e. be gated by) the delivery check.
    expect(checkIdx).toBeLessThan(cleanupIdx);
  });

  test('undelivered clones are preserved, not cleaned up', () => {
    const finallyIdx = source.indexOf('await heartbeat.stop(taskSuccess);');
    const region = source.slice(finallyIdx, finallyIdx + 2000);
    // The preservation branch alerts ops and does NOT call cleanupDir.
    expect(region).toMatch(/Scratch clone preserved/);
    expect(region).toMatch(/if \(delivery\.undelivered\)/);
  });
});
