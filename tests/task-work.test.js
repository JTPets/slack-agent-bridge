'use strict';

/**
 * tests/task-work.test.js
 *
 * WORK-TODO #39, the recording half: lib/task-work.js against REAL git repositories
 * (a bare origin and a clone of it, in temp dirs), TaskQueue.recordWork() against a
 * real queue file, and the bridge-agent.js wiring read from its source.
 *
 * The property that matters most is that recording work cannot disturb the delivery
 * invariant (#74): recordWork writes `work` and nothing else, so a terminal row's
 * status and verdict are byte-identical before and after.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { headSha, describeWork, formatWork } = require('../lib/task-work');
const { TaskQueue, STATUS } = require('../lib/task-queue');

const git = (cwd, args) => execFileSync('git', args, {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
}).toString().trim();

let root;
let origin;
let clone;

function commit(dir, name) {
  fs.writeFileSync(path.join(dir, name), name);
  git(dir, ['add', name]);
  git(dir, ['commit', '-q', '-m', name]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-work-'));
  origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(root, ['init', '-q', '-b', 'main', seed]);
  commit(seed, 'a.txt');
  git(seed, ['push', '-q', origin, 'main']);
  clone = path.join(root, 'clone');
  git(root, ['clone', '-q', '--single-branch', '--branch', 'main', origin, clone]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('describeWork against real repositories', () => {
  test('a clone the task did not change: no new commits, on the remote as main', () => {
    const base = headSha(clone);
    const work = describeWork(clone, base);
    expect(work.branch).toBe('main');
    expect(work.head).toBe(base);
    expect(work.newCommits).toBe(0);
    expect(work.onRemote).toBe(true);
    expect(work.remoteRefs).toEqual(['refs/heads/main']);
    expect(work.note).toBeNull();
  });

  test('a committed, UNPUSHED branch is recorded as not on the remote', () => {
    const base = headSha(clone);
    git(clone, ['checkout', '-q', '-b', 'feature/x']);
    commit(clone, 'b.txt');
    commit(clone, 'c.txt');
    const work = describeWork(clone, base);
    expect(work.branch).toBe('feature/x');
    expect(work.newCommits).toBe(2);
    expect(work.onRemote).toBe(false);
    expect(work.remoteRefs).toEqual([]);
  });

  test('a PUSHED feature branch is found by asking the remote, though the clone has no origin/feature ref', () => {
    const base = headSha(clone);
    git(clone, ['checkout', '-q', '-b', 'feature/y']);
    commit(clone, 'b.txt');
    git(clone, ['push', '-q', 'origin', 'feature/y']);
    // --single-branch: the push creates no local tracking ref, which is exactly why
    // a local-only check would read this as unpushed.
    expect(() => git(clone, ['rev-parse', '--verify', 'refs/remotes/origin/feature/y'])).toThrow();
    const work = describeWork(clone, base);
    expect(work.onRemote).toBe(true);
    expect(work.remoteRefs).toEqual(['refs/heads/feature/y']);
    expect(work.newCommits).toBe(1);
  });

  test('an unreachable remote is "not checked" (null), never "not on the remote"', () => {
    const base = headSha(clone);
    git(clone, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);
    const work = describeWork(clone, base);
    expect(work.onRemote).toBeNull();
    expect(work.note).toMatch(/remote unreachable/);
  });

  test('no base sha: the count is unknown rather than zero', () => {
    const work = describeWork(clone, null);
    expect(work.newCommits).toBeNull();
    expect(describeWork(clone, 'not-a-sha').baseSha).toBeNull();
  });

  test('a directory that is not a repository records an unreadable head and does not throw', () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    const work = describeWork(empty, null);
    expect(work.head).toBeNull();
    expect(work.note).toMatch(/unreadable/);
  });
});

describe('formatWork', () => {
  const head = 'a'.repeat(40);
  test('names the branch, short sha, commit count and remote state', () => {
    expect(formatWork({ branch: 'feature/x', head, newCommits: 2, onRemote: true, remoteRefs: ['refs/heads/feature/x'] }))
      .toBe(' — `feature/x` @ `aaaaaaa`, 2 new commit(s), on remote as feature/x');
    expect(formatWork({ branch: 'feature/x', head, newCommits: 1, onRemote: false, remoteRefs: [] }))
      .toMatch(/NOT on the remote/);
    expect(formatWork({ branch: null, head, newCommits: null, onRemote: null, remoteRefs: [] }))
      .toMatch(/detached.*remote not checked/);
  });
  test('a row with no record renders nothing', () => {
    expect(formatWork(null)).toBe('');
    expect(formatWork(undefined)).toBe('');
  });
});

describe('TaskQueue.recordWork', () => {
  let q;
  beforeEach(() => {
    q = new TaskQueue(path.join(root, 'task-queue.json'));
  });

  const enqueue = () => q.enqueue({ msgTs: '1.1', channelId: 'C0FIX', text: 'TASK: x', description: 'x', repo: 'o/r' });

  test('writes the work field and leaves status and the delivery verdict untouched', () => {
    const t = enqueue();
    q.markRunning(t.id);
    q.complete(t.id, 'ok', { delivered: true, detail: 'posted' });
    const before = q._load().find(r => r.id === t.id);
    const work = { branch: 'feature/x', head: 'b'.repeat(40), newCommits: 1, onRemote: true, remoteRefs: ['refs/heads/feature/x'] };
    expect(q.recordWork(t.id, work)).toBe(true);
    const after = q._load().find(r => r.id === t.id);
    expect(after.work).toEqual(work);
    const { work: _w1, ...restAfter } = after;
    const { work: _w2, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    expect(after.status).toBe(STATUS.COMPLETED);
    expect(after.delivery.delivered).toBe(true);
  });

  test('a new row starts with work: null, and a re-attempt clears the previous record', () => {
    const t = enqueue();
    expect(q._load().find(r => r.id === t.id).work).toBeNull();
    q.markRunning(t.id);
    q.complete(t.id, 'ok', { delivered: true });
    q.recordWork(t.id, { branch: 'b', head: 'c'.repeat(40) });
    q.markRunning(t.id);
    expect(q._load().find(r => r.id === t.id).work).toBeNull();
  });

  test('an unknown id writes nothing and says so', () => {
    expect(q.recordWork('nope', { head: 'd'.repeat(40) })).toBe(false);
  });
});

describe('the bridge-agent.js wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');

  test('the base sha is captured right after the clone', () => {
    const at = src.indexOf('cloneRepo(task.repo, task.branch, taskDir);');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 400)).toMatch(/taskBaseSha = headSha\(taskDir\)/);
  });

  test('the work is recorded BEFORE the clone can be cleaned up', () => {
    expect(src).toMatch(/recordWork\(queueId, describeWork\(taskDir, baseSha\)\)/);
    const record = src.indexOf('await recordTaskWork(queueId, taskDir, taskBaseSha, task.description)');
    const detect = src.indexOf('const delivery = detectUndeliveredWork(taskDir);');
    const cleanup = src.indexOf('cleanupDir(taskDir);');
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(detect);
    expect(record).toBeLessThan(cleanup);
  });

  test('the status reply renders each recent row with its work', () => {
    const fn = src.slice(src.indexOf('function formatStatusResponse()'));
    expect(fn.slice(0, 4000)).toMatch(/formatWork\(task\.work\)/);
  });
});
