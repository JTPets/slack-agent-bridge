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
// bridge-agent.js still owns the finally block that gates cleanup on the delivery
// check (the "cleanup gating wiring" suite below asserts against it), so its source
// is still read here.
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

// LOGIC CHANGE 2026-09-14: detectUndeliveredWork moved to lib/clone-lifecycle.js
// (seam A). Its source-text lift now reads from the extracted module rather than
// bridge-agent.js, but the classification behaviour it exercises is unchanged.
const CLONE_LIFECYCLE_PATH = path.join(__dirname, '..', 'lib', 'clone-lifecycle.js');
const cloneLifecycleSource = fs.readFileSync(CLONE_LIFECYCLE_PATH, 'utf8');

/**
 * LOGIC CHANGE 2026-09-14: detectUndeliveredWork no longer builds shell command
 * strings — it calls execFileSync with an argv array (see the module header for why
 * the old "every argument is a literal or a SHA" justification did not hold). The
 * harness had to change with it, and the change is not cosmetic: it used to inject a
 * fake `execSync` and match on SUBSTRINGS OF A COMMAND STRING, which is the artifact
 * being removed. It now injects a fake `execFileSync` and matches on ARGV ARRAYS, so
 * these tests assert the shape the code actually produces.
 *
 * The function also closes over module-level `path` and `assertValidTargetDir` now,
 * so the source lift injects those too.
 */
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

const factory = (() => {
  const start = cloneLifecycleSource.indexOf('function detectUndeliveredWork(dir) {');
  expect(start).toBeGreaterThan(-1);
  const end = cloneLifecycleSource.indexOf('\n}\n', start) + 3;
  const body = cloneLifecycleSource.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(
    'execFileSync',
    'process',
    'assertValidTargetDir',
    'SHA_PATTERN',
    `${body}\nreturn detectUndeliveredWork;`
  );
})();

/**
 * Build a fake execFileSync that answers the git argv arrays detectUndeliveredWork
 * runs, driven by a scenario description.
 *
 * Every branch asserts the argv SHAPE it is answering, so a call that silently
 * changed into a shell string (or grew a quoted format value again) would not be
 * answered at all — it would fall through to the "unexpected git argv" throw.
 */
function makeExecFileSync(scenario) {
  return (bin, args) => {
    expect(bin).toBe('git');
    expect(Array.isArray(args)).toBe(true);
    // No argv element may be a whole command line: that is what a shell string
    // looks like after a regression.
    for (const a of args) {
      expect(typeof a).toBe('string');
      expect(a).not.toMatch(/^git\s/);
    }
    const joined = args.join(' ');

    if (joined === 'rev-parse --is-inside-work-tree') {
      if (!scenario.isRepo) throw new Error('not a git repository');
      return Buffer.from('true');
    }
    if (joined === 'status --porcelain') {
      if (scenario.statusThrows) throw new Error('status failed');
      return Buffer.from(scenario.status || '');
    }
    if (joined === 'rev-parse HEAD') return Buffer.from(scenario.head || '');
    if (args[0] === 'for-each-ref') {
      // The format arg must be the BARE value. The single quotes it used to carry
      // existed only to survive /bin/sh; with no shell git would emit them
      // literally and every SHA comparison would silently fail to match.
      expect(args).toEqual(['for-each-ref', '--format=%(objectname)', 'refs/heads']);
      return Buffer.from((scenario.branchTips || []).join('\n'));
    }
    if (args[0] === 'ls-remote') {
      if (scenario.remoteUnreachable) throw new Error('could not read from remote');
      return Buffer.from(
        (scenario.remote || []).map((s) => `${s}\trefs/heads/x`).join('\n')
      );
    }
    if (args[0] === 'log') {
      if (scenario.logThrows) throw new Error('log failed');
      expect(args).toContain('--not');
      expect(args).toContain('--remotes');
      // Revisions are hex-asserted before they become arguments.
      for (const a of args.slice(1)) {
        if (!a.startsWith('--')) expect(a).toMatch(/^[0-9a-f]{40}$/);
      }
      return Buffer.from(scenario.unpushed || '');
    }
    throw new Error('unexpected git argv in test: ' + JSON.stringify(args));
  };
}

function detectWith(scenario) {
  const detect = factory(
    makeExecFileSync(scenario),
    { env: {} },
    () => {},
    /^[0-9a-f]{40}$/
  );
  return detect('/fake/dir');
}

describe('detectUndeliveredWork', () => {
  test('clean clone with HEAD on the remote is delivered', () => {
    const result = detectWith({
      isRepo: true,
      status: '',
      head: SHA_A,
      branchTips: [SHA_A],
      remote: [SHA_A],
    });
    expect(result.undelivered).toBe(false);
  });

  test('uncommitted changes count as undelivered', () => {
    const result = detectWith({
      isRepo: true,
      status: ' M bridge-agent.js',
      head: SHA_A,
      branchTips: [SHA_A],
      remote: [SHA_A],
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
      head: SHA_B,
      branchTips: [SHA_B],
      remote: [SHA_A],
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
      head: SHA_B, // pushed feature branch tip
      branchTips: [SHA_B, SHA_A],
      remote: [SHA_A, SHA_B], // remote now has both
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
      head: SHA_B,
      branchTips: [SHA_B],
      remoteUnreachable: true,
      unpushed: `${SHA_B} local work`,
    });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/remote unreachable/i);
  });

  test('unreachable remote with no local commits still cleans up', () => {
    const result = detectWith({
      isRepo: true,
      status: '',
      head: SHA_A,
      branchTips: [SHA_A],
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

  // LOGIC CHANGE 2026-09-14: This test used to assert the OPPOSITE — that
  // `--format='%(objectname)'` carried single quotes, because execSync ran through
  // /bin/sh and unquoted parentheses were read as a subshell. With execFileSync
  // there is no shell, so those quotes would be passed to git as part of the format
  // string and it would emit literally-quoted SHAs, which match nothing on the
  // remote and silently degrade every clone to "delivery status unknown". The
  // assertion flips in the same change as the fix, and it previously encoded the
  // shell-string behaviour that was the defect.
  //
  // Asserted BEHAVIOURALLY, on the argv that actually reaches git, not by grepping
  // the source: the old source-text form matched this file's own comment about the
  // quotes it was checking for, which is the precise way a text-scanning guard goes
  // blind. makeExecFileSync's `toEqual` runs this check on every scenario; this test
  // makes the single claim explicit and fails on its own.
  test('the for-each-ref format reaches git as a bare value (there is no shell)', () => {
    const seen = [];
    const detect = factory(
      (bin, args) => {
        seen.push(args);
        if (args[0] === 'for-each-ref') return Buffer.from(SHA_A);
        if (args[0] === 'ls-remote') return Buffer.from(`${SHA_A}\trefs/heads/main`);
        if (args[1] === '--is-inside-work-tree') return Buffer.from('true');
        if (args[0] === 'status') return Buffer.from('');
        return Buffer.from(SHA_A);
      },
      { env: {} },
      () => {},
      /^[0-9a-f]{40}$/
    );
    detect('/fake/dir');

    const forEachRef = seen.find((a) => a[0] === 'for-each-ref');
    expect(forEachRef).toEqual(['for-each-ref', '--format=%(objectname)', 'refs/heads']);
    // Not "--format='%(objectname)'": with no shell those quotes would be part of
    // the format and git would emit literally-quoted SHAs, matching nothing on the
    // remote and degrading every clone to "delivery status unknown".
    expect(forEachRef[1]).not.toContain("'");
  });

  test('an object name that is not a 40-hex SHA is never passed back to git', () => {
    // "it came from git" was an assumption, not a check, and it was the load-bearing
    // half of the old header's argument that a shell was safe here. If git returns
    // something unexpected, preserve the clone rather than use it as an argument.
    const result = detectWith({
      isRepo: true,
      status: '',
      head: '--not-a-sha',
      branchTips: ['--not-a-sha'],
      remoteUnreachable: true,
    });
    expect(result.undelivered).toBe(true);
    expect(result.reason).toMatch(/unreadable/i);
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
