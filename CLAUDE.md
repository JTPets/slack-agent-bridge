# CLAUDE.md - Slack Agent Bridge

## Project Overview

Node.js Slack polling agent that monitors Slack channels for task messages and executes them via Claude Code CLI. Running on Raspberry Pi. No database, no frontend, no multi-tenant.

## Tech Stack

- **Runtime**: Node.js 18+
- **Slack SDK**: @slack/web-api ^7.0.0
- **Process Manager**: PM2
- **Timezone**: America/Toronto

---

## Critical Rules

### Security First
- **NEVER log tokens** — Slack tokens, API keys, and secrets must never appear in logs or console output
- **No eval/exec** — Never use `eval()` or `child_process.exec()`. Use `child_process.spawn()` only
- **Sanitize all input** — Validate and sanitize any data from Slack before processing
- **No hardcoded secrets** — All credentials via environment variables

### Error Handling
- **ALL errors posted to Slack** — Every caught error must be reported back to the originating Slack channel
- **Never silent failures** — If something fails, the user must know via Slack message
- **Cleanup temp dirs in finally blocks** — Any temporary directories must be cleaned up in `finally` blocks, not just success paths

```javascript
// CORRECT: Cleanup in finally
let tempDir;
try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'task-'));
    // ... do work ...
} catch (error) {
    await postErrorToSlack(channel, error);
    throw error;
} finally {
    if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
}

// WRONG: Cleanup only on success
try {
    tempDir = await fs.mkdtemp(...);
    // ... do work ...
    await fs.rm(tempDir, ...); // Never reached on error!
} catch (error) {
    // tempDir leaks!
}
```

### Child Process Safety
```javascript
// CORRECT: spawn only
const { spawn } = require('child_process');
const child = spawn('claude', ['--print', message], {
    cwd: workingDir,
    env: { ...process.env }
});

// WRONG: exec allows shell injection
const { exec } = require('child_process');
exec(`claude --print "${message}"`); // NEVER DO THIS
```

### Logic Change Comments
- **Every logic change gets a LOGIC CHANGE comment** — When modifying business logic, add a dated comment explaining what changed and why

```javascript
// LOGIC CHANGE 2026-03-26: Added 5-second delay between polls to avoid rate limiting
const POLL_INTERVAL = 5000;
```

### Testing
- **NO new function ships without a unit test** — This is non-negotiable
- **Tests use Jest** — Test files go in `tests/` mirroring the source structure
- **Run `npm test` before every commit** — If tests fail, do not commit
- **Run `npm run test:smoke` before every deploy** — This catches missing requires, broken imports, and startup crashes that unit tests miss
- **Mock external dependencies** — Slack API calls, child_process.spawn for CC, file system for memory
- **Test the task parser independently** — Various REPO formats, missing fields, multiline INSTRUCTIONS
- **Test memory-manager CRUD operations** — Use a temp directory for isolation
- **Test isTaskMessage and isConversationMessage** — Include edge cases
- **Coverage target** — Every exported function must have at least one test
- **No fix without regression test** — Every bug fix must include a test that would have caught the bug
- **Test error paths** — Ensure error handling is tested, not just happy paths

### Git Rules
- Always start work with: `git checkout main && git pull origin main`
- When told "do not commit" or "show me before committing", do NOT run `git commit` or `git push`
- Never commit tokens or secrets

---

## Code Rules

| Rule | Requirement |
|------|-------------|
| Token logging | NEVER — immediate security violation |
| Error reporting | ALL errors to Slack |
| Shell execution | spawn() only, never exec() or eval() |
| Temp cleanup | Always in finally block |
| Logic changes | LOGIC CHANGE comment required |
| Bug fixes | Regression test required |
| Dependencies | `npm install --save` only — never manually edit package.json |
| Env vars | Document in README if adding new ones |
| Refactor validation | Before committing any refactor that moves variables or changes imports, run: `node -e "require('./bridge-agent.js')"` to verify the process loads. This catches missing references that unit tests miss. |
| dotenv required | Every executable JS file (bridge-agent.js, auto-update.js, cron scripts) MUST have `require('dotenv').config()` as its first line. PM2 does not inherit shell environment variables on restart. |

### Anti-Duplication
• BEFORE creating any file or function, check if it already exists (find/grep first)
• BEFORE writing tests, check for existing test files covering those functions
• If work is already done, report what exists and skip
• Update CLAUDE.md architecture section when adding new files
• CLAUDE.md is the source of truth. If it is wrong, fix it.

### Environment Variable Management
• The .env file is LOCAL ONLY. It is gitignored and must never be committed.
• When adding a new env var to code, you MUST:
    a. Add a sensible default in the code (e.g., process.env.NEW_VAR || 'default')
    b. Update the Environment Variables section in this CLAUDE.md with the var name, description, and default
    c. Include in your task completion message: 'ACTION REQUIRED: Add to .env: NEW_VAR=recommended_value'
• When removing an env var, note it in the completion message so the owner can clean up .env.
• Never hardcode secrets. All tokens, keys, and credentials go in .env.
• The bot cannot edit .env directly. All .env changes require manual action by the owner.

---

## Environment Variables

### Required
| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (xoxb-). **Never log this.** |
| `BRIDGE_CHANNEL_ID` | #claude-bridge channel ID |
| `OPS_CHANNEL_ID` | #sqtools-ops channel ID |

### Optional
| Variable | Description | Default |
|----------|-------------|---------|
| `ALLOWED_USER_IDS` | Comma-separated Slack user IDs allowed to submit tasks | `U02QKNHHU7J` |
| `BOT_USER_ID` | Slack user ID of the bot itself; allows bot to post scheduled tasks in agent channels | `U0AP5PLQB44` |
| `LLM_PROVIDER` | Which LLM backend to use | `claude` |
| `GITHUB_ORG` | Default GitHub org | `jtpets` |
| `CLAUDE_BIN` | Path to claude binary | `/home/jtpets/.local/bin/claude` |
| `POLL_INTERVAL_MS` | Poll frequency in ms | `30000` |
| `MAX_TURNS` | CC max turns per task | `50` |
| `TASK_TIMEOUT_MS` | Hard kill timeout in ms | `600000` |
| `WORK_DIR` | Base dir for temp clones | `/tmp/bridge-agent` |
| `REPOS` | Comma-separated repos for security-review | `jtpets/slack-agent-bridge,jtpets/SquareDashboardTool` |
| `CLAUDE_RATE_LIMIT_PAUSE` | Initial pause duration (ms) when rate limit/bandwidth exhausted | `1800000` |
| `STORE_TASKS_CHANNEL_ID` | #store-tasks channel ID for staff task management | - |

**LLM_PROVIDER options:** `claude` (default), `openai` (not yet implemented), `ollama` (not yet implemented)

### Google Calendar and Gmail integration
| Variable | Description | Default |
|----------|-------------|---------|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Path to Google service account JSON key file | - |
| `GOOGLE_REFRESH_TOKEN` | OAuth refresh token (covers both Calendar and Gmail) | - |
| `GOOGLE_CALENDAR_REFRESH_TOKEN` | Alias for GOOGLE_REFRESH_TOKEN (legacy) | - |
| `GOOGLE_CLIENT_ID` | OAuth client ID (required with refresh token) | - |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret (required with refresh token) | - |
| `GOOGLE_CALENDAR_IDS` | Comma-separated calendar IDs to fetch events from | `primary` |

**Note:** Either `GOOGLE_SERVICE_ACCOUNT_KEY` OR the OAuth trio (`GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) is required for calendar/Gmail integration. `GOOGLE_CALENDAR_REFRESH_TOKEN` is supported as an alias for `GOOGLE_REFRESH_TOKEN`. If neither is set, calendar and email sections in the morning digest will be skipped.

### Auto-update vars
| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_REPO_DIR` | Path to local repo | `/home/jtpets/jt-agent` |
| `CHECK_INTERVAL_MS` | Git poll frequency | `300000` |
| `PM2_PROCESS_NAME` | PM2 process to restart | `bridge-agent` |

### httpSMS integration (Primary SMS)
| Variable | Description | Default |
|----------|-------------|---------|
| `HTTPSMS_API_KEY` | API key from httpsms.com. **Never log this.** | - |
| `HTTPSMS_PHONE_NUMBER` | Owner's phone number with httpSMS app (+1...) | - |
| `STORE_INBOX_CHANNEL_ID` | Slack channel for SMS/call logs | - |
| `SMS_SESSION_TTL_MS` | SMS session expiry | `86400000` |

**Note:** httpSMS uses the owner's Android phone for free SMS. Customers see a real local number. See [docs/SMS-INTEGRATION.md](docs/SMS-INTEGRATION.md) for full specification.

### Twilio integration (Voice/Fallback)
| Variable | Description | Default |
|----------|-------------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID (AC...). **Never log this.** | - |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. **Never log this.** | - |
| `TWILIO_PHONE_NUMBER` | JT Pets Twilio phone number (+1...) | - |
| `TWILIO_WEBHOOK_URL` | Public webhook URL via Cloudflare Tunnel | - |
| `VOICE_MAX_DURATION_SEC` | Max voice call duration | `300` |

**Note:** Twilio is optional, only needed for voice/IVR features. See [docs/SMS-INTEGRATION.md](docs/SMS-INTEGRATION.md).

### Storefront chat widget
| Variable | Description | Default |
|----------|-------------|---------|
| `STOREFRONT_PORT` | Port for storefront Express server | `3001` |
| `STOREFRONT_ALLOWED_ORIGINS` | Comma-separated CORS origins | `http://localhost:3000,https://jtpets.ca` |
| `STOREFRONT_SESSION_TTL_MS` | Session expiry time in ms | `3600000` |
| `DELIVERY_QUOTES_FILE` | Path to delivery quotes JSON file | `data/delivery-quotes.json` |

**Note:** `STORE_INBOX_CHANNEL_ID` (listed in Twilio section) is also used by the storefront widget for logging conversations and delivery quote requests.

---

## Commands

```bash
# Development
npm start                    # Run the agent
node bridge-agent.js         # Direct execution

# Production (PM2)
# PM2 runs 3 processes: sqtools (PRODUCTION DO NOT TOUCH), bridge-agent, auto-update
# Cloudflare tunnel: sudo systemctl restart cloudflared-sqtools
pm2 start bridge-agent.js --name slack-bridge
pm2 restart slack-bridge
pm2 logs slack-bridge

# Morning digest runs via cron, not PM2:
# 0 8 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node morning-digest.js

# Security review runs via cron at 1am daily:
# 0 1 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node security-review.js

# Storefront chat widget
node bots/storefront.js              # Direct execution
pm2 start bots/storefront.js --name storefront-chat

# Testing
npm test
```

---

## Error Handling Pattern

```javascript
async function handleTask(channel, message) {
    let tempDir;
    try {
        tempDir = await createTempDir();

        const result = await executeTask(tempDir, message);
        await postToSlack(channel, result);

    } catch (error) {
        // ALWAYS report errors to Slack
        await postToSlack(channel, `❌ Error: ${error.message}`);

        // Log error details (but NEVER tokens)
        console.error('Task failed:', {
            message: error.message,
            stack: error.stack,
            // NEVER: token: process.env.SLACK_BOT_TOKEN
        });

    } finally {
        // ALWAYS cleanup temp dirs
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}
```

---

## Architecture

```
slack-agent-bridge/
├── bridge-agent.js       # Main entry point: Slack polling, task execution via Claude CLI
├── auto-update.js        # Git polling daemon: pulls updates and restarts PM2 on changes
├── morning-digest.js     # Cron job script: sends daily task stats DM to owner
├── security-review.js    # Cron job script: security audit of commits from last 24h
├── scripts/
│   └── watercooler.js    # Cron/manual script: weekly team standup conversation (Friday 5PM)
├── bots/
│   └── storefront.js     # Express server for storefront chat widget (POST /api/chat, GET /widget, POST /api/delivery-quote)
├── data/
│   └── delivery-quotes.json  # Delivery quote requests (created at runtime)
├── public/
│   ├── widget.html       # Embeddable chat widget HTML (mobile-responsive, floating button)
│   └── delivery.html     # Courier intake page with geocoding and auto-quote (JTPets.ca/delivery)
├── agents/
│   ├── agents.json               # Agent registry: defines all agents, permissions, and config
│   ├── activation-checklists.json # Owner action items for activating each agent
│   ├── shared/
│   │   ├── bulletin.json         # Inter-agent bulletin board (created at runtime, gitignored)
│   │   ├── watercooler-state.json # Tracks last standup timestamp (created at runtime, gitignored)
│   │   ├── processed-tasks.json  # Task deduplication: Slack msg timestamps (created at runtime, gitignored)
│   │   ├── channel-map.json      # Resolved channel ID cache (created at runtime, gitignored)
│   │   ├── staff.json            # Staff member definitions (name, slackId, role)
│   │   └── daily-tasks-template.json  # Recurring daily store tasks template
│   ├── bridge/
│   │   └── memory/       # Bridge agent's tiered memory directory
│   │       ├── context.json      # Permanent: owner info, preferences
│   │       ├── working.json      # Session: current task state
│   │       ├── short-term.json   # 24-72h TTL: recent events, reminders
│   │       ├── long-term.json    # Weeks/months: patterns, preferences
│   │       └── archive.json      # Decayed long-term (reference only)
│   └── social-media/
│       └── memory/       # Social Media Manager's memory directory
│           ├── backlog.json      # Activation backlog and feature roadmap
│           └── .gitkeep          # Placeholder for memory files
├── lib/
│   ├── agent-context.js  # Agent context builder: injects real data into ASK prompts to prevent hallucination
│   ├── agent-registry.js # Agent registry loader: loadAgents, getAgent, getAgentByChannel, activateAgent
│   ├── bulletin-board.js # Inter-agent communication: postBulletin, getBulletins, markRead, cleanupOldBulletins
│   ├── config.js         # Environment variable loading, validation, and defaults
│   ├── llm-runner.js     # LLM execution abstraction with provider adapters (claude, openai, ollama)
│   ├── memory-tiers.js   # Tiered memory system: TTL expiry, auto-promote, cleanup, archive
│   ├── owner-tasks.js    # Owner task management: activation checklists, pending tasks, ACTION REQUIRED detection
│   ├── code-review-pipeline.js  # 3-phase task pipeline: reviewTask (Phase 1), buildPrompt (Phase 2), validateOutput (Phase 3)
│   ├── slack-client.js   # Slack client wrapper: channel management (createChannel, ensureChannel, joinAgentChannels, loadChannelMap)
│   ├── staff-tasks.js    # Staff task management: daily tasks, assignments, escalations to #store-tasks
│   ├── task-parser.js    # Task message parsing and message type detection
│   ├── validate.js       # Pre-commit validation: checks bridge-agent.js loads and file line counts
│   ├── watercooler.js    # Multi-agent standup orchestrator: runStandup, agent conversation flow
│   └── integrations/
│       ├── google-calendar.js  # Google Calendar API integration for fetching events (today, tomorrow, yesterday)
│       ├── gmail.js            # Gmail API integration: getRecentEmails, getEmailById, getEmailHeaders (read-only)
│       ├── email-categorizer.js # Email categorization by sender/subject patterns (vendor_deal, customer, newsletter, etc.)
│       ├── holidays.js         # Canadian public holidays (Nager.Date API) and pet awareness dates
│       └── httpsms.js          # httpSMS API wrapper: sendSMS, getMessages, registerWebhook (free SMS via Android)
├── memory/
│   └── memory-manager.js # Task history storage and context retrieval (legacy + tiered API)
├── skills/               # Reusable skill templates for common tasks
│   ├── run-tests/
│   │   └── SKILL.md      # Run test suite and report results
│   ├── code-review/
│   │   └── SKILL.md      # Review commits for issues and violations
│   ├── research/
│   │   └── SKILL.md      # Research topics with pros/cons/recommendations
│   ├── deploy-check/
│   │   └── SKILL.md      # Verify deployment health checks
│   ├── refactor/
│   │   └── SKILL.md      # Safe refactoring with pre/post checks
│   ├── security-review/
│   │   └── SKILL.md      # Security audit of commits for vulnerabilities
│   └── accountability-check/
│       └── SKILL.md      # Review calendar events and verify task completion
├── tests/
│   ├── smoke.test.js            # Smoke tests: module loading, dotenv checks, export verification
│   ├── integration.test.js      # Integration tests: critical paths, wiring, no circular deps
│   ├── agent-context.test.js    # Tests for lib/agent-context.js (anti-hallucination, secretary context)
│   ├── agent-registry.test.js   # Tests for lib/agent-registry.js (includes activation helpers)
│   ├── config.test.js           # Tests for lib/config.js
│   ├── llm-runner.test.js       # Tests for lib/llm-runner.js
│   ├── memory-tiers.test.js     # Tests for lib/memory-tiers.js (TTL, auto-promote, cleanup)
│   ├── message-detection.test.js # Tests for isTaskMessage/isConversationMessage
│   ├── owner-tasks.test.js      # Tests for lib/owner-tasks.js (checklists, pending tasks)
│   ├── retry-logic.test.js      # Tests for auto-retry on max turns behavior
│   ├── code-review-pipeline.test.js # Tests for lib/code-review-pipeline.js (reviewTask, buildPrompt, validateOutput)
│   ├── slack-client.test.js     # Tests for lib/slack-client.js (channel management, joinAgentChannels)
│   ├── task-parser.test.js      # Tests for task parsing logic (includes create channel command)
│   ├── storefront.test.js       # Tests for bots/storefront.js (chat API, session management)
│   ├── holidays.test.js         # Tests for lib/integrations/holidays.js (API, pet dates, caching)
│   ├── gmail.test.js            # Tests for lib/integrations/gmail.js (OAuth, email parsing, API)
│   ├── email-categorizer.test.js # Tests for lib/integrations/email-categorizer.js (categorization, rules)
│   ├── staff-tasks.test.js      # Tests for lib/staff-tasks.js (assignments, escalations, daily tasks)
│   ├── bulletin-board.test.js   # Tests for lib/bulletin-board.js (inter-agent communication)
│   └── watercooler.test.js      # Tests for lib/watercooler.js (standup orchestration, agent flow)
├── docs/
│   ├── AGENTS.md            # Agent registry and memory tier documentation
│   ├── COURIER-INTAKE.md    # Courier intake page and delivery quote API documentation
│   ├── INTEGRATION-SPEC.md  # SqTools API integration specification and security requirements
│   ├── SMS-INTEGRATION.md    # SMS integration spec: httpSMS (primary), Twilio (fallback/voice)
│   ├── SOCIAL-MEDIA-DESIGN.md # Social Media Manager agent design and content strategy
│   └── STOREFRONT-WIDGET.md  # Storefront chat widget documentation and embedding guide
├── package.json          # Dependencies and npm scripts
├── CLAUDE.md             # Project rules and documentation (this file)
├── README.md             # Project overview
└── .gitignore            # Git ignore rules (node_modules, .env, etc.)
```

---

## Security

• GitHub branch protection MUST be enabled on main for all repos: block force pushes, prevent deletion
• Dependabot enabled: checks npm dependencies weekly on Mondays, opens PRs for security updates (max 5 open PRs)
• Bot only processes messages from ALLOWED_USER_IDS
• Never log or post tokens, API keys, or .env values
• Tasks run with --dangerously-skip-permissions (required for non-interactive CC). Mitigated by: max turns cap, timeout, user allowlist, branch protection
• NEVER run git push --force or git branch -D on main
• NEVER delete or overwrite .env files on the Pi

### External API Integration Security
See [docs/INTEGRATION-SPEC.md](docs/INTEGRATION-SPEC.md) for SqTools API security requirements including:
• API key authentication (X-API-Key header)
• Rate limiting (60 req/min per key)
• IP allowlist (127.0.0.1 only by default)
• Read-only access, no write operations without approval
• Response sanitization (no stack traces, internal paths, or DB details)

### Required Slack Scopes
The bot requires these OAuth scopes at [api.slack.com/apps](https://api.slack.com/apps):
| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages from public channels |
| `channels:read` | List and find channels by name |
| `channels:manage` | Create channels and set topics |
| `channels:join` | Join the bot to channels |
| `chat:write` | Post messages to channels |
| `reactions:write` | Add emoji reactions to messages |
| `reactions:read` | Check if messages have been processed |
| `users:read` | Resolve user IDs |

If the API returns `missing_scope` error, the log will show: `Missing Slack scope: <scope>. Add it at api.slack.com/apps`

---

## Code Review Pipeline

When a task has a REPO field, `bridge-agent.js` runs a 3-phase pipeline via `lib/code-review-pipeline.js`:

**Phase 1 — Review (before executing)**
- Reads `CLAUDE.md` and `COMMANDMENTS.md` from the cloned repo
- Reads `package.json` for test scripts and dependencies
- Lists all JS files in the repo (excluding node_modules)
- Checks `git log --oneline -20` for recent changes
- Searches for relevant existing code by keyword to surface patterns
- Returns context object with all codebase information

**Phase 2 — Execute (enriched prompt)**
- `buildPrompt()` assembles the full prompt in this order:
  1. COMMANDMENTS.md content
  2. Agent system_prompt (personality)
  3. Production warning (if applicable)
  4. CLAUDE.md rules from cloned repo
  5. Memory context (task history)
  6. Bulletin context (recent agent bulletins)
  7. Repo structure (JS file list)
  8. Recent git history
  9. Relevant existing code snippets
  10. Skill template content (if SKILL: specified)
  11. Execution plan metadata
  12. Original task instructions
  13. Quality checklist (LOGIC CHANGE, npm test, no console.log, env var docs)
- Claude gets the FULL context, not just raw task instructions
- Falls back to basic prompt if pipeline throws

**Phase 3 — Validate (after executing)**
- Runs `npm test` in the cloned repo
- Checks changed files for LOGIC CHANGE comments
- Warns about `console.log` in non-test files
- Reports test results to `#sqtools-ops`
- If tests fail: posts report as "tests failed after completion"
- If tests pass: posts `:white_check_mark: Code review passed — N tests passing`

### Task Deduplication

`agents/shared/processed-tasks.json` (gitignored) stores processed Slack message timestamps.
- Loaded on every startup
- Checked before processing any TASK: or ASK: message
- Written after processing (success or fail)
- Entries older than 7 days cleaned up on startup
- Prevents re-processing old messages after PM2 restarts

### Channel Auto-Join

On every startup, `slackClient.joinAgentChannels(channelsToPoll)` is called to join all
agent channels before the poll loop starts. This ensures the bot is in all channels even
if channels were recreated while the bot was offline. Results are logged:
`[bridge-agent] Joined 5/5 agent channels` or `Joined 3/5 agent channels (2 failed - check scopes)`

Resolved channel IDs are cached in `agents/shared/channel-map.json` (gitignored) to reduce
API calls on subsequent startups.

---

## Task Message Format

```
TASK: Short description
REPO: jtpets/repo-name (or full GitHub URL)
BRANCH: main (optional, default: main)
TURNS: 50 (optional, default: 50, range: 5-100)
INSTRUCTIONS: What to do
```

### Field Reference
| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| TASK | Yes | - | Short description of the task |
| REPO | No | - | GitHub repo (org/repo or full URL) |
| BRANCH | No | main | Branch to clone from |
| TURNS | No | 50 | Max LLM turns for this task (5-100) |
| INSTRUCTIONS | Yes | - | Detailed instructions (can be multiline) |

### TURNS Field
• Controls how many LLM turns (API round-trips) the agent will execute for this task.
• Default: 50. Minimum: 5. Maximum: 100.
• Non-numeric values are ignored (falls back to default).
• Use higher values for complex multi-step tasks. Use lower values for quick fixes.

### Auto-Retry on Max Turns
When a task hits its max turns limit, the agent automatically retries ONCE with doubled turns:
• First attempt runs with the specified TURNS value (or default 50)
• If max turns is hit and original turns < 100, the agent posts a message to #sqtools-ops and retries with turns × 2 (capped at 100)
• If the retry also hits max turns, the agent posts a warning and gives up
• No retry occurs if original turns was already 100
• Memory tracking records: `{ retried: true, originalTurns: N, retryTurns: N*2 }` when a retry occurred

### Branch Handling
• BRANCH in a task message specifies which branch to CLONE from, not which branch to CREATE.
• If a task needs to create a new branch, set BRANCH to main and include branch creation in the INSTRUCTIONS.
• The agent always clones the specified branch. If the branch does not exist on the remote, the clone fails.
• Example: To create feature/foo, use BRANCH: main and instruct CC to git checkout -b feature/foo

---

## Built-in Commands

The agent responds to these built-in commands without calling the LLM. Use them via `ASK: <command>`.

### Status Query
Check the task queue and recent history:
```
ASK: what's queued
ASK: queue status
ASK: task status
ASK: what are you working on
```
Returns: currently running task, queued tasks, and last 5 completed tasks.

### Create Channel
Create a Slack channel and invite the bot:
```
ASK: create channel #channel-name
ASK: create channel channel-name
```
- Channel names are auto-normalized (lowercase, spaces to hyphens, max 80 chars)
- Returns channel ID if successful
- If channel exists, joins it instead of failing
- Requires `channels:manage` scope

### Owner Tasks
Check pending owner action items:
```
ASK: what do I need to do
ASK: my tasks
ASK: pending tasks
```
Returns: activation checklists and ACTION REQUIRED items from recent tasks.

### Staff Tasks
Manage daily store operations tasks (requires `STORE_TASKS_CHANNEL_ID`):
```
ASK: assign [task] to [name] by [time]
ASK: what tasks are overdue
ASK: store tasks today
```
- Tasks are posted to #store-tasks with priority emoji, assignee, and due time
- Staff members defined in `agents/shared/staff.json`
- Daily recurring tasks from `agents/shared/daily-tasks-template.json`
- Critical overdue tasks (high priority, 1+ hour late) escalate to owner via DM
- Morning digest includes staff task summary

### Bulletin Board
View recent inter-agent bulletins:
```
ASK: bulletins
ASK: what's new
ASK: show bulletins
```
- Returns recent bulletins from all agents (milestones, alerts, task completions, security findings)
- Bulletins automatically posted when: tasks complete, morning digest runs, security review finds issues
- Other agents see unread bulletins in their conversation context
- Old bulletins cleaned up daily (7 day retention)

### Team Standup
Trigger a multi-agent standup conversation:
```
ASK: team standup
ASK: standup
ASK: watercooler
ASK: kickoff standup
ASK: retro standup
```
- Each active agent shares an update in their personality voice
- Agents reference and respond to what previous agents said
- The Jester gets the final word and pokes holes in what others said
- Standup posts to #sqtools-ops channel
- Story Bot flags anything worth a LinkedIn post

**Two standup types:**

| Type | Schedule | Theme |
|------|----------|-------|
| Kickoff | Monday 8:30 AM | "What are we focused on this week? What opportunities do you see?" |
| Retro | Friday 5:00 PM | "What did we accomplish? What failed? What surprised us?" |

**Kickoff Standup (Monday 8:30 AM):**
- Secretary opens: calendar for the week, key dates, deadlines
- Marketing: campaigns or content due this week
- Social Media: content calendar for the week
- Story Bot: LinkedIn posts queued
- Security: overnight findings
- Code agents: what's in the pipeline
- Jester closes: challenges the weekly plan, picks one thing to kill

**Retro Standup (Friday 5:00 PM):**
- Secretary opens: week recap, tasks completed vs planned
- All agents: wins, losses, observations from their domain
- Story Bot: flags best moments for LinkedIn content
- Jester closes: grades the week A-F, names MVP agent, roasts weakest performer

**Cron schedules:**
```bash
# Monday Kickoff (8:30 AM Toronto time)
30 8 * * 1 cd /home/jtpets/jt-agent && set -a && source .env && set +a && node scripts/watercooler.js kickoff

# Friday Retro (5:00 PM Toronto time)
0 17 * * 5 cd /home/jtpets/jt-agent && set -a && source .env && set +a && node scripts/watercooler.js retro
```

Manual execution: `node scripts/watercooler.js [kickoff|retro]`

---

## Agent Activation

When activating an agent from "planned" to "active" status:
1. Use `ASK: create channel #agent-name` to create the channel
2. Update `agents/agents.json` with the channel ID
3. Remove the `status: "planned"` field
4. Complete any activation checklist items

The agent registry helper `activateAgent(id, slackClient)` automates this:
- Creates channel named `<id>-agent` if none assigned
- Sets topic from agent's name and role
- Updates the registry JSON
- Returns `{ agent, channelCreated, channelId }`

---

## Checklist for Changes

- [ ] No tokens or secrets in logs
- [ ] All errors posted to Slack
- [ ] Temp directories cleaned in finally blocks
- [ ] Using spawn(), not exec() or eval()
- [ ] LOGIC CHANGE comment added for logic changes
- [ ] Regression test added for bug fixes
- [ ] No new dependencies without npm install --save
