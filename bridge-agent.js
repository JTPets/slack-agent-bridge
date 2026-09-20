#!/usr/bin/env node
// LOGIC CHANGE 2026-03-27: Load .env file on startup so a restarted process retains
// its env vars. LOGIC CHANGE 2026-09-14: was "so PM2 restarts retain env vars" - the
// reason is unchanged, the supervisor named was not this one. The `jt-agent` container
// has no pm2; it restarts via the container runtime's `restart: unless-stopped`.
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
 * Run:
 *   node bridge-agent.js
 * In the deployment this is the container's `command:` - there is no process manager
 * inside the `jt-agent` image. A restart is `docker compose restart jt-agent` on the
 * NAS (`up -d --force-recreate` for an .env change). See CLAUDE.md -> Commands.
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
// LOGIC CHANGE 2026-09-14: `const { execSync } = require('child_process')` removed.
// It was left behind when the git/clone lifecycle moved to lib/clone-lifecycle.js
// (seam A) and had no remaining use in this file — a dead import of the one API in
// the codebase that executes a shell command string. Keeping it around is an
// invitation: the next `execSync(...)` written here would need no new require to
// look at home. tests/no-shell-execution.test.js now fails on the import itself.
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
// LOGIC CHANGE 2026-04-01: Added isNaturalConversationMessage for natural language
// routing when NATURAL_CONVERSATION_MODE is enabled.
const {
  parseTask,
  isTaskMessage,
  isConversationMessage,
  isNaturalConversationMessage,
  isStatusQuery,
  isCreateChannelCommand,
  parseCreateChannelCommand,
  // LOGIC CHANGE 2026-04-01: Added approval queue command imports.
  isApprovalQuery,
  isApproveCommand,
  parseApproveCommand,
  isRejectCommand,
  parseRejectCommand,
  isShowTaskCommand,
  parseShowTaskCommand,
  alreadyProcessed,
} = require('./lib/task-parser');

// LOGIC CHANGE 2026-03-26: Extracted config loading and validation into
// lib/config.js for centralized env var management.
// LOGIC CHANGE 2026-03-26: Import isUserAuthorized from config for user
// authorization checks in the poll loop.
const { config, validate, isUserAuthorized, resolveLlmProvider } = require('./lib/config');

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

// LOGIC CHANGE 2026-09-15: the pure rule for "which channels does the bridge join".
// It lives in lib/agent-surface.js beside the rest of the agent-surface enumeration,
// so scripts/agent-surface.js reports the same set this file acts on.
const { joinableChannels, activeChannels } = require('./lib/agent-surface');
// LOGIC CHANGE 2026-09-15: channel-name resolution at startup. Find-only — it never
// creates a channel; see lib/agent-activation.js.
const { resolveAgentChannel } = require('./lib/agent-activation');

// LOGIC CHANGE 2026-09-15: THE verb -> handler table. It sources its deterministic
// verbs from lib/agent-task-catalogue.js rather than redeclaring them, because a
// scheduled job and an on-demand command are the same operation triggered
// differently. Guarded by tests/command-router.test.js.
const commandRouter = require('./lib/command-router');

// LOGIC CHANGE 2026-03-26: Extracted LLM execution into lib/llm-runner.js
// to support multiple LLM providers via LLM_PROVIDER env var.
// LOGIC CHANGE 2026-03-26: Import RateLimitError for detecting rate limit
// errors and implementing pause/retry behavior.
// LOGIC CHANGE 2026-03-27: Import BandwidthExhaustedError for bandwidth-specific
// handling when Claude CLI exits with code 1 and empty/short output.
// LOGIC CHANGE 2026-09-13: Import runWithFallback and use it for both LLM call
// sites below. It had zero non-test callers, so the claude -> gemini failover
// documented in CLAUDE.md/README/.env.example never actually ran - which is why
// a stale CLAUDE_BIN took three agents down with no fallback, and why the
// llm-metrics fallback_reason counter could only ever record null.
const { runWithFallback, RateLimitError, BandwidthExhaustedError, validateGeminiOnStartup, validateOllamaOnStartup } = require('./lib/llm-runner');

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

// LOGIC CHANGE 2026-03-28: Added code-review-pipeline module for Phase 1/2/3 task execution.
// Phase 1: reviewTask reads codebase before executing. Phase 2: buildPrompt assembles enriched
// prompt with COMMANDMENTS + CLAUDE.md + structure + context. Phase 3: validateOutput runs tests.
const { reviewTask, createExecutionPlan, buildPrompt, validateOutput } = require('./lib/code-review-pipeline');

// LOGIC CHANGE 2026-04-01: Added task-queue module for persistent task queueing.
// Tasks are queued on disk before execution, so auto-update can see in-flight work
// and defer rather than restart into it.
// LOGIC CHANGE 2026-09-14: PM2 removed from this comment's prose (it read "before
// restarting PM2"). Same removal as lib/task-queue.js's header: naming a supervisor
// this deployment does not have described a mechanism that does not exist. The
// auto-update half is also not live - nothing starts auto-update.js.
const taskQueue = require('./lib/task-queue');
const taskLock = require('./lib/task-lock');
// LOGIC CHANGE 2026-09-20: DRAIN-ONE. The poll loop refuses a new dispatch while a
// self-update is waiting to apply, so the update waits for ONE task rather than for
// however long work keeps arriving. See lib/update-drain.js.
const updateDrain = require('./lib/update-drain');

// LOGIC CHANGE 2026-03-28: Added agent-context module for injecting real data into ASK prompts.
// Prevents hallucination by giving agents (especially secretary) actual calendar events,
// owner tasks, and bulletins instead of letting them invent fake data.
const agentContext = require('./lib/agent-context');

// LOGIC CHANGE 2026-04-01: Added approval-queue module for manual approval of auto-generated tasks.
// Auto-generated tasks (security findings, email actions) are queued for owner approval
// instead of executing immediately. This prevents prompt injection attacks.
const approvalQueue = require('./lib/approval-queue');

// LOGIC CHANGE 2026-09-13: Redact secrets from any text before it reaches Slack
// or the logs. Guards the stderr-surfacing path (a child process's stderr could
// echo live tokens) and every #sqtools-ops post via postToOps().
const { redact } = require('./lib/redact-secrets');

// LOGIC CHANGE 2026-09-14: Extracted the git/clone lifecycle (cloneRepo,
// cleanupDir, detectUndeliveredWork) into lib/clone-lifecycle.js — seam A in
// docs/WIRING-AND-SEAMS.md. Pure fs/execFileSync helpers with no bridge state.
const { cloneRepo, cleanupDir, detectUndeliveredWork } = require('./lib/clone-lifecycle');

// LOGIC CHANGE 2026-09-20: install the target repo's own dependencies in the scratch
// clone before the LLM runs. Without this, Phase-3's test command found no node_modules
// and could only ever classify runner_absent — every repo dispatch's verification was
// vacuous (WORK-TODO #61). An install failure is a HARNESS failure that stops the
// dispatch; see lib/dependency-install.js.
const { installDependencies } = require('./lib/dependency-install');

// LOGIC CHANGE 2026-09-14: Additive Slack Socket Mode connection for slash commands.
// It does NOT carry messages: the poll loop below is untouched and remains the only
// path a TASK:/ASK: message arrives on. See lib/slack-socket.js and
// docs/WIRING-AND-SEAMS.md section 7.
// LOGIC CHANGE 2026-09-15: The command seam is now attached to. `/dispatch` opens a
// five-input modal and its submission is composed into a task message that is POSTED
// TO THE BRIDGE CHANNEL — poll() then picks it up like any other message. The task
// path is not called directly: one intake path, one dedup owner, and a task that
// survives a restart because it exists as a message.
const { startSocketMode } = require('./lib/slack-socket');
const { handleSlashCommand, handleViewSubmission } = require('./lib/dispatch-command');

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
  BOT_USER_ID,
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

// LOGIC CHANGE 2026-09-14: Extracted file-backed state persistence into
// lib/bridge-state.js — seam B in docs/WIRING-AND-SEAMS.md. That module is the
// single owner of .bridge-agent-state.json (per-channel poll cursors) and
// agents/shared/processed-tasks.json (task-dedup timestamps); bridge-agent now
// reaches both only through the exported accessors. init() loads both files and
// is handed BRIDGE_CHANNEL so it can migrate the legacy single-channel format.
const bridgeState = require('./lib/bridge-state');
bridgeState.init({ bridgeChannel: BRIDGE_CHANNEL });
const {
  getLastChecked,
  setLastChecked,
  isTaskProcessed,
  markTaskProcessed,
  cleanupProcessedTasks,
} = bridgeState;

let isRunning = false;

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

// LOGIC CHANGE 2026-09-20: returns whether the post actually landed. It previously
// returned undefined on both paths, so a caller could not tell a delivered message
// from a swallowed one even when it mattered — and on the task path it matters: the
// interruption notice IS that task's result. Existing callers ignore the value and
// are unaffected; the behaviour on failure is unchanged (log, never throw), because
// a Slack outage must not fail the work that was reporting through it.
async function postToOps(text) {
  try {
    await slack.chat.postMessage({
      channel: OPS_CHANNEL,
      // LOGIC CHANGE 2026-09-13: Redact secrets at the choke point so no ops
      // post can leak a live token, regardless of how the caller built `text`.
      text: redact(text),
      unfurl_links: false,
    });
    return true;
  } catch (err) {
    console.error('[bridge-agent] Failed to post to #sqtools-ops:', err.message);
    return false;
  }
}

// ---- Drain-one: is a self-update waiting? ----

// LOGIC CHANGE 2026-09-20: one-shot so an unexpected throw in the drain check is
// reported to a human once, not once per message per poll. The console line is not
// rate-limited — a container log can afford the repetition, #sqtools-ops cannot.
let drainCheckFailureReported = false;

/**
 * Should the next dispatch be refused because a self-update is pending?
 *
 * Also sweeps an ORPHANED marker on the way past. That sweep is not a ceiling on how
 * long an update may wait — a live updater refreshes its marker every check interval,
 * so a marker whose heartbeat stopped belongs to a process that is gone, and honouring
 * it would leave the bridge silently accepting no work at all for an update that is
 * never coming. It is surfaced, never silent (lib/update-drain.js builds the verdict;
 * this posts it).
 *
 * Degrades OPEN, deliberately. If the check itself throws, dispatches are accepted —
 * which is exactly the behaviour that existed before drain-one. Refusing every task
 * forever because a marker file could not be parsed would be a worse outcome than the
 * race drain-one exists to close, and it would be indistinguishable from a dead bridge.
 *
 * @returns {{ refuse: boolean, state: object }}
 */
function drainStateForDispatch() {
  try {
    const sweep = updateDrain.clearIfStale();
    if (sweep.verdict) {
      postToOps(`:unlock: ${sweep.verdict}`).catch(postErr => {
        console.error('[bridge-agent] Failed to post stale pending-update verdict:', postErr.message);
      });
    }

    const state = updateDrain.inspect();
    // A stale marker that could NOT be removed still does not refuse: its verdict
    // above already told a human the file needs removing by hand.
    return { refuse: state.pending && !state.stale, state };
  } catch (err) {
    console.error('[bridge-agent] Pending-update check threw; accepting dispatches:', err.message);
    if (!drainCheckFailureReported) {
      drainCheckFailureReported = true;
      postToOps(
        `:warning: *The pending-update check threw* — ${err.message}\n` +
        `Dispatches are being ACCEPTED (the behaviour before drain-one existed), so a self-update ` +
        `could restart a task that starts from now on. Reported once per process.`
      ).catch(postErr => {
        console.error('[bridge-agent] Failed to post drain-check failure:', postErr.message);
      });
    }
    return { refuse: false, state: { pending: false, stale: false, commit: null } };
  }
}

// ---- Task parsing ----
// Functions moved to lib/task-parser.js: parseTask, isTaskMessage, isConversationMessage, alreadyProcessed

// ---- Git helpers ----
// LOGIC CHANGE 2026-09-14: cloneRepo, cleanupDir, and detectUndeliveredWork moved
// to lib/clone-lifecycle.js (seam A). They are imported at the top of this file.

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
// to be removed before restarting, to avoid interrupting running tasks.
// LOGIC CHANGE 2026-09-14: "restarting PM2" -> "restarting". There is no pm2 here.
// LOGIC CHANGE 2026-09-14: The file is now owned by lib/task-lock.js, which adds
// the staleness rule this lock never had. A `finally` does not run when the
// process is killed - which is exactly what a self-update does - so a lock left
// behind by a killed task was previously never cleaned up by anything. The path
// stays here because it is passed to the module; the read/write/expiry logic does not.
const TASK_LOCK_FILE = taskLock.DEFAULT_LOCK_FILE;

// LOGIC CHANGE 2026-03-27: Added sourceChannel parameter for multi-channel support.
// Tasks can be submitted from any agent channel but always execute with bridge agent.
// LOGIC CHANGE 2026-04-01: Added queueId parameter for task queue integration.
// Queue status is updated on task completion/failure for auto-update coordination.
async function processTask(msg, sourceChannel = BRIDGE_CHANNEL, queueId = null, handlingAgent = null) {
  // LOGIC CHANGE 2026-09-15: a task executes as the agent it was addressed to.
  // WORK-TODO #38: `agentConfig` is bound ONCE at module scope to getAgent('bridge')
  // and never rebound, and until now processTask read it directly while
  // processConversation already took the channel's agent as a parameter. So every
  // TASK: message - including one a scheduled agent's own cron job posted into its
  // own channel - ran with the BRIDGE's persona, provider, model and metrics
  // identity. Defining agents separately bought nothing on the path that does the
  // work.
  //
  // This is deliberately NOT a third mechanism: it is the SAME `handlingAgent ||
  // agentConfig` fallback processConversation has used since 2026-03-27, with the
  // same `|| 'bridge'` arm for a registry that failed to load, and the poll loop now
  // passes the same `channelAgentConfig` to both.
  //
  // What follows the resolved agent, and what deliberately does not, is enumerated
  // at each site below and in the commit body. The short version: the agent decides
  // its own IDENTITY (persona, provider, model, metrics id, bulletin voice, working
  // memory). It does not decide the ORCHESTRATOR's bookkeeping (the queue, the lock,
  // the ops channel, the owner's action inbox, the global task history).
  const currentAgent = handlingAgent || agentConfig;
  const currentAgentId = currentAgent?.id || 'bridge';

  const task = parseTask(msg.text);
  const startTime = Date.now();
  let taskDir = null;
  let taskSuccess = false;
  // LOGIC CHANGE 2026-09-14: Phase 3 used to run a hardcoded `npm test` while Phase 1
  // had already read the repo's own `scripts.test` into the plan and thrown it away.
  // A repo whose test script is anything else had its declared suite ignored and a
  // different command scored as its gate. Captured here because the plan is
  // block-scoped inside the Phase-1 try and Phase 3 runs long after it.
  let taskTestScript = 'npm test';

  // LOGIC CHANGE 2026-03-27: Create heartbeat for visual progress feedback.
  // Cycles through emojis while task runs. Wrapped in try/catch so heartbeat
  // failures never affect task execution.
  // Uses sourceChannel to add reactions to the correct channel's message.
  const heartbeat = createHeartbeat(slack, sourceChannel, msg.ts);

  // LOGIC CHANGE 2026-03-27: Create task lock file to signal to auto-update.js
  // that a task is running. Auto-update will wait for this file to be removed
  // before restarting, to avoid interrupting running tasks.
  // LOGIC CHANGE 2026-09-14: "restarting PM2" -> "restarting". There is no pm2 here.
  // Best effort: a task that cannot write its lock still runs. A missing lock
  // risks an interrupting restart, which beats refusing to do the work at all.
  const lockResult = taskLock.acquire({
    msgTs: msg.ts,
    description: task.description,
    lockFile: TASK_LOCK_FILE,
  });
  if (!lockResult.acquired) {
    console.error(
      `[bridge-agent] Running without a task lock (${lockResult.error}) - ` +
      `a self-update during this task will not defer for it`
    );
  }

  // LOGIC CHANGE 2026-09-14: Mark the queue entry RUNNING here, beside the lock.
  // The lock and the queue both answer "is a task running?" and were out of step:
  // the lock was written around the task, but the queue went straight from
  // `pending` to `completed`/`failed` with no transition in between, because
  // dequeue() - the only writer of STATUS.RUNNING - had no production caller. Every
  // completed entry therefore carried `startedAt: null`, and recoverInterrupted()
  // returned 0 at every startup, so a task killed mid-run was never recorded as
  // interrupted. See WORK-TODO P1 #18.
  //
  // markRunning(queueId), not dequeue(): the id is already known here, and
  // dequeue()'s "first pending entry" search would pick the wrong entry whenever a
  // second one is pending. Best effort, like the lock - a queue write that fails
  // must not stop the work; but it is logged, never swallowed.
  if (queueId) {
    try {
      taskQueue.getQueue().markRunning(queueId);
    } catch (queueErr) {
      console.error('[bridge-agent] Queue markRunning failed:', queueErr.message);
    }
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

  // LOGIC CHANGE 2026-04-01: Determine LLM provider early so it's available in catch block
  // for error notifications. Falls back to env LLM_PROVIDER or 'claude'.
  // LOGIC CHANGE 2026-09-13: resolveLlmProvider adds a per-agent LLM_PROVIDER_<AGENTID>
  // env override (highest precedence) so on-box provider config in .env survives a pull.
  const llmProvider = resolveLlmProvider(currentAgent, currentAgentId);

  try {
    // LOGIC CHANGE 2026-09-14: Refuse a task whose fields parseTask rejected before
    // any work starts. parseTask validates REPO:/BRANCH:/SKILL: at the boundary and
    // records rejections in task.errors instead of quietly dropping them; running
    // the task anyway would clone the wrong repo, or run with no repo at all, and
    // nobody would be told. Throwing here routes to this function's catch, which
    // posts the reason to Slack and reacts with the failure emoji.
    if (task.errors && task.errors.length > 0) {
      throw new Error(`Task message rejected: ${task.errors.join('; ')}`);
    }

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

      // LOGIC CHANGE 2026-09-20: install the clone's dependencies BEFORE the LLM runs
      // (WORK-TODO #61). This is what makes Phase 3's test gate real: `npm test` in a
      // clone with no node_modules exits 127 (`jest: not found`), which validateOutput
      // can only ever score runner_absent — so verification has never once run against
      // work a dispatch produced. Pre-LLM and fail-hard by decision: an agent that
      // cannot install can still write a branch it cannot verify, which puts the owner
      // back to merging on a claim. An install failure is a HARNESS failure (the bridge
      // is broken), classified and reported distinctly from a test failure (the branch
      // is broken) and a timeout — never collapsed into one. A repo with no recognised
      // manifest installs nothing and proceeds (research/audit and no-dependency tasks).
      const install = installDependencies(taskDir);
      if (install.harnessFailure) {
        await postToOps(
          `:rotating_light: *Dispatch stopped — HARNESS failure (install), not a code failure.*\n` +
          `Task: ${task.description}\n` +
          `Repo: ${task.repo} (branch: ${task.branch}) — ecosystem: \`${install.ecosystem}\`\n` +
          `Outcome: \`${install.outcome}\`\n${install.reason}\n` +
          `No branch was produced: the bridge could not prepare the clone, so nothing was verified.\n` +
          `\`\`\`\n${(install.output || '').trim().slice(-1200)}\n\`\`\`\n` +
          `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
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
      // LOGIC CHANGE 2026-09-15: the EXECUTING agent's prompt, not the bridge's.
      const agentSystemPrompt = currentAgent?.system_prompt || '';

      // LOGIC CHANGE 2026-03-28: Phase 1 of code review pipeline.
      // reviewTask reads CLAUDE.md, repo structure, git history, and relevant files
      // to give Claude rich context before it executes. buildPrompt assembles everything
      // in the correct order so Claude follows project rules and avoids duplicate work.
      let usingPipelinePrompt = false;
      try {
        const pipelineContext = reviewTask(task, taskDir);
        const pipelinePlan = createExecutionPlan(task, pipelineContext);
        taskTestScript = pipelinePlan.testScript || taskTestScript;

        if (pipelinePlan.skip) {
          // Task already done - report and exit without running LLM
          await postToOps(
            `:white_check_mark: *Already implemented:* ${pipelinePlan.reason}\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
          await react(sourceChannel, msg.ts, EMOJI_DONE);
          taskSuccess = true;
          return;
        }

        // Build memory and bulletin context for the prompt
        let memoryContext = '';
        try {
          memoryContext = memory.buildTaskContext() || '';
        } catch (ctxErr) {
          console.error('[bridge-agent] buildTaskContext failed:', ctxErr.message);
        }

        let bulletinContextStr = '';
        try {
          // LOGIC CHANGE 2026-09-15: the executing agent's view of the stream.
          // processConversation has always passed its own agentId here; this site
          // was hardcoded to 'bridge', so a task ran against the bridge's unread set.
          bulletinContextStr = bulletinBoard.formatBulletinsForContext(currentAgentId, 10);
        } catch (bErr) {
          console.error('[bridge-agent] formatBulletinsForContext failed:', bErr.message);
        }

        // Load COMMANDMENTS.md from project root (host, not cloned repo)
        let commandmentsContent = '';
        try {
          const commandmentsPath = path.join(__dirname, 'COMMANDMENTS.md');
          if (fs.existsSync(commandmentsPath)) {
            commandmentsContent = fs.readFileSync(commandmentsPath, 'utf8');
          }
        } catch (cmdErr) {
          console.warn('[bridge-agent] Could not read COMMANDMENTS.md:', cmdErr.message);
        }

        prompt = buildPrompt(task, pipelineContext, pipelinePlan, {
          commandmentsContent,
          agentSystemPrompt,
          productionWarning,
          skillContent,
          memoryContext,
          bulletinContext: bulletinContextStr,
          repoRef: `${task.repo} (branch: ${task.branch})`,
        });
        usingPipelinePrompt = true;
        console.log('[bridge-agent] Using pipeline-enriched prompt for task:', task.description);
      } catch (pipelineErr) {
        console.error('[bridge-agent] Code review pipeline failed, falling back to basic prompt:', pipelineErr.message);
      }

      if (!usingPipelinePrompt) {
        // Fallback: basic prompt assembly (original behavior)
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
      }
    } else {
      // No repo specified, run in work dir
      // LOGIC CHANGE 2026-03-27: Also prepend system_prompt for non-repo tasks.
      // LOGIC CHANGE 2026-09-15: the executing agent's, not the bridge's.
      const agentSystemPrompt = currentAgent?.system_prompt || '';
      prompt = agentSystemPrompt
        ? `${agentSystemPrompt}\n\n${task.instructions || task.description}`
        : (task.instructions || task.description);
    }

    // LOGIC CHANGE 2026-03-26: Prepend task context from memory to help CC avoid
    // duplicate work and build on previous results. Context failure never blocks
    // task execution. Skip when using pipeline prompt (already included).
    // LOGIC CHANGE 2026-03-28: usingPipelinePrompt flag prevents double-adding context.
    if (!task.repo) {
      // LOGIC CHANGE 2026-09-15: inject the EXECUTING AGENT'S OWN DATA on the no-repo
      // task path, the same data lib/agent-context.js already injects on the ASK:
      // path. `buildEnrichedPrompt` has exactly one production caller —
      // processConversation — so until now everything that module does was reachable
      // from ASK: and from nothing else. A scheduled agent's own TASK: therefore got
      // the agent's personality and none of its facts: story-bot's Friday job is
      // literally "draft posts about this week's milestones", and it was never told
      // what they were. Drafting from nothing is the hallucination agent-context.js
      // was written to prevent, on the one path that runs unattended.
      //
      // Scoped to no-repo tasks deliberately. A repo task's prompt is assembled by
      // the code-review pipeline in a specific order (COMMANDMENTS -> system_prompt
      // -> CLAUDE.md -> memory -> bulletins -> repo structure -> ...); inserting into
      // that is a prompt-composition change with its own review. The no-repo branch
      // is `system_prompt + instructions` plus the memory context below, and is
      // exactly where a scheduled agent task lands.
      //
      // `generic: false`, so an agent with no builder contributes nothing rather than
      // a line saying it has nothing. Never blocks the task: failures are logged.
      try {
        const agentData = await agentContext.buildAgentDataContext(currentAgentId);
        if (agentData) {
          prompt = agentData + '\n\n' + prompt;
        }
      } catch (agentCtxErr) {
        console.error('[bridge-agent] buildAgentDataContext failed:', agentCtxErr.message);
      }

      try {
        const taskContext = memory.buildTaskContext();
        if (taskContext) {
          prompt = taskContext + '\n\n' + prompt;
        }
      } catch (contextErr) {
        console.error('[bridge-agent] buildTaskContext failed:', contextErr.message);
        // Continue without context - never block task execution
      }
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
    // LOGIC CHANGE 2026-09-13: resolveLlmProvider layers a per-agent
    // LLM_PROVIDER_<AGENTID> env override on top so on-box .env config survives a pull.
    const llmProvider = resolveLlmProvider(currentAgent, currentAgentId);

    // LOGIC CHANGE 2026-09-13: Declare agentId in this scope. It was referenced in
    // the runLLM options below but never bound here, so evaluating that object
    // literal threw `ReferenceError: agentId is not defined` before the LLM was
    // ever spawned. That broke EVERY TASK: message - most visibly the scheduled
    // check-inbox job, which failed in zero seconds every 30 minutes.
    //
    // LOGIC CHANGE 2026-09-15: the source of the value has changed and the comment
    // that stood here is now WRONG rather than merely stale, so it is replaced. It
    // read "processTask always executes as the bridge agent ... which is why every
    // sibling option here - system_prompt, llm_provider, llm_model - reads the
    // module-level agentConfig". That was an accurate description of WORK-TODO #38,
    // which is what this change closes: all four now read the resolved
    // `currentAgent`, and `currentAgentId` is the same `|| 'bridge'` fallback for a
    // registry that failed to load.
    //
    // This id is the METRICS identity - it is what `recordVerdict` buckets a
    // provider/fallback verdict under (lib/llm-metrics.js). Leaving it on 'bridge'
    // while the provider followed the agent would have been the worst of both: every
    // agent's fallback rate billed to one counter, so the question the counter exists
    // to answer ("what fraction of the secretary's calls fell back?") would stay
    // unanswerable exactly when it started to differ per agent.
    const agentId = currentAgentId;

    while (retryCount <= 1) {
      try {
        // LOGIC CHANGE 2026-09-11: Pass the agent's optional llm_model and its id.
        // llm_model lets two agents share a provider with different models (a
        // router model and a workhorse model on the same local Ollama server).
        // agentId is what makes the per-agent fallback counter answerable.
        // LOGIC CHANGE 2026-09-13: runLLM -> runWithFallback. Same options, same
        // return shape, plus usedFallback/fallbackProvider. runWithFallback records
        // exactly one verdict per logical call, so the per-agent counter now
        // distinguishes "no fallback" from "never measured".
        result = await runWithFallback(prompt, {
          cwd,
          maxTurns: currentTurns,
          timeout: TASK_TIMEOUT,
          claudeBin: CLAUDE_BIN,
          provider: llmProvider,
          // LOGIC CHANGE 2026-09-15: the executing agent's model, not the bridge's.
          model: currentAgent?.llm_model,
          agentId,
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

    // LOGIC CHANGE 2026-04-01: Extract provider from result for LLM engine visibility.
    // LOGIC CHANGE 2026-09-13: Also pull signal/stderr the adapter now carries so
    // an interruption reports which signal killed it and any last stderr, not a
    // bare "exit code null".
    const { output, hitMaxTurns, interrupted, provider: usedProvider, signal, stderr: llmStderr } = result;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // LOGIC CHANGE 2026-03-27: Handle interrupted tasks (exit code null, e.g., container restart).
    // Do not count as failure, do not trigger rate limit. Just log and return.
    if (interrupted) {
      const signalNote = signal ? ` (${signal})` : '';
      // LOGIC CHANGE 2026-09-13: Redact stderr before it reaches the logs. The
      // Slack post is additionally scrubbed in postToOps, but console.log is a
      // separate sink that log aggregation ships off-box, so scrub here too.
      const safeStderr = llmStderr ? redact(llmStderr) : '';
      const stderrNote = safeStderr ? `\n\`\`\`\n${safeStderr.slice(-1000)}\n\`\`\`` : '';
      console.log(`[bridge-agent] Task interrupted${signalNote} - likely container restart${safeStderr ? `; stderr: ${safeStderr.slice(-500)}` : ''}`);
      // LOGIC CHANGE 2026-09-20: this post IS the interrupted task's result — there
      // is no other output to deliver — so its outcome is captured and recorded on
      // the queue entry below rather than discarded.
      const interruptDelivered = await postToOps(`:warning: Task interrupted${signalNote} (likely container restart) after ${elapsed}s.${stderrNote}\nSource: <${msgLink(msg.ts, sourceChannel)}|source>`);
      // stderrNote is built from safeStderr (already redacted); postToOps redacts again defensively.
      taskSuccess = true; // Don't mark as failure
      if (memoryTaskId) {
        try {
          memory.completeTask(memoryTaskId, { output: 'interrupted', elapsed: parseInt(elapsed, 10), interrupted: true });
        } catch (memErr) {
          console.error('[bridge-agent] Memory completeTask failed:', memErr.message);
        }
      }
      // LOGIC CHANGE 2026-09-14: Record the interruption in the queue HERE. The
      // comment this replaces said startup recovery would handle it - but this
      // branch runs in a process that is still alive and may never restart:
      // `interrupted` is set by lib/llm-runner.js for any `code === null` child
      // exit, which includes the TASK_TIMEOUT_MS hard kill. Now that the entry is
      // actually RUNNING by this point, leaving it would strand a phantom in-flight
      // task - reported by getRunning() forever, never expired by cleanup() (which
      // keeps every RUNNING entry), and counted as live work by auto-update's
      // deferral gate. recoverInterrupted() remains the backstop for the case this
      // cannot reach: the bridge process itself being killed.
      if (queueId) {
        try {
          taskQueue.getQueue().interrupt(
            queueId,
            `Task interrupted${signalNote} after ${elapsed}s (likely container restart)`,
            {
              delivered: interruptDelivered === true,
              detail: interruptDelivered === true
                ? 'interruption notice posted to the ops channel'
                : 'the interruption notice post to the ops channel failed',
            }
          );
        } catch (queueErr) {
          console.error('[bridge-agent] Queue interrupt failed:', queueErr.message);
        }
      }
      return;
    }

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task completion notification.
    // LOGIC CHANGE 2026-04-01: Pass llmProvider to surface which engine handled the task.
    //
    // LOGIC CHANGE 2026-09-20: the return value is no longer discarded. THIS IS THE
    // DELIVERY OF THE TASK'S RESULT and it is the only copy — `output` is a local
    // that is gone when this function returns, and `memory.completeTask` stores a
    // 500-character truncation, not the result. `notifyOwner.taskCompleted` returns
    // a BOOLEAN and `notifyChannel` returns false on a Slack failure instead of
    // throwing (lib/notify-owner.js), so a dropped return value meant a task whose
    // output reached nobody was written to the queue as `completed`, byte-identical
    // to one the owner read. That is the signal an update gate has to trust to know
    // a task is finished, so it is now recorded rather than assumed.
    const resultDelivered = await notifyOwner.taskCompleted(task, truncate(output), {
      elapsed,
      sourceLink: `<${msgLink(msg.ts, sourceChannel)}|source>`,
      llmProvider: usedProvider,
    });

    // Never a silent null: a failed delivery is announced (best effort — the ops
    // channel is where the result itself just failed to land, so this may fail too)
    // AND recorded durably on the queue entry below, which does not depend on Slack.
    if (!resultDelivered) {
      console.error(
        `[bridge-agent] Task ${msg.ts} finished but its RESULT WAS NOT DELIVERED to Slack. ` +
        `The output is not recoverable from this process.`
      );
      await postToOps(
        `:rotating_light: *Task finished but its result was not delivered.*\n` +
        `Task: ${task.description}\n` +
        `The completion post to this channel failed, so the task output reached nobody and is gone. ` +
        `Recorded as \`delivered: false\` on the queue entry.\n` +
        `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
      );
    }

    // LOGIC CHANGE 2026-03-27: Mark task as successful for heartbeat cleanup.
    taskSuccess = true;
    console.log(`[bridge-agent] Task ${msg.ts} done (${elapsed}s)`);

    // LOGIC CHANGE 2026-04-01: Mark task as completed in queue for auto-update coordination.
    // LOGIC CHANGE 2026-09-20: carries the delivery verdict. The terminal write stays
    // strictly AFTER the delivery above — that ordering is what makes "this entry is
    // terminal" mean "the result was delivered, or its loss was recorded", which is
    // the signal lib/update-drain.js gates a restart on. The ordering is asserted by
    // tests/task-delivery-signal.test.js, not left to this comment.
    if (queueId) {
      try {
        taskQueue.getQueue().complete(queueId, `Success in ${elapsed}s`, {
          delivered: resultDelivered === true,
          detail: resultDelivered === true
            ? 'task result posted to the ops channel'
            : 'the task result post to the ops channel failed',
        });
      } catch (queueErr) {
        console.error('[bridge-agent] Queue complete failed:', queueErr.message);
      }
    }

    // LOGIC CHANGE 2026-03-26: Clear rate limit state on successful task completion.
    // This resets the exponential backoff counter.
    await clearRateLimitState();

    // LOGIC CHANGE 2026-03-28: Phase 3 of code review pipeline.
    // Run tests and quality checks after execution. Post results to ops channel.
    // Tests failing here means Claude didn't run them properly — report as "needs-fix".
    if (task.repo && taskDir && fs.existsSync(taskDir)) {
      try {
        const validation = validateOutput(taskDir, { testScript: taskTestScript });
        const testRun = validation.testRun;

        // LOGIC CHANGE 2026-09-14: three outcomes, not two, and none of them is
        // silence. Previously a run that exited 0 without executing an assertion
        // scored `passed: true` with `testsPassed: 0`, which fell through BOTH arms
        // below and posted nothing at all - the gate reported a pass to its caller
        // and reported nothing to a human. A gate that cannot say which assertions
        // ran has not run (docs/EXECUTOR-CONTRACT.md section 4).
        if (!validation.passed && testRun && !testRun.ran) {
          // The runner never started, or nothing countable executed. This is not a
          // test failure and must not be read as one.
          await postToOps(
            `:rotating_light: *Code review: the test gate DID NOT RUN.*\n` +
            `Task: ${task.description}\n` +
            `Command: \`${taskTestScript}\` — outcome: \`${testRun.outcome}\`\n` +
            `${testRun.reason}\n` +
            `\`\`\`\n${validation.testOutput.slice(-1200)}\n\`\`\`\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
        } else if (!validation.passed) {
          await postToOps(
            `:warning: *Code review: tests failed after task completion.*\n` +
            `Task: ${task.description}\n` +
            `Failed: ${validation.testsFailed}, Passed: ${validation.testsPassed}\n` +
            `\`\`\`\n${validation.testOutput.slice(-1500)}\n\`\`\`\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
        } else {
          await postToOps(
            `:white_check_mark: *Code review passed* — ${validation.testsPassed} tests passing.\n` +
            `Task: ${task.description}\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
        }
        if (validation.warnings.length > 0) {
          await postToOps(
            `:mag: *Code review warnings:*\n${validation.warnings.map(w => `• ${w}`).join('\n')}\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
        }
      } catch (validErr) {
        console.error('[bridge-agent] Phase 3 validation error:', validErr.message);
        // LOGIC CHANGE 2026-09-14: a review that could not run is not a review that
        // passed. Previously this swallowed the throw and the task reported success
        // with no gate having been applied at all.
        await postToOps(
          `:rotating_light: *Code review did not complete* — the gate threw before reaching a verdict.\n` +
          `Task: ${task.description}\n${validErr.message}\n` +
          `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
        ).catch(postErr => {
          console.error('[bridge-agent] Could not post Phase 3 failure:', postErr.message);
        });
      }
    }

    // LOGIC CHANGE 2026-03-28: Post task completion bulletin for inter-agent awareness.
    // Other agents can see what tasks have been completed without watching ops channel.
    try {
      // Extract commit hash from output if present (look for common git commit patterns)
      let commitHash = null;
      const commitMatch = output.match(/\[([a-f0-9]{7,40})\]|commit\s+([a-f0-9]{7,40})/i);
      if (commitMatch) {
        commitHash = commitMatch[1] || commitMatch[2];
      }

      // LOGIC CHANGE 2026-09-15: posted AS the agent that did the work, not as the
      // bridge. This is not cosmetic: lib/bulletin-watcher.js:154 skips the poster
      // when fanning out, so a story-bot task posting as 'bridge' notified story-bot
      // about its OWN completion and left any bridge watcher silent - the fan-out
      // inverted. It is also what makes `[type] from <agentId>` in the notification,
      // and the bulletin stream every agent reads, say who actually ran.
      const bulletinResult = bulletinBoard.postBulletin(currentAgentId, 'task_completed', {
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
    //
    // LOGIC CHANGE 2026-09-15: DELIBERATELY still 'bridge', and it is the one
    // identity in this function that did NOT move to the executing agent. Two
    // reasons, in order of weight:
    //   1. This is the OWNER's action inbox, not the agent's identity. An ACTION
    //      REQUIRED item is something a human must do (add an env var, create a
    //      channel); which agent's task surfaced it is metadata, not ownership.
    //   2. Routing it by agent would add a SILENT DROP path to the one message class
    //      whose whole purpose is not to be lost: addTask() returns false, writing
    //      nothing and telling nobody, for an agent with no entry in
    //      agents/activation-checklists.json (lib/owner-tasks-store.js:243). Every
    //      agent declared today has one, so it would work today and fail silently
    //      for the next agent added - the worst shape of defect this repo files.
    // `getPendingTasks()` does aggregate across all agents
    // (lib/owner-tasks-store.js:77), so attribution is available if wanted later;
    // it needs addTask to refuse loudly first. Recorded in WORK-TODO #38's close.
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
    // LOGIC CHANGE 2026-09-13: Redact secrets from the error message before it
    // is logged or persisted. err.message embeds subprocess stderr (via
    // describeClaudeExit), which can carry an env dump with live tokens. The
    // Slack/DM path is scrubbed inside notifyOwner.taskFailed; console.error,
    // taskQueue.fail (writes task-queue.json), and memory.failTask are separate
    // sinks that must be scrubbed here.
    const safeErrMsg = redact(err.message);

    // LOGIC CHANGE 2026-03-27: Rate limit auto-pause disabled due to false positives killing tasks.
    // Manual restart is safer than auto-pausing on misdetection. If a task fails, it just fails.
    // No pausing the queue. handleRateLimit() is NOT called here anymore.
    // Will re-add rate limit handling when detection is properly calibrated.

    // LOGIC CHANGE 2026-03-26: Use notify-owner module for task failure notification.
    // Posts to ops channel and sends critical DM to owner.
    // LOGIC CHANGE 2026-04-01: Pass llmProvider to surface which engine was being used when task failed.
    // Uses the configured provider since the error occurred during LLM execution.
    // LOGIC CHANGE 2026-09-20: the return value is no longer discarded, for the same
    // reason as the completion path above. `taskFailed` returns
    // `{ opsPosted, ownerNotified }` (lib/notify-owner.js) and neither throws on a
    // Slack failure — a failure report that reached nobody was recorded as a clean
    // `failed` entry, which is the one message class that must not go quiet.
    // `opsPosted` is the delivery: the DM is a CRITICAL-priority escalation on top
    // of it, not a substitute, and it is false whenever no ownerId is configured.
    const failureReport = await notifyOwner.taskFailed(task, err, {
      elapsed,
      sourceLink: `<${msgLink(msg.ts, sourceChannel)}|source>`,
      llmProvider: llmProvider || 'claude',
    });
    const failureDelivered = failureReport?.opsPosted === true
      || failureReport?.ownerNotified === true;
    if (!failureDelivered) {
      console.error(
        `[bridge-agent] Task ${msg.ts} FAILED and the failure report reached nobody ` +
        `(ops post and owner notification both failed).`
      );
    }

    // LOGIC CHANGE 2026-03-27: taskSuccess remains false, heartbeat.stop(false)
    // will add :x: emoji in finally block.
    console.error(`[bridge-agent] Task ${msg.ts} failed (${elapsed}s):`, safeErrMsg);

    // LOGIC CHANGE 2026-04-01: Mark task as failed in queue for auto-update coordination.
    // LOGIC CHANGE 2026-09-20: carries the delivery verdict for the failure report,
    // after the report above, for the reason given at the completion path.
    if (queueId) {
      try {
        taskQueue.getQueue().fail(queueId, safeErrMsg, {
          delivered: failureDelivered,
          detail: failureDelivered
            ? 'failure report posted to the ops channel or DMed to the owner'
            : 'the failure report reached neither the ops channel nor the owner',
        });
      } catch (queueErr) {
        console.error('[bridge-agent] Queue fail failed:', queueErr.message);
      }
    }

    // LOGIC CHANGE 2026-03-26: Record task failure in memory.
    if (memoryTaskId) {
      try {
        memory.failTask(memoryTaskId, safeErrMsg);
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

    // LOGIC CHANGE 2026-09-13: Only clean up the scratch clone once its work has
    // been delivered (pushed to the remote). Deleting a clone that still holds
    // uncommitted changes or unpushed commits silently destroys finished work —
    // the failure that lost three tasks before the deploy key was wired. When
    // work is undelivered, preserve the clone and alert #sqtools-ops so it can be
    // recovered and pushed manually, rather than deleting it.
    if (taskDir && fs.existsSync(taskDir)) {
      const delivery = detectUndeliveredWork(taskDir);
      if (delivery.undelivered) {
        console.warn(`[bridge-agent] Preserving scratch clone ${taskDir} — ${delivery.reason}`);
        try {
          await postToOps(
            `:warning: *Scratch clone preserved — undelivered work.*\n` +
            `Task: ${task.description}\n` +
            `Reason: ${delivery.reason}\n` +
            `Location: \`${taskDir}\`\n` +
            `The clone was NOT deleted so the work can be recovered and pushed manually.\n` +
            `Source: <${msgLink(msg.ts, sourceChannel)}|source>`
          );
        } catch (postErr) {
          console.error('[bridge-agent] Failed to post undelivered-work alert:', postErr.message);
        }
      } else {
        cleanupDir(taskDir);
      }
    }

    // LOGIC CHANGE 2026-03-27: Clear working memory at end of each task to prevent
    // accumulation of stale "running" entries that never get cleared.
    try {
      // LOGIC CHANGE 2026-09-15: clear the EXECUTING agent's working memory. Each
      // agent has its own memory dir (agents/<id>/memory), so clearing 'bridge'
      // after a story-bot task both left story-bot's stale entries in place and
      // wiped a directory the task never wrote to.
      memory.clearAgentWorkingMemory(currentAgentId);
    } catch (memErr) {
      console.error('[bridge-agent] Failed to clear working memory:', memErr.message);
    }

    // LOGIC CHANGE 2026-03-27: Remove task lock file to signal task completion.
    // Auto-update.js waits for this file to be removed before restarting.
    // LOGIC CHANGE 2026-09-14: Delegated to lib/task-lock.js, which logs the
    // release and reports a failed unlink rather than swallowing it. A lock that
    // survives this block is now aged out by the staleness rule instead of
    // blocking every future deploy.
    const releaseResult = taskLock.release(TASK_LOCK_FILE);
    if (releaseResult.existed && !releaseResult.released) {
      console.error(
        `[bridge-agent] Task lock ${TASK_LOCK_FILE} could not be removed ` +
        `(${releaseResult.error}); it will be aged out by the staleness rule`
      );
    }
  }
}

// ---- Status query handling ----

// LOGIC CHANGE 2026-03-26: Added formatStatusResponse() to build a human-readable
// status message from memory data. Shows currently running task, queued tasks,
// and last 5 completed tasks with elapsed time.
// LOGIC CHANGE 2026-03-26: Added rate limit status display when queue is paused.
// LOGIC CHANGE 2026-04-01: Updated to use task queue for more accurate status.
function formatStatusResponse() {
  // Use task queue for current status (more accurate than memory)
  const queue = taskQueue.getQueue();
  const queueStatus = queue.getStatus();
  const running = queue.getRunning();
  const pending = queue.getPending();
  const recentCompleted = queue.getRecentCompleted(5);

  let response = '';

  // LOGIC CHANGE 2026-03-26: Show rate limit status at the top if active.
  if (isRateLimitPaused()) {
    const resumeTime = getPauseResumeTime();
    const waitingCount = queueStatus.pending + (rateLimitState.failedTask ? 1 : 0);
    response += `:warning: *Queue paused due to rate limit.*\n`;
    response += `Resumes at ${resumeTime}. ${waitingCount} task(s) waiting.\n`;
    response += `Retry attempt: ${rateLimitState.retryCount}\n\n`;
  }

  // Currently running task
  if (running) {
    const startedAt = new Date(running.startedAt);
    const minutesAgo = Math.round((Date.now() - startedAt.getTime()) / 60000);
    response += `*Currently running:* ${running.description || 'No description'} (started ${minutesAgo} min ago)\n`;
  } else {
    response += `*Currently running:* none\n`;
  }

  // Queued tasks
  if (pending.length > 0) {
    response += `*Queued:* ${pending.length} task(s)\n`;
    for (const task of pending.slice(0, 5)) {
      response += `  • ${task.description || 'No description'}\n`;
    }
    if (pending.length > 5) {
      response += `  ... and ${pending.length - 5} more\n`;
    }
  } else {
    response += `*Queued:* none\n`;
  }

  // Last 5 completed (from queue)
  if (recentCompleted.length > 0) {
    response += `\n*Last 5 completed:*\n`;
    for (const task of recentCompleted) {
      const timestamp = task.completedAt || task.enqueuedAt;
      const timeStr = new Date(timestamp).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: 'America/Toronto',
      });
      const emoji = task.status === 'completed' ? '✅'
        : task.status === 'interrupted' ? '⚠️'
        : '❌';
      response += `• ${timeStr} ${emoji} ${task.description || 'No description'} (${task.status})\n`;
    }
  } else {
    // Fall back to memory history if queue is empty
    const history = memory.loadMemory(path.join(__dirname, 'memory', 'history.json'));
    const last5 = history.slice(-5).reverse();
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

    // LOGIC CHANGE 2026-09-15: the command router, ahead of the LLM and ahead of the
    // hand-written built-in chain below. A command is a VERB with known parameters
    // mapped to a handler (WORK-TODO #45); a deterministic verb needs no model, no
    // turn budget and no clone, so running one is a function call, not a dispatch.
    //
    // It runs only in the bridge channel, like every built-in below it: an agent
    // channel is how an AGENT is addressed, and a verb answering there would be the
    // verb/name mixing #45 exists to prevent.
    //
    // The existing isStatusQuery / isOwnerTasksQuery / isCreateChannelCommand chain
    // below is deliberately NOT migrated here in this change — those are on the live
    // ASK path with their own phrase-matching behaviour, and moving them is its own
    // change. The router adds verbs; it takes none away. `runCommand` returns
    // { handled: false } for anything it does not own, so nothing that worked before
    // stops working.
    if (sourceChannel === BRIDGE_CHANNEL) {
      const routed = await commandRouter.runCommand(questionText, {
        slack,
        agent: agentConfig,
        channelId: sourceChannel,
        userId: msg.user,
        // LOGIC CHANGE 2026-09-15: the two seams the activation verbs need.
        // `slackClient` is the wrapper that can FIND a channel by name (it never
        // creates one here — lib/agent-activation.js names no create API at all).
        slackClient,
        // `onActivationChanged` re-derives the startup-only state so an activation
        // takes effect now rather than at the next restart. `channelsToPoll` and the
        // scheduler's jobs are both built once at boot (docs/AGENTS.md), so without
        // this an activation would be recorded and do nothing visible for hours.
        // The handler reports which of the two happened; it never claims live effect
        // it did not have.
        onActivationChanged: reRegisterAgents,
      });
      if (routed.handled) {
        console.log(`[${agentId}] Command \`${routed.verb}\` handled: ${msg.ts} (ok=${routed.ok})`);
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: routed.text,
          unfurl_links: false,
        });
        return;
      }
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

    // LOGIC CHANGE 2026-04-01: Check for approval queue queries ("pending approvals", etc.).
    // Returns pending auto-generated tasks awaiting owner approval.
    if (isApprovalQuery(questionText)) {
      console.log(`[${agentId}] Approval query detected: ${msg.ts}`);
      const response = approvalQueue.formatPendingTasks();
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: response,
        unfurl_links: false,
      });
      console.log(`[${agentId}] Approval query ${msg.ts} answered`);
      return;
    }

    // LOGIC CHANGE 2026-04-01: Check for approve command ("approve <id>" or "approve all").
    // Approves pending tasks and posts them to the target agent channel.
    if (isApproveCommand(questionText)) {
      console.log(`[${agentId}] Approve command detected: ${msg.ts}`);
      const parsed = parseApproveCommand(questionText);

      if (!parsed) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: ':x: Invalid format. Use: `approve <task-id>` or `approve all`',
          unfurl_links: false,
        });
        return;
      }

      try {
        if (parsed.all) {
          // Approve all pending tasks
          const result = approvalQueue.approveAllTasks(msg.user);
          if (result.count === 0) {
            await slack.chat.postMessage({
              channel: sourceChannel,
              thread_ts: msg.ts,
              text: ':information_source: No pending tasks to approve.',
              unfurl_links: false,
            });
            return;
          }

          // Post each approved task to its target channel
          let posted = 0;
          for (const task of result.tasks) {
            if (task.targetChannel && task.taskMessage) {
              await slack.chat.postMessage({
                channel: task.targetChannel,
                text: task.taskMessage,
                unfurl_links: false,
              });
              posted++;
            }
          }

          await slack.chat.postMessage({
            channel: sourceChannel,
            thread_ts: msg.ts,
            text: `:white_check_mark: Approved and posted ${posted} task(s) to agent channels.`,
            unfurl_links: false,
          });
        } else {
          // Approve specific task
          const result = approvalQueue.approveTask(parsed.id, msg.user);
          if (!result.success) {
            await slack.chat.postMessage({
              channel: sourceChannel,
              thread_ts: msg.ts,
              text: `:x: ${result.error}`,
              unfurl_links: false,
            });
            return;
          }

          // Post approved task to target channel
          const task = result.task;
          if (task.targetChannel && task.taskMessage) {
            await slack.chat.postMessage({
              channel: task.targetChannel,
              text: task.taskMessage,
              unfurl_links: false,
            });
          }

          await slack.chat.postMessage({
            channel: sourceChannel,
            thread_ts: msg.ts,
            text: `:white_check_mark: Approved task \`${parsed.id}\` and posted to <#${task.targetChannel}>.`,
            unfurl_links: false,
          });
        }
        console.log(`[${agentId}] Approve command ${msg.ts} completed`);
      } catch (approveErr) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:x: Approval failed: ${approveErr.message}`,
          unfurl_links: false,
        });
        console.error(`[${agentId}] Approve command failed:`, approveErr.message);
      }
      return;
    }

    // LOGIC CHANGE 2026-04-01: Check for reject command ("reject <id>" or "reject all").
    // Rejects pending tasks, removing them from the queue without execution.
    if (isRejectCommand(questionText)) {
      console.log(`[${agentId}] Reject command detected: ${msg.ts}`);
      const parsed = parseRejectCommand(questionText);

      if (!parsed) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: ':x: Invalid format. Use: `reject <task-id> [reason]` or `reject all`',
          unfurl_links: false,
        });
        return;
      }

      try {
        if (parsed.all) {
          const result = approvalQueue.rejectAllTasks(msg.user, parsed.reason);
          await slack.chat.postMessage({
            channel: sourceChannel,
            thread_ts: msg.ts,
            text: result.count > 0
              ? `:wastebasket: Rejected ${result.count} task(s).`
              : ':information_source: No pending tasks to reject.',
            unfurl_links: false,
          });
        } else {
          const result = approvalQueue.rejectTask(parsed.id, msg.user, parsed.reason);
          if (!result.success) {
            await slack.chat.postMessage({
              channel: sourceChannel,
              thread_ts: msg.ts,
              text: `:x: ${result.error}`,
              unfurl_links: false,
            });
            return;
          }

          await slack.chat.postMessage({
            channel: sourceChannel,
            thread_ts: msg.ts,
            text: `:wastebasket: Rejected task \`${parsed.id}\`.`,
            unfurl_links: false,
          });
        }
        console.log(`[${agentId}] Reject command ${msg.ts} completed`);
      } catch (rejectErr) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: `:x: Rejection failed: ${rejectErr.message}`,
          unfurl_links: false,
        });
        console.error(`[${agentId}] Reject command failed:`, rejectErr.message);
      }
      return;
    }

    // LOGIC CHANGE 2026-04-01: Check for show task command ("show task <id>").
    // Shows detailed information about a specific queued task.
    if (isShowTaskCommand(questionText)) {
      console.log(`[${agentId}] Show task command detected: ${msg.ts}`);
      const taskId = parseShowTaskCommand(questionText);

      if (!taskId) {
        await slack.chat.postMessage({
          channel: sourceChannel,
          thread_ts: msg.ts,
          text: ':x: Invalid format. Use: `show task <task-id>`',
          unfurl_links: false,
        });
        return;
      }

      const task = approvalQueue.getTaskById(taskId);
      const response = approvalQueue.formatTaskDetails(task);
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: response,
        unfurl_links: false,
      });
      console.log(`[${agentId}] Show task command ${msg.ts} answered`);
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
      bulletinContext = bulletinBoard.formatBulletinsForContext(agentId, 10);
    } catch (bulletinErr) {
      console.error(`[${agentId}] formatBulletinsForContext failed:`, bulletinErr.message);
    }

    // LOGIC CHANGE 2026-03-28: Use buildEnrichedPrompt to inject REAL data into agent prompts.
    // This prevents agents (especially secretary) from hallucinating calendar events,
    // meetings, people, and other data. Each agent gets relevant real data:
    // - Secretary: actual calendar events, pending owner tasks
    // - Security: recent security bulletins
    // - Jester: recent bulletins, milestones
    // - Story-bot: recent milestones for LinkedIn content
    // - Code agents: recent task completions
    // All agents get an anti-hallucination rule reminding them to only use provided data.
    const prompt = await agentContext.buildEnrichedPrompt(
      currentAgent,
      questionText,
      { memoryContext, bulletinContext }
    );

    // LOGIC CHANGE 2026-03-26: Use runLLM from lib/llm-runner.js for conversation
    // handling. Uses max-turns 10 for quick Q&A responses.
    // LOGIC CHANGE 2026-03-27: Pass handling agent's llm_provider for conversation handling.
    // Uses the agent's configured max_turns capped at 20 for conversations.
    const maxTurns = Math.min(currentAgent?.max_turns || 10, 20);
    // LOGIC CHANGE 2026-09-11: Pass llm_model and agentId (see the task call site).
    // LOGIC CHANGE 2026-09-13: runLLM -> runWithFallback, so a gemini agent whose
    // provider is rate limited or unreachable falls through the chain instead of
    // failing the ASK outright. See the task call site for the full rationale.
    const result = await runWithFallback(prompt, {
      cwd: WORK_DIR,
      maxTurns,
      timeout: TASK_TIMEOUT,
      claudeBin: CLAUDE_BIN,
      // LOGIC CHANGE 2026-09-13: resolveLlmProvider honours the per-agent
      // LLM_PROVIDER_<AGENTID> on-box override (see the task call site).
      provider: resolveLlmProvider(currentAgent, agentId),
      model: currentAgent?.llm_model,
      agentId,
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
    // LOGIC CHANGE 2026-03-30: Post conversation errors to #sqtools-ops.
    // Previously only logged — this allowed the gemini-2.5-flash outage to go
    // undetected for 2 days because all 8 Gemini agent failures were invisible.
    console.error(`[${agentId}] Conversation ${msg.ts} failed:`, err.message);
    try {
      await slack.chat.postMessage({
        channel: OPS_CHANNEL,
        text: `:x: [${agentId}] ASK handler failed (msg ${msg.ts}): ${err.message}`,
      });
    } catch (postErr) {
      console.error(`[${agentId}] Failed to post error to ops:`, postErr.message);
    }
  }
}

// ---- Poll loop ----

// LOGIC CHANGE 2026-09-13: Name the reason a polled message was not acted on.
//
// Why this exists: a message with no TASK:/ASK: prefix, with
// NATURAL_CONVERSATION_MODE unset, fell through all three branches of the poll
// loop and logged nothing at all. From the outside that is indistinguishable
// from the bot being down, and it turned a one-line cause into an afternoon of
// diagnosis. A silently discarded input is the same class of defect as a test
// suite that reports green because it skipped.
//
// Returns a short human-readable reason. Never includes the message body -
// only metadata the operator needs to correlate the message in Slack.
//
// @param {{ ts: string, text?: string, subtype?: string }} msg - Slack message
// @returns {string} Reason the message was skipped
function describeSkipReason(msg) {
  if (msg.subtype) return `message subtype "${msg.subtype}" is not actionable`;
  if (!msg.text || !msg.text.trim()) return 'message has no text';

  const isTask = isTaskMessage(msg);
  const isAsk = isConversationMessage(msg);

  if (isTask || isAsk) {
    const kind = isTask ? 'TASK:' : 'ASK:';
    if (alreadyProcessed(msg)) return `${kind} message already carries a done/failed reaction`;
    if (isTaskProcessed(msg.ts)) return `${kind} message already recorded in processed-tasks.json`;
    return `${kind} message matched no handler`;
  }

  // Unprefixed message.
  if (!config.NATURAL_CONVERSATION_MODE) {
    return 'no TASK:/ASK: prefix and NATURAL_CONVERSATION_MODE is off';
  }
  if (alreadyProcessed(msg)) return 'unprefixed message already carries a done/failed reaction';
  if (isTaskProcessed(msg.ts)) return 'unprefixed message already recorded in processed-tasks.json';
  return 'unprefixed message rejected by isNaturalConversationMessage';
}

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
    // LOGIC CHANGE 2026-09-15: deliberately passes NO handlingAgent, so this retry
    // falls back to the bridge. Two reasons: this path is dead (handleRateLimit() is
    // the only writer of rateLimitState.failedTask and has no production caller -
    // see the note at the isBandwidthExhausted site), and `failedTask` stores only
    // the Slack message, not the channel entry, so the agent is not recoverable here.
    // Inventing one would be worse than the honest fallback. If the pause path is
    // ever revived, `failedTask` must carry its channelAgentConfig with it.
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
        // LOGIC CHANGE 2026-04-01: Allow bot's own messages in agent channels so
        // scheduled tasks (morning-briefing, nightly-audit, etc.) posted AS THE BOT
        // are not silently dropped. All channels in channelsToPoll are agent channels,
        // so this does not open up non-agent channels (store-inbox, social-media, etc.).
        const isBotMessage = msg.user === BOT_USER_ID;
        if ((isTaskMessage(msg) || isConversationMessage(msg)) && !isUserAuthorized(msg.user) && !isBotMessage) {
          console.log(`[bridge-agent] Ignoring message from unauthorized user: ${msg.user}`);
          continue;
        }

        // LOGIC CHANGE 2026-03-27: TASK: messages always go to bridge agent regardless of channel.
        // This allows tasks to be submitted from any agent channel but always use bridge for execution.
        // LOGIC CHANGE 2026-03-28: Added isTaskProcessed() deduplication check to prevent
        // re-processing old messages after bot restarts. alreadyProcessed() checks reactions;
        // isTaskProcessed() checks our local processed-tasks.json file.
        // LOGIC CHANGE 2026-04-01: Tasks are now enqueued before processing. The queue is
        // persisted to disk so auto-update can see pending tasks and wait for them.
        if (isTaskMessage(msg) && !alreadyProcessed(msg) && !isTaskProcessed(msg.ts)) {
          console.log(`[bridge-agent] Task found in ${agentId} channel: ${msg.ts}`);

          // Parse task to get description for queue
          const taskData = parseTask(msg.text);

          // ---- DRAIN-ONE: refuse a new dispatch while an update is waiting ----
          // LOGIC CHANGE 2026-09-20. This is the half that BOUNDS the wait. The
          // updater already stood aside for a running task (evaluateTaskDeferral,
          // auto-update.js), but its wait was bounded by the ARRIVAL RATE of new
          // dispatches, not by one task: a back-to-back succession of healthy tasks
          // defers a deploy forever. Refusing here means the only task an update can
          // wait for is the one already in flight.
          //
          // REFUSED, NEVER SWALLOWED. The reason goes back to the channel the task
          // was typed in and the message is marked processed so it is not re-refused
          // every POLL_INTERVAL_MS. This repo has already had one silent-drop defect
          // on this exact path — a body with no `INSTRUCTIONS:` label was dropped and
          // the executor ran on the one-line description with nothing reported — and
          // the fix there was to refuse and NAME what was dropped. Same shape here: a
          // race is eventually noticed, a disappearance is not.
          const drain = drainStateForDispatch();
          if (drain.refuse) {
            console.warn(
              `[bridge-agent] Refusing dispatch ${msg.ts}: a self-update is pending ` +
              `(${drain.state.commit || 'unknown commit'})`
            );
            try {
              await slack.chat.postMessage({
                channel: channelId,
                thread_ts: msg.thread_ts || msg.ts,
                text: redact(updateDrain.describeRefusal(drain.state, taskData.description)),
                unfurl_links: false,
              });
            } catch (refusalErr) {
              // The refusal itself failing is the one thing worse than the refusal.
              // Say so somewhere else before giving up on telling anyone.
              console.error('[bridge-agent] Could not post dispatch refusal:', refusalErr.message);
              await postToOps(
                `:rotating_light: *A dispatch was refused for a pending update and the refusal could not be posted.*\n` +
                `Task: ${taskData.description || 'unknown'}\n` +
                `Channel: <#${channelId}> — ${refusalErr.message}\n` +
                `The operator has not been told their task was dropped.`
              );
            }
            markTaskProcessed(msg.ts);
            continue;
          }

          // Enqueue task before processing (persists to disk for auto-update coordination)
          const queue = taskQueue.getQueue();
          const queuedTask = queue.enqueue({
            msgTs: msg.ts,
            channelId,
            text: msg.text,
            description: taskData.description || 'Unnamed task',
            repo: taskData.repo,
          });

          isRunning = true;

          // LOGIC CHANGE 2026-03-27: Track current task promise for graceful shutdown.
          // Allows shutdown handler to wait for task completion.
          // Pass channel context for proper message linking
          // LOGIC CHANGE 2026-09-15: pass `channelAgentConfig` - the SAME value this
          // loop already passes to processConversation eighteen lines below. TASK:
          // and ASK: now resolve their agent identically; before this, a TASK: in an
          // agent's own channel ran as the bridge (WORK-TODO #38). `channelAgentConfig`
          // is destructured from the channelsToPoll entry above and is null for no
          // channel, which processTask's `handlingAgent || agentConfig` handles.
          currentTaskPromise = processTask(msg, channelId, queuedTask.id, channelAgentConfig);
          await currentTaskPromise;
          currentTaskPromise = null;

          isRunning = false;

          // LOGIC CHANGE 2026-03-28: Mark message as processed after completion (success or fail).
          // Prevents re-processing on next startup even if reaction emoji was not added.
          markTaskProcessed(msg.ts);

          // LOGIC CHANGE 2026-03-26: After processing a task, check if we got rate limited.
          // If so, exit the loop to pause processing.
          if (isRateLimitPaused()) {
            console.log('[bridge-agent] Rate limit triggered. Pausing task processing.');
            return;
          }

          continue;
        }

        // LOGIC CHANGE 2026-09-15: the comment that stood here said "TASK: messages
        // always go to bridge agent regardless of channel". That is no longer true and
        // was the defect, not the design - see WORK-TODO #38 and the processTask call
        // above. TASK: and ASK: both take the channel's agent now.
        // LOGIC CHANGE 2026-03-27: ASK: messages are routed to the agent that owns the channel.
        // Each agent processes conversations with its own personality and system_prompt.
        // LOGIC CHANGE 2026-03-28: Added isTaskProcessed() to prevent re-answering old ASK: messages.
        if (isConversationMessage(msg) && !alreadyProcessed(msg) && !isTaskProcessed(msg.ts)) {
          await processConversation(msg, channelId, channelAgentConfig);
          markTaskProcessed(msg.ts);
          continue;
        }

        // LOGIC CHANGE 2026-04-01: Natural conversation mode - route messages without TASK:/ASK:
        // prefixes to the channel's default agent. Only active when NATURAL_CONVERSATION_MODE=true.
        // This enables casual conversation with agents without requiring structured prefixes.
        if (config.NATURAL_CONVERSATION_MODE &&
            isNaturalConversationMessage(msg) &&
            !alreadyProcessed(msg) &&
            !isTaskProcessed(msg.ts)) {
          // Check authorization for natural messages too
          const isBotMessage = msg.user === BOT_USER_ID;
          if (!isUserAuthorized(msg.user) && !isBotMessage) {
            console.log(`[bridge-agent] Ignoring natural message from unauthorized user: ${msg.user}`);
            continue;
          }

          console.log(`[bridge-agent] Natural conversation in ${agentId} channel: ${msg.ts}`);
          await processConversation(msg, channelId, channelAgentConfig);
          markTaskProcessed(msg.ts);
          continue;
        }

        // LOGIC CHANGE 2026-09-13: Nothing handled this message. Say so, with the
        // channel, the ts and the reason, instead of dropping it without a trace.
        console.log(
          `[bridge-agent] Skipped message in ${agentId} channel (${channelId}) ts=${msg.ts}: ${describeSkipReason(msg)}`
        );
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
// LOGIC CHANGE 2026-09-15: it DELEGATES to `activeChannels()` in lib/agent-surface.js
// instead of restating the rule. Joining and polling used to be two rules maintained
// separately and they had drifted — every declared channel was joined, only active
// agents' channels were polled — so story-bot was joined to a channel the poll loop
// never read and its weekly job posted a TASK: message nothing executed. There is now
// one rule, in one place, and the join path, the poll set and the scheduler all read
// it. A rule restated in two places with nothing comparing them is the drift this
// repo files as a defect; the fix is to have one statement, not a better comparison.
//
// Returns array of { channelId, agentId, agentConfig }.
function buildChannelsToPoll() {
  let declared = [];
  try {
    declared = activeChannels(loadAgents(), BRIDGE_CHANNEL);
  } catch (err) {
    console.error('[bridge-agent] Failed to load active agents:', err.message);
    // Continue with just the bridge channel - the path every task arrives on.
    declared = BRIDGE_CHANNEL ? [{ channelId: BRIDGE_CHANNEL, agentId: 'bridge' }] : [];
  }

  return declared.map(entry => ({
    channelId: entry.channelId,
    agentId: entry.agentId,
    agentConfig: entry.agentId === 'bridge' ? agentConfig : getAgent(entry.agentId),
  }));
}

/**
 * Re-derive the two pieces of state that are otherwise built only at startup: the
 * poll set and the scheduler's cron registrations.
 *
 * LOGIC CHANGE 2026-09-15: activating an agent has to change what the RUNNING
 * process does, or it is a decision with no effect until someone restarts the
 * container — and deploys here are manual, so that could be days.
 *
 * It re-registers EVERY agent rather than adding one, by stopping the scheduler and
 * starting it again. Registration is idempotent and cron jobs hold no state, so this
 * reuses the one code path that already exists instead of adding a second, partial
 * one that could disagree with it.
 *
 * @returns {{ channels: number, jobs: number }}
 */
function reRegisterAgents() {
  channelsToPoll = buildChannelsToPoll();
  stopScheduler();
  const result = startScheduler(slack);
  console.log(`[bridge-agent] Re-registered: ${channelsToPoll.length} channel(s), ${result.jobCount} job(s)`);
  return { channels: channelsToPoll.length, jobs: result.jobCount };
}

console.log('[bridge-agent] Starting v2');

// LOGIC CHANGE 2026-03-27: Rate limit state is in-memory only — never persisted
// to disk. The variable is initialised at declaration so every restart
// automatically gives the bot a fresh start with no stale pause state.
// LOGIC CHANGE 2026-09-14: "every PM2 restart" -> "every restart". There is no pm2
// here; the container restarts under `restart: unless-stopped`.
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

// LOGIC CHANGE 2026-04-01: Recover interrupted tasks and clean up old queue entries on startup.
// Any task with status "running" at startup was interrupted by a restart.
try {
  const queue = taskQueue.getQueue();
  const interruptedCount = queue.recoverInterrupted();
  if (interruptedCount > 0) {
    console.log(`[bridge-agent] Recovered ${interruptedCount} interrupted task(s) from queue`);
    // LOGIC CHANGE 2026-09-14: post it. Every OTHER lifecycle event on this path
    // already posts to #sqtools-ops - a stale lock release, a deferred update, a
    // task failure, an undelivered scratch clone. This one wrote `interrupted` into
    // task-queue.json, logged one line, and stopped: the observable for the person
    // who submitted the task was "it never answered". WORK-TODO #22.
    postToOps(
      `:warning: *${interruptedCount} task(s) were interrupted by a restart.*\n` +
      queue.getRecentCompleted(10)
        .filter(t => t.status === 'interrupted')
        .slice(0, 5)
        .map(t => `• ${t.description}${t.repo ? ` (${t.repo})` : ''}${t.msgTs && t.channelId ? ` — <${msgLink(t.msgTs, t.channelId)}|source>` : ''}`)
        .join('\n') +
      '\nThey were not retried. Re-submit any that still matter.'
    ).catch(postErr => {
      console.error('[bridge-agent] Could not post interrupted-task report:', postErr.message);
    });
  }
  const cleanedCount = queue.cleanup();
  if (cleanedCount > 0) {
    console.log(`[bridge-agent] Cleaned up ${cleanedCount} old queue entries`);
  }
  const queueStatus = queue.getStatus();
  if (queueStatus.pending > 0) {
    console.log(`[bridge-agent] Queue has ${queueStatus.pending} pending task(s) from previous session`);
  }
} catch (queueErr) {
  console.error('[bridge-agent] Task queue startup failed:', queueErr.message);
  // LOGIC CHANGE 2026-09-14: the queue is how a killed task is ever noticed. If it
  // fails to load, nothing downstream will report that it is not working.
  postToOps(`:x: *Task queue failed to start:* ${queueErr.message}\nInterrupted-task recovery and queue status are unavailable this session.`)
    .catch(postErr => console.error('[bridge-agent] Could not post queue startup failure:', postErr.message));
}

// LOGIC CHANGE 2026-09-14: Clear a task lock left behind by the previous process.
// recoverInterrupted() above repairs the QUEUE after a kill, but nothing repaired
// the LOCK - processTask's `finally` cannot run when the process is killed, which
// is precisely what a self-update restart does. The orphan then made auto-update
// think a task was running forever.
//
// Clearing it here is sound because bridge-agent is the lock's only writer and is
// single-instance in this deployment (one `jt-agent` container): if this process is
// starting, no task of its own can be running, so any lock on disk is an orphan.
// The staleness rule in lib/task-lock.js is the backstop for the case this cannot
// see - a lock orphaned while the bridge keeps running.
//
// Surfaced, never silent: logged here and posted to #sqtools-ops.
try {
  const orphan = taskLock.inspect({ lockFile: TASK_LOCK_FILE });
  if (orphan.held) {
    const ageMin = Math.round((orphan.ageMs || 0) / 60000);
    const who = orphan.description || orphan.msgTs || 'unknown task';
    const cleared = taskLock.release(TASK_LOCK_FILE);
    const verdict = cleared.released
      ? `Cleared an orphaned task lock at startup: "${who}" had held \`${TASK_LOCK_FILE}\` for ${ageMin}m. ` +
        `Its task did not survive the restart, so the lock could not be released by the task itself. ` +
        `Self-update is no longer blocked by it.`
      : `Found an orphaned task lock at \`${TASK_LOCK_FILE}\` ("${who}", ${ageMin}m) but could NOT remove it ` +
        `(${cleared.error}). Self-update stays blocked until it ages out or is removed by hand.`;
    console.warn(`[bridge-agent] ${verdict}`);
    postToOps(`:unlock: ${verdict}`).catch(postErr => {
      console.error('[bridge-agent] Failed to post orphaned-lock notice:', postErr.message);
    });
  }
} catch (lockErr) {
  console.error('[bridge-agent] Startup task-lock check failed:', lockErr.message);
}

// LOGIC CHANGE 2026-03-28: Clean up processed-tasks entries older than 7 days on startup.
cleanupProcessedTasks();

// LOGIC CHANGE 2026-03-28: Start the agent scheduler for cron-based proactive tasks.
// Each agent with a schedule field gets a cron job that posts TASK messages to their channel.
// LOGIC CHANGE 2026-09-15: MOVED into the startup IIFE below, after channel
// resolution. Registering jobs before the declared channel names were resolved meant
// an agent whose channel resolves on THIS boot would still have had its schedule
// refused for want of a channel — the third consequence of a declaration missing
// because it was evaluated before the first.

// LOGIC CHANGE 2026-03-28: Join all agent channels before starting the poll loop.
// Runs async so the bot is guaranteed to be in all channels before first poll.
// This must happen on EVERY startup — channels might be recreated while offline.
// LOGIC CHANGE 2026-09-14: Holds the Socket Mode handle so gracefulShutdown can
// close the connection. Stays null when Socket Mode is off — a normal state — and
// also while the startup IIFE below is still resolving it.
let socketMode = null;

// LOGIC CHANGE 2026-03-30: Also validates Gemini API at startup so a bad model
// name or expired key shows up immediately in logs instead of silently on the
// first ASK message. Does not block the poll loop from starting.
(async () => {
  // LOGIC CHANGE 2026-09-15: ONE DECLARATION, THREE CONSEQUENCES — and this is
  // where they happen, in the order that makes them consequences of each other:
  // resolve the declared channel NAME to an id, then join it, then poll it.
  //
  // A tracked definition carries `channel_name`, never a workspace id
  // (lib/agent-markdown.js). Resolution is cached durably in the local channel map
  // (lib/bridge-state.js), so this costs a Slack lookup only for a name that has
  // never resolved — every already-known channel is a cache hit and no API call.
  //
  // NOTHING HERE CREATES A CHANNEL. Where the declared channel does not exist the
  // agent gets none of the three and the reason is REPORTED to #sqtools-ops, which
  // is also what the scheduler now does with that agent's schedule. That is the
  // correct behaviour: creating a channel has a cost outside this repository.
  try {
    const unresolved = [];
    for (const agent of loadAgents()) {
      if (agent.status === 'planned' || agent.channel || !agent.channel_name) continue;
      const resolution = await resolveAgentChannel(agent, slackClient);
      if (!resolution.resolved) unresolved.push(`• \`${agent.id}\` — ${resolution.reason}`);
      else console.log(`[bridge-agent] Resolved #${agent.channel_name} -> ${resolution.channelId} for ${agent.id}`);
    }

    if (unresolved.length) {
      await notifyOwner.notifyOps(
        `:mag: *${unresolved.length} active agent(s) declare a channel that could not be resolved.*\n` +
        unresolved.join('\n') + '\n' +
        'They are not joined, not polled, and their schedules are not registered — three consequences of one ' +
        'declaration, or none. Nothing here creates a channel: create it, then the next restart picks it up. ' +
        'Run `node scripts/agent-surface.js` for the per-agent picture.'
      ).catch(notifyErr => {
        console.error('[bridge-agent] Could not escalate unresolved channels:', notifyErr.message);
      });
    }

    // Rebuild from the registry now that resolution has run, so a channel resolved
    // on THIS boot is polled on this boot rather than the next one.
    channelsToPoll = buildChannelsToPoll();
    console.log(`  Channels: ${channelsToPoll.length} (${channelsToPoll.map(c => c.agentId).join(', ')})`);

    const schedulerResult = startScheduler(slack);
    console.log(`  Scheduler: ${schedulerResult.jobCount} jobs (${schedulerResult.agents.join(', ') || 'none'})`);

    // The set joined is the set polled, from the same rule — see
    // `activeChannels()` in lib/agent-surface.js. Joining a channel that ALREADY
    // EXISTS is safe and reversible; this creates none.
    const toJoin = joinableChannels(loadAgents(), BRIDGE_CHANNEL);
    const joinResult = await slackClient.joinAgentChannels(toJoin);

    // LOGIC CHANGE 2026-09-15: a failed join was a console.error and nothing else.
    // A channel the bot is not in is a scheduled job whose output reaches nobody,
    // and the container log is not where anyone learns that. Escalate by the path
    // this repo already uses for operational failures.
    if (joinResult && joinResult.failed > 0) {
      await notifyOwner.notifyOps(
        `:door: *Could not join ${joinResult.failed} of ${joinResult.total} agent channel(s)* at startup.\n` +
        'Anything scheduled to post there reaches nobody until the bot is a member. ' +
        'Check the `channels:join` scope, or invite the bot manually. ' +
        'Run `node scripts/agent-surface.js` for the per-agent picture.'
      ).catch(notifyErr => {
        console.error('[bridge-agent] Could not escalate channel-join failures:', notifyErr.message);
      });
    }
  } catch (joinErr) {
    console.error('[bridge-agent] Failed to join agent channels on startup:', joinErr.message);
    await notifyOwner.notifyOps(
      `:door: *Agent channel join threw at startup* — ${joinErr.message}\n` +
      'The bridge is still polling, but it may not be a member of every agent channel.'
    ).catch(notifyErr => {
      console.error('[bridge-agent] Could not escalate channel-join throw:', notifyErr.message);
    });
  }
  await validateGeminiOnStartup();
  // LOGIC CHANGE 2026-09-11: Probe the local Ollama server the same way.
  // Like the Gemini check, this NEVER blocks boot - an unreachable ollama logs
  // a warning and every agent still starts on its configured provider.
  try {
    await validateOllamaOnStartup({ agents: getActiveAgents() });
  } catch (ollamaErr) {
    console.error('[bridge-agent] Ollama startup check threw unexpectedly:', ollamaErr.message);
  }
  poll();
  setInterval(poll, POLL_INTERVAL);

  // LOGIC CHANGE 2026-09-14: Open the Socket Mode connection LAST and do not await
  // it. The ordering is the additivity proof, not a style choice: the poll loop is
  // already running by the time this line is reached, so a Socket Mode connection
  // that is unconfigured, slow, or failing cannot delay or prevent the one path
  // every task actually arrives on. startSocketMode() never rejects — the .catch()
  // is a belt-and-braces guard against a future edit breaking that promise, and it
  // logs rather than throwing so an unhandled rejection can never kill the bridge.
  startSocketMode({
    // LOGIC CHANGE 2026-09-15: THE COMMAND SEAM, attached. Both handlers resolve in
    // every case and never reject, so the additivity contract is unchanged: nothing
    // here can delay or kill the poll loop, which is already running by this line.
    //
    // Authorisation is isUserAuthorized — the SAME allowlist the poll loop applies,
    // not a second check. It has to be applied HERE because the message this posts is
    // a BOT post, and the poll loop deliberately lets a bot post through without an
    // allowlist check so scheduled tasks are not dropped. There is no gate after this.
    onSlashCommand: (envelope) =>
      handleSlashCommand(envelope, {
        openView: (args) => slack.views.open(args),
        postEphemeral: (args) => slack.chat.postEphemeral(args),
        isAuthorized: isUserAuthorized,
        notify: postToOps,
      }),
    onInteractive: (envelope) =>
      handleViewSubmission(envelope, {
        postMessage: (args) => slack.chat.postMessage({ ...args, unfurl_links: false }),
        isAuthorized: isUserAuthorized,
        bridgeChannel: BRIDGE_CHANNEL,
        notify: postToOps,
        // githubOrg is deliberately NOT passed: omitted, lib/dispatch-message.js
        // falls back to lib/task-parser.js's own DEFAULT_GITHUB_ORG, so the generator
        // and the parser cannot disagree about which org a bare repo name belongs to.
      }),
  })
    .then((handle) => {
      socketMode = handle;
      if (!handle.started) {
        console.log(`[bridge-agent] Socket Mode not started (${handle.reason}). Poll loop unaffected.`);
      }
    })
    .catch((socketErr) => {
      console.error('[bridge-agent] Socket Mode startup threw unexpectedly:', socketErr.message);
    });
})();

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

  // LOGIC CHANGE 2026-09-14: Close the Socket Mode connection, if one is open, so a
  // deliberate shutdown is not reported to #sqtools-ops as an unexplained outage.
  // Bounded, because a wedged WebSocket must not hold shutdown open: this runs before
  // the ops post and before the up-to-60s wait for a running task, and a socket that
  // will not close within SOCKET_STOP_TIMEOUT_MS is abandoned rather than awaited.
  if (socketMode && typeof socketMode.stop === 'function') {
    const SOCKET_STOP_TIMEOUT_MS = 5000;
    try {
      await Promise.race([
        socketMode.stop(),
        new Promise((resolve) => setTimeout(resolve, SOCKET_STOP_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error('[bridge-agent] Failed to stop Socket Mode:', err.message);
    }
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
