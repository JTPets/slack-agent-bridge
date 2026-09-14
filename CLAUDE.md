# CLAUDE.md - Slack Agent Bridge

> ## Executors: read [`docs/EXECUTOR-CONTRACT.md`](docs/EXECUTOR-CONTRACT.md) first
>
> It is the standing contract for every task dispatched to this repository — the branch
> gate, what counts as proof, when `Closes` is allowed, and the bridge-specific
> operational facts. Read it **in full** before anything else in this file, and confirm
> the read in your report. A dispatch may add to it; nothing waives it.

## Project Overview

Node.js Slack polling agent that monitors Slack channels for task messages and executes them via Claude Code CLI. No database, no frontend, no multi-tenant.

**Deployment (as of 2026-09-13):** runs as the `jt-agent` container (`node:20`) on a QNAP NAS. The Raspberry Pi that previously hosted it is dead. The compose file lives beside the repo on the NAS and is deliberately untracked (it carries host paths). Line endings are pinned to LF by `.gitattributes` — a Windows clone copied to Linux once made the entire tree uncommittable.

**`package-lock.json` is committed (as of 2026-09-13).** It was gitignored, which meant every container start resolved semver ranges afresh: the deployed dependency tree was whatever npm picked that minute, and `.github/dependabot.yml`'s weekly npm PRs could only ever bump direct ranges in `package.json` — transitive dependencies, where most published advisories actually live, were unpinnable and invisible.

> **ACTION REQUIRED on the NAS (not changeable from this repo):** the compose
> `command:` should move from `npm install` to `npm ci`. `npm install` is free to
> re-resolve and rewrite the lockfile, so committing it buys nothing at deploy time
> until the command honours it. `npm ci` installs the locked tree exactly and fails
> loudly if `package.json` and the lockfile disagree. Until that edit is made, the
> lockfile pins CI and local installs but not production.

## Tech Stack

- **Runtime**: Node.js 18+
- **Slack SDK**: @slack/web-api ^7.0.0
- **Process supervisor**: the container runtime (`restart: unless-stopped`). There is no PM2 and no process manager inside the `jt-agent` image.
- **Timezone**: `America/Toronto`, named **explicitly at every site** — the code does
  not depend on the process timezone. No file reads `process.env.TZ`; every
  `toLocale*String` call passes `timeZone: 'America/Toronto'` and the cron registrar
  passes `timezone: 'America/Toronto'` (`lib/agent-scheduler.js:224`). The one
  deliberate exception is `lib/llm-metrics.js`, which buckets by UTC so a day key is
  stable across a DST transition.

  **The `jt-agent` container sets `TZ: America/New_York`** in its compose
  `environment:` block (owner-supplied; regenerate on the NAS with
  `grep -n "TZ:" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`, and see
  `docs/CONFIG-SURFACE-AND-REBUILD.md` → Step 0). This documentation previously said
  only "America/Toronto", which read as a claim about the deployment and was wrong
  about it. The deployment is not changed by this repo and does not need to be: the two
  zones share an offset and a DST rule, and — the part that actually matters — nothing
  reads `TZ`, so the container value reaches no behaviour. **What keeps that true is a
  test, not this paragraph:** `tests/timezone-explicit.test.js` enumerates every source
  file from disk and fails when a new date-format or cron site omits its zone, or when
  anything starts reading `process.env.TZ`.

---

## Critical Rules

### Security First
- **NEVER log tokens** — Slack tokens, API keys, and secrets must never appear in logs or console output
- **No eval/exec** — Never use `eval()`, `child_process.exec()` or `child_process.execSync()` **at all** (not merely "with an interpolated value" — a call with no interpolation today is the next one's template). Use `child_process.spawn()` (async) or `child_process.execFileSync()` (sync) with an **argv array** — those never involve a shell, so a metacharacter in an argument is just a character. Do not import `exec` or `execSync` from `child_process` either; a dead shell import is the next shell call's missing half
- **Argv arrays defeat a shell, not git's option parser** — a positional value beginning with `-` is read by `git` as a flag however it arrived. Validate the value (reject, never sanitise) **and** pass `--` before positional arguments where the subcommand accepts one. `git clone`, `git config`, `git fetch` and `git ls-remote` all do; `git log` does **not** — after `git log`, `--` begins a *pathspec*, so revisions are shape-asserted instead
- **The enumerating guard for this class is `tests/no-shell-execution.test.js`.** It scans every non-test `.js` file in the repo, enumerated from disk, with comments and string contents stripped. Cite it — not a count and not a grep you ran once — when claiming the class is closed. The shell equivalent, for a one-off check:
  ```bash
  find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*' \
         -not -path './tests/*' -not -path './coverage/*' \
    | xargs grep -nE '\bexecSync\s*\(|(^|[^.\w])exec\s*\(|shell\s*:\s*true'
  ```
  That grep is **comment-blind** — it matches prose naming a banned API as readily as a
  call, and it currently reports exactly one such false positive (a LOGIC CHANGE comment
  in `bridge-agent.js`). It is a lead, not a verdict. The test strips comments and string
  contents first, which is why the test is the authority and the grep is the convenience.
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
| Shell execution | spawn()/execFileSync() with an argv array only, never exec(), execSync() or eval(). Guarded repo-wide by `tests/no-shell-execution.test.js` |
| git positional args | Validate the value AND pass `--` before positionals (not for `git log` — see Critical Rules) |
| Error message vs pattern | A rejection message must be GENERATED from the same character list the pattern is built around, never retyped beside it |
| Temp cleanup | Always in finally block |
| Logic changes | LOGIC CHANGE comment required |
| Bug fixes | Regression test required |
| Dependencies | `npm install --save` only — never manually edit package.json |
| Env vars | Document in README if adding new ones |
| Refactor validation | Before committing any refactor that moves variables or changes imports, run: `node -e "require('./bridge-agent.js')"` to verify the process loads. This catches missing references that unit tests miss. |
| dotenv required | Every executable JS file (bridge-agent.js, auto-update.js, cron scripts) MUST have `require('dotenv').config()` as its first line. A restarted process does not inherit shell environment variables — originally a PM2 problem, now a container-restart one. |

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
| `LLM_PROVIDER` | Which LLM backend to use (global default) | `claude` |
| `LLM_PROVIDER_<AGENTID>` | Per-agent provider override; wins over the agent's `agents.json` `llm_provider`. `<AGENTID>` is the agent id upper-cased with non-alphanumerics as `_` (e.g. `code-bridge` → `LLM_PROVIDER_CODE_BRIDGE`). Lives in `.env`, so it survives auto-update's `git reset --hard`. | - |
| `GITHUB_ORG` | Default GitHub org | `jtpets` |
| `CLAUDE_BIN` | Path to claude binary | `/usr/local/bin/claude` |
| `POLL_INTERVAL_MS` | Poll frequency in ms | `30000` |
| `MAX_TURNS` | CC max turns per task | `50` |
| `TASK_TIMEOUT_MS` | Hard kill timeout in ms | `600000` |
| `TASK_LOCK_STALE_MS` | Age at which a task lock is treated as orphaned and released. Must exceed the longest a task can legitimately run. | `2 × TASK_TIMEOUT_MS + 600000` (30 min at defaults) |
| `UPDATE_DEFER_ALERT_MS` | How long one self-update may be deferred before every cycle escalates to `#sqtools-ops` | `3600000` (60 min) |
| `WORK_DIR` | Base dir for temp clones | `/tmp/bridge-agent` |
| `REPOS` | Comma-separated repos for security-review | `jtpets/slack-agent-bridge,jtpets/SquareDashboardTool` |
| `CLAUDE_RATE_LIMIT_PAUSE` | Initial pause duration (ms) when rate limit/bandwidth exhausted | `1800000` |
| `STORE_TASKS_CHANNEL_ID` | #store-tasks channel ID for staff task management | - |
| `NATURAL_CONVERSATION_MODE` | Enable natural language processing for messages without TASK:/ASK: prefixes | `false` |
| `GEMINI_API_KEY` | Google Gemini API key for fallback provider. **Never log this.** | - |
| `LLM_FALLBACK_ENABLED` | Enable automatic fallback to secondary LLM on rate limits | `true` |
| `LLM_FALLBACK_PROVIDER` | Secondary LLM provider to use when primary hits rate limits | `gemini` |
| `SECURITY_FOLLOWUP_ENABLED` | Auto-create tasks from CRITICAL/HIGH security findings | `true` |
| `SECURITY_FOLLOWUP_INCLUDE_MEDIUM` | Also create tasks for MEDIUM severity findings | `false` |
| `EMAIL_RATE_LIMIT_EMAILS_PER_WINDOW` | Max emails to process per rate limit window | `50` |
| `EMAIL_RATE_LIMIT_BULLETINS_PER_WINDOW` | Max bulletins to post per rate limit window | `10` |
| `EMAIL_RATE_LIMIT_SLACK_PER_WINDOW` | Max Slack messages to post per rate limit window | `20` |
| `EMAIL_RATE_LIMIT_WINDOW_MS` | Rate limit sliding window size in ms | `300000` (5 min) |
| `EMAIL_RATE_LIMIT_COOLDOWN_MS` | Cooldown period after hitting rate limit | `60000` (1 min) |
| `OLLAMA_MODEL` | Model for the ollama provider. **No default** — ollama calls fail their precondition check without it. | - |
| `OLLAMA_BASE_URL` | Ollama server base URL. Loopback by design. | `http://127.0.0.1:11434` |
| `OLLAMA_KEEP_ALIVE` | How long the model stays resident in RAM after a request | `5m` |
| `OLLAMA_NUM_CTX` | Context window in tokens | `8192` |
| `OLLAMA_TIMEOUT_MS` | Per-request timeout for ollama (used when the caller passes none) | `120000` |
| `OLLAMA_THINK` | Thinking mode: `false`, `true`, or a level (`low`/`medium`/`high`/`max`) | `false` |
| `LLM_METRICS_FILE` | Path to the provider verdict counter | `agents/shared/llm-metrics.json` |
| `LLM_METRICS_RETENTION_DAYS` | Days of verdict history to keep | `30` |

**LLM_PROVIDER options:** `claude` (default), `gemini`, `ollama`, `openai` (not yet implemented)

**Per-agent provider precedence:** `LLM_PROVIDER_<AGENTID>` env > the agent's `agents.json` `llm_provider` > global `LLM_PROVIDER` env > `claude`. Resolved by `resolveLlmProvider()` in `lib/config.js`. Because `agents.json` is tracked and auto-update runs `git reset --hard HEAD` before each pull, on-box edits to it are silently discarded — set the per-agent env var in `.env` (gitignored) instead so the override survives a pull.

**LLM Fallback:** When `LLM_FALLBACK_ENABLED=true` (default), a provider failure automatically retries on the next provider in the chain. `LLM_FALLBACK_PROVIDER` accepts a single provider or a comma-separated chain; when unset, the chain defaults per primary — `ollama` -> `gemini` -> `claude`, everything else -> `gemini`. Gemini requires `GEMINI_API_KEY`; an unconfigured provider is skipped (with a logged reason) rather than attempted.

**Fallback triggers** (any of these on the primary moves to the next provider):

| Trigger | `fallback_reason` |
|---------|-------------------|
| Request exceeded the timeout | `timeout` |
| Server refused the connection / unreachable | `connection_refused` |
| Non-2xx response | `http_error` |
| HTTP 429 or a rate-limit message | `rate_limit` |
| 200 with empty output | `empty_output` |
| 200 with unparseable or wrong-shaped output | `malformed_output` |

An **unknown provider name is a configuration defect, not a fallback trigger** — it throws so the typo is visible rather than being masked by another engine.

### No silent fallback

**Where it is wired in:** `bridge-agent.js` calls `runWithFallback` at both LLM entry
points — `processTask` (TASK:) and `processConversation` (ASK:). Until 2026-09-13 both
called `runLLM` directly, so `runWithFallback` had zero non-test callers and everything
documented in this section described code that never ran. `tests/integration.test.js`
pins the wiring so it cannot become dead code again. The remaining `runLLM` callers —
`security-review.js`, `bots/storefront.js`, `lib/watercooler.js`, `lib/task-decomposer.js`
— still bypass the chain and are **not** covered by this section.

Every LLM call records exactly one verdict via `lib/llm-metrics.js`, whether or not it fell back:

- **One structured log line per call:** `[llm-verdict] {"provider_requested":…,"provider_used":…,"fallback_reason":…,"latency_ms":…,"model":…,"agent_id":…,"ok":…}`. `fallback_reason` is `null` when the requested provider served the call — that null distinguishes "no fallback" from "never measured".
- **A durable counter**, day-bucketed per agent, so the question is answerable without grepping logs:

```bash
# What fraction of the secretary's calls fell back this week?
node -e "console.log(require('./lib/llm-metrics').getStats({ agentId: 'secretary', days: 7 }))"
```

Fallback is meant to be invisible to the agent. Invisible to the *operator* is the defect this exists to prevent.

### Local LLM (Ollama) provider

`runOllamaAdapter` in `lib/llm-runner.js` posts to Ollama's **native** `/api/chat` (not the OpenAI-compatible `/v1/chat/completions`), non-streaming, single-shot.

**Why native and not the OpenAI-compatible path:** the compat endpoint's request struct carries no `keep_alive` and no `options` field, so model residency and context size cannot be set per request — both are load-bearing on a memory-fenced Pi. Thinking control *is* reachable over compat (`reasoning_effort: "none"`), but `keep_alive`/`num_ctx` are not. **There is no `enable_thinking` field on either path** — Ollama's knob is `think`, which takes a boolean or one of `low`/`medium`/`high`/`max`.

**Portability cost of that choice:** this adapter speaks Ollama's wire format, so pointing it at llama.cpp's server, vLLM or LM Studio needs a second request/response mapping rather than just a base-URL swap. Accepted deliberately.

**Contract:** single-shot, so `maxTurns` is ignored and `hitMaxTurns` is always `false` (same as the Gemini adapter). Returns `{ output, hitMaxTurns: false, model }`. `options.timeout` is honored via `AbortController`.

**Per-agent model override:** an agent in `agents/agents.json` may carry `llm_model` alongside `llm_provider`; it is passed through as `options.model` and wins over `OLLAMA_MODEL`. This is what lets a router model and a workhorse model share one provider. There is no hardcoded model name in the adapter — with neither `options.model` nor `OLLAMA_MODEL` set, the call throws a precondition error rather than guessing a model that may not be pulled.

**Startup check:** `validateOllamaOnStartup()` probes `GET /api/tags` and, like `validateGeminiOnStartup`, **never prevents boot**. An unreachable or down server logs a loud warning, marks the provider unavailable, and the bridge starts normally with every agent on its configured provider. The availability flag is reporting state only — it never gates dispatch, because a sticky flag would route an agent away from its provider forever after one bad boot.

#### Pi-side resource fencing (reproducible)

Ollama on the Pi runs alongside `sqtools` (PRODUCTION) and must never starve it. The fencing below lives in a systemd drop-in so it survives package upgrades — config that lives only on the box is the same class of problem as a finding that lives only in chat.

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
# Loopback only. The model server must never be reachable off-box.
Environment="OLLAMA_HOST=127.0.0.1:11434"

# One model resident, one request at a time, short queue.
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_QUEUE=4"

# Unload promptly so RAM returns to sqtools between bursts.
Environment="OLLAMA_KEEP_ALIVE=5m"

# Hard memory ceiling: the kernel kills ollama, not postgres, under pressure.
MemoryMax=4G
MemoryHigh=3G
CPUQuota=300%

# ollama is the first thing to die under global memory pressure.
OOMScoreAdjust=500
EOF

sudo systemctl daemon-reload
sudo systemctl restart ollama

# Verify the fence actually applied:
systemctl show ollama -p MemoryMax -p CPUQuota -p OOMScoreAdjust
sudo ss -lntp | grep 11434   # must show 127.0.0.1:11434, never 0.0.0.0
curl -s http://127.0.0.1:11434/api/tags | head -c 200
```

Tune `MemoryMax` to the model actually pulled — it must be below `(total RAM - sqtools + postgres working set)`. Matching app-side values go in `.env`: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_NUM_CTX`.

**Not done by this change:** no agent's `llm_provider` was migrated to ollama, and ollama is not installed or configured on any machine by this repo. Migration is a separate, observed, one-at-a-time decision.

**Security Followup:** When `SECURITY_FOLLOWUP_ENABLED=true` (default), the nightly security review creates TASK messages for CRITICAL and HIGH severity findings. Tasks are queued in the approval queue for owner review instead of executing immediately. Use `ASK: pending approvals` to review and `ASK: approve <id>` to execute. This prevents prompt injection attacks via malicious security findings.

**Email Rate Limiting:** Protects Slack from flood attacks when large volumes of emails arrive (spam, attack, or legitimate burst). Uses a sliding window approach: if limits are exceeded, excess items are suppressed and aggregated into a summary message. Hitting the email limit triggers a cooldown period during which all email pipeline operations are blocked. The rate limiter is integrated into `email-categorizer.js` and automatically tracks emails processed, bulletins posted, and Slack messages sent.

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
| `LOCAL_REPO_DIR` | Path to local repo, as seen by the auto-update process. **Load-bearing:** `validateConfig()` exits 1 if the path does not exist, and the default below is the dead Pi path — so an unset value is a hard startup failure, not a fallback. | `/home/jtpets/jt-agent` (stale Pi default — set explicitly) |
| `CHECK_INTERVAL_MS` | Git poll frequency | `300000` |

### Self-update — DESIGNED AND TESTED, **NOT WIRED** (verified 2026-09-14)

> **How the bridge actually deploys today: a human restarts the container.**
> `auto-update.js` is never started, so nothing in this section describes running
> behaviour. Merging to `main` changes nothing about the running process until
> someone runs `docker compose restart jt-agent` (or `up -d --force-recreate` for an
> `.env` change) on the NAS.
>
> **Evidence (repo-side, regenerable from any checkout):**
> - No npm script starts it — `node -e "console.log(Object.keys(require('./package.json').scripts))"` → `[ 'test', 'test:smoke', 'validate' ]`.
> - Nothing spawns or forks it — `grep -rn "auto-update" --include=*.js --include=*.json . | grep -v node_modules | grep -v package-lock | grep -v '^./tests/'` returns only comments, doc prose, and `auto-update.js`'s own body.
> - The repo contains no compose file, Procfile, systemd unit or supervisor config of any kind.
>
> **Evidence (container-side):** a check run from inside the `jt-agent` container
> recorded that the compose service's `command:` starts `node bridge-agent.js` only —
> see `docs/CONFIG-SURFACE-AND-REBUILD.md` Step 5 ("The compose service starts only
> `node bridge-agent.js`"). The compose file itself is untracked and off-repo, so from
> a checkout that remains an unverified lead; re-check on the NAS with
> `grep -n "command\|entrypoint\|auto-update" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`.
>
> **It would also fail to start today if launched unchanged.** `validateConfig()`
> (`auto-update.js:803-823`) hard-fails when `LOCAL_REPO_DIR` does not exist, and the
> default is the dead Raspberry Pi path `/home/jtpets/jt-agent` (`auto-update.js:40`).
> Observed: `node auto-update.js` with no `LOCAL_REPO_DIR` set prints
> `LOCAL_REPO_DIR does not exist: /home/jtpets/jt-agent` and exits **1**. Whether the
> live `.env` sets it is not knowable from this repo. Note the shape of that failure:
> exit 1 under `restart: unless-stopped` is a restart loop, so wiring this in without
> setting `LOCAL_REPO_DIR` first trades a silent no-deploy for a crash-looping service.
>
> **The guard suites are green and prove nothing about the deployment.**
> `tests/auto-update-restart.test.js`, `tests/auto-update-defer.test.js` and
> `tests/update-verifier.test.js` pass (62 tests) by injecting a dependency bag into
> `checkForUpdates()`. Neither `main()` nor `validateConfig()` is exported or exercised,
> so the startup path that fails above is untested. A green suite for a daemon that is
> never started is a verification-integrity failure, not a passing gate.
>
> **The design below is kept, not deleted** — it is correct about what the code does,
> and it is what shape (a) in `WORK-TODO.md` item **#17** would make live. Read every
> sentence in it as "would, once started", not "does".

**There is no `PM2_PROCESS_NAME`.** `auto-update.js` used to run
`pm2 restart $PM2_PROCESS_NAME` after a successful pull. The `jt-agent` container has no
`pm2` on PATH, so that spawn failed with `ENOENT` on every update and returned **before**
saving the new commit hash — re-pulling and re-failing every check interval, permanently.

The restart is now **`process.exit(0)`**. The container runs with
`restart: unless-stopped`, so the supervisor re-runs `npm install && node bridge-agent.js`
— exiting *is* the restart. Nothing configures this; there is no branch knob either.
auto-update tracks `main` deliberately (single-operator repo; a hand-moved deploy branch
would just go stale), which *would* mean **merging to `main` deploys within
`CHECK_INTERVAL_MS`** — once the daemon is started. It is not. Merging to `main` deploys
nothing today; see the banner at the top of this section.

Self-updating is the point of a code agent, but `unless-stopped` turns a commit that
cannot start into an endless restart loop with no shell to fix it from. Four guards gate
the exit — see `lib/update-verifier.js` and `checkForUpdates()` in `auto-update.js`:

| Guard | Implementation | Prevents |
|-------|----------------|----------|
| (a) Verify before exiting | `node --check` on every entry point + `npm install` exits 0 + `npm run test:smoke` passes (`runSmokeTest()`, bounded by `SMOKE_TEST_TIMEOUT_MS`). On failure: revert to the commit that was running, post to `#sqtools-ops`, keep running | Exiting into code that cannot start |
| (b) Save state before exiting | `lastKnownCommit` written and the write confirmed before `exit()` | The pm2 bug — state written after the restart point is never written, so the commit re-pulls forever |
| (c) Never re-exit for the same commit | `restartedIntoCommit` persisted; `planRestart()` refuses a repeat | A restart loop on a commit that comes back around |
| (d) Post before exiting | Slack post awaited, stdout flushed, then exit | A silent restart — there is no "after" an exit |

A commit that fails (a) is recorded in `failedCommit` and not retried; the next commit on
`main` deploys normally. Exit code is `0` — a clean intentional restart, not a crash.

A fifth gate, added 2026-09-14, runs **before** all of these: the **deferral gate**
(`evaluateTaskDeferral()`). Guards (a)-(d) stop the bridge restarting into code that
cannot start; the deferral gate stops it restarting *out of* work that is still running.
It sits ahead of `git reset --hard`/`git pull` so a deferred update mutates nothing.
See "Task lock and self-update deferral" below.

> **Why (a) runs the smoke suite, not just `node --check`:** `node --check` is a *syntax*
> check — a commit that deletes a required file or adds a dependency missing from
> `package.json` parses clean and would still brick the bridge. `npm run test:smoke`
> `require()`s every entry point and lib module, so it catches exactly those breakages.
> It runs after `npm install` (it needs `node_modules`) and is bounded by
> `SMOKE_TEST_TIMEOUT_MS` (< `CHECK_INTERVAL_MS`), so a wedged smoke run reverts rather
> than hanging the update loop. It became wireable once the jest open handle at
> `bots/storefront.js` (an un-`.unref()`'d module-scope `setInterval`) was fixed.

#### Two open questions (stated, not decided — owner's call)

These are separate problems. The second is the real requirement and it does not depend
on how the first is answered.

**1. What would make merged code reach the running process?** Three shapes exist; none
is chosen here, and none is implemented by this repo.

| Shape | What changes | What it costs |
|-------|--------------|---------------|
| Start the daemon | The compose `command:` runs `auto-update.js` alongside `bridge-agent.js`. Everything documented above becomes true. | `LOCAL_REPO_DIR` must be set first or it exits 1 into a restart loop. The exit-restart assumes the *container* dies on exit, so which process is PID 1 decides whether an exit restarts anything — a backgrounded updater whose exit leaves PID 1 alive restarts nothing. Its guards have never run outside tests. |
| Push-triggered restart | A GitHub Action or webhook restarts the container on merge to `main`. | Needs an inbound path to the NAS and a credential to hold; the deploy decision moves off-box. |
| Keep manual, say so | `auto-update.js`, `lib/update-verifier.js`, the deferral gate and their 62 tests become acknowledged dead code. | Deploys stay a human step that is easy to forget — which is the failure already observed. The docs are now honest about this either way. |

Whatever is chosen, the compose file is untracked and off-repo, so **this repo cannot
make any of them true.** That is itself the finding: the deploy path belongs to no
repository today (`docs/CONFIG-SURFACE-AND-REBUILD.md`, Step 6).

**2. What would make "is the running process on current `main`?" answerable at all?**
**Nothing today can answer it.** Not the repo, not the container, not Slack. "Merged"
and "deployed" are unrelated facts and no one is told when they diverge — the observed
11-hour gap was found by a person noticing, not by the system reporting.

Answering it needs the running process to state the commit it loaded, somewhere a human
or an agent can read without shell access to the NAS. Anything that does that would do:
a boot line to `#sqtools-ops`, an `ASK: version` built-in, a field on the existing
heartbeat, a written state file. The requirement is only that the *running* process is
the one reporting — a value read from the repo working tree or from `git rev-parse` at
query time answers a different question and would have shown "current" throughout the
11-hour gap.

This is the scheduled-job-with-no-liveness-check class applied to the deploy itself, and
it is worth landing **before** any self-restart is armed: the first real self-update
should be observable while it happens.

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

# Production: the `jt-agent` container (node:20) on the QNAP NAS.
# The compose file lives at the repo's path on the NAS and is untracked.
docker compose up -d jt-agent
docker compose restart jt-agent
docker compose logs -f jt-agent

# PM2 does not exist on this host and no longer appears anywhere in the code.
#
# DEPLOYING A MERGE IS A MANUAL STEP. Nothing starts auto-update.js, so merging to
# main does not reach the running process. `docker compose restart jt-agent` is what
# deploys. An .env change needs `up -d --force-recreate`, not `restart` — restart
# reuses the existing container and its baked-in environment.
# See "Self-update — DESIGNED AND TESTED, NOT WIRED" above.

# Cron jobs. <repo> is the repo path as the cron host sees it; on the NAS the
# host path is /share/CACHEDEV1_DATA/jt-agent, and the in-container path differs.
# Morning digest:
# 0 8 * * * cd <repo> && set -a && source .env && set +a && node morning-digest.js

# Security review (1am daily):
# 0 1 * * * cd <repo> && set -a && source .env && set +a && node security-review.js

# Storefront chat widget
node bots/storefront.js              # Direct execution

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
├── auto-update.js        # Git polling daemon: pulls, verifies, then exits so the container supervisor restarts the bridge
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
│   │   ├── approval-queue.json   # Manual approval queue for auto-generated tasks (created at runtime, gitignored)
│   │   ├── staff.json            # Staff member definitions (name, slackId, role)
│   │   └── daily-tasks-template.json  # Recurring daily store tasks template
│   ├── bridge/
│   │   └── memory/       # Bridge agent's tiered memory directory
│   │       ├── context.json      # Permanent: owner info, preferences
│   │       ├── working.json      # Session: current task state
│   │       ├── short-term.json   # 24-72h TTL: recent events, reminders
│   │       ├── long-term.json    # Weeks/months: patterns, preferences
│   │       └── archive.json      # Decayed long-term (reference only)
│   ├── social-media/
│   │   └── memory/       # Social Media Manager's memory directory
│   │       ├── backlog.json      # Activation backlog and feature roadmap
│   │       └── .gitkeep          # Placeholder for memory files
│   └── email-monitor/
│       └── memory/       # Email Monitor's memory directory
│           └── rules.json        # Email categorization rules (urgent, important, vendor_deal, newsletter, spam)
├── lib/
│   ├── agent-context.js  # Agent context builder: injects real data into ASK prompts to prevent hallucination
│   ├── agent-registry.js # Agent registry loader: loadAgents, getAgent, getAgentByChannel, activateAgent
│   ├── bulletin-board.js # Inter-agent communication: postBulletin, getBulletins, markRead, cleanupOldBulletins
│   ├── config.js         # Environment variable loading, validation, and defaults
│   ├── git-identifiers.js # Boundary validation for Slack-controlled REPO:/BRANCH: values (isValidRepo, isValidBranch, assertValid*); *_PUNCTUATION + describeCharset() generate the rejection messages from the same character lists the patterns use
│   ├── llm-runner.js     # LLM execution abstraction with provider adapters (claude, gemini, ollama), fallback chain, startup validation
│   ├── memory-tiers.js   # Tiered memory system: TTL expiry, auto-promote, cleanup, archive
│   ├── owner-tasks.js    # Owner task management: activation checklists, pending tasks, ACTION REQUIRED detection
│   ├── code-review-pipeline.js  # 3-phase task pipeline: reviewTask (Phase 1), buildPrompt (Phase 2), validateOutput (Phase 3)
│   ├── clone-lifecycle.js # Git/clone lifecycle (seam A): cloneRepo, cleanupDir, detectUndeliveredWork, assertValidTargetDir. Every git call is an execFileSync argv array — no function here builds a shell command string
│   ├── bridge-state.js    # State persistence (seam B): sole owner of .bridge-agent-state.json (per-channel poll cursors) and processed-tasks.json (task dedup); init, get/setLastChecked, isTaskProcessed, markTaskProcessed, cleanupProcessedTasks
│   ├── slack-client.js   # Slack client wrapper: channel management (createChannel, ensureChannel, joinAgentChannels, loadChannelMap)
│   ├── staff-tasks.js    # Staff task management: daily tasks, assignments, escalations to #store-tasks
│   ├── security-followup.js # Security finding → auto-task pipeline: parses findings, creates TASK messages
│   ├── approval-queue.js # Manual approval queue for auto-generated tasks: queueTask, approveTask, rejectTask
│   ├── task-decomposer.js # Automated task decomposition: analyzeComplexity, decomposeTask, findAgentForTask, subtask management
│   ├── task-lock.js      # Sole owner of $WORK_DIR/.task-running: acquire/release plus the staleness rule that stops an orphaned lock freezing self-update
│   ├── task-parser.js    # Task message parsing and message type detection
│   ├── task-queue.js     # Persistent task queue: coordinates tasks between bridge-agent and auto-update. markRunning() is the live `running` transition; dequeue() has no production caller
│   ├── update-verifier.js # Pre-restart gate for auto-update: node --check on entry points, restart plan (guard c)
│   ├── validate.js       # Pre-commit validation: checks bridge-agent.js loads and file line counts
│   ├── watercooler.js    # Multi-agent standup orchestrator: runStandup, agent conversation flow
│   ├── email-rate-limiter.js # Rate limiting for email-to-Slack pipeline: sliding window, cooldown, flood protection
│   ├── llm-metrics.js    # LLM provider verdict counter: recordVerdict, getStats (fallback visibility)
│   └── integrations/
│       ├── google-calendar.js  # Google Calendar API integration for fetching events (today, tomorrow, yesterday)
│       ├── gmail.js            # Gmail API integration: getRecentEmails, getEmailById, getEmailHeaders (read-only)
│       ├── email-categorizer.js # Email categorization by sender/subject patterns (vendor_deal, customer, newsletter, etc.)
│       ├── email-sanitizer.js  # Email content sanitization: prompt injection protection for LLM-bound content
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
│   ├── security-fix/
│   │   └── SKILL.md      # Fix security vulnerabilities found by security-review
│   ├── accountability-check/
│   │   └── SKILL.md      # Review calendar events and verify task completion
│   └── decompose/
│       └── SKILL.md      # Task decomposition: break complex tasks into subtasks
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
│   ├── clone-lifecycle.test.js  # Tests for lib/clone-lifecycle.js (cloneRepo argv/`--` separators, assertValidTargetDir rejections, deploy-key paths, cleanupDir, export surface)
│   ├── bridge-state.test.js     # Tests for lib/bridge-state.js (poll cursors, legacy migration, processed-task dedup; temp-dir CRUD)
│   ├── slack-client.test.js     # Tests for lib/slack-client.js (channel management, joinAgentChannels)
│   ├── task-parser.test.js      # Tests for task parsing logic (includes create channel command, label anchoring, field rejection)
│   ├── git-identifiers.test.js  # Tests for lib/git-identifiers.js (repo/branch allowlists, injection payload rejection, message-vs-pattern agreement probed over every ASCII punctuation character)
│   ├── no-shell-execution.test.js # THE enumerating guard for the command-injection class: scans every non-test .js file in the repo for execSync/exec/shell:true and for shell APIs imported from child_process
│   ├── timezone-explicit.test.js # THE enumerating guard for the "no dependence on the process timezone" class: every non-test .js file must name timeZone/timezone at each toLocale*String, Intl.DateTimeFormat and cron.schedule call, and nothing may read process.env.TZ
│   ├── storefront.test.js       # Tests for bots/storefront.js (chat API, session management)
│   ├── holidays.test.js         # Tests for lib/integrations/holidays.js (API, pet dates, caching)
│   ├── gmail.test.js            # Tests for lib/integrations/gmail.js (OAuth, email parsing, API)
│   ├── email-categorizer.test.js # Tests for lib/integrations/email-categorizer.js (categorization, rules)
│   ├── email-rate-limiter.test.js # Tests for lib/email-rate-limiter.js (sliding window, cooldown, flood protection)
│   ├── llm-metrics.test.js      # Tests for lib/llm-metrics.js (verdict recording, getStats, retention)
│   ├── staff-tasks.test.js      # Tests for lib/staff-tasks.js (assignments, escalations, daily tasks)
│   ├── bulletin-board.test.js   # Tests for lib/bulletin-board.js (inter-agent communication)
│   ├── watercooler.test.js      # Tests for lib/watercooler.js (standup orchestration, agent flow)
│   ├── task-queue.test.js       # Tests for lib/task-queue.js (queue persistence, auto-update coordination)
│   ├── task-queue-lifecycle.test.js # THE guard that the LIVE task path drives the queue state machine: extracts the lifecycle from bridge-agent.js's source and replays it against a real queue (a module-only test cannot see an unreachable path)
│   ├── task-decomposer.test.js  # Tests for lib/task-decomposer.js (complexity analysis, decomposition, agent routing)
│   ├── security-followup.test.js # Tests for lib/security-followup.js (finding parsing, task generation)
│   ├── approval-queue.test.js   # Tests for lib/approval-queue.js (queueing, approval/rejection, commands)
│   ├── update-verifier.test.js      # Tests for lib/update-verifier.js (entry-point syntax gate, planRestart)
│   ├── auto-update-restart.test.js  # Tests for the exit-based self-update: one per guard (a)-(d)
│   ├── task-lock.test.js            # Tests for lib/task-lock.js (acquire/release, staleness, legacy + unparseable lock formats)
│   ├── auto-update-defer.test.js    # Tests the deferral gate: defers while a task holds the lock, releases a stale one, escalation bound
│   ├── bridge-agent-scope.test.js   # AST scope guard: catches `X is not defined` in bridge-agent.js
│   └── silent-drop-logging.test.js  # Tests for describeSkipReason + the poll loop's skip logging
├── docs/
│   ├── EXECUTOR-CONTRACT.md # THE standing contract every dispatched executor reads first
│   ├── AGENTS.md            # Agent registry and memory tier documentation
│   ├── WIRING-AND-SEAMS.md  # Entry points, what is actually wired, bridge-agent.js extraction seams
│   ├── CONFIG-SURFACE-AND-REBUILD.md # Config surface inventory and the rebuild path
│   ├── COURIER-INTAKE.md    # Courier intake page and delivery quote API documentation
│   ├── INTEGRATION-SPEC.md  # SqTools API integration specification and security requirements
│   ├── SMS-INTEGRATION.md    # SMS integration spec: httpSMS (primary), Twilio (fallback/voice)
│   ├── SOCIAL-MEDIA-DESIGN.md # Social Media Manager agent design and content strategy
│   └── STOREFRONT-WIDGET.md  # Storefront chat widget documentation and embedding guide
├── package.json          # Dependencies and npm scripts
├── CLAUDE.md             # Project rules and documentation (this file)
├── README.md             # Project overview
├── COMMANDMENTS.md       # Non-negotiable rules, prepended to every task prompt
├── WORK-TODO.md          # The backlog: flat, one ### heading per item, closed items purged
├── .gitattributes        # Line-ending normalization (* text=auto eol=lf) - stops CRLF corruption
└── .gitignore            # Git ignore rules (node_modules, .env, .claude-home/, *.bak, etc.)
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

### Required Google OAuth Scopes
When using OAuth (not service account), the refresh token must be generated with these scopes at [console.cloud.google.com](https://console.cloud.google.com):
| Scope | Purpose |
|-------|---------|
| `https://www.googleapis.com/auth/gmail.readonly` | Read emails for morning digest and inbox triage |
| `https://www.googleapis.com/auth/calendar.readonly` | Read calendar events for daily briefings |
| `https://www.googleapis.com/auth/analytics.readonly` | Read Google Analytics data for marketing reports (future) |

**Generating a refresh token with multiple scopes:**
```bash
# Use the OAuth Playground or a script to request these scopes together:
SCOPES="https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/analytics.readonly"
```

**Note:** A single `GOOGLE_REFRESH_TOKEN` can cover multiple scopes if generated with all required scopes during the OAuth consent flow. The same token works for both Gmail and Calendar integrations.

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
- Prevents re-processing old messages after container restarts

### Scratch Clone Lifecycle

Each repo task is executed in a fresh scratch clone under `WORK_DIR`
(`cloneRepo`, configured to push via the deploy key). `processTask`'s `finally`
block used to delete that clone unconditionally — so when a push never landed
(a READ-ONLY clone, or a failed push), the agent's commits lived only in the
clone and cleanup erased them. Three tasks were lost this way.

**Cleanup now gates on delivery.** `detectUndeliveredWork(dir)` in
`lib/clone-lifecycle.js` (called from `processTask` in `bridge-agent.js`)
classifies the clone before `cleanupDir` runs:

- **Uncommitted changes** (`git status --porcelain` non-empty) → undelivered.
- **Local commits absent from the remote** → undelivered. Delivery is checked by
  matching local branch/HEAD tip SHAs against `git ls-remote origin`, *not*
  `git log --not --remotes`: scratch clones use `--single-branch`, whose fetch
  refspec never creates a local `origin/feature/*` tracking ref, so a pushed
  feature branch would otherwise look unpushed. ls-remote asks the remote directly.
- **Remote unreachable** (e.g. a READ-ONLY clone) → preserve if any local commits
  exist, else clean up. On any uncertainty the function errs toward preserving.

An undelivered clone is **kept** (not deleted) and an alert is posted to
`#sqtools-ops` with its path so the work can be recovered and pushed manually.
Delivered clones (clean tree, tips on the remote — the normal success case, and
research/audit tasks that make no commits) are cleaned up as before.

### Channel Auto-Join

On every startup, `slackClient.joinAgentChannels(channelsToPoll)` is called to join all
agent channels before the poll loop starts. This ensures the bot is in all channels even
if channels were recreated while the bot was offline. Results are logged:
`[bridge-agent] Joined 5/5 agent channels` or `Joined 3/5 agent channels (2 failed - check scopes)`

Resolved channel IDs are cached in `agents/shared/channel-map.json` (gitignored) to reduce
API calls on subsequent startups.

### Task Queue Coordination

`lib/task-queue.js` provides a persistent task queue that coordinates between `bridge-agent.js`
and `auto-update.js` to prevent task interruption during updates.

**Queue file:** `$WORK_DIR/task-queue.json` (default: `/tmp/bridge-agent/task-queue.json`)

**Task statuses:**
- `pending`: Task is queued, waiting to be processed
- `running`: Task is currently being executed
- `completed`: Task finished successfully
- `failed`: Task failed with an error
- `interrupted`: Task was interrupted — by a kill the bridge did not survive
  (recorded at the next startup by `recoverInterrupted()`), or by a child-process
  kill it did survive (recorded immediately by `interrupt()`)

**LOGIC CHANGE 2026-09-14: `running` is a state the live path actually enters.** Until
now `dequeue()` was the *sole* writer of `running` and `startedAt`, and it had **zero
non-test callers**: the live path went `enqueue` → `complete`/`fail` with no transition
in between. Every completed entry therefore carried `startedAt: null`, and
`recoverInterrupted()` returned `0` at every startup, unconditionally — a task killed
mid-run was never marked interrupted, it stayed `pending` forever. `processTask` now
calls **`markRunning(queueId)`** beside `taskLock.acquire()`, so the lock and the queue
agree about what is running.

- **`markRunning(id)`, not `dequeue()`.** The bridge already holds the id it enqueued;
  `dequeue()` searches for "the first pending entry", which with two entries pending
  starts the wrong one and strands it `running` until the staleness rule ages it out.
  `dequeue()` remains as a queue-consumer API with no production caller, and delegates
  to the same transition so the two cannot disagree.
- **Status and `startedAt` are written together, never separately.** A `running` entry
  with a null `startedAt` is load-bearing damage, not untidiness: `checkTaskQueue()`
  treats an unparseable stamp as **live**, so such an entry would defer every future
  deploy; and `formatStatusResponse()` would render `new Date(null)` as 1970 and report
  the task as having started ~29 million minutes ago.

**Coordination flow.** Steps 3 and 4 are **not live** — they are auto-update's half of
the protocol, and `auto-update.js` is never started (see "Self-update — DESIGNED AND
TESTED, NOT WIRED"). Steps 1, 2, 5 and 6 run today, in `bridge-agent.js`. A manual
`docker compose restart` respects none of this and will kill a running task.

1. When a TASK: message is found, it's enqueued before processing **(live)**
2. `processTask` marks it `running` with a `startedAt` stamp as work begins **(live)**
3. *(not live)* Auto-update checks both the queue and the task lock **before** pulling anything
4. *(not live)* If tasks are active, auto-update **defers** — it pulls nothing and retries on the next `CHECK_INTERVAL_MS`
5. On startup, any tasks with status "running" are marked as "interrupted" **(live — and
   now reachable)**
6. Completed/failed tasks are cleaned up after 24 hours **(live)**

**An interrupted task is not reported to a human.** `recoverInterrupted()` writes the
verdict to `task-queue.json` and logs a line to stdout; nothing posts it to Slack, and
`formatStatusResponse()` surfaces it only if someone runs `ASK: what's queued` within
the 24-hour retention window. Every other lifecycle event on this path — a stale lock
release, a deferred update, a task failure — posts to `#sqtools-ops`. This one does not.
Recorded as a finding, not fixed here.

**Bridge-agent startup:**
```javascript
// Recover any interrupted tasks
queue.recoverInterrupted();
// Clean up old entries
queue.cleanup();
```

**Auto-update coordination:**
```javascript
// Decide, don't wait. Returns { defer, reason, staleVerdicts, queue, lock }.
const deferral = deps.evaluateTaskDeferral();
if (deferral.defer) return;   // nothing pulled; next cycle retries
```

### Task lock and self-update deferral

> **Half of this is not live.** The deferral gate lives in `auto-update.js`, which is
> never started — so nothing currently defers a deploy for a running task, because
> nothing currently deploys. What *is* live is the lock itself: `bridge-agent.js`
> acquires and releases it, and clears a stale one on startup. Read the auto-update
> half as design. See "Self-update — DESIGNED AND TESTED, NOT WIRED".

**LOGIC CHANGE 2026-09-14.** The self-update cycle used to call
`waitForTaskCompletion()`: poll the lock every 30s, up to 10 times, then **restart
anyway**. `TASK_TIMEOUT_MS` defaults to 600000 (10 minutes) and a task that hits max
turns retries once with doubled turns, so a task is permitted to run several times
longer than auto-update was willing to wait. That was not a race that occasionally
bit a long task — a task running longer than 5 minutes was *certain* to be killed.

The lock is now owned by **`lib/task-lock.js`** and the wait is a **deferral**:

| | Before | After |
|---|---|---|
| Gate runs | after `reset --hard` + `pull` + `npm install` | **before** any git mutation |
| Task still running at the cap | restart anyway (task killed) | defer; pull nothing; retry next cycle |
| Lock left by a killed task | never cleaned up by anything | detected and released, with a posted verdict |

**Why a staleness rule is mandatory, not a nicety.** `processTask`'s `finally` cannot
run when the process is killed — and a self-update restart is exactly that kill — so a
lock left behind was previously cleaned up by nothing. Under the old 5-minute cap that
only cost a delay. Removing the cap without an expiry would turn a task-killer into a
permanent deploy freeze. Both halves ship together.

**The staleness threshold** defaults to `2 × TASK_TIMEOUT_MS + 10 min` (30 minutes at
defaults). The derivation: a task runs the LLM once and, on a max-turns hit, retries
once, each invocation bounded by `TASK_TIMEOUT_MS`; the grace window covers Phase-3
`npm test`, delivery detection and Slack posts. A lock older than that cannot belong to
a live task, because a task that age has already been hard-killed by its own timeout.
Override with `TASK_LOCK_STALE_MS`.

**Process liveness is deliberately not a release criterion.** bridge-agent and
auto-update are separate processes and this repo cannot prove they share a pid
namespace; a wrong liveness read would release a live task's lock and destroy its work —
the exact failure being fixed. The pid is recorded and reported for diagnosis only.

**Two independent stale-lock releases**, both logged *and* posted to `#sqtools-ops` —
there is no silent release:
- **bridge-agent startup** clears any lock on disk. Sound because bridge-agent is the
  lock's only writer and is single-instance here: if it is starting, no task of its own
  can be running. This complements `recoverInterrupted()`, which repairs the *queue*
  after a kill but never touched the *lock*.
- **auto-update** ages a lock out by the threshold above. This is the backstop for the
  case startup cannot see — a lock orphaned while the bridge keeps running.

**Orphaned queue entries.** `recoverInterrupted()` only rewrites `running` entries. Until
2026-09-14 *nothing* wrote `running`, so a task killed at any point stayed `pending`
forever and this age cutoff was carrying the whole weight. With `markRunning()` wired in,
the window in which a kill leaves a `pending` orphan is now just the gap between
`enqueue()` (poll loop) and `markRunning()` (top of `processTask`) — but the cutoff stays,
because that gap is real and one orphan would freeze deploys permanently. `checkTaskQueue()`
ignores entries older than the staleness threshold and reports how many. It does **not**
rewrite them — `task-queue.json` is bridge-agent's file and auto-update only reads it.

**How long can a deploy be deferred?** A deferral retries on the very next check interval;
nothing is persisted that suppresses the commit (`failedCommit` is untouched), so it is a
retry, not a skip. A **single** task can hold the lock for at most the staleness threshold
before it is released out from under it. A back-to-back **succession** of healthy tasks
can defer an update indefinitely — deliberately, because the alternative is killing live
work. That case is bounded by visibility, not by a timer: once one update has been
deferred continuously for `UPDATE_DEFER_ALERT_MS` (default 60 min), every subsequent cycle
escalates to `#sqtools-ops`. The update is never forced.

### Task Decomposition

`lib/task-decomposer.js` provides automated analysis and decomposition of complex tasks into subtasks.

**Complexity Analysis:**
- Detects multi-task indicators: numbered lists, bullet points, "then/also/finally" keywords
- Counts task components and assigns complexity score
- Threshold: score >= 3 triggers potential decomposition

**Decomposition Flow:**
1. `analyzeComplexity(text)` - heuristic analysis for fast detection
2. `decomposeTask(task)` - LLM-powered decomposition (uses Gemini for efficiency)
3. LLM returns structured JSON with subtasks, dependencies, and priorities
4. `findAgentForTask(repo, taskType)` - routes subtasks to appropriate agents

**Subtask Routing:**

| Task Type | Default Agent |
|-----------|---------------|
| Code (slack-agent-bridge) | code-bridge |
| Code (SquareDashboardTool) | code-sqtools |
| Code (other repos) | bridge |
| Security review | security |
| Email/inbox | email-monitor or secretary |
| Calendar/scheduling | secretary |
| Social media | social-media |
| Research/analysis | bridge with research skill |

**Subtask Status Flow:**
```
pending → running → completed
                 → failed
       → blocked (waiting for dependency)
       → skipped (dependency failed)
```

**Dependency Handling:**
- Subtasks can specify `dependsOn: [subtask-ids]`
- `getReadySubtasks()` returns subtasks with all dependencies satisfied
- Failed dependencies cascade to skip dependent subtasks
- Independent subtasks can run in parallel

**Key Functions:**
```javascript
// Analyze complexity heuristically
const { score, isComplex, indicators } = analyzeComplexity(task.instructions);

// Full decomposition with LLM
const { decomposed, subtasks, reason } = await decomposeTask(task);

// Check which subtasks are ready
const ready = getReadySubtasks(allSubtasks);

// Format for execution
const message = formatSubtaskAsMessage(subtask, { previousResults });

// Generate final summary
const summary = generateSummary(completedSubtasks);
```

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

### Field Label Rules

**LOGIC CHANGE 2026-09-14.** A field label is recognised only when it is
**UPPERCASE** and at the **start of a line** (leading spaces or tabs are allowed).
`TASK:`, `REPO:`, `BRANCH:`, `TURNS:`, `SKILL:` and `INSTRUCTIONS:` all follow this
rule — the list lives in `FIELD_LABELS` in `lib/task-parser.js`.

This replaces the 2026-04-01 case-insensitive labels. The old patterns were
unanchored *and* case-insensitive, so prose matched: on 2026-09-13 the sentence
fragment "repo: runWithFallback had" inside an INSTRUCTIONS body produced
`git clone https://github.com/jtpets/runWithFallback had.git`.

A label written in a non-canonical form (`repo:`, `Repo:`) is **not silently
ignored** — it is reported and the whole task is refused, so a mis-typed label can
never quietly downgrade a task to "no repo".

### Field Value Rules

`REPO:` and `BRANCH:` reach `git` and are validated at the boundary by
`lib/git-identifiers.js`, then asserted again at the sink in `cloneRepo`. Values are
**rejected, never sanitised** — stripping characters out of `jtpets/my;repo` would
clone `jtpets/myrepo`, a different repository than was asked for, with nobody told.

| Field | Accepted shape |
|-------|----------------|
| `REPO` | `owner/name`. Owner: 1-39 chars of `[A-Za-z0-9-]`, first and last alphanumeric. Name: 1-100 chars of `[A-Za-z0-9._-]`, no `..` |
| `BRANCH` | 1-255 chars of `[A-Za-z0-9._/-]` starting alphanumeric, and git-ref-legal (no `..`, `//`, trailing `/` or `.`, no component starting `.` or ending `.lock`) |
| `SKILL` | A single path segment: 1-64 chars of `[a-z0-9._-]` starting alphanumeric, no `..` (it indexes `skills/<skill>/SKILL.md`) |

A rejected value is collected into `task.errors` by `parseTask`; `processTask`
throws on a non-empty `task.errors`, which posts the reason to Slack and marks the
message failed. No clone is attempted.

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

### Approval Queue
Manage the manual approval queue for auto-generated tasks:
```
ASK: pending approvals
ASK: approval queue
ASK: awaiting approval
ASK: what's pending
```
- Returns list of auto-generated tasks awaiting owner approval
- Tasks queued from: security-followup, email-monitor, automated-scan
- Each task shows: ID, source, repo, file, severity, age

**Approve tasks:**
```
ASK: approve <task-id>
ASK: approve all
```
- Approving posts the task to its target agent channel for execution
- `approve all` approves all pending tasks at once

**Reject tasks:**
```
ASK: reject <task-id> [reason]
ASK: reject all [reason]
```
- Rejected tasks are removed from the queue without execution
- Optional reason is logged for audit purposes

**View task details:**
```
ASK: show task <task-id>
```
- Shows full task message content and metadata
- Useful for reviewing before approve/reject decision

**Why approval queue exists:**
- Prevents prompt injection attacks via malicious security findings
- Prevents automated systems from creating arbitrary code execution tasks
- All auto-generated tasks are queued, not executed directly
- Owner must explicitly approve before tasks run

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
30 8 * * 1 cd <repo> && set -a && source .env && set +a && node scripts/watercooler.js kickoff

# Friday Retro (5:00 PM Toronto time)
0 17 * * 5 cd <repo> && set -a && source .env && set +a && node scripts/watercooler.js retro
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
