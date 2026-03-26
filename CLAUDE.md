# CLAUDE.md - Slack Agent Bridge

## Project Overview

Single-file Node.js Slack polling agent that monitors Slack channels for task messages and executes them via Claude Code CLI. Running on Raspberry Pi. No database, no frontend, no multi-tenant.

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

### Testing Requirements
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

---

## Environment Variables

```bash
SLACK_BOT_TOKEN=xoxb-...     # Bot token (never log this)
SLACK_CHANNEL_ID=C...        # Channel to poll
POLL_INTERVAL_MS=5000        # Polling interval (optional, default 5000)
```

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
├── bridge-agent.js      # Single-file agent (all logic here)
├── package.json         # Dependencies
├── CLAUDE.md           # This file
└── README.md           # Project description
```

This is intentionally a single-file architecture. Do not split into multiple files unless the file exceeds 500 lines.

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
