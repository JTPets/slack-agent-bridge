#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so PM2 restarts retain env vars
require('dotenv').config();

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
// LOGIC CHANGE 2026-03-27: Added getActiveAgents and getAgentByChannel for multi-channel polling.
const { getAgent, loadAgents, getActiveAgents, getAgentByChannel, registryExists, isProductionRepo } = require('./lib/agent-registry');

// LOGIC CHANGE 2026-03-26: Extracted LLM execution into lib/llm-runner.js
// to support multiple LLM providers via LLM_PROVIDER env var.
// LOGIC CHANGE 2026-03-26: Import RateLimitError for detecting rate limit
// errors and implementing pause/retry behavior.
// LOGIC CHANGE 2026-03-27: Import BandwidthExhaustedError for bandwidth-specific
// handling when Claude CLI exits with code 1 and empty/short output.
const { runLLM, RateLimitError, BandwidthExhaustedError } = require('./lib/llm-runner');

// LOGIC CHANGE 2026-03-26: Added slack-client module for channel management
// functions (createChannel, ensureChannel, etc.).
const { createSlackClient } = require('./lib/slack-client');

// LOGIC CHANGE 2026-03-26: Added notify-owner module for centralized owner notifications.
// All owner-facing notifications (DMs, task failures, action required) go through
// this layer. When secretary agent is active, routes through its channel.
const notifyOwner = require('./lib/notify-owner');

// LOGIC CHANGE 2026-03-27: Added heartbeat module for visual task progress feedback.
// Cycles through reactions while task runs: :eyes: -> :hourglass_flowing_sand: -> :gear:
const { createHeartbeat } = require('./lib/heartbeat');

// LOGIC CHANGE 2026-03-27: Added staff-tasks module for store operations task management.
// Handles "assign [task] to [name] by [time]", "what tasks are overdue", and "store tasks today".
const staffTasks = require('./lib/staff-tasks');

// LOGIC CHANGE 2026-03-28: Added bulletin-board module for inter-agent communication.
// Agents can post bulletins (milestones, alerts, task completions) that other agents can read.
const bulletinBoard = require('./lib/bulletin-board');

// LOGIC CHANGE 2026-03-28: Added agent-scheduler module for cron-based proactive tasks.
// Enables agents to run on schedules (e.g., morning briefings, nightly audits).
const { startScheduler, stopScheduler } = require('./lib/agent-scheduler');

// LOGIC CHANGE 2026-03-28: Added bulletin-watcher module for event-driven agent triggers.
// When a bulletin is posted, watching agents get notified via ASK messages.
const bulletinWatcher = require('./lib/bulletin-watcher');

// LOGIC CHANGE 2026-03-28: Added watercooler module for weekly team standup conversations.
// Orchestrates multi-agent conversation where each agent shares updates in their voice.
const watercooler = require('./lib/watercooler');

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
let isRunning = false;

// LOGIC CHANGE 2026-03-27: Changed from single lastChecked to per-channel lastChecked map.
// Each channel has its own timestamp to track which messages have been processed.
// Format: { channelId: timestamp, ... }
let channelLastChecked = loadState();

// LOGIC CHANGE 2026-03-27: Added graceful shutdown support.
// shuttingDown: flag to stop processing new tasks on SIGTERM/SIGINT
// currentTaskPromise: tracks the currently running task for graceful completion
let shuttingDown = false;
let currentTaskPromise = null;

// LOGIC CHANGE 2026-03-27: Multi-channel polling support.
// channelsToPoll: list of channels to poll on each interval (bridge channel + active agent channels).
// Built on startup from active agents in registry. Each entry has { channelId, agentId, agentConfig }.
let channelsToPoll = [];

// LOGIC CHANGE 2026-03-26: Rate limit state tracking with exponential backoff.
// pauseUntil: timestamp when pause expires, retryCount: number of consecutive rate limits,
// failedTask: the task message to retry after pause expires.
// LOGIC CHANGE 2026-03-27: Initial pause duration now configurable via CLAUDE_RATE_LIMIT_PAUSE
// env var. Subsequent pauses use exponential backoff with 2x multiplier, capped at 4 hours.
const INITIAL_PAUSE_MS = config.RATE_LIMIT_PAUSE_MS || 1800000; // Default 30 min
const MAX_PAUSE_MS = 4 * 60 * 60 * 1000; // 4 hours cap
let rateLimitState = {
  pauseUntil: null,
  retryCount: 0,
  failedTask: null,
};

// LOGIC CHANGE 2026-03-27: Updated loadState to support per-channel timestamps.
// Returns an object mapping channelId -> lastChecked timestamp.
// Migrates legacy single-channel format ({ lastChecked: ts }) to multi-channel format.
function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    // Legacy format: { lastChecked: "timestamp" }
    // New format: { channels: { channelId: "timestamp", ... } }
    if (data.channels) {
      return data.channels;
    }
    // Migrate legacy format: assign old timestamp to bridge channel
    if (data.lastChecked) {
      return { [BRIDGE_CHANNEL]: data.lastChecked };
    }
    return {};
  } catch {
    return {};
  }
}

// LOGIC CHANGE 2026-03-27: Updated saveState to save per-channel timestamps.
// Saves the entire channelLastChecked object to disk.
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ channels: channelLastChecked }), 'utf8');
  } catch (err) {
    console.error('[bridge-agent] Failed to save state:', err.message);
  }
}

// LOGIC CHANGE 2026-03-27: Helper to get lastChecked timestamp for a channel.
// Returns '0' if channel has never been polled.
function getLastChecked(channelId) {
  return channelLastChecked[channelId] || '0';
}

// LOGIC CHANGE 2026-03-27: Helper to update lastChecked timestamp for a channel.
function setLastChecked(channelId, ts) {
  channelLastChecked[channelId] = ts;
  saveState();
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
// LOGIC CHANGE 2026-03-27: Now uses INITIAL_PAUSE_MS from config (CLAUDE_RATE_LIMIT_PAUSE env var)
// with 2x multiplier for each retry, capped at MAX_PAUSE_MS (4 hours).
// E.g., with default 30min: 30min -> 60min -> 2h -> 4h (capped)
function getRateLimitPauseDuration() {
  // First attempt uses initial pause, subsequent attempts double (with cap)
  const multiplier = Math.pow(2, rateLimitState.retryCount);
  const duration = INITIAL_PAUSE_MS * multiplier;
  return Math.min(duration, MAX_PAUSE_MS);
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

  // LOGIC CHANGE 2026-03-27: Rate limit state is in-memory only. No persistence
  // to disk — every restart automatically clears it (desired behavior).
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

  // LOGIC CHANGE 2026-03-27: Rate limit state is in-memory only. No disk
  // cleanup needed — in-memory variable was already reset above.
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

// LOGIC CHANGE 2026-03-27: Added channel parameter to support multi-channel polling.
// Defaults to BRIDGE_CHANNEL for backward compatibility.
function msgLink(ts, channel = BRIDGE_CHANNEL) {
  return `https://jtpets.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
}

// ---- Process a single task ----

// LOGIC CHANGE 2026-03-27: Task lock file path for coordination with auto-update.js.
// Created at task start, deleted in finally block. Auto-update waits for this file
// to be removed before restarting PM2 to avoid interrupting running tasks.
const TASK_LOCK_FILE = path.join(WORK_DIR, '.task-running');

// LOGIC CHANGE 2026-03-27: Added sourceChannel parameter for multi-channel support.
// Tasks can be submitted from any agent channel but always execute with bridge agent.
async function processTask(msg, sourceChannel = BRIDGE_CHANNEL) {
  const task = parseTask(msg.text);
  const startTime = Date.now();
  let taskDir = null;
  let taskSuccess = false;

  // LOGIC CHANGE 2026-03-27: Create heartbeat for visual progress feedback.
  // Cycles through emojis while task runs. Wrapped in try/catch so heartbeat
  // failures never affect task execution.
  // Uses sourceChannel to add reactions to the correct channel's message.
  const heartbeat = createHeartbeat(slack, sourceChannel, msg.ts);

  // LOGIC CHANGE 2026-03-27: Create task lock file to signal to auto-update.js
  // that a task is running. Auto-update will wait for this file to be removed
  // before restarting PM2 to avoid interrupting running tasks.
  try {
    fs.writeFileSync(TASK_LOCK_FILE, `${msg.ts}\n${Date.now()}\n${task.description || 'no description'}`, 'utf8');
    console.log(`[bridge-agent] Created task lock file: ${TASK_LOCK_FILE}`);
  } catch (lockErr) {
    console.error('[bridge-agent] Failed to create task lock file:', lockErr.message);
    // Continue anyway - lock file is best effort coordination
  }

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
    // LOGIC CHANGE 2026-03-27: Start heartbeat reactions (eyes -> cycling emojis).
    await heartbeat.start();

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

      // LOGIC CHANGE 2026-03-27: Prepend agent system_prompt to task prompt for
      // consistent agent personality and behavior. Falls back to empty string if
      // no system_prompt is defined.
      const agentSystemPrompt = agentConfig?.system_prompt || '';

      prompt = [
        agentSystemPrompt,
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
      // LOGIC CHANGE 2026-03-27: Also prepend system_prompt for non-repo tasks.
      const agentSystemPrompt = agentConfig?.system_prompt || '';
      prompt = agentSystemPrompt
        ? `${agentSystemPrompt}\n\n${task.instructions || task.description}`
        : (task.instructions || task.description);
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

    // LOGIC CHANGE 2026-03-27: Pass agent's llm_provider to runLLM. Code agents
    // use claude, others use gemini. Falls back to env LLM_PROVIDER or 'claude'.
    const llmProvider = agentConfig?.llm_provider;

    while (retryCount <= 1) {
      try {
        result = await runLLM(prompt, {
          cwd,
          maxTurns: currentTurns,
          timeout: TASK_TIMEOUT,
          claudeBin: CLAUDE_BIN,
          provider: llmProvider,
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
          `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
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
        `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
      );
      break;
    }

    const { output, hitMaxTurns, interrupted } = result;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // LOGIC CHANGE 2026-03-27: Handle interrupted tasks (exit code null, e.g., PM2 restart).
    // Do not count as failure, do not trigger rate limit. Just log and return.
    if (interrupted) {
      console.log(`[bridge-agent] Task interrupted (exit code null) - likely PM2 restart`);
      await postToOps(`:warning: Task interrupted (likely PM2 restart) after ${elapsed}s.\nSource: <${msgLink(msg.ts, sourceChannel)}|source>`);
      taskSuccess = true; // Don't mark as failure
      if (memoryTaskId) {
        try {
          memory.completeTask(memoryTaskId, { output: 'interrupted', elapsed: parseInt(elapsed, 10), interrupted: true });
        } catch (memErr) {
          console.error('[bridge-agent] Memory completeTask failed:', memErr.message);
        }
      }
      return;
    }

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task completion notification.
    await notifyOwner.taskCompleted(task, truncate(output), {
      elapsed,
      sourceLink: `<${msgLink(msg.ts, sourceChannel)}|source>`,
    });

    // LOGIC CHANGE 2026-03-27: Mark task as successful for heartbeat cleanup.
    taskSuccess = true;
    console.log(`[bridge-agent] Task ${msg.ts} done (${elapsed}s)`);

    // LOGIC CHANGE 2026-03-26: Clear rate limit state on successful task completion.
    // This resets the exponential backoff counter.
    await clearRateLimitState();

    // LOGIC CHANGE 2026-03-28: Post task completion bulletin for inter-agent awareness.
    // Other agents can see what tasks have been completed without watching ops channel.
    try {
      // Extract commit hash from output if present (look for common git commit patterns)
      let commitHash = null;
      const commitMatch = output.match(/\[([a-f0-9]{7,40})\]|commit\s+([a-f0-9]{7,40})/i);
      if (commitMatch) {
        commitHash = commitMatch[1] || commitMatch[2];
      }

      const bulletinResult = bulletinBoard.postBulletin('bridge', 'task_completed', {
        description: task.description,
        repo: task.repo || null,
        branch: task.branch || 'main',
        commitHash,
        elapsed: parseInt(elapsed, 10),
        partial: hitMaxTurns || false,
      });

      // LOGIC CHANGE 2026-03-28: Notify watching agents about the bulletin.
      // Agents with watches.bulletin_types containing 'task_completed' get notified.
      if (bulletinResult.success && bulletinResult.bulletin) {
        bulletinWatcher.processBulletin(slack, bulletinResult.bulletin).catch(watchErr => {
          console.error('[bridge-agent] Bulletin watcher error:', watchErr.message);
        });
      }
    } catch (bulletinErr) {
      console.error('[bridge-agent] Failed to post task completion bulletin:', bulletinErr.message);
    }

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

    // LOGIC CHANGE 2026-03-27: Rate limit auto-pause disabled due to false positives killing tasks.
    // Manual restart is safer than auto-pausing on misdetection. If a task fails, it just fails.
    // No pausing the queue. handleRateLimit() is NOT called here anymore.
    // Will re-add rate limit handling when detection is properly calibrated.

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task failure notification.
    // Posts to ops channel and sends critical DM to owner.
    await notifyOwner.taskFailed(task, err, {
      elapsed,
      sourceLink: `<${msgLink(msg.ts, sourceChannel)}|source>`,
    });

    // LOGIC CHANGE 2026-03-27: taskSuccess remains false, heartbeat.stop(false)
    // will add :x: emoji in finally block.
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
    // LOGIC CHANGE 2026-03-27: Stop heartbeat and add final status emoji.
    // Wrapped in try/catch - heartbeat failure must never affect task execution.
    try {
      await heartbeat.stop(taskSuccess);
    } catch (heartbeatErr) {
      console.error('[bridge-agent] Heartbeat cleanup failed:', heartbeatErr.message);
    }

    if (taskDir && fs.existsSync(taskDir)) {
      cleanupDir(taskDir);
    }

    // LOGIC CHANGE 2026-03-27: Clear working memory at end of each task to prevent
    // accumulation of stale "running" entries that never get cleared.
    try {
      memory.clearAgentWorkingMemory('bridge');
    } catch (memErr) {
      console.error('[bridge-agent] Failed to clear working memory:', memErr.message);
    }

    // LOGIC CHANGE 2026-03-27: Remove task lock file to signal task completion.
    // Auto-update.js waits for this file to be removed before restarting PM2.
    try {
      if (fs.existsSync(TASK_LOCK_FILE)) {
        fs.unlinkSync(TASK_LOCK_FILE);
        console.log(`[bridge-agent] Removed task lock file: ${TASK_LOCK_FILE}`);
      }
    } catch (unlinkErr) {
      console.error('[bridge-agent] Failed to remove task lock file:', unlinkErr.message);
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
// LOGIC CHANGE 2026-03-27: Added sourceChannel and handlingAgent parameters for
// multi-channel routing. Each agent handles ASK: messages in its own channel
// with its own personality and system_prompt.
async function processConversation(msg, sourceChannel = BRIDGE_CHANNEL, handlingAgent = null) {
  // Use the handling agent's config, or fall back to bridge agent config
  const currentAgent = handlingAgent || agentConfig;
  const agentName = currentAgent?.name || 'Bridge Agent';
  const agentId = currentAgent?.id || 'bridge';

  try {
    // Extract question text after "ASK:" prefix
    const questionText = msg.text.replace(/^ASK:\s*/i, '').trim();
    if (!questionText) {
      console.log(`[${agentId}] Empty ASK: message, skipping`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for built-in status query before calling LLM.
    // This saves LLM tokens for simple status checks.
    // Only bridge agent handles status queries (they're global to the system).
    if (sourceChannel === BRIDGE_CHANNEL && isStatusQuery(questionText)) {
      console.log(`[${agentId}] Status query detected: ${msg.ts}`);
      const statusResponse = formatStatusResponse();
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: statusResponse,
        unfurl_links: false,
      });
      console.log(`[${agentId}] Status query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for owner tasks query ("what do I need to do",
    // "my tasks", etc.) to return pending activation checklist items.
    // Only bridge agent handles owner task queries (they're global to the system).
    if (sourceChannel === BRIDGE_CHANNEL && isOwnerTasksQuery(questionText)) {
      console.log(`[${agentId}] Owner tasks query detected: ${msg.ts}`);
      const tasksResponse = formatPendingTasks();
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: tasksResponse,
        unfurl_links: false,
      });
      console.log(`[${agentId}] Owner tasks query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-03-26: Check for "create channel #name" command.
    // Creates the channel, invites the bot, and returns the channel ID.
    // Only bridge agent handles channel creation (system-level operation).
    if (sourceChannel === BRIDGE_CHANNEL && isCreateChannelCommand(questionText)) {
      console.log(`[${agentId}] Create channel command detected: ${msg.ts}`);
      const channelName = parseCreateChannelCommand(questionText);

      if (!channelName) {
        await slack.chat.postMessage({
          channel: sourceChannel,
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
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:white_check_mark: ${action} channel <#${result.channelId}|${result.name}>\nChannel ID: \`${result.channelId}\``,
          unfurl_links: false,
        });
        console.log(`[${agentId}] Channel ${action.toLowerCase()}: ${result.name} (${result.channelId})`);
      } catch (channelErr) {
        // Post error to thread
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:x: Failed to create channel: ${channelErr.message}`,
          unfurl_links: false,
        });
        console.error(`[${agentId}] Create channel failed:`, channelErr.message);
      }
      return;
    }

    // LOGIC CHANGE 2026-03-27: Check for staff task commands.
    // Handles "assign [task] to [name] by [time]", "what tasks are overdue", "store tasks today".
    if (staffTasks.isStaffTaskCommand(questionText)) {
      const commandType = staffTasks.parseStaffTaskCommandType(questionText);
      console.log(`[${agentId}] Staff task command detected: ${commandType} (${msg.ts})`);

      try {
        let response;

        if (commandType === 'assign') {
          const parsed = staffTasks.parseAssignCommand(questionText);
          if (!parsed) {
            response = ':x: Invalid format. Use: `assign [task] to [name] by [time]`';
          } else {
            // Look up staff member
            const staffMember = staffTasks.getStaffByName(parsed.assignee);
            const assigneeId = staffMember ? staffMember.slackId : parsed.assignee;

            // Check if STORE_TASKS_CHANNEL is configured
            if (!config.STORE_TASKS_CHANNEL) {
              response = ':x: STORE_TASKS_CHANNEL_ID not configured. Add it to .env first.';
            } else {
              const result = await staffTasks.createTask(slack, config.STORE_TASKS_CHANNEL, {
                description: parsed.task,
                assignee: assigneeId,
                dueTime: parsed.dueTime,
                priority: 'medium',
              });
              response = `:white_check_mark: Task created and posted to <#${config.STORE_TASKS_CHANNEL}>`;
            }
          }
        } else if (commandType === 'overdue') {
          response = staffTasks.formatOverdueList();
        } else if (commandType === 'today') {
          response = staffTasks.formatTodayList();
        } else {
          response = ':x: Unknown staff task command.';
        }

        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: response,
          unfurl_links: false,
        });
        console.log(`[${agentId}] Staff task command ${msg.ts} answered`);
      } catch (staffErr) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:x: Staff task error: ${staffErr.message}`,
          unfurl_links: false,
        });
        console.error(`[${agentId}] Staff task command failed:`, staffErr.message);
      }
      return;
    }

    // LOGIC CHANGE 2026-03-28: Check for bulletin query ("bulletins", "what's new").
    // Returns recent bulletins without using LLM tokens.
    if (bulletinBoard.isBulletinQuery(questionText)) {
      console.log(`[${agentId}] Bulletin query detected: ${msg.ts}`);
      const recentBulletins = bulletinBoard.getBulletins({ limit: 10 });
      const response = bulletinBoard.formatBulletinsForSlack(recentBulletins);
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: response,
        unfurl_links: false,
      });
      console.log(`[${agentId}] Bulletin query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-03-28: Check for standup command ("team standup", "watercooler").
    // Triggers the weekly team standup conversation where all agents share updates.
    if (watercooler.isStandupCommand(questionText)) {
      console.log(`[${agentId}] Standup command detected: ${msg.ts}`);
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: ':coffee: Starting team standup... This will post to #sqtools-ops.',
        unfurl_links: false,
      });

      try {
        const result = await watercooler.runStandup(slack);
        const statusMsg = result.success
          ? `:white_check_mark: Standup complete! ${result.messagesPosted} messages posted.`
          : `:warning: Standup finished with issues: ${result.errors.join(', ')}`;
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: statusMsg,
          unfurl_links: false,
        });
      } catch (standupErr) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:x: Standup failed: ${standupErr.message}`,
          unfurl_links: false,
        });
        console.error(`[${agentId}] Standup failed:`, standupErr.message);
      }
      console.log(`[${agentId}] Standup command ${msg.ts} completed`);
      return;
    }

    console.log(`[${agentId}] Processing conversation: ${msg.ts}`);

    // Build memory context
    let memoryContext = '';
    try {
      memoryContext = memory.buildTaskContext() || '';
    } catch (contextErr) {
      console.error(`[${agentId}] buildTaskContext failed:`, contextErr.message);
    }

    // LOGIC CHANGE 2026-03-28: Include unread bulletins in conversation context.
    // This allows agents to be aware of recent events from other agents without
    // needing to explicitly query the bulletin board.
    let bulletinContext = '';
    try {
      bulletinContext = bulletinBoard.formatBulletinsForContext(agentId, 5);
    } catch (bulletinErr) {
      console.error(`[${agentId}] formatBulletinsForContext failed:`, bulletinErr.message);
    }

    // LOGIC CHANGE 2026-03-27: Use agent's system_prompt and personality for conversations.
    // Each agent responds with its own voice and expertise.
    const systemInstruction = currentAgent?.system_prompt ||
      'You are a helpful assistant for John Alexander who runs JT Pets. Answer concisely.';

    const prompt = [
      systemInstruction,
      memoryContext,
      bulletinContext,
      questionText,
    ].filter(Boolean).join('\n\n');

    // LOGIC CHANGE 2026-03-26: Use runLLM from lib/llm-runner.js for conversation
    // handling. Uses max-turns 10 for quick Q&A responses.
    // LOGIC CHANGE 2026-03-27: Pass handling agent's llm_provider for conversation handling.
    // Uses the agent's configured max_turns capped at 20 for conversations.
    const maxTurns = Math.min(currentAgent?.max_turns || 10, 20);
    const result = await runLLM(prompt, {
      cwd: WORK_DIR,
      maxTurns,
      timeout: TASK_TIMEOUT,
      claudeBin: CLAUDE_BIN,
      provider: currentAgent?.llm_provider,
    });
    const { output } = result;

    // Post response as a thread reply
    await slack.chat.postMessage({
      channel: sourceChannel,
      thread_ts: msg.ts,
      text: truncate(output),
      unfurl_links: false,
    });

    console.log(`[${agentId}] Conversation ${msg.ts} answered`);

  } catch (err) {
    // Log errors but do not post to ops channel
    console.error(`[${agentId}] Conversation ${msg.ts} failed:`, err.message);
  }
}

// ---- Poll loop ----

// LOGIC CHANGE 2026-03-27: Refactored poll() to iterate through all agent channels.
// Each channel is polled for messages. TASK: messages always go to bridge agent.
// ASK: messages are routed to the agent that owns the channel.
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

  // LOGIC CHANGE 2026-03-27: Poll all channels in channelsToPoll array.
  // Process messages from each channel with appropriate agent context.
  for (const channelInfo of channelsToPoll) {
    const { channelId, agentId, agentConfig: channelAgentConfig } = channelInfo;

    try {
      const result = await slack.conversations.history({
        channel: channelId,
        oldest: getLastChecked(channelId),
        limit: 5,
        inclusive: false,
      });

      if (!result.messages?.length) continue;

      const messages = result.messages.reverse();

      for (const msg of messages) {
        if (msg.ts > getLastChecked(channelId)) {
          setLastChecked(channelId, msg.ts);
        }

        // LOGIC CHANGE 2026-03-26: Check if message sender is authorized before
        // processing TASK: or ASK: messages. Unauthorized users are logged and skipped.
        if ((isTaskMessage(msg) || isConversationMessage(msg)) && !isUserAuthorized(msg.user)) {
          console.log(`[bridge-agent] Ignoring message from unauthorized user: ${msg.user}`);
          continue;
        }

        // LOGIC CHANGE 2026-03-27: TASK: messages always go to bridge agent regardless of channel.
        // This allows tasks to be submitted from any agent channel but always use bridge for execution.
        if (isTaskMessage(msg) && !alreadyProcessed(msg)) {
          console.log(`[bridge-agent] Task found in ${agentId} channel: ${msg.ts}`);
          isRunning = true;

          // LOGIC CHANGE 2026-03-27: Track current task promise for graceful shutdown.
          // Allows shutdown handler to wait for task completion.
          // Pass channel context for proper message linking
          currentTaskPromise = processTask(msg, channelId);
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

        // LOGIC CHANGE 2026-03-27: ASK: messages are routed to the agent that owns the channel.
        // Each agent processes conversations with its own personality and system_prompt.
        if (isConversationMessage(msg) && !alreadyProcessed(msg)) {
          await processConversation(msg, channelId, channelAgentConfig);
        }
      }
    } catch (err) {
      // LOGIC CHANGE 2026-03-27: Log channel-specific poll errors but continue polling other channels.
      // A single channel error shouldn't block the entire poll loop.
      console.error(`[bridge-agent] Poll error for channel ${channelId} (${agentId}):`, err.message);
    }
  }

  isRunning = false;
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

    // LOGIC CHANGE 2026-03-27: Clear stale "running" tasks in working.json on startup.
    // Any task with status "running" was interrupted by a restart and should be marked "interrupted".
    try {
      const workingPath = path.join(__dirname, 'agents', 'bridge', 'memory', 'working.json');
      if (fs.existsSync(workingPath)) {
        const raw = fs.readFileSync(workingPath, 'utf8');
        if (raw && raw.trim()) {
          let working;
          try {
            working = JSON.parse(raw);
          } catch (parseErr) {
            console.warn('[bridge-agent] working.json corrupted, resetting to empty array');
            working = [];
          }
          if (Array.isArray(working)) {
            let cleared = 0;
            for (const entry of working) {
              if (entry && entry.content && entry.content.status === 'running') {
                entry.content.status = 'interrupted';
                cleared++;
              }
            }
            if (cleared > 0) {
              fs.writeFileSync(workingPath, JSON.stringify(working, null, 2), 'utf8');
              console.log(`[bridge-agent] Cleared ${cleared} stale running task(s) in working.json`);
            }
          }
        }
      }
    } catch (wErr) {
      console.error('[bridge-agent] Failed to clear stale working memory:', wErr.message);
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

// LOGIC CHANGE 2026-03-27: Build list of channels to poll on startup.
// Always includes bridge channel. Adds channels for all active agents that have
// a channel assigned. Returns array of { channelId, agentId, agentConfig }.
function buildChannelsToPoll() {
  const channels = [];

  // Always include bridge channel (for TASK: messages and bridge agent)
  channels.push({
    channelId: BRIDGE_CHANNEL,
    agentId: 'bridge',
    agentConfig: agentConfig,
  });

  // Add channels for all active agents (those without status="planned")
  try {
    const activeAgents = getActiveAgents();
    for (const agent of activeAgents) {
      // Skip bridge agent (already added) and agents without channels
      if (agent.id === 'bridge' || !agent.channel) {
        continue;
      }
      // Skip if channel is same as bridge (some agents share channels)
      if (agent.channel === BRIDGE_CHANNEL) {
        continue;
      }
      // Check if this channel is already in the list (multiple agents may share a channel)
      const existing = channels.find(c => c.channelId === agent.channel);
      if (!existing) {
        channels.push({
          channelId: agent.channel,
          agentId: agent.id,
          agentConfig: agent,
        });
      }
    }
  } catch (err) {
    console.error('[bridge-agent] Failed to load active agents:', err.message);
    // Continue with just the bridge channel
  }

  return channels;
}

console.log('[bridge-agent] Starting v2');

// LOGIC CHANGE 2026-03-27: Rate limit state is in-memory only — never persisted
// to disk. The variable is initialised at declaration so every PM2 restart
// automatically gives the bot a fresh start with no stale pause state.
// No memory.updateContext/loadContext calls needed here.
console.log('[bridge-agent] Startup: rate limit state is in-memory only, cleared on every restart');

// LOGIC CHANGE 2026-03-27: Build channels to poll from active agents.
channelsToPoll = buildChannelsToPoll();

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
console.log(`  Channels: ${channelsToPoll.length} (${channelsToPoll.map(c => c.agentId).join(', ')})`);

// Run memory maintenance before starting poll loop
runStartupMemoryMaintenance();

// LOGIC CHANGE 2026-03-28: Start the agent scheduler for cron-based proactive tasks.
// Each agent with a schedule field gets a cron job that posts TASK messages to their channel.
const schedulerResult = startScheduler(slack);
console.log(`  Scheduler: ${schedulerResult.jobCount} jobs (${schedulerResult.agents.join(', ') || 'none'})`);

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

  // LOGIC CHANGE 2026-03-28: Stop the agent scheduler on shutdown.
  try {
    stopScheduler();
  } catch (err) {
    console.error('[bridge-agent] Failed to stop scheduler:', err.message);
  }

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
