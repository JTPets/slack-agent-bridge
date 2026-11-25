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
 * inside the `jt-agent` image. A restart is `docker compose restart bridge` on the
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
 *   TASK_TIMEOUT_MS     hard kill timeout (default: 600000 = 10min)
 *   CLAUDE_BIN          path to claude binary
 *   WORK_DIR            base dir for temp clones (default: /tmp/bridge-agent)
 */

// LOGIC CHANGE 2026-10-04 (WORK-TODO #30, #21): every Slack client is built by lib/slack-web.js,
// which redacts secrets out of every chat.* post and drops the already_in_channel warning.
const { createWebClient, postText } = require('./lib/slack-web');
// LOGIC CHANGE 2026-09-14: `const { execSync } = require('child_process')` removed.
// It was left behind when the git/clone lifecycle moved to lib/clone-lifecycle.js
// (seam A) and had no remaining use in this file — a dead import of the one API in
// the codebase that executes a shell command string. Keeping it around is an
// invitation: the next `execSync(...)` written here would need no new require to
// look at home. tests/no-shell-execution.test.js now fails on the import itself.
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  // LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B35): the built-in command matchers moved
  // with their commands to lib/conversation-builtins.js.
  alreadyProcessed,
  DEFAULT_TURNS,
  MIN_TURNS,
  TURNS_CEILING,
  conversationTurns,
} = require('./lib/task-parser');

// LOGIC CHANGE 2026-03-26: Extracted config loading and validation into
// lib/config.js for centralized env var management.
// LOGIC CHANGE 2026-03-26: Import isUserAuthorized from config for user
// authorization checks in the poll loop.
const { config, validate, isUserAuthorized, resolveLlmProvider } = require('./lib/config');

// LOGIC CHANGE 2026-03-26: Added agent registry for multi-agent architecture.
// Loads agent config from agents/agents.json with fallback to env vars if registry
// doesn't exist or agent not found.
// LOGIC CHANGE 2026-03-26: Added isProductionRepo for production workflow detection.
// LOGIC CHANGE 2026-03-27: Added getActiveAgents and getAgentByChannel for multi-channel polling.
const { getAgent, loadAgents, getActiveAgents, getAgentByChannel, registryExists } = require('./lib/agent-registry');

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

// LOGIC CHANGE 2026-03-28: Added bulletin-board module for inter-agent communication.
// Agents can post bulletins (milestones, alerts, task completions) that other agents can read.
const bulletinBoard = require('./lib/bulletin-board');

// LOGIC CHANGE 2026-03-28: Added agent-scheduler module for cron-based proactive tasks.
// Enables agents to run on schedules (e.g., morning briefings, nightly audits).
const { startScheduler, stopScheduler } = require('./lib/agent-scheduler');

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): bulletin-watcher is lib/task-followups.js's.

// LOGIC CHANGE 2026-03-28: Added code-review-pipeline module for Phase 1/2/3 task execution.
// Phase 1: reviewTask reads codebase before executing. Phase 2: buildPrompt assembles enriched
// prompt with COMMANDMENTS + CLAUDE.md + structure + context. Phase 3: validateOutput runs tests.
// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): the pipeline is called from lib/task-prompt.js
// (Phases 1-2) and lib/task-outcome.js (Phase 3), the task spokes.

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
const { shouldRefuseAsk, describeAskRefusal } = require('./lib/ask-drain');
const { decideAgentChannelVerb, describeVerbRefusal } = require('./lib/agent-channel-verbs');
const { naturalConversationVerdict } = require('./lib/natural-conversation');

// LOGIC CHANGE 2026-03-28: Added agent-context module for injecting real data into ASK prompts.
// Prevents hallucination by giving agents (especially secretary) actual calendar events,
// owner tasks, and bulletins instead of letting them invent fake data.
const agentContext = require('./lib/agent-context');

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B35): the owner-tasks, staff-tasks, watercooler
// and approval-queue requires moved to lib/conversation-builtins.js, their only user here.

// LOGIC CHANGE 2026-09-13: Redact secrets from any text before it reaches Slack
// or the logs. Guards the stderr-surfacing path (a child process's stderr could
// echo live tokens) and every #sqtools-ops post via postToOps().
const { redact } = require('./lib/redact-secrets');

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): the clone lifecycle, task work record,
// result card, preserved-clone alert, divergence notice and start check are required by
// the task spokes below, which processTask calls; only what this file still uses is here.
const { formatWork } = require('./lib/task-work');
const { resolveMergeStates, formatMergeState } = require('./lib/merge-state');
// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B35): the ASK: built-ins, out of processConversation.
const { answerBuiltin } = require('./lib/conversation-builtins');
const { describeStartRefusal } = require('./lib/task-start-check');
// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): processTask's spokes.
const { beginTask, releaseTaskLock } = require('./lib/task-state-gate');
const { prepareWorkspace, cleanupWorkspace } = require('./lib/task-workspace');
const { buildTaskPrompt } = require('./lib/task-prompt');
const { runTaskLlm } = require('./lib/task-llm-run');
const {
  deliverInterrupted, deliverCompleted, deliverFailure, reportAlreadyDone,
} = require('./lib/task-outcome');
const { afterCompletion } = require('./lib/task-followups');
const taskMemory = require('./lib/task-memory-record');
const repoHistory = require('./lib/repo-history');

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): the dependency install (WORK-TODO #61) is
// lib/task-workspace.js prepareWorkspace's.

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
const { createMainWatch, remoteMainSha } = require('./lib/main-watch');
const { createSelfDeploy } = require('./lib/self-deploy');
const { createBackupWatch } = require('./lib/backup-watch');
const { createHighDigest, intervalFromEnv: highDigestInterval } = require('./lib/high-digest');
const { createClaudeAuthWatch, probeClaudeAuth } = require('./lib/claude-auth-watch');
const { DEFAULT_CLAUDE_BIN } = require('./lib/llm-defaults');
const { handleSlashCommand, handleViewSubmission } = require('./lib/dispatch-command');
// LOGIC CHANGE 2026-11-25 (WORK-TODO #81): which bot-authored TASK messages are the bridge's own.
const botTaskLedger = require('./lib/bot-task-ledger');
// LOGIC CHANGE 2026-11-07 (WORK-TODO #78): SqTools alert buttons share the interactive seam.
const sqtoolsAlertButtons = require('./lib/sqtools-alert-buttons');
// LOGIC CHANGE 2026-11-09: social post drafts' Publish/Edit/Reject buttons and Edit form.
const socialButtons = require('./lib/social-buttons');
const { createPollWake } = require('./lib/poll-wake');

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

// LOGIC CHANGE 2026-10-04 (WORK-TODO #20): the module-scope MAX_TURNS (bridge agent's
// max_turns, else the MAX_TURNS env var) is gone. Its one reader was the startup banner;
// no task or conversation used it. See lib/task-parser.js for the budgets that are used.

const slack = createWebClient(SLACK_BOT_TOKEN);

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
// LOGIC CHANGE 2026-10-04 (WORK-TODO #30): delegates to lib/slack-web.js postText, the one
// post helper, which redacts (as this did since 2026-09-13), never throws, and returns
// whether the post landed. The client redacts too, so every other post here is covered.
async function postToOps(text) {
  return postText(slack, OPS_CHANNEL, text, 'bridge-agent');
}

// LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): readTaskWork and recordTaskWork moved to
// lib/task-workspace.js with the rest of the task's workspace.

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

/**
 * WORK-TODO #71 (owner, 2026-11-08: "let the code finish its loop but halt new asks from
 * starting"). While a self-update is pending, a new question that needs a model is
 * refused in its thread and marked processed, like a refused TASK:. Built-in commands
 * still answer (lib/ask-drain.js). Returns true when the message was refused.
 */
async function refuseAskForPendingUpdate(msg, channelId) {
  const pending = drainStateForDispatch();
  if (!shouldRefuseAsk({ text: msg.text, drain: pending })) return false;
  console.warn(`[bridge-agent] Refusing ask ${msg.ts}: a self-update is pending (${pending.state.commit || 'unknown commit'})`);
  try {
    await slack.chat.postMessage({
      channel: channelId, thread_ts: msg.thread_ts || msg.ts,
      text: redact(describeAskRefusal(pending.state)), unfurl_links: false,
    });
  } catch (err) {
    await postToOps(`:rotating_light: A question in <#${channelId}> was held for a pending update and the notice could not be posted (${err.message}). The person has not been told.`);
  }
  markTaskProcessed(msg.ts);
  return true;
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
  // LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B36): processTask is a HUB. It reads top to
  // bottom as the steps of a task and calls one spoke per step:
  //   lib/task-state-gate.js    the lock and the queue row, in and out (middleware)
  //   lib/task-workspace.js     the temp dir or scratch clone, made and removed
  //   lib/task-prompt.js        the prompt
  //   lib/task-llm-run.js       the model run, with the one max-turns retry
  //   lib/task-outcome.js       the result delivered, THEN the terminal queue row
  //   lib/task-followups.js     Phase-3 detail, bulletin, ACTION REQUIRED, history
  //   lib/task-memory-record.js the history entry and the agent's working memory
  // Everything a step needs about this task is on `run`; everything it needs from this
  // process is on `taskDeps()`. The history of each rule moved with it.
  //
  // LOGIC CHANGE 2026-09-15 (WORK-TODO #38): a task executes as the agent it was
  // addressed to: the SAME `handlingAgent || agentConfig` fallback processConversation
  // uses, and the poll loop passes the same `channelAgentConfig` to both. The agent
  // decides its own IDENTITY (persona, provider, model, metrics id, bulletin voice,
  // working memory), never the orchestrator's bookkeeping (queue, lock, ops channel, the
  // owner's action inbox, the global task history).
  const currentAgent = handlingAgent || agentConfig;
  const currentAgentId = currentAgent?.id || 'bridge';
  const task = parseTask(msg.text);
  const deps = taskDeps();
  const run = {
    msg, sourceChannel, queueId, task, currentAgent, currentAgentId,
    startTime: Date.now(),
    sourceLink: `<${msgLink(msg.ts, sourceChannel)}|source>`,
    taskDir: null, scratchCwd: null, taskBaseSha: null, taskSuccess: false,
    // The repo's own test script, set by lib/task-prompt.js from Phase 1; null lets
    // validateOutput use its own default (lib/code-review-pipeline.js).
    taskTestScript: null,
    // LOGIC CHANGE 2026-03-27: progress reactions on the source message.
    heartbeat: createHeartbeat(slack, sourceChannel, msg.ts),
    // LOGIC CHANGE 2026-09-13: per-agent LLM_PROVIDER_<AGENTID> wins (survives a pull).
    llmProvider: resolveLlmProvider(currentAgent, currentAgentId),
    memoryTaskId: null,
  };

  // 1. May it start? Lock and queue row (WORK-TODO #72: refuse, a human overrules).
  const { startRefusal, lockOwned } = await beginTask({
    msg, task, queueId, lockFile: TASK_LOCK_FILE, postToOps,
  });
  run.memoryTaskId = taskMemory.startRecord(task);

  try {
    // LOGIC CHANGE 2026-09-14: a field parseTask rejected stops the task before any work.
    if (task.errors && task.errors.length > 0) {
      throw new Error(`Task message rejected: ${task.errors.join('; ')}`);
    }
    if (startRefusal) throw new Error(describeStartRefusal(startRefusal));
    await run.heartbeat.start();

    // 2. Where it runs, 3. what it is told.
    const cwd = await prepareWorkspace(run, deps);
    const built = await buildTaskPrompt(run);
    if (built.alreadyDone) {
      await reportAlreadyDone(run, built.alreadyDone, deps);
      return;
    }

    // 4. The run.
    const llm = await runTaskLlm(run, built.prompt, cwd, deps);
    if (llm.result.interrupted) {
      await deliverInterrupted(run, llm, deps);
      return;
    }

    // 5. Verify and deliver, then the follow-ups.
    const done = await deliverCompleted(run, llm, deps);
    await afterCompletion(run, llm, done, deps);
  } catch (err) {
    await deliverFailure(run, err, deps);
  } finally {
    // 6. Clean up. The lock is released LAST, after every terminal write above.
    try {
      await run.heartbeat.stop(run.taskSuccess);
    } catch (heartbeatErr) {
      console.error('[bridge-agent] Heartbeat cleanup failed:', heartbeatErr.message);
    }
    await cleanupWorkspace(run, deps);
    taskMemory.clearWorkingMemory(currentAgentId);
    releaseTaskLock({ lockOwned, lockFile: TASK_LOCK_FILE });
  }
}

/**
 * What the task spokes need from this process. Built per task, so a spoke never holds a
 * stale reference.
 */
function taskDeps() {
  return {
    slack, postToOps, react, truncate, clearRateLimitState,
    workDir: WORK_DIR, taskTimeout: TASK_TIMEOUT, claudeBin: CLAUDE_BIN, emojiDone: EMOJI_DONE,
  };
}

// ---- Status query handling ----

// LOGIC CHANGE 2026-03-26: Added formatStatusResponse() to build a human-readable
// status message from memory data. Shows currently running task, queued tasks,
// and last 5 completed tasks with elapsed time.
// LOGIC CHANGE 2026-03-26: Added rate limit status display when queue is paused.
// LOGIC CHANGE 2026-04-01: Updated to use task queue for more accurate status.
// LOGIC CHANGE 2026-11-08 (WORK-TODO #39): takes the merge state of each recent row,
// resolved by the caller (lib/merge-state.js) because asking the remote is async.
function formatStatusResponse(mergeStates = new Map()) {
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
      // LOGIC CHANGE 2026-10-04 (WORK-TODO #39): with the branch and commit it left.
      response += `• ${timeStr} ${emoji} ${task.description || 'No description'} (${task.status})${formatWork(task.work)}${formatMergeState(mergeStates.get(task.id))}\n`;
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

/** Agent ids, or none when the registry cannot be read (a verb argument check, not a gate). */
function knownAgentIds() {
  try {
    return loadAgents().map(a => a.id);
  } catch (err) {
    return [];
  }
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
    // The phrase-matched built-ins (lib/conversation-builtins.js, after this block) are
    // deliberately NOT migrated here in this change — those are on the live
    // ASK path with their own phrase-matching behaviour, and moving them is its own
    // change. The router adds verbs; it takes none away. `runCommand` returns
    // { handled: false } for anything it does not own, so nothing that worked before
    // stops working.
    const agentChannelVerb = sourceChannel === BRIDGE_CHANNEL ? { action: null }
      : decideAgentChannelVerb(questionText, knownAgentIds());
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
    } else if (agentChannelVerb.action) {
      // LOGIC CHANGE 2026-10-04 (WORK-TODO #64, the safe half): a verb typed on its own
      // in an agent's channel used to fall through to that agent's model, which
      // answered a question about the system from a persona that cannot see it.
      // LOGIC CHANGE 2026-11-09 (WORK-TODO #64, owner's answer 2026-11-08): a verb that
      // only reads now RUNS here, with this channel's agent as the invoking agent; a verb
      // that changes something or starts work is refused with the reason
      // (lib/agent-channel-verbs.js decides from the command table's `kind`).
      const { verb } = agentChannelVerb;
      let replyText;
      if (agentChannelVerb.action === 'run') {
        const routed = await commandRouter.runCommand(questionText, {
          slack, agent: currentAgent, channelId: sourceChannel, userId: msg.user,
        });
        console.log(`[${agentId}] Read-only command \`${verb}\` handled in an agent channel: ${msg.ts} (ok=${routed.ok})`);
        replyText = routed.text;
      } else {
        console.log(`[${agentId}] Bridge verb \`${verb}\` refused in an agent channel: ${msg.ts}`);
        replyText = describeVerbRefusal(verb, BRIDGE_CHANNEL);
      }
      await slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text: replyText,
        unfurl_links: false,
      });
      return;
    }

    // LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B35): the phrase-matched built-ins (status,
    // owner tasks, create channel, staff tasks, bulletins, standup, the approval queue) are
    // spokes in lib/conversation-builtins.js, tried in the same order with the same channel
    // rule; this hub only hands them what they need and stops when one answered.
    const answered = await answerBuiltin(questionText, {
      reply: (text) => slack.chat.postMessage({
        channel: sourceChannel,
        thread_ts: msg.ts,
        text,
        unfurl_links: false,
      }),
      inBridgeChannel: sourceChannel === BRIDGE_CHANNEL,
      agentId,
      msgTs: msg.ts,
      userId: msg.user,
      slack,
      slackClient,
      storeTasksChannel: config.STORE_TASKS_CHANNEL,
      postToOps,
      resolveMergeStates: () => resolveMergeStates(taskQueue.getQueue().getRecentCompleted(5), { workDir: WORK_DIR }),
      formatStatusResponse,
    });
    if (answered) return;

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
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #20): the default and ceiling are named in
    // lib/task-parser.js and applied by conversationTurns(), not two bare literals here.
    const maxTurns = conversationTurns(currentAgent);
    // LOGIC CHANGE 2026-09-11: Pass llm_model and agentId (see the task call site).
    // LOGIC CHANGE 2026-09-13: runLLM -> runWithFallback, so a gemini agent whose
    // provider is rate limited or unreachable falls through the chain instead of
    // failing the ASK outright. See the task call site for the full rationale.
    // LOGIC CHANGE 2026-11-25 (WORK-TODO #82): an answer runs in an empty directory of
    // its own, not in WORK_DIR (every clone, the gate checkout, the queue). Removed in the
    // finally below whatever the answer does.
    const askCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ask-'));
    let result;
    try {
      result = await runWithFallback(prompt, {
        cwd: askCwd,
        maxTurns,
        timeout: TASK_TIMEOUT,
        claudeBin: CLAUDE_BIN,
        // LOGIC CHANGE 2026-09-13: resolveLlmProvider honours the per-agent
        // LLM_PROVIDER_<AGENTID> on-box override (see the task call site).
        provider: resolveLlmProvider(currentAgent, agentId),
        model: currentAgent?.llm_model,
        agentId,
        // LOGIC CHANGE 2026-11-07: per-agent Claude tool permissions (lib/agent-tools.js).
        agentRecord: currentAgent,
      });
    } finally {
      try {
        fs.rmSync(askCwd, { recursive: true, force: true });
      } catch (rmErr) {
        console.error(`[bridge-agent] Could not remove ${askCwd}:`, rmErr.message);
      }
    }
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

// LOGIC CHANGE 2026-11-08 (WORK-TODO #4): a Socket Mode `message` event in a polled
// channel starts one poll ~1.5 s later (coalesced), so a typed TASK:/ASK: no longer
// waits for the next tick. The event is a wake-up only; poll() still reads the message.
const pollWake = createPollWake({ trigger: pollNow, watchedChannels: () => channelsToPoll });

// LOGIC CHANGE 2026-10-04 (WORK-TODO #4, cheap half): one sweep at a time.
// Before this, the only re-entrancy check was `isRunning`, which is set around a
// TASK: and NOT around an ASK: answer. So a setInterval tick that landed while an ASK:
// was being answered (a model call, routinely longer than POLL_INTERVAL_MS) started a
// SECOND sweep: it could answer the same ASK: again (the dedup mark is written after
// the answer), start a task beside the conversation, and its trailing
// `isRunning = false` could clear the flag while the other sweep's task was still
// running, letting a third sweep start a second task. The guard below makes the sweep
// itself exclusive; a call that finds one in flight returns false and does nothing,
// because the sweep in flight (or the next tick) reads whatever it would have read.
// Guard: tests/poll-reentrancy.test.js.
let pollInFlight = false;
async function poll() {
  if (pollInFlight) return false;
  pollInFlight = true;
  try {
    await pollSweep();
    return true;
  } finally {
    pollInFlight = false;
  }
}

let botTaskLedgerReported = false;

/**
 * WORK-TODO #81: is this bot-authored TASK message one the bridge posted as a task?
 *
 * Waits for task posts still being recorded (the poll can read a post before its
 * poster's await has run), then looks the message up. Not posted by the bridge: logged,
 * and when it parses as a well-formed task (so something real was refused) also posted
 * to #sqtools-ops, once per message. An unreadable ledger refuses every bot task and is
 * reported once per process. Never throws.
 *
 * @returns {Promise<boolean>}
 */
async function isBridgePostedTask(msg, channelId) {
  try {
    await botTaskLedger.settle();
    const found = botTaskLedger.lookup(channelId, msg.ts);
    if (found.posted) return true;
    if (found.error) {
      console.error(`[bridge-agent] Bot task ledger unreadable, refusing bot task ${msg.ts}: ${found.error}`);
      if (!botTaskLedgerReported) {
        botTaskLedgerReported = true;
        await postToOps(
          `:rotating_light: *The bot task ledger cannot be read, so no task the bridge posts will run* ` +
          `(scheduled, approved and /dispatch tasks included): ${found.error}\n` +
          `Fix or remove ${botTaskLedger.DEFAULT_FILE}; a missing file is an empty ledger (WORK-TODO #81).`
        );
      }
      return false;
    }
    console.log(`[bridge-agent] Bot message ${msg.ts} in ${channelId} contains TASK: but the bridge did not post it as a task; not run`);
    const parsed = parseTask(msg.text);
    if (parsed.description && (!parsed.errors || parsed.errors.length === 0)) {
      if (!isTaskProcessed(msg.ts)) {
        markTaskProcessed(msg.ts);
        await postToOps(
          `:shield: *A bot post that carried a task block was not run* (WORK-TODO #81). ` +
          `The bridge did not post it as a task, so it is text the bot relayed (an email, an alert, ` +
          `a task's output). Task line: ${parsed.description || 'none'}. ` +
          `<${msgLink(String(msg.ts), channelId)}|message>`
        );
      }
    }
    return false;
  } catch (err) {
    console.error(`[bridge-agent] Bot task check failed for ${msg.ts}; not run: ${err.message}`);
    return false;
  }
}

/**
 * Poll once now, outside the interval - used after /dispatch posts a task so it starts
 * without waiting up to POLL_INTERVAL_MS. Never throws and never reaches the operator:
 * a skipped or failed immediate poll leaves the message for the next tick to read.
 */
function pollNow(reason) {
  poll()
    .then((ran) => {
      if (!ran) console.log(`[bridge-agent] Immediate poll (${reason}) skipped: a sweep is in flight`);
    })
    .catch((err) => {
      console.error(`[bridge-agent] Immediate poll (${reason}) failed; the next tick retries:`, err.message);
    });
}

// LOGIC CHANGE 2026-03-27: Refactored poll() to iterate through all agent channels.
// Each channel is polled for messages. TASK: messages always go to bridge agent.
// ASK: messages are routed to the agent that owns the channel.
async function pollSweep() {
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
        // LOGIC CHANGE 2026-11-25 (WORK-TODO #81): a bot-authored message runs as a task
        // only when the bridge itself posted it as one (lib/bot-task-ledger.js). The bot
        // also posts text it did not write - email subjects, SqTools alerts, task output -
        // and `isTaskMessage` matches `TASK:` anywhere, so before this any such post that
        // carried a task block ran with the allowlist skipped. A refused bot post that is
        // not a task falls through, so a bot ASK: still reaches the conversation path.
        let runsAsTask = isTaskMessage(msg);
        if (runsAsTask && isBotMessage) {
          runsAsTask = await isBridgePostedTask(msg, channelId);
        }

        if (runsAsTask && !alreadyProcessed(msg) && !isTaskProcessed(msg.ts)) {
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

          // LOGIC CHANGE 2026-10-02 (WORK-TODO #23): mark the message processed
          // BEFORE the task runs, not after. Both dedup guards used to be written only
          // after completion - this mark (after `await currentTaskPromise`) and the
          // done/failed reaction (heartbeat.stop() in processTask's finally) - and
          // neither runs when the process is killed. So a task that was killed (a
          // `docker compose restart`, an OOM, a task that crashes the bridge) was
          // re-read on the next poll and run again, and under `restart:
          // unless-stopped` a task that kills the bridge became a loop. Marking first
          // means a killed task is NOT re-run: the next startup's recoverInterrupted()
          // records it as interrupted and posts it to #sqtools-ops, which tells the
          // operator to re-submit it. A lost re-run is reported; a repeated one was not.
          markTaskProcessed(msg.ts);

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
          // LOGIC CHANGE 2026-11-08 (WORK-TODO #71): halt new asks while an update waits.
          if (await refuseAskForPendingUpdate(msg, channelId)) continue;
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
          // Check authorization for natural messages too.
          // LOGIC CHANGE 2026-10-04 (WORK-TODO #49): no bot exemption here. It exists on
          // the TASK:/ASK: path so scheduled tasks posted AS the bot are not dropped;
          // nothing scheduled posts natural conversation, and exempting the bot let its
          // own reports reach a model. Only an allowlisted person starts one.
          if (!isUserAuthorized(msg.user)) {
            console.log(`[bridge-agent] Ignoring natural message from unauthorized user: ${msg.user}`);
            continue;
          }

          // LOGIC CHANGE 2026-11-09 (WORK-TODO #49, owner's answer 2026-11-08): only an
          // agent whose model run can write nothing answers an unprefixed message, so a
          // remark cannot reach a shell or an edit tool without an explicit ASK:/TASK:.
          const natural = naturalConversationVerdict(channelAgentConfig);
          if (!natural.allowed) {
            console.log(`[bridge-agent] Skipped natural message in ${agentId} channel (${channelId}) ts=${msg.ts}: ${natural.reason}`);
            continue;
          }
          console.log(`[bridge-agent] Natural conversation in ${agentId} channel: ${msg.ts}`);
          if (await refuseAskForPendingUpdate(msg, channelId)) continue;
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
// LOGIC CHANGE 2026-10-04 (WORK-TODO #20): this line printed MAX_TURNS, which no task
// used. It now states where a task's budget actually comes from.
console.log(`  Turns:    ${DEFAULT_TURNS} per task unless TURNS: says otherwise (${MIN_TURNS}-${TURNS_CEILING})`);

// LOGIC CHANGE 2026-10-02 (WORK-TODO #17): say which commit this process booted on,
// read ONCE here and posted, so "is the running bridge on main?" has an answer that
// comes from the running process. A merge reaches the bridge only on a manual
// restart, and nothing reported when the two diverged. postToOps never throws.
// LOGIC CHANGE 2026-10-10: also recorded in lib/boot-record.js, so the jester's digest
// reports this commit instead of saying nothing records it.
const BOOT_COMMIT = require('./lib/boot-record').recordBootCommit(repoHistory.loadedCommit());
console.log(`  Commit:   ${BOOT_COMMIT.available ? `${BOOT_COMMIT.short}${BOOT_COMMIT.dirty ? ' (tracked files modified)' : ''}` : `unknown (${BOOT_COMMIT.reason})`}`);
postToOps(repoHistory.describeLoadedCommit(BOOT_COMMIT));

// LOGIC CHANGE 2026-10-04 (WORK-TODO #66): watch origin main against the commit above,
// and say once per new main sha when they differ - the forgotten-deploy signal. First
// check a minute after boot, then every MAIN_WATCH_INTERVAL_MS (0 turns it off).
// Report-only; lib/main-watch.js pulls and restarts nothing.
const MAIN_WATCH_INTERVAL_MS = parseInt(process.env.MAIN_WATCH_INTERVAL_MS || '1800000', 10);
if (MAIN_WATCH_INTERVAL_MS > 0) {
  const mainWatch = createMainWatch({
    bootCommit: BOOT_COMMIT,
    readMain: () => remoteMainSha(repoHistory.REPO_ROOT),
    notify: postToOps,
  });
  const runMainWatch = () => mainWatch.tick().catch(err => console.error('[main-watch] tick threw:', err.message));
  setTimeout(runMainWatch, 60000).unref();
  setInterval(runMainWatch, MAIN_WATCH_INTERVAL_MS).unref();
}

// LOGIC CHANGE 2026-11-08 (WORK-TODO #17, owner's choice): merged code deploys itself
// once the full suite passes on it. lib/self-deploy.js runs auto-update.js's cycle in
// this process, gated by lib/update-gate.js; a green commit applies when nothing is in
// flight, then this process exits and the container restarts it. `busy` is the poll
// sweep, which holds every TASK: and ASK: while it runs (WORK-TODO #71).
// SELF_DEPLOY_INTERVAL_MS=0 turns it off.
const selfDeploy = createSelfDeploy({
  repoDir: __dirname,
  busy: () => (pollInFlight ? 'a task or an answer is in progress' : null),
  postToOps,
});
selfDeploy.start().then((r) => {
  console.log(`  Deploy:   ${r.started ? 'self-deploy ON (gated by the full suite)' : `self-deploy OFF (${r.reason})`}`);
});

// LOGIC CHANGE 2026-11-09 (WORK-TODO #37, owner's answer 2026-11-08): HIGH owner notices
// are recorded (lib/high-notices.js) and posted here as a digest every
// HIGH_DIGEST_INTERVAL_MS when there are any; the secretary then proposes next steps
// into the approval queue, and nothing runs until the owner approves one.
const HIGH_DIGEST_INTERVAL_MS = highDigestInterval();
if (HIGH_DIGEST_INTERVAL_MS > 0) {
  const highDigest = createHighDigest({ notify: postToOps, bridgeChannelId: BRIDGE_CHANNEL });
  const runHighDigest = () => highDigest.tick().catch(err => console.error('[high-digest] tick threw:', err.message));
  setTimeout(runHighDigest, 120000).unref();
  setInterval(runHighDigest, HIGH_DIGEST_INTERVAL_MS).unref();
}

// LOGIC CHANGE 2026-10-04 (WORK-TODO #42 c): the backup age alert. The host writes
// BACKUP_STATUS_FILE (scripts/backup-status.sh, host cron); this reads it hourly and
// posts to #sqtools-ops when a backup, or the host job itself, is older than
// BACKUP_MAX_AGE_HOURS. Off - and said so in the log - until the file is configured.
const BACKUP_STATUS_FILE = process.env.BACKUP_STATUS_FILE || '';
if (BACKUP_STATUS_FILE) {
  const backupWatch = createBackupWatch({
    file: BACKUP_STATUS_FILE,
    maxAgeMs: (parseFloat(process.env.BACKUP_MAX_AGE_HOURS) || 26) * 3600000,
    notify: postToOps,
  });
  const runBackupWatch = () => backupWatch.tick().catch(err => console.error('[backup-watch] tick threw:', err.message));
  setTimeout(runBackupWatch, 90000).unref();
  setInterval(runBackupWatch, 3600000).unref();
} else {
  console.log('  Backups:  NOT watched (BACKUP_STATUS_FILE unset; see scripts/backup-status.sh)');
}
// LOGIC CHANGE 2026-11-01 (WORK-TODO #77): check that the Claude CLI can actually run a
// call - 45s after boot, then every CLAUDE_AUTH_CHECK_INTERVAL_MS (daily; 0 turns it off).
// A logged-out CLI used to be found only when the 7am briefing failed. Report-only and
// never awaited here, so it cannot delay boot or the poll loop.
const CLAUDE_AUTH_CHECK_INTERVAL_MS = parseInt(process.env.CLAUDE_AUTH_CHECK_INTERVAL_MS || '86400000', 10);
if (CLAUDE_AUTH_CHECK_INTERVAL_MS > 0) {
  const claudeAuthWatch = createClaudeAuthWatch({
    probe: () => probeClaudeAuth({ claudeBin: DEFAULT_CLAUDE_BIN, cwd: WORK_DIR }),
    notify: postToOps,
  });
  const runClaudeAuthWatch = () => claudeAuthWatch.tick().catch(err => console.error('[claude-auth] tick threw:', err.message));
  setTimeout(runClaudeAuthWatch, 45000).unref();
  setInterval(runClaudeAuthWatch, CLAUDE_AUTH_CHECK_INTERVAL_MS).unref();
  console.log(`  ClaudeOK: CLI health check 45s after boot, then every ${Math.round(CLAUDE_AUTH_CHECK_INTERVAL_MS / 3600000)}h`);
} else {
  console.log('  ClaudeOK: CLI health check OFF (CLAUDE_AUTH_CHECK_INTERVAL_MS=0)');
}
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
    // LOGIC CHANGE 2026-11-07 (WORK-TODO #78): a press of a SqTools alert button
    // (block_actions) goes to lib/sqtools-alert-buttons.js, gated by the same allowlist;
    // everything else (the /dispatch modal's view_submission) goes where it always did.
    // LOGIC CHANGE 2026-11-09: a social post draft's buttons and Edit form go to
    // lib/social-buttons.js first (THE ONLY path from a draft to a live post), gated by
    // the same allowlist.
    onInteractive: (envelope) => (socialButtons.isSocialInteraction(envelope && envelope.body)
      ? socialButtons.handleSocialInteraction(envelope, {
        isAuthorized: isUserAuthorized,
        updateMessage: (args) => slack.chat.update(args),
        postEphemeral: (args) => slack.chat.postEphemeral(args),
        openView: (args) => slack.views.open(args),
        notify: postToOps,
      })
      : sqtoolsAlertButtons.isAckAction(envelope && envelope.body)
      ? sqtoolsAlertButtons.handleAckAction(envelope, {
        isAuthorized: isUserAuthorized,
        updateMessage: (args) => slack.chat.update(args),
        postEphemeral: (args) => slack.chat.postEphemeral(args),
        notify: postToOps,
      })
      : handleViewSubmission(envelope, {
        // LOGIC CHANGE 2026-11-25 (WORK-TODO #81): the form's post is a task the bridge
        // posted, so it goes through the ledger the poll loop checks bot posts against.
        postMessage: (args) => botTaskLedger.postBridgeTask(slack, { ...args, unfurl_links: false }, { onUnrecorded: postToOps }),
        isAuthorized: isUserAuthorized,
        // LOGIC CHANGE 2026-10-04 (WORK-TODO #46): the poll set, read at submit time so
        // an activation since boot counts. A form opened anywhere else is refused.
        watchedChannels: () => channelsToPoll,
        // LOGIC CHANGE 2026-10-04 (WORK-TODO #4): start the task now, not next tick.
        onDispatched: () => pollNow('dispatch'),
        notify: postToOps,
        // githubOrg is deliberately NOT passed: omitted, lib/dispatch-message.js
        // falls back to lib/task-parser.js's own DEFAULT_GITHUB_ORG, so the generator
        // and the parser cannot disagree about which org a bare repo name belongs to.
      })),
    // LOGIC CHANGE 2026-11-08 (WORK-TODO #4): THE WAKE SEAM. A channel id, nothing else.
    onMessageSignal: (channel) => pollWake.wake(channel),
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
