#!/usr/bin/env node

/**
 * bridge-agent.js v2
 *
 * Polls #claude-bridge for TASK messages posted by Claude Chat,
 * executes them via Claude Code CLI (non-interactive) against
 * GitHub repos (cloned fresh per task), posts results to #sqtools-ops.
 *
 * Task message format:
 *   TASK: Short description
 *   REPO: jtpets/SquareDashboardTool (or full URL)
 *   BRANCH: main (optional, default: main)
 *   INSTRUCTIONS: What to do
 *
 * Run with PM2:
 *   pm2 start bridge-agent.js --name bridge-agent
 *
 * Required env vars:
 *   SLACK_BOT_TOKEN     xoxb- token
 *   BRIDGE_CHANNEL_ID   #claude-bridge channel ID
 *   OPS_CHANNEL_ID      #sqtools-ops channel ID
 *
 * Optional env vars:
 *   GITHUB_ORG          default GitHub org (default: jtpets)
 *   POLL_INTERVAL_MS    poll frequency (default: 30000)
 *   MAX_TURNS           Claude Code max turns per task (default: 50)
 *   TASK_TIMEOUT_MS     hard kill timeout (default: 600000 = 10min)
 *   CLAUDE_BIN          path to claude binary
 *   WORK_DIR            base dir for temp clones (default: /tmp/bridge-agent)
 */

const { WebClient } = require('@slack/web-api');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// LOGIC CHANGE 2026-03-26: Added memory-manager integration to track task
// execution history for analytics and debugging purposes.
const memory = require('./memory/memory-manager');

// LOGIC CHANGE 2026-03-26: Extracted task parsing and message detection into
// lib/task-parser.js for testability.
// LOGIC CHANGE 2026-03-26: Added isStatusQuery import for built-in status
// command handling without LLM calls.
// LOGIC CHANGE 2026-03-26: Added isCreateChannelCommand and parseCreateChannelCommand
// for built-in "create channel #name" command handling.
const {
  parseTask,
  isTaskMessage,
  isConversationMessage,
  isStatusQuery,
  isCreateChannelCommand,
  parseCreateChannelCommand,
  alreadyProcessed,
} = require('./lib/task-parser');

// LOGIC CHANGE 2026-03-26: Extracted config loading and validation into
// lib/config.js for centralized env var management.
// LOGIC CHANGE 2026-03-26: Import isUserAuthorized from config for user
// authorization checks in the poll loop.
const { config, validate, isUserAuthorized } = require('./lib/config');

// LOGIC CHANGE 2026-03-26: Added owner-tasks module for tracking activation
// checklists and owner action items across all agents.
// LOGIC CHANGE 2026-03-26: Removed extractActionRequired and addTask imports -
// now used via notify-owner module for centralized action tracking.
const {
  isOwnerTasksQuery,
  formatPendingTasks,
} = require('./lib/owner-tasks');

// LOGIC CHANGE 2026-03-26: Added agent registry for multi-agent architecture.
// Loads agent config from agents/agents.json with fallback to env vars if registry
// doesn't exist or agent not found.
// LOGIC CHANGE 2026-03-26: Added isProductionRepo for production workflow detection.
const { getAgent, loadAgents, registryExists, isProductionRepo } = require('./lib/agent-registry');

// LOGIC CHANGE 2026-03-26: Extracted LLM execution into lib/llm-runner.js
// to support multiple LLM providers via LLM_PROVIDER env var.
// LOGIC CHANGE 2026-03-26: Import RateLimitError for detecting rate limit
// errors and implementing pause/retry behavior.
const { runLLM, RateLimitError } = require('./lib/llm-runner');

// LOGIC CHANGE 2026-03-26: Added slack-client module for channel management
// functions (createChannel, ensureChannel, etc.).
const { createSlackClient } = require('./lib/slack-client');

// LOGIC CHANGE 2026-03-26: Added notify-owner module for centralized owner notifications.
// All owner-facing notifications (DMs, task failures, action required) go through
// this layer. When secretary agent is active, routes through its channel.
const notifyOwner = require('./lib/notify-owner');

// ---- Config ----

// Validate required config
validate(config);

// LOGIC CHANGE 2026-03-26: Load bridge agent config from registry if available.
// Falls back to env vars if agents.json doesn't exist or bridge agent not found.
let agentConfig = null;
if (registryExists()) {
  agentConfig = getAgent('bridge');
  if (agentConfig) {
    console.log('[bridge-agent] Loaded config from agent registry');
  }
}

// Destructure config for convenience, with registry overrides where applicable
const {
  SLACK_BOT_TOKEN,
  BRIDGE_CHANNEL,
  OPS_CHANNEL,
  POLL_INTERVAL,
  TASK_TIMEOUT,
  CLAUDE_BIN,
  WORK_DIR,
  EMOJI_RUNNING,
  EMOJI_DONE,
  EMOJI_FAILED,
  ALLOWED_USER_IDS,
} = config;

// LOGIC CHANGE 2026-03-26: MAX_TURNS can be overridden by agent registry.
// Agent config takes precedence over env var.
const MAX_TURNS = agentConfig?.max_turns || config.MAX_TURNS;

const slack = new WebClient(SLACK_BOT_TOKEN);

// LOGIC CHANGE 2026-03-26: Create SlackClient wrapper for channel management.
// Used for "create channel #name" command and agent activation helpers.
const slackClient = createSlackClient(SLACK_BOT_TOKEN);

// LOGIC CHANGE 2026-03-26: Initialize notify-owner module with dependencies.
// Takes WebClient, owner ID, and ops channel for routing notifications.
notifyOwner.init({
  slack,
  ownerId: ALLOWED_USER_IDS[0],
  opsChannelId: OPS_CHANNEL,
});

// Ensure work dir exists
if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// ---- State persistence ----

const STATE_FILE = path.join(__dirname, '.bridge-agent-state.json');
let lastChecked = loadState();
let isRunning = false;

// LOGIC CHANGE 2026-03-27: Added graceful shutdown support.
// shuttingDown: flag to stop processing new tasks on SIGTERM/SIGINT
// currentTaskPromise: tracks the currently running task for graceful completion
let shuttingDown = false;
let currentTaskPromise = null;

// LOGIC CHANGE 2026-03-26: Rate limit state tracking with exponential backoff.
// pauseUntil: timestamp when pause expires, retryCount: number of consecutive rate limits,
// failedTask: the task message to retry after pause expires.
// Pause durations: 30 min -> 60 min -> 2 hours -> 4 hours (capped)
const RATE_LIMIT_PAUSE_MINUTES = [30, 60, 120, 240]; // 30min, 1h, 2h, 4h
let rateLimitState = {
  pauseUntil: null,
  retryCount: 0,
  failedTask: null,
};

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return data.lastChecked || '0';
  } catch {
    return '0';
  }
}

function saveState(ts) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastChecked: ts }), 'utf8');
  } catch (err) {
    console.error('[bridge-agent] Failed to save state:', err.message);
  }
}

// LOGIC CHANGE 2026-03-26: Check if currently paused due to rate limit.
function isRateLimitPaused() {
  if (!rateLimitState.pauseUntil) return false;
  return Date.now() < rateLimitState.pauseUntil;
}

// LOGIC CHANGE 2026-03-26: Get formatted time when pause expires.
function getPauseResumeTime() {
  if (!rateLimitState.pauseUntil) return null;
  return new Date(rateLimitState.pauseUntil).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Toronto',
  });
}

// LOGIC CHANGE 2026-03-26: Calculate pause duration based on retry count with exponential backoff.
// 30 min -> 60 min -> 2 hours -> 4 hours (capped at 4 hours)
function getRateLimitPauseDuration() {
  const index = Math.min(rateLimitState.retryCount, RATE_LIMIT_PAUSE_MINUTES.length - 1);
  return RATE_LIMIT_PAUSE_MINUTES[index] * 60 * 1000;
}

// LOGIC CHANGE 2026-03-26: Handle rate limit error by setting pause and notifying.
// LOGIC CHANGE 2026-03-26: Refactored to use notify-owner module for notifications.
async function handleRateLimit(failedTask) {
  const pauseDuration = getRateLimitPauseDuration();
  const pauseUntil = Date.now() + pauseDuration;
  const resumeTime = new Date(pauseUntil).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Toronto',
  });
  const pauseMinutes = Math.round(pauseDuration / 60000);

  rateLimitState.pauseUntil = pauseUntil;
  rateLimitState.retryCount++;
  rateLimitState.failedTask = failedTask;

  console.log(`[bridge-agent] Rate limit hit. Pausing for ${pauseMinutes} minutes until ${resumeTime}`);

  // Notify via notify-owner module (posts to ops and DMs owner)
  await notifyOwner.rateLimitHit({
    pauseMinutes,
    resumeTime,
    retryCount: rateLimitState.retryCount,
  });

  // Update memory with rate limit status
  try {
    memory.updateContext('rateLimitStatus', {
      rateLimited: true,
      pauseUntil: pauseUntil,
      retryCount: rateLimitState.retryCount,
      lastHit: new Date().toISOString(),
    });
  } catch (memErr) {
    console.error('[bridge-agent] Failed to update rate limit memory:', memErr.message);
  }
}

// LOGIC CHANGE 2026-03-26: Clear rate limit state after successful task completion.
// LOGIC CHANGE 2026-03-26: Refactored to use notify-owner module for notifications.
async function clearRateLimitState() {
  if (rateLimitState.retryCount > 0) {
    console.log('[bridge-agent] Rate limit pause cleared after successful task');
    await notifyOwner.rateLimitCleared();
  }
  rateLimitState.pauseUntil = null;
  rateLimitState.retryCount = 0;
  rateLimitState.failedTask = null;

  // Clear rate limit status from memory
  try {
    memory.updateContext('rateLimitStatus', null);
  } catch (memErr) {
    // Ignore memory errors
  }
}

// ---- Slack helpers ----

async function react(channel, timestamp, emoji) {
  try {
    await slack.reactions.add({ channel, timestamp, name: emoji });
  } catch (err) {
    if (err.data?.error !== 'already_reacted') {
      console.error(`[bridge-agent] react(${emoji}) failed:`, err.message);
    }
  }
}

async function unreact(channel, timestamp, emoji) {
  try {
    await slack.reactions.remove({ channel, timestamp, name: emoji });
  } catch {
    // Reaction may not exist
  }
}

async function postToOps(text) {
  try {
    await slack.chat.postMessage({
      channel: OPS_CHANNEL,
      text,
      unfurl_links: false,
    });
  } catch (err) {
    console.error('[bridge-agent] Failed to post to #sqtools-ops:', err.message);
  }
}

// ---- Task parsing ----
// Functions moved to lib/task-parser.js: parseTask, isTaskMessage, isConversationMessage, alreadyProcessed

// ---- Git helpers ----

// LOGIC CHANGE 2026-03-26: Added try/catch with fallback to main branch when
// specified branch is not found. Cleans up partial clone before retrying.
function cloneRepo(repo, branch, targetDir) {
  const url = `https://github.com/${repo}.git`;
  console.log(`[bridge-agent] Cloning ${url} (branch: ${branch}) -> ${targetDir}`);
  try {
    execSync(`git clone --depth 1 --branch ${branch} ${url} ${targetDir}`, {
      stdio: 'pipe',
      timeout: 60000,
    });
  } catch (err) {
    if (branch !== 'main') {
      console.warn(`[bridge-agent] Branch ${branch} not found, falling back to main`);
      // Clean up any partial clone before retrying
      fs.rmSync(targetDir, { recursive: true, force: true });
      execSync(`git clone --depth 1 --branch main ${url} ${targetDir}`, {
        stdio: 'pipe',
        timeout: 60000,
      });
    } else {
      throw err;
    }
  }
}

function cleanupDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[bridge-agent] Cleaned up ${dir}`);
  } catch (err) {
    console.error(`[bridge-agent] Cleanup failed for ${dir}:`, err.message);
  }
}

// ---- Formatting ----

function truncate(text, max = 3500) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2) - 30;
  return text.slice(0, half) + '\n\n... [truncated] ...\n\n' + text.slice(-half);
}

function msgLink(ts) {
  return `https://jtpets.slack.com/archives/${BRIDGE_CHANNEL}/p${ts.replace('.', '')}`;
}

// ---- Process a single task ----

async function processTask(msg) {
  const task = parseTask(msg.text);
  const startTime = Date.now();
  let taskDir = null;

  // LOGIC CHANGE 2026-03-26: Track task in memory for history/analytics.
  // Memory errors are logged but never crash task execution.
  let memoryTaskId = null;
  try {
    const memTask = memory.addTask({
      description: task.description,
      repo: task.repo,
      branch: task.branch,
      status: 'running',
    });
    memoryTaskId = memTask.id;
  } catch (memErr) {
    console.error('[bridge-agent] Memory addTask failed:', memErr.message);
  }

  try {
    await react(BRIDGE_CHANNEL, msg.ts, EMOJI_RUNNING);

    let prompt = '';
    let cwd = WORK_DIR;

    if (task.repo) {
      // Clone into a unique temp dir
      const dirName = `task-${msg.ts.replace('.', '-')}`;
      taskDir = path.join(WORK_DIR, dirName);
      cloneRepo(task.repo, task.branch, taskDir);
      cwd = taskDir;

      // LOGIC CHANGE 2026-03-26: Load skill template from skills/<skill>/SKILL.md
      // if SKILL field is specified. Prepends skill content to the prompt.
      let skillContent = '';
      if (task.skill) {
        try {
          const skillPath = path.join(taskDir, 'skills', task.skill, 'SKILL.md');
          if (fs.existsSync(skillPath)) {
            skillContent = fs.readFileSync(skillPath, 'utf8');
            console.log(`[bridge-agent] Loaded skill template: ${task.skill}`);
          } else {
            console.warn(`[bridge-agent] Skill not found: ${skillPath}`);
          }
        } catch (skillErr) {
          console.error(`[bridge-agent] Failed to load skill ${task.skill}:`, skillErr.message);
        }
      }

      // LOGIC CHANGE 2026-03-26: Check if repo is production and prepend warning.
      // Production repos MUST use feature branches and PRs, never push to main.
      let productionWarning = '';
      if (isProductionRepo(task.repo)) {
        productionWarning = 'This is a PRODUCTION repo. You MUST create a feature branch, commit there, push the branch, and create a pull request using `gh pr create`. Do NOT push to main. Do NOT merge.\n\n';
        console.log(`[bridge-agent] Production repo detected: ${task.repo}`);
      }

      prompt = [
        productionWarning,
        skillContent,
        `You are working in a cloned repo: ${task.repo} (branch: ${task.branch}).`,
        `Your working directory is the repo root.`,
        productionWarning ? '' : `When done, commit and push your changes if you made any code changes.`,
        '',
        task.instructions || task.description,
      ].filter(Boolean).join('\n');
    } else {
      // No repo specified, run in work dir
      prompt = task.instructions || task.description;
    }

    // LOGIC CHANGE 2026-03-26: Prepend task context from memory to help CC avoid
    // duplicate work and build on previous results. Context failure never blocks
    // task execution.
    try {
      const taskContext = memory.buildTaskContext();
      if (taskContext) {
        prompt = taskContext + '\n\n' + prompt;
      }
    } catch (contextErr) {
      console.error('[bridge-agent] buildTaskContext failed:', contextErr.message);
      // Continue without context - never block task execution
    }

    // LOGIC CHANGE 2026-03-26: Use runLLM from lib/llm-runner.js instead of
    // inline runClaudeCode. Supports multiple providers via LLM_PROVIDER env var.
    // LOGIC CHANGE 2026-03-26: Use task.turns for per-task control of LLM max
    // turns instead of global MAX_TURNS. Defaults to 50, capped at 5-100 range.
    // LOGIC CHANGE 2026-03-26: Auto-retry on max turns hit. If task hits max turns
    // and original turns < 100, automatically retry once with doubled turns (capped
    // at 100). Prevents infinite loops via retryCount tracking.
    const originalTurns = task.turns;
    let currentTurns = originalTurns;
    let retryCount = 0;
    let result;
    let didRetry = false;

    while (retryCount <= 1) {
      try {
        result = await runLLM(prompt, {
          cwd,
          maxTurns: currentTurns,
          timeout: TASK_TIMEOUT,
          claudeBin: CLAUDE_BIN,
        });
      } catch (llmErr) {
        // Re-throw LLM errors - they will be caught by outer catch
        throw llmErr;
      }

      const { hitMaxTurns } = result;

      if (!hitMaxTurns) {
        // Success - task completed without hitting max turns
        break;
      }

      // Hit max turns - check if we can retry
      if (retryCount === 0 && currentTurns < 100) {
        // Calculate retry turns: double but cap at 100
        const retryTurns = Math.min(currentTurns * 2, 100);
        await postToOps(
          `:hourglass_flowing_sand: *Task hit max turns (${currentTurns}). Retrying with ${retryTurns} turns...*\n` +
          `Source: <${msgLink(msg.ts)}|#claude-bridge>`
        );
        currentTurns = retryTurns;
        retryCount++;
        didRetry = true;
        continue;
      }

      // Either already retried once, or original turns was already 100
      // Post warning and break out of loop
      await postToOps(
        `:warning: *Task hit max turns limit${didRetry ? ' on retry' : ''}. May be partially complete.*\n` +
        `Source: <${msgLink(msg.ts)}|#claude-bridge>`
      );
      break;
    }

    const { output, hitMaxTurns } = result;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task completion notification.
    await notifyOwner.taskCompleted(task, truncate(output), {
      elapsed,
      sourceLink: `<${msgLink(msg.ts)}|#claude-bridge>`,
    });

    await unreact(BRIDGE_CHANNEL, msg.ts, EMOJI_RUNNING);
    await react(BRIDGE_CHANNEL, msg.ts, EMOJI_DONE);
    console.log(`[bridge-agent] Task ${msg.ts} done (${elapsed}s)`);

    // LOGIC CHANGE 2026-03-26: Clear rate limit state on successful task completion.
    // This resets the exponential backoff counter.
    await clearRateLimitState();

    // LOGIC CHANGE 2026-03-26: Auto-detect ACTION REQUIRED in task output and add
    // to bridge agent's activation checklist. Uses notify-owner module for
    // centralized action tracking.
    try {
      await notifyOwner.processActionRequired(output, { agentId: 'bridge' });
    } catch (actionErr) {
      console.error('[bridge-agent] Failed to process ACTION REQUIRED:', actionErr.message);
    }

    // LOGIC CHANGE 2026-03-26: Record task completion in memory.
    // Use different outcome format if max turns was hit.
    // LOGIC CHANGE 2026-03-26: Added retry tracking fields to memory outcome.
    // Tracks retried (bool), originalTurns (number), retryTurns (number if retried).
    if (memoryTaskId) {
      try {
        const outcome = {
          output: truncate(output, 500),
          elapsed: parseInt(elapsed, 10),
        };

        if (didRetry) {
          outcome.retried = true;
          outcome.originalTurns = originalTurns;
          outcome.retryTurns = currentTurns;
        }

        if (hitMaxTurns) {
          outcome.partial = true;
          outcome.output = 'max turns reached';
        }

        memory.completeTask(memoryTaskId, outcome);
      } catch (memErr) {
        console.error('[bridge-agent] Memory completeTask failed:', memErr.message);
      }
    }

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // LOGIC CHANGE 2026-03-26: Check for rate limit errors and handle with pause/retry.
    // Rate limit errors are not marked as failures - they trigger a pause and will be
    // retried automatically when the pause expires.
    if (err.isRateLimit || (err instanceof RateLimitError)) {
      console.error(`[bridge-agent] Rate limit detected for task ${msg.ts}`);

      // Remove running reaction but don't add failed - task will be retried
      await unreact(BRIDGE_CHANNEL, msg.ts, EMOJI_RUNNING);

      // Handle rate limit (posts to ops, DMs owner, sets pause)
      await handleRateLimit(msg);

      // Update memory to show task is paused, not failed
      if (memoryTaskId) {
        try {
          memory.failTask(memoryTaskId, 'rate_limit_paused');
        } catch (memErr) {
          console.error('[bridge-agent] Memory failTask failed:', memErr.message);
        }
      }

      return; // Exit without marking as failed - will retry after pause
    }

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task failure notification.
    // Posts to ops channel and sends critical DM to owner.
    await notifyOwner.taskFailed(task, err, {
      elapsed,
      sourceLink: `<${msgLink(msg.ts)}|#claude-bridge>`,
    });

    await unreact(BRIDGE_CHANNEL, msg.ts, EMOJI_RUNNING);
    await react(BRIDGE_CHANNEL, msg.ts, EMOJI_FAILED);
    console.error(`[bridge-agent] Task ${msg.ts} failed (${elapsed}s):`, err.message);

    // LOGIC CHANGE 2026-03-26: Record task failure in memory.
    if (memoryTaskId) {
      try {
        memory.failTask(memoryTaskId, err.message);
      } catch (memErr) {
        console.error('[bridge-agent] Memory failTask failed:', memErr.message);
      }
    }

  } finally {
    if (taskDir && fs.existsSync(taskDir)) {
      cleanupDir(taskDir);
    }
  }
}

// ---- Status query handling ----

// LOGIC CHANGE 2026-03-26: Added formatStatusResponse() to build a human-readable
// status message from memory data. Shows currently running task, queued tasks,
// and last 5 completed tasks with elapsed time.
// LOGIC CHANGE 2026-03-26: Added rate limit status display when queue is paused.
function formatStatusResponse() {
  const activeTasks = memory.getActiveTasks();
  const history = memory.loadMemory(path.join(__dirname, 'memory', 'history.json'));
  const last5 = history.slice(-5).reverse();

  let response = '';

  // LOGIC CHANGE 2026-03-26: Show rate limit status at the top if active.
  if (isRateLimitPaused()) {
    const resumeTime = getPauseResumeTime();
    const waitingCount = activeTasks.length + (rateLimitState.failedTask ? 1 : 0);
    response += `:warning: *Queue paused due to rate limit.*\n`;
    response += `Resumes at ${resumeTime}. ${waitingCount} task(s) waiting.\n`;
    response += `Retry attempt: ${rateLimitState.retryCount}\n\n`;
  }

  // Currently running task
  if (activeTasks.length > 0) {
    const running = activeTasks[0];
    const startedAt = new Date(running.created);
    const minutesAgo = Math.round((Date.now() - startedAt.getTime()) / 60000);
    response += `*Currently running:* ${running.description || 'No description'} (started ${minutesAgo} min ago)\n`;

    // Additional queued tasks
    if (activeTasks.length > 1) {
      response += `*Queued:* ${activeTasks.length - 1} task(s)\n`;
      for (let i = 1; i < activeTasks.length; i++) {
        response += `  • ${activeTasks[i].description || 'No description'}\n`;
      }
    } else {
      response += `*Queued:* none\n`;
    }
  } else {
    response += `*Currently running:* none\n`;
    response += `*Queued:* none\n`;
  }

  // Last 5 completed
  if (last5.length > 0) {
    response += `\n*Last 5 completed:*\n`;
    for (const task of last5) {
      const timestamp = task.completedAt || task.failedAt || task.created;
      const timeStr = new Date(timestamp).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Toronto',
      });
      const emoji = task.status === 'completed' ? '✅' : '❌';
      const elapsed = task.outcome?.elapsed ? `${task.outcome.elapsed}s` : 'N/A';
      response += `• ${timeStr} ${emoji} ${task.description || 'No description'} (${elapsed})\n`;
    }
  } else {
    response += `\n*Last 5 completed:* none\n`;
  }

  return response;
}

// ---- Process a conversational message ----

// LOGIC CHANGE 2026-03-26: Added processConversation for handling ASK: messages.
// Uses Claude Code with -p flag and max-turns 10 for quick Q&A responses.
// Replies are posted as thread replies to the original message.
async function processConversation(msg) {
  try {
    // Extract question text after "ASK:" prefix
    const questionText = msg.text.replace(/^ASK:\s*/i, '').trim();
    if (!questionText) {
      console.log(`[bridge-agent] Empty ASK: message, skipping`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for built-in status query before calling LLM.
    // This saves LLM tokens for simple status checks.
    if (isStatusQuery(questionText)) {
      console.log(`[bridge-agent] Status query detected: ${msg.ts}`);
      const statusResponse = formatStatusResponse();
      await slack.chat.postMessage({
        channel: BRIDGE_CHANNEL,
        thread_ts: msg.ts,
        text: statusResponse,
        unfurl_links: false,
      });
      console.log(`[bridge-agent] Status query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for owner tasks query ("what do I need to do",
    // "my tasks", etc.) to return pending activation checklist items.
    if (isOwnerTasksQuery(questionText)) {
      console.log(`[bridge-agent] Owner tasks query detected: ${msg.ts}`);
      const tasksResponse = formatPendingTasks();
      await slack.chat.postMessage({
        channel: BRIDGE_CHANNEL,
        thread_ts: msg.ts,
        text: tasksResponse,
        unfurl_links: false,
      });
      console.log(`[bridge-agent] Owner tasks query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for "create channel #name" command.
    // Creates the channel, invites the bot, and returns the channel ID.
    if (isCreateChannelCommand(questionText)) {
      console.log(`[bridge-agent] Create channel command detected: ${msg.ts}`);
      const channelName = parseCreateChannelCommand(questionText);

      if (!channelName) {
        await slack.chat.postMessage({
          channel: BRIDGE_CHANNEL,
          thread_ts: msg.ts,
          text: ':x: Invalid channel name. Use: `create channel #channel-name`',
          unfurl_links: false,
        });
        return;
      }

      try {
        const result = await slackClient.ensureChannel(channelName);
        const action = result.created ? 'Created' : 'Found existing';
        await slack.chat.postMessage({
          channel: BRIDGE_CHANNEL,
          thread_ts: msg.ts,
          text: `:white_check_mark: ${action} channel <#${result.channelId}|${result.name}>\nChannel ID: \`${result.channelId}\``,
          unfurl_links: false,
        });
        console.log(`[bridge-agent] Channel ${action.toLowerCase()}: ${result.name} (${result.channelId})`);
      } catch (channelErr) {
        // Post error to thread
        await slack.chat.postMessage({
          channel: BRIDGE_CHANNEL,
          thread_ts: msg.ts,
          text: `:x: Failed to create channel: ${channelErr.message}`,
          unfurl_links: false,
        });
        console.error(`[bridge-agent] Create channel failed:`, channelErr.message);
      }
      return;
    }

    console.log(`[bridge-agent] Processing conversation: ${msg.ts}`);

    // Build memory context
    let memoryContext = '';
    try {
      memoryContext = memory.buildTaskContext() || '';
    } catch (contextErr) {
      console.error('[bridge-agent] buildTaskContext failed:', contextErr.message);
    }

    // Build prompt with system instruction
    const systemInstruction = 'You are a helpful assistant for John Alexander who runs JT Pets. Answer concisely.';
    const prompt = [
      systemInstruction,
      memoryContext,
      questionText,
    ].filter(Boolean).join('\n\n');

    // LOGIC CHANGE 2026-03-26: Use runLLM from lib/llm-runner.js for conversation
    // handling. Uses max-turns 10 for quick Q&A responses.
    const result = await runLLM(prompt, {
      cwd: WORK_DIR,
      maxTurns: 10,
      timeout: TASK_TIMEOUT,
      claudeBin: CLAUDE_BIN,
    });
    const { output } = result;

    // Post response as a thread reply
    await slack.chat.postMessage({
      channel: BRIDGE_CHANNEL,
      thread_ts: msg.ts,
      text: truncate(output),
      unfurl_links: false,
    });

    console.log(`[bridge-agent] Conversation ${msg.ts} answered`);

  } catch (err) {
    // Log errors but do not post to ops channel
    console.error(`[bridge-agent] Conversation ${msg.ts} failed:`, err.message);
  }
}

// ---- Poll loop ----

async function poll() {
  if (isRunning) return;

  // LOGIC CHANGE 2026-03-27: Check if shutting down before processing new tasks.
  // Allows current task to complete but prevents new task processing.
  if (shuttingDown) {
    console.log('[bridge-agent] Shutting down, not processing new tasks');
    return;
  }

  // LOGIC CHANGE 2026-03-26: Check if paused due to rate limit.
  // When paused, skip new task processing but still update lastChecked.
  // When pause expires, retry the failed task first.
  if (isRateLimitPaused()) {
    console.log(`[bridge-agent] Rate limit pause active. Resumes at ${getPauseResumeTime()}`);
    return;
  }

  // LOGIC CHANGE 2026-03-26: Check if there's a failed task to retry after pause expires.
  if (rateLimitState.failedTask && !isRateLimitPaused()) {
    const failedMsg = rateLimitState.failedTask;
    console.log(`[bridge-agent] Retrying rate-limited task: ${failedMsg.ts}`);

    // Clear the failed task before retrying to prevent infinite retry loop
    rateLimitState.failedTask = null;

    isRunning = true;
    // LOGIC CHANGE 2026-03-27: Track current task promise for graceful shutdown.
    currentTaskPromise = processTask(failedMsg);
    await currentTaskPromise;
    currentTaskPromise = null;
    isRunning = false;

    // If we successfully completed, continue to normal polling
    // If rate limited again, handleRateLimit will set new pause and failedTask
    return;
  }

  try {
    const result = await slack.conversations.history({
      channel: BRIDGE_CHANNEL,
      oldest: lastChecked,
      limit: 5,
      inclusive: false,
    });

    if (!result.messages?.length) return;

    const messages = result.messages.reverse();

    for (const msg of messages) {
      if (msg.ts > lastChecked) {
        lastChecked = msg.ts;
        saveState(lastChecked);
      }

      // LOGIC CHANGE 2026-03-26: Check if message sender is authorized before
      // processing TASK: or ASK: messages. Unauthorized users are logged and skipped.
      if ((isTaskMessage(msg) || isConversationMessage(msg)) && !isUserAuthorized(msg.user)) {
        console.log(`[bridge-agent] Ignoring message from unauthorized user: ${msg.user}`);
        continue;
      }

      // Check for TASK: messages first
      if (isTaskMessage(msg) && !alreadyProcessed(msg)) {
        console.log(`[bridge-agent] Task found: ${msg.ts}`);
        isRunning = true;

        // LOGIC CHANGE 2026-03-27: Track current task promise for graceful shutdown.
        // Allows shutdown handler to wait for task completion.
        currentTaskPromise = processTask(msg);
        await currentTaskPromise;
        currentTaskPromise = null;

        isRunning = false;

        // LOGIC CHANGE 2026-03-26: After processing a task, check if we got rate limited.
        // If so, exit the loop to pause processing.
        if (isRateLimitPaused()) {
          console.log('[bridge-agent] Rate limit triggered. Pausing task processing.');
          return;
        }

        continue;
      }

      // LOGIC CHANGE 2026-03-26: Check for ASK: conversational messages.
      // These are handled inline without blocking the task queue.
      if (isConversationMessage(msg) && !alreadyProcessed(msg)) {
        await processConversation(msg);
      }
    }
  } catch (err) {
    console.error('[bridge-agent] Poll error:', err.message);
    isRunning = false;
  }
}

// ---- Startup ----

// LOGIC CHANGE 2026-03-26: Run memory cleanup and migration on startup.
// Cleans up expired short-term entries, archives decayed long-term entries,
// auto-promotes frequently accessed items, and migrates legacy memory files.
function runStartupMemoryMaintenance() {
  try {
    // Get all agent IDs from registry
    const agents = loadAgents();
    const agentIds = agents.map(a => a.id);

    if (agentIds.length === 0) {
      console.log('[bridge-agent] No agents in registry, skipping memory maintenance');
      return;
    }

    // Run migration for legacy memory files (bridge agent only for now)
    try {
      const migrationResult = memory.migrateAgentMemory('bridge');
      if (migrationResult.alreadyMigrated) {
        console.log('[bridge-agent] Memory already migrated');
      } else if (migrationResult.migratedTasks > 0 || migrationResult.migratedHistory > 0 || migrationResult.migratedContext) {
        console.log(`[bridge-agent] Migrated legacy memory: tasks=${migrationResult.migratedTasks}, history=${migrationResult.migratedHistory}, context=${migrationResult.migratedContext}`);
      }
    } catch (migErr) {
      console.error('[bridge-agent] Memory migration failed:', migErr.message);
    }

    // Run cleanup for all agents
    const cleanupResult = memory.startupMemoryCleanup(agentIds);
    let totalExpired = 0;
    let totalArchived = 0;
    let totalPromoted = 0;

    for (const [agentId, result] of Object.entries(cleanupResult)) {
      if (result.error) {
        console.error(`[bridge-agent] Cleanup error for ${agentId}:`, result.error);
      } else {
        totalExpired += result.expiredCount || 0;
        totalArchived += result.archivedCount || 0;
        totalPromoted += result.promotedCount || 0;
      }
    }

    if (totalExpired > 0 || totalArchived > 0 || totalPromoted > 0) {
      console.log(`[bridge-agent] Memory cleanup: expired=${totalExpired}, archived=${totalArchived}, promoted=${totalPromoted}`);
    }
  } catch (err) {
    console.error('[bridge-agent] Startup memory maintenance failed:', err.message);
    // Never block startup - memory maintenance is optional
  }
}

console.log('[bridge-agent] Starting v2');
console.log(`  Config:   ${agentConfig ? 'agent registry' : 'env vars'}`);
console.log(`  Claude:   ${CLAUDE_BIN}`);
console.log(`  Bridge:   #claude-bridge (${BRIDGE_CHANNEL})`);
console.log(`  Ops:      #sqtools-ops (${OPS_CHANNEL})`);
console.log(`  GitHub:   ${config.GITHUB_ORG || "jtpets"}`);
console.log(`  WorkDir:  ${WORK_DIR}`);
console.log(`  Interval: ${POLL_INTERVAL / 1000}s`);
console.log(`  Timeout:  ${TASK_TIMEOUT / 1000}s`);
console.log(`  Turns:    ${MAX_TURNS}`);
console.log(`  Allowed:  ${ALLOWED_USER_IDS.join(', ')}`);

// Run memory maintenance before starting poll loop
runStartupMemoryMaintenance();

// LOGIC CHANGE 2026-03-27: Clear stale rate limit state on startup.
// If pauseUntil is in the past (from a previous crash), clear it to prevent
// blocking the new instance. Also clears any stale rate limit status from memory.
function clearStaleRateLimitState() {
  try {
    const context = memory.loadContext();
    if (context && context.rateLimitStatus && context.rateLimitStatus.pauseUntil) {
      const pauseUntil = context.rateLimitStatus.pauseUntil;
      if (Date.now() >= pauseUntil) {
        console.log('[bridge-agent] Clearing stale rate limit state from previous run');
        memory.updateContext('rateLimitStatus', null);
        // Also reset in-memory state (should be fresh on startup, but be safe)
        rateLimitState = {
          pauseUntil: null,
          retryCount: 0,
          failedTask: null,
        };
      } else {
        // Pause is still valid, restore state from memory
        const remainingMs = pauseUntil - Date.now();
        const remainingMin = Math.ceil(remainingMs / 60000);
        console.log(`[bridge-agent] Restoring rate limit pause from memory (${remainingMin} min remaining)`);
        rateLimitState.pauseUntil = pauseUntil;
        rateLimitState.retryCount = context.rateLimitStatus.retryCount || 1;
        // failedTask cannot be restored (was in memory), so it will be null
      }
    }
  } catch (err) {
    console.error('[bridge-agent] Failed to check stale rate limit state:', err.message);
    // On error, assume no stale state - don't block startup
  }
}

clearStaleRateLimitState();

poll();
setInterval(poll, POLL_INTERVAL);

// LOGIC CHANGE 2026-03-27: Graceful shutdown handler for SIGTERM and SIGINT.
// Sets shuttingDown flag to stop new task processing, waits for current task
// to complete (up to 60 second timeout), then exits cleanly.
async function gracefulShutdown(signal) {
  if (shuttingDown) {
    console.log(`[bridge-agent] Already shutting down, ignoring ${signal}`);
    return;
  }

  shuttingDown = true;
  console.log(`[bridge-agent] Received ${signal}, initiating graceful shutdown`);

  // Notify ops channel about shutdown
  try {
    await postToOps(`:wave: Bridge agent shutting down gracefully. ${isRunning ? 'Current task will complete.' : 'No task running.'}`);
  } catch (err) {
    console.error('[bridge-agent] Failed to post shutdown message:', err.message);
  }

  // If a task is running, wait for it to complete (with timeout)
  if (isRunning && currentTaskPromise) {
    console.log('[bridge-agent] Waiting for current task to complete...');

    const SHUTDOWN_TIMEOUT = 60000; // 60 seconds
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => {
        console.log('[bridge-agent] Shutdown timeout reached, exiting');
        resolve('timeout');
      }, SHUTDOWN_TIMEOUT);
    });

    const result = await Promise.race([currentTaskPromise, timeoutPromise]);
    if (result === 'timeout') {
      console.log('[bridge-agent] Task did not complete within timeout');
    } else {
      console.log('[bridge-agent] Current task completed');
    }
  }

  console.log('[bridge-agent] Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
