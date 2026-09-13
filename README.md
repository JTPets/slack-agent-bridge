# Slack Agent Bridge

A Slack bot that executes coding tasks via Claude Code CLI—post a task, get a commit.

## What It Does

- Polls Slack channels for task messages in a structured format
- Clones GitHub repos, runs Claude Code CLI with your instructions
- Commits and pushes changes automatically
- Supports conversational mode for quick questions (ASK prefix)
- Self-updates from git (the restart step is currently manual — see Auto-Update)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                          SLACK WORKSPACE                            │
│  ┌─────────────────┐                      ┌─────────────────┐       │
│  │ #claude-bridge  │                      │  #sqtools-ops   │       │
│  │                 │                      │                 │       │
│  │ TASK: Fix bug   │                      │ ✅ Task done    │       │
│  │ REPO: org/repo  │                      │ 🔗 PR created   │       │
│  │ INSTRUCTIONS:   │                      │                 │       │
│  │ ...             │                      │                 │       │
│  └────────┬────────┘                      └────────▲────────┘       │
└───────────│────────────────────────────────────────│────────────────┘
            │ poll                                   │ post results
            ▼                                        │
┌───────────────────────────────────────────────────────────────────┐
│                       BRIDGE AGENT (Node.js)                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ Task Parser  │  │ Memory Mgr   │  │ Auto-Updater             │ │
│  │ - validates  │  │ - history    │  │ - git pull               │ │
│  │ - extracts   │  │ - context    │  │ - restart (manual)       │ │
│  └──────┬───────┘  └──────────────┘  └──────────────────────────┘ │
│         │                                                          │
│         ▼                                                          │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │                      LLM Runner                               │ │
│  │  spawn('claude', ['--print', ...])                           │ │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
            ┌─────────────────────┼─────────────────────┐
            ▼                     ▼                     ▼
     ┌────────────┐        ┌────────────┐        ┌────────────┐
     │   GitHub   │        │   GitHub   │        │   GitHub   │
     │  org/repo1 │        │  org/repo2 │        │  org/repo3 │
     │            │        │            │        │            │
     │ git clone  │        │ git clone  │        │ git clone  │
     │ make edits │        │ make edits │        │ make edits │
     │ git push   │        │ git push   │        │ git push   │
     └────────────┘        └────────────┘        └────────────┘
```

## Prerequisites

- Node.js 18+
- [Claude Code CLI](https://github.com/anthropics/claude-code) installed and authenticated
- Slack workspace with a bot token (Bot User OAuth Token starting with `xoxb-`)
- GitHub account with SSH keys configured

## Quick Start

```bash
# Clone the repo
git clone https://github.com/jtpets/slack-agent-bridge.git
cd slack-agent-bridge

# Set up environment
cp .env.example .env
# Edit .env with your Slack token and channel IDs

# Install and run
npm install
npm start
```

## Task Format

Post a message to your bridge channel:

```
TASK: Fix the login button styling
REPO: myorg/myapp
BRANCH: main
TURNS: 30
INSTRUCTIONS:
The login button on /auth/login is misaligned on mobile.
Fix the CSS to center it properly.
Add a hover state.
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| TASK | Yes | - | Short description |
| REPO | No | - | GitHub repo (org/repo or full URL) |
| BRANCH | No | main | Branch to clone |
| TURNS | No | 50 | Max LLM turns (5-100) |
| INSTRUCTIONS | Yes | - | Detailed instructions (multiline OK) |

## Conversational Mode

For quick questions without repo context, use ASK:

```
ASK: What's the best way to handle rate limiting in Node.js?
```

The agent responds directly without cloning any repo.

## Configuration

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (xoxb-...) |
| `BRIDGE_CHANNEL_ID` | Channel ID for task messages |
| `OPS_CHANNEL_ID` | Channel ID for status updates |

### Optional Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BIN` | `/usr/local/bin/claude` | Path to Claude CLI binary |
| `POLL_INTERVAL_MS` | `30000` | How often to check Slack (ms) |
| `MAX_TURNS` | `50` | Default max LLM turns per task |
| `TASK_TIMEOUT_MS` | `600000` | Hard timeout per task (10 min) |
| `WORK_DIR` | `/tmp/bridge-agent` | Temp directory for clones |
| `GITHUB_ORG` | - | Default org for short repo names |

### LLM Provider Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_PROVIDER` | `claude` | Primary provider: `claude`, `gemini`, `ollama` |
| `LLM_FALLBACK_ENABLED` | `true` | Automatic fallback on provider failure |
| `LLM_FALLBACK_PROVIDER` | per-primary | Fallback chain (comma-separated). Unset: `ollama` -> `gemini` -> `claude`, else -> `gemini` |
| `GEMINI_API_KEY` | - | Required for the `gemini` provider. Never logged. |
| `OLLAMA_MODEL` | - | **Required** for the `ollama` provider. No default model name. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server URL (loopback by design) |
| `OLLAMA_KEEP_ALIVE` | `5m` | How long the model stays resident in RAM |
| `OLLAMA_NUM_CTX` | `8192` | Context window in tokens |
| `OLLAMA_TIMEOUT_MS` | `120000` | Per-request timeout when the caller passes none |
| `OLLAMA_THINK` | `false` | Thinking mode: `false`, `true`, or `low`/`medium`/`high`/`max` |
| `LLM_METRICS_FILE` | `agents/shared/llm-metrics.json` | Provider verdict counter |
| `LLM_METRICS_RETENTION_DAYS` | `30` | Days of verdict history to keep |

Fallback triggers on timeout, connection refused, non-2xx, rate limit, empty output
and malformed output. Every call — fallback or not — emits one `[llm-verdict]` log
line and increments a durable counter:

```bash
node -e "console.log(require('./lib/llm-metrics').getStats({ agentId: 'secretary', days: 7 }))"
```

See [CLAUDE.md](CLAUDE.md) for the full provider contract and the Pi-side
resource fencing for a local Ollama server.

### Auto-Update Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOCAL_REPO_DIR` | `/home/jtpets/jt-agent` | Path to the agent's own repo (stale default — set explicitly) |
| `CHECK_INTERVAL_MS` | `300000` | Git poll interval (5 min) |
| `PM2_PROCESS_NAME` | `bridge-agent` | PM2 process name to restart |

## Auto-Update

The agent runs a background process that polls its own git repo every 5 minutes. When
new commits are detected on main, it pulls the changes and then runs
`pm2 restart $PM2_PROCESS_NAME`.

> **The restart step does not currently work.** The bridge runs in a container with no
> `pm2` binary, so that spawn fails with `ENOENT`. Auto-update posts the failure to
> `#sqtools-ops` and returns *before* saving the new commit hash, so it re-pulls and
> re-fails every check interval. The pull succeeds; restarting is a manual step until a
> container-aware restart mechanism is chosen.

## Memory

Task history is stored as JSON files in the `memory/` directory. The agent loads recent task context (last 10 tasks) to provide continuity across sessions. Memory is local—no external database required.

## Development

```bash
# Run tests
npm test

# Validate before commit
npm run validate

# Run directly
npm start
```

## Project Structure

```
slack-agent-bridge/
├── bridge-agent.js       # Main entry point
├── auto-update.js        # Git polling and restart (restart step is PM2-only; see Auto-Update)
├── morning-digest.js     # Daily stats (cron job)
├── lib/
│   ├── config.js         # Environment config
│   ├── llm-runner.js     # Provider adapters (claude, gemini, ollama) + fallback chain
│   ├── llm-metrics.js    # Provider verdict counter (fallback visibility)
│   ├── task-parser.js    # Message parsing
│   └── validate.js       # Pre-commit checks
├── memory/
│   └── memory-manager.js # Task history storage
└── tests/                # Jest test suite
```

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests for new functionality
4. Run `npm test` and `npm run validate`
5. Commit with clear messages
6. Open a PR against `main`

See [CLAUDE.md](CLAUDE.md) for coding standards and project rules.

## License

MIT - see [LICENSE](LICENSE)
