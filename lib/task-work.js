'use strict';

/**
 * lib/task-work.js
 *
 * WORK-TODO #39, the recording half: what a finished repo task left behind, as facts
 * a later reader can check — the branch the clone ended on, its head commit, how many
 * commits the task added, and which refs on the REMOTE carry that commit.
 *
 * LOGIC CHANGE 2026-10-04: before this, a queue row said `completed` and nothing else,
 * so "the agent stopped", "the agent pushed a branch" and "the agent committed and
 * never pushed" read identically in `ASK: what's queued`. processTask now captures the
 * clone's HEAD right after cloning (baseSha) and, at the end, records describeWork()
 * on the queue row via TaskQueue.recordWork().
 *
 * What this does NOT answer: whether the branch MERGED. That needs the remote's view
 * of `main` against this sha over time, and is the open half of #39. "on the remote"
 * here means a remote ref's tip IS the head commit, nothing more.
 *
 * Asked of the remote, never the clone: scratch clones are `--single-branch`, so a
 * pushed feature branch has no local origin/* ref (see detectUndeliveredWork).
 * Every git call is execFileSync with an argv array; revisions are hex-asserted
 * because `git rev-list` reads `--` as the start of a pathspec.
 */

const { execFileSync } = require('child_process');
const { assertValidTargetDir, SHA_PATTERN } = require('./clone-lifecycle');

function gitIn(dir, args, timeout = 15000) {
  return execFileSync('git', args, {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    timeout,
  }).toString().trim();
}

/** The clone's HEAD commit, or null when it cannot be read as an object name. */
function headSha(dir) {
  assertValidTargetDir(dir);
  try {
    const sha = gitIn(dir, ['rev-parse', 'HEAD']);
    return SHA_PATTERN.test(sha) ? sha : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {string} dir      the scratch clone
 * @param {string|null} baseSha  HEAD as cloned (headSha() right after cloneRepo)
 * @returns {{ branch, head, baseSha, newCommits, remoteRefs, onRemote, checkedAt, note }}
 *   onRemote is true / false, or null when the remote could not be asked. newCommits
 *   is null when there is no base to count from. Never throws.
 */
function describeWork(dir, baseSha) {
  const work = {
    branch: null,
    head: null,
    baseSha: baseSha && SHA_PATTERN.test(baseSha) ? baseSha : null,
    newCommits: null,
    remoteRefs: [],
    onRemote: null,
    checkedAt: new Date().toISOString(),
    note: null,
  };
  const notes = [];

  work.head = headSha(dir);
  if (!work.head) {
    work.note = 'head commit unreadable';
    return work;
  }
  try {
    const branch = gitIn(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    work.branch = branch === 'HEAD' ? null : branch;
    if (!work.branch) notes.push('detached HEAD');
  } catch (e) {
    notes.push(`branch unreadable: ${e.message.split('\n')[0]}`);
  }

  if (work.baseSha) {
    try {
      const count = parseInt(gitIn(dir, ['rev-list', '--count', `${work.baseSha}..${work.head}`]), 10);
      work.newCommits = Number.isFinite(count) ? count : null;
    } catch (e) {
      notes.push(`commit count unreadable: ${e.message.split('\n')[0]}`);
    }
  }

  try {
    const lines = gitIn(dir, ['ls-remote', '--', 'origin'], 30000).split('\n');
    work.remoteRefs = lines
      .map((line) => line.split(/\s+/))
      .filter(([sha, ref]) => sha === work.head && ref && ref.startsWith('refs/heads/'))
      .map(([, ref]) => ref);
    work.onRemote = work.remoteRefs.length > 0;
  } catch (e) {
    notes.push(`remote unreachable: ${e.message.split('\n')[0]}`);
  }

  work.note = notes.length ? notes.join('; ') : null;
  return work;
}

/** One status-line fragment, or '' for a row with no work record. */
function formatWork(work) {
  if (!work || typeof work !== 'object') return '';
  if (!work.head) return ` — work: ${work.note || 'not recorded'}`;
  const parts = [`\`${work.branch || 'detached'}\` @ \`${work.head.slice(0, 7)}\``];
  if (work.newCommits === 0) parts.push('no new commits');
  else if (work.newCommits > 0) parts.push(`${work.newCommits} new commit(s)`);
  if (work.onRemote === true) {
    parts.push(`on remote as ${work.remoteRefs.map((r) => r.replace('refs/heads/', '')).join(', ')}`);
  } else if (work.onRemote === false) {
    parts.push('NOT on the remote');
  } else {
    parts.push('remote not checked');
  }
  return ` — ${parts.join(', ')}`;
}

module.exports = { headSha, describeWork, formatWork };
