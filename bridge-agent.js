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
 *   MAX_TURNS           Claude Code max turns per task (default: 30)
 *   TASK_TIMEOUT_MS     hard kill timeout (default: 600000 = 10min)
 *   CLAUDE_BIN          path to claude binary
 *   WORK_DIR            base dir for temp clones (default: /tmp/bridge-agent)
 */

const { WebClient } = require('@slack/web-api');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// LOGIC CHANGE 2026-03-26: Added memory-manager integration to track task
// execution history for analytics and debugging purposes.
const memory = require('./memory/memory-manager');

// ---- Config ----

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const BRIDGE_CHANNEL = process.env.BRIDGE_CHANNEL_ID;
const OPS_CHANNEL = process.env.OPS_CHANNEL_ID;
const GITHUB_ORG = process.env.GITHUB_ORG || 'jtpets';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
// LOGIC CHANGE 2026-03-26: Increased MAX_TURNS default from 15 to 30 to allow
// more complex tasks to complete without hitting the turn limit.
const MAX_TURNS = parseInt(process.env.MAX_TURNS || '30', 10);
const TASK_TIMEOUT = parseInt(process.env.TASK_TIMEOUT_MS || '600000', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/jtpets/.local/bin/claude';
const WORK_DIR = process.env.WORK_DIR || '/tmp/bridge-agent';

const EMOJI_RUNNING = 'hourglass_flowing_sand';
const EMOJI_DONE = 'robot_face';
const EMOJI_FAILED = 'x';

// Validate required config
const missing = [];
if (!SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
if (!BRIDGE_CHANNEL) missing.push('BRIDGE_CHANNEL_ID');
if (!OPS_CHANNEL) missing.push('OPS_CHANNEL_ID');
if (missing.length) {
  console.error(`[bridge-agent] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);

// Ensure work dir exists
if (!fs.existsSync(WORK_DIR)) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
}

// ---- State persistence ----

const STATE_FILE = path.join(__dirname, '.bridge-agent-state.json');
let lastChecked = loadState();
let isRunning = false;

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

function parseTask(text) {
  const task = {
    description: '',
    repo: '',
    branch: 'main',
    instructions: '',
    raw: text,
  };

  // Extract TASK:
  const taskMatch = text.match(/TASK:\s*(.+?)(?:\n|$)/);
  if (taskMatch) task.description = taskMatch[1].trim();

  // Extract REPO: (handles "org/repo", "https://github.com/org/repo", or just "repo")
  const repoMatch = text.match(/REPO:\s*(.+?)(?:\n|$)/);
  if (repoMatch) {
    let repo = repoMatch[1].trim();
    repo = repo.replace(/https?:\/\/github\.com\//, '');
    repo = repo.replace(/\.git$/, '');
    if (!repo.includes('/')) {
      repo = `${GITHUB_ORG}/${repo}`;
    }
    task.repo = repo;
  }

  // Extract BRANCH:
  const branchMatch = text.match(/BRANCH:\s*(.+?)(?:\n|$)/);
  if (branchMatch) {
    const branch = branchMatch[1].trim();
    if (branch && branch !== 'none') task.branch = branch;
  }

  // Extract INSTRUCTIONS: (everything after the label, can be multiline)
  const instrMatch = text.match(/INSTRUCTIONS:\s*([\s\S]+)/);
  if (instrMatch) task.instructions = instrMatch[1].trim();

  return task;
}

function isTaskMessage(msg) {
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (!msg.text) return false;
  return msg.text.includes('TASK:');
}

function alreadyProcessed(msg) {
  if (!msg.reactions) return false;
  return msg.reactions.some(
    (r) => r.name === EMOJI_DONE || r.name === EMOJI_FAILED
  );
}

// LOGIC CHANGE 2026-03-26: Added conversational mode support for quick Q&A.
// Messages starting with "ASK:" are answered directly via Claude Code without
// repo cloning. Response is posted as a thread reply to the original message.
function isConversationMessage(msg) {
  if (msg.subtype === 'channel_join' || msg.subtype === 'channel_leave') return false;
  if (!msg.text) return false;
  return msg.text.trim().toUpperCase().startsWith('ASK:');
}

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

// ---- Claude Code execution ----

function runClaudeCode(taskText, cwd) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', taskText,
      '--output-format', 'text',
      '--max-turns', String(MAX_TURNS),
      '--dangerously-skip-permissions',
    ];

    console.log(`[bridge-agent] Spawning CC in ${cwd} (max-turns=${MAX_TURNS})`);

    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: { ...process.env, HOME: os.homedir() },
      timeout: TASK_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(
          `Exit code ${code}${stderr ? '\n' + stderr.slice(0, 2000) : ''}`
        ));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
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

      prompt = [
        `You are working in a cloned repo: ${task.repo} (branch: ${task.branch}).`,
        `Your working directory is the repo root.`,
        `When done, commit and push your changes if you made any code changes.`,
        '',
        task.instructions || task.description,
      ].join('\n');
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

    const output = await runClaudeCode(prompt, cwd);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    // LOGIC CHANGE 2026-03-26: Check if output indicates max turns was reached.
    // If so, post a warning to ops before posting the partial output.
    const hitMaxTurns = output.includes('Reached max turns');
    if (hitMaxTurns) {
      await postToOps(
        `:warning: *Task hit max turns limit. May be partially complete.*\n` +
        `Source: <${msgLink(msg.ts)}|#claude-bridge>`
      );
    }

    const repoLabel = task.repo ? `\nRepo: \`${task.repo}\` (${task.branch})` : '';

    await postToOps(
      `:white_check_mark: *Task completed* (${elapsed}s)\n` +
      `Source: <${msgLink(msg.ts)}|#claude-bridge>${repoLabel}\n\n` +
      `\`\`\`\n${truncate(output)}\n\`\`\``
    );

    await unreact(BRIDGE_CHANNEL, msg.ts, EMOJI_RUNNING);
    await react(BRIDGE_CHANNEL, msg.ts, EMOJI_DONE);
    console.log(`[bridge-agent] Task ${msg.ts} done (${elapsed}s)`);

    // LOGIC CHANGE 2026-03-26: Record task completion in memory.
    // Use different outcome format if max turns was hit.
    if (memoryTaskId) {
      try {
        if (hitMaxTurns) {
          memory.completeTask(memoryTaskId, { output: 'max turns reached', partial: true });
        } else {
          memory.completeTask(memoryTaskId, { output: truncate(output, 500), elapsed: parseInt(elapsed, 10) });
        }
      } catch (memErr) {
        console.error('[bridge-agent] Memory completeTask failed:', memErr.message);
      }
    }

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);

    await postToOps(
      `:x: *Task failed* (${elapsed}s)\n` +
      `Source: <${msgLink(msg.ts)}|#claude-bridge>\n\n` +
      `\`\`\`\n${truncate(err.message)}\n\`\`\``
    );

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

    // Run Claude Code with -p flag, max-turns 10
    const args = [
      '-p', prompt,
      '--output-format', 'text',
      '--max-turns', '10',
      '--dangerously-skip-permissions',
    ];

    const output = await new Promise((resolve, reject) => {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: WORK_DIR,
        env: { ...process.env, HOME: os.homedir() },
        timeout: TASK_TIMEOUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(
            `Exit code ${code}${stderr ? '\n' + stderr.slice(0, 2000) : ''}`
          ));
        }
      });

      child.on('error', (err) => {
        reject(new Error(`Spawn failed: ${err.message}`));
      });
    });

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

      // Check for TASK: messages first
      if (isTaskMessage(msg) && !alreadyProcessed(msg)) {
        console.log(`[bridge-agent] Task found: ${msg.ts}`);
        isRunning = true;

        await processTask(msg);

        isRunning = false;
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

console.log('[bridge-agent] Starting v2');
console.log(`  Claude:   ${CLAUDE_BIN}`);
console.log(`  Bridge:   #claude-bridge (${BRIDGE_CHANNEL})`);
console.log(`  Ops:      #sqtools-ops (${OPS_CHANNEL})`);
console.log(`  GitHub:   ${GITHUB_ORG}`);
console.log(`  WorkDir:  ${WORK_DIR}`);
console.log(`  Interval: ${POLL_INTERVAL / 1000}s`);
console.log(`  Timeout:  ${TASK_TIMEOUT / 1000}s`);
console.log(`  Turns:    ${MAX_TURNS}`);

poll();
setInterval(poll, POLL_INTERVAL);

process.on('SIGTERM', () => {
  console.log('[bridge-agent] Shutting down');
  process.exit(0);
});
