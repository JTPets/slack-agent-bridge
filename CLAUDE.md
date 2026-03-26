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
| `GITHUB_ORG` | Default GitHub org | `jtpets` |
| `CLAUDE_BIN` | Path to claude binary | `/home/jtpets/.local/bin/claude` |
| `POLL_INTERVAL_MS` | Poll frequency in ms | `30000` |
| `MAX_TURNS` | CC max turns per task | `50` |
| `TASK_TIMEOUT_MS` | Hard kill timeout in ms | `600000` |
| `WORK_DIR` | Base dir for temp clones | `/tmp/bridge-agent` |

### Auto-update vars
| Variable | Description | Default |
|----------|-------------|---------|
| `LOCAL_REPO_DIR` | Path to local repo | `/home/jtpets/jt-agent` |
| `CHECK_INTERVAL_MS` | Git poll frequency | `300000` |
| `PM2_PROCESS_NAME` | PM2 process to restart | `bridge-agent` |

---

## Commands

```bash
# Development
npm start                    # Run the agent
node bridge-agent.js         # Direct execution

# Production (PM2)
pm2 start bridge-agent.js --name slack-bridge
pm2 restart slack-bridge
pm2 logs slack-bridge

# Morning digest runs via cron, not PM2:
# 0 8 * * * cd /home/jtpets/jt-agent && set -a && source .env && set +a && node morning-digest.js

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
├── lib/
│   ├── config.js         # Environment variable loading, validation, and defaults
│   └── task-parser.js    # Task message parsing and message type detection
├── memory/
│   └── memory-manager.js # Task history storage and context retrieval (JSON file-based)
├── tests/
│   ├── config.test.js           # Tests for lib/config.js
│   ├── message-detection.test.js # Tests for isTaskMessage/isConversationMessage
│   └── task-parser.test.js      # Tests for task parsing logic
├── package.json          # Dependencies and npm scripts
├── CLAUDE.md             # Project rules and documentation (this file)
├── README.md             # Project overview
└── .gitignore            # Git ignore rules (node_modules, .env, etc.)
```

---

## Task Message Format

### Branch Handling
• BRANCH in a task message specifies which branch to CLONE from, not which branch to CREATE.
• If a task needs to create a new branch, set BRANCH to main and include branch creation in the INSTRUCTIONS.
• The agent always clones the specified branch. If the branch does not exist on the remote, the clone fails.
• Example: To create feature/foo, use BRANCH: main and instruct CC to git checkout -b feature/foo

---

## Checklist for Changes

- [ ] No tokens or secrets in logs
- [ ] All errors posted to Slack
- [ ] Temp directories cleaned in finally blocks
- [ ] Using spawn(), not exec() or eval()
- [ ] LOGIC CHANGE comment added for logic changes
- [ ] Regression test added for bug fixes
- [ ] No new dependencies without npm install --save
