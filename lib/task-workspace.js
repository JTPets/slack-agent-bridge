'use strict';

/**
 * lib/task-workspace.js
 *
 * WORK-TODO #10, B36 (2026-11-25): where a task runs, from creation to removal, moved
 * out of bridge-agent.js processTask. Both halves live here so the directory a task
 * makes and the directory it removes are read in one place.
 *
 *   prepareWorkspace  an empty temp dir for a task with no REPO:, or a scratch clone
 *                     with its own dependencies installed
 *   readTaskWork      what the clone holds, for the result card
 *   cleanupWorkspace  record the clone's work, keep an undelivered clone (and say so),
 *                     remove a delivered one, remove the empty temp dir
 *
 * Every function takes the task's `run` record (built by processTask) and writes the
 * paths it creates onto it, so the hub's finally can clean up whatever got made.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const taskQueue = require('./task-queue');
const { cloneRepo, cleanupDir, detectUndeliveredWork } = require('./clone-lifecycle');
const { headSha, describeWork } = require('./task-work');
const { installDependencies } = require('./dependency-install');
const { formatPreservedCloneAlert } = require('./preserved-clone-alert');

/**
 * Make the directory the task runs in, and return it as the cwd.
 *
 * @param {object} run - processTask's run record ({ task, msg, sourceLink })
 * @param {object} deps - { workDir, postToOps }
 * @returns {Promise<string>} the cwd
 * @throws on a clone failure or a HARNESS (install) failure
 */
async function prepareWorkspace(run, deps) {
  const { task, msg } = run;

  // LOGIC CHANGE 2026-11-25 (WORK-TODO #82): a task with no REPO: runs in an empty
  // directory of its own, removed by cleanupWorkspace. It used to run in WORK_DIR, which
  // holds every scratch and preserved clone, the update-gate checkout, the task queue and
  // the HIGH notices: a read-only agent was confined to that tree and read it.
  if (!task.repo) {
    run.scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-task-'));
    return run.scratchCwd;
  }

  // Clone into a unique temp dir
  const taskDir = path.join(deps.workDir, `task-${msg.ts.replace('.', '-')}`);
  run.taskDir = taskDir;
  cloneRepo(task.repo, task.branch, taskDir);
  // LOGIC CHANGE 2026-10-04 (WORK-TODO #39): HEAD as cloned, so the work record can
  // count the commits this task added.
  run.taskBaseSha = headSha(taskDir);

  // LOGIC CHANGE 2026-09-20 (WORK-TODO #61): install the clone's dependencies BEFORE the
  // LLM runs, so Phase 3's test gate is real (no node_modules = `jest: not found` =
  // runner_absent, every time). Fail-hard by decision: an agent that cannot install can
  // still write a branch it cannot verify. A HARNESS failure (the bridge is broken) is
  // reported apart from a test failure (the branch is broken) and never collapsed into
  // one. A repo with no recognised manifest installs nothing and proceeds.
  const install = installDependencies(taskDir);
  if (install.harnessFailure) {
    await deps.postToOps(
      `:rotating_light: *Dispatch stopped — HARNESS failure (install), not a code failure.*\n` +
      `Task: ${task.description}\n` +
      `Repo: ${task.repo} (branch: ${task.branch}) — ecosystem: \`${install.ecosystem}\`\n` +
      `Outcome: \`${install.outcome}\`\n${install.reason}\n` +
      `No branch was produced: the bridge could not prepare the clone, so nothing was verified.\n` +
      `\`\`\`\n${(install.output || '').trim().slice(-1200)}\n\`\`\`\n` +
      `Source: ${run.sourceLink}`
    ).catch(postErr => {
      console.error('[bridge-agent] Could not post install-harness failure:', postErr.message);
    });
    throw new Error(`HARNESS FAILURE — dependency install: ${install.reason}`);
  }
  if (install.ran) {
    console.log(`[bridge-agent] Installed ${install.ecosystem} dependencies (${install.command})`);
  } else {
    console.log(`[bridge-agent] No dependency install: ${install.reason}`);
  }
  return taskDir;
}

/**
 * The work a clone holds, for the result card (lib/task-work.js). Never throws: a work
 * record that cannot be read is a card without it, never a task that cannot report.
 */
function readTaskWork(taskDir, baseSha) {
  if (!taskDir || !fs.existsSync(taskDir)) return null;
  try {
    return describeWork(taskDir, baseSha);
  } catch (workErr) {
    console.error('[bridge-agent] Could not read the task work for its result:', workErr.message);
    return null;
  }
}

/**
 * LOGIC CHANGE 2026-10-04 (WORK-TODO #39): record the branch, head commit and remote refs
 * a repo task left behind on its queue row. Writes only the row's `work` field, never a
 * status or a delivery verdict, so the #74 invariant is untouched. A failure is reported
 * to ops, never fatal to the task.
 */
async function recordTaskWork(queueId, taskDir, baseSha, description, postToOps) {
  try {
    taskQueue.getQueue().recordWork(queueId, describeWork(taskDir, baseSha));
  } catch (workErr) {
    console.error('[bridge-agent] Failed to record task work:', workErr.message);
    await postToOps(
      `:warning: Could not record which branch and commit "${description}" left behind: ${workErr.message}. ASK: what's queued will not show it.`
    );
  }
}

/**
 * Remove what prepareWorkspace made, unless a clone holds work that never reached the
 * remote. Never throws.
 *
 * LOGIC CHANGE 2026-09-13: only a DELIVERED clone is deleted. Deleting one that still
 * held uncommitted changes or unpushed commits silently destroyed finished work, which
 * lost three tasks before the deploy key was wired. An undelivered clone is kept and
 * #sqtools-ops is told where (LOGIC CHANGE 2026-10-02, WORK-TODO #25: the alert says the
 * path is inside the container, how to reach it, and what deletes it).
 *
 * @param {object} run - { taskDir, taskBaseSha, scratchCwd, queueId, task, sourceLink }
 * @param {object} deps - { workDir, postToOps }
 */
async function cleanupWorkspace(run, deps) {
  const { taskDir, task } = run;
  if (taskDir && fs.existsSync(taskDir)) {
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #39): before the clone can be deleted.
    if (run.queueId) {
      await recordTaskWork(run.queueId, taskDir, run.taskBaseSha, task.description, deps.postToOps);
    }
    const delivery = detectUndeliveredWork(taskDir);
    if (delivery.undelivered) {
      console.warn(`[bridge-agent] Preserving scratch clone ${taskDir} — ${delivery.reason}`);
      try {
        await deps.postToOps(formatPreservedCloneAlert({
          description: task.description,
          reason: delivery.reason,
          taskDir,
          workDir: deps.workDir,
          sourceLink: run.sourceLink,
        }));
      } catch (postErr) {
        console.error('[bridge-agent] Failed to post undelivered-work alert:', postErr.message);
      }
    } else {
      cleanupDir(taskDir);
    }
  }

  // LOGIC CHANGE 2026-11-25 (WORK-TODO #82): the no-repo task's own empty directory.
  // Nothing in it is delivered work: a task without a repository has nowhere to push.
  if (run.scratchCwd) {
    try {
      fs.rmSync(run.scratchCwd, { recursive: true, force: true });
    } catch (rmErr) {
      console.error(`[bridge-agent] Could not remove ${run.scratchCwd}:`, rmErr.message);
    }
  }
}

module.exports = { prepareWorkspace, readTaskWork, recordTaskWork, cleanupWorkspace };
