# Configuration Surface Inventory & Rebuild Path

**Filed:** 2026-09-14 · **Branch:** `claude/config-surface-inventory` · **Status:** backlog / evidence — for John to review and act on.

> **Credential rule observed throughout.** This document records **variable names
> only**. No token, key, secret, or `.env` value was printed, logged, committed, or
> reproduced anywhere below. Where a value was read (e.g. to count keys), only its
> **name** left the tooling. Deploy keys and the live `.env` were never opened for
> their contents — only their filenames and the `KEY=` left-hand sides were read.

This was produced from inside the running `jt-agent` container. Its purpose is to make
the deployment rebuildable from evidence rather than from memory, after the Pi→NAS
migration left the only copy of several artifacts on the NAS.

---

## Files read for this report (one line each)

| File / path | What it governs |
|---|---|
| `/tmp/bridge-agent/task-.../` (this scratch clone) | The repo tree being inventoried; where this doc is committed. |
| `/bridge/` (bind mount of the NAS deploy dir) | The **live** deployment: running code, live `.env`, deploy key, compose file, state files. |
| `/bridge/docker-compose.yml` | The `jt-agent` service definition — image, mounts, env_file, command, restart policy. |
| `/bridge/.env` (left-hand sides only) | The live environment file — the actual runtime configuration surface. |
| `.env.example` (repo) | The documented/example configuration surface that ships in the repo. |
| `lib/config.js`, `lib/llm-runner.js`, `lib/task-parser.js`, `lib/task-lock.js`, `lib/clone-lifecycle.js`, `auto-update.js`, `bots/storefront.js`, integrations | The code sites that actually read `process.env.*`. |
| `/repo/` (read-only mount) | The SquareDashboardTool (SqTools) working tree, mounted read-only; PRODUCTION. |
| own process env (`printenv`, names only) | What the container actually injected at runtime. |

---

## Step 1 — Filesystem reach (established before anything else)

| Target | Verdict | How verified |
|---|---|---|
| Bridge working tree (this scratch clone) | **Confirmed** | `pwd` → `/tmp/bridge-agent/task-1789386893-896619`; `git status` clean |
| Live deploy dir `/bridge` | **Confirmed — readable** | `ls -la /bridge` (bind mount of `/share/CACHEDEV1_DATA/jt-agent`, per compose) |
| Read-only mount of the other repo | **Confirmed — `/repo` (read-only)** | `ls /repo` → SquareDashboardTool tree. **Not** `/mnt` (empty); the real path came from the compose `volumes:` |
| Host filesystem under the NAS share | **Unreachable** | `/share/CACHEDEV1_DATA` is ABSENT inside the container; only the two bind-mounted subdirs (`…/jt-agent`, `…/sqtools/app`) are visible, not the share root |
| Live environment of own process | **Confirmed** | `printenv` (52 vars; names only) |

**Reach is larger than the task assumed.** The task framed the deploy dir and compose
file as "on the NAS, not written down." They are in fact **readable at `/bridge`** — the
NAS deploy directory is bind-mounted into the container. So the compose file, the live
`.env` key names, one deploy key, and the runtime state files are all directly
observable and are captured below. What remains genuinely unreachable is the **host
level** (the NAS share root, host crontab, Tailscale auth, and the other two stacks'
deploy keys) — see Step 6.

---

## Step 2 — Environment-variable surface

**Enumerating command (regenerates the figure):**

```bash
grep -rhoE "process\.env\.[A-Z0-9_]+" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=tests . \
  | sed -E 's/process\.env\.//' | sort -u
```

**Figures:** code reads **56** distinct keys statically + **1 dynamic pattern**
(`LLM_PROVIDER_<AGENTID>`, built at `lib/config.js:168` and read via
`process.env[key]`). `.env.example` documents **33**. The live `/bridge/.env` sets **31**.

Full name→site map is in the appendix. Every read site was captured with:

```bash
grep -rnoE "process\.env(\.[A-Z0-9_]+|\[[^]]+\])" --include="*.js" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=tests .
```

### List A — code reads, `.env.example` does NOT document (25)

```
ALLOWED_USER_IDS, BOT_USER_ID, CATALOG_CACHE_FILE, CATALOG_CACHE_TTL_MS,
CLAUDE_RATE_LIMIT_PAUSE, DELIVERY_QUOTES_FILE, DEPLOY_KEY_PATH,
EMAIL_RATE_LIMIT_BULLETINS_PER_WINDOW, EMAIL_RATE_LIMIT_COOLDOWN_MS,
EMAIL_RATE_LIMIT_EMAILS_PER_WINDOW, EMAIL_RATE_LIMIT_SLACK_PER_WINDOW,
EMAIL_RATE_LIMIT_WINDOW_MS, GOOGLE_REFRESH_TOKEN, REPOS,
SECURITY_FOLLOWUP_ENABLED, SECURITY_FOLLOWUP_INCLUDE_MEDIUM, SQUARE_ACCESS_TOKEN,
STATE_FILE, STOREFRONT_ALLOWED_ORIGINS, STOREFRONT_PORT, STOREFRONT_SESSION_TTL_MS,
STORE_INBOX_CHANNEL_ID, STORE_TASKS_CHANNEL_ID, TASK_LOCK_STALE_MS, UPDATE_DEFER_ALERT_MS
```

These are undocumented in the shipped example but are real inputs (several are
credentials — `SQUARE_ACCESS_TOKEN`, `GOOGLE_REFRESH_TOKEN`). A rebuilder working only
from `.env.example` would miss all 25.

### List B — `.env.example` documents, no code reads statically (2)

```
LLM_PROVIDER_BRIDGE, LLM_PROVIDER_CODE_BRIDGE
```

**Both are false positives of a static grep.** They ARE read — dynamically — via the
`LLM_PROVIDER_<AGENTID>` pattern at `lib/config.js:168-169`. Once the dynamic path is
accounted for, **List B is empty**: the example documents nothing that the code cannot
consume. (They are the two concrete instances the example chose to illustrate.)

---

## Step 3 — Classification (names only)

**Credentials** (never safe to commit; must live off-box, encrypted):
```
SLACK_BOT_TOKEN, GEMINI_API_KEY, GOOGLE_CLIENT_SECRET, GOOGLE_CLIENT_ID,
GOOGLE_REFRESH_TOKEN, GOOGLE_CALENDAR_REFRESH_TOKEN, GOOGLE_SERVICE_ACCOUNT_KEY,
SQUARE_ACCESS_TOKEN, HTTPSMS_API_KEY
```
(`GOOGLE_CLIENT_ID` is arguably an identifier, but is paired with the secret and is
treated as sensitive here.)

**Behavioural settings** (change how the system runs):
```
POLL_INTERVAL_MS, MAX_TURNS, TASK_TIMEOUT_MS, TASK_LOCK_STALE_MS, CHECK_INTERVAL_MS,
UPDATE_DEFER_ALERT_MS, CLAUDE_RATE_LIMIT_PAUSE, NATURAL_CONVERSATION_MODE,
SECURITY_FOLLOWUP_ENABLED, SECURITY_FOLLOWUP_INCLUDE_MEDIUM,
LLM_PROVIDER, LLM_PROVIDER_<AGENTID> (per-agent override), LLM_FALLBACK_ENABLED,
LLM_FALLBACK_PROVIDER, LLM_METRICS_RETENTION_DAYS,
OLLAMA_BASE_URL, OLLAMA_KEEP_ALIVE, OLLAMA_NUM_CTX, OLLAMA_TIMEOUT_MS, OLLAMA_THINK,
OLLAMA_MODEL, EMAIL_RATE_LIMIT_* (5 keys), CATALOG_CACHE_TTL_MS, STOREFRONT_SESSION_TTL_MS,
STOREFRONT_PORT, STOREFRONT_ALLOWED_ORIGINS
```

**Identifiers** (paths, channels, orgs, hosts):
```
BRIDGE_CHANNEL_ID, OPS_CHANNEL_ID, STORE_TASKS_CHANNEL_ID, STORE_INBOX_CHANNEL_ID,
ALLOWED_USER_IDS, BOT_USER_ID, GITHUB_ORG, REPOS, WORK_DIR, LOCAL_REPO_DIR, STATE_FILE,
CLAUDE_BIN, DEPLOY_KEY_PATH, CATALOG_CACHE_FILE, DELIVERY_QUOTES_FILE,
LLM_METRICS_FILE, GOOGLE_CALENDAR_IDS
```

Own-process env (names only) classified the same way; nothing new leaked in.

---

## Step 4 — Behavioural defaults: code vs example, and multi-site divergence

Every behavioural key set in `.env.example` **agrees** with its code default:

| Key | Code default (site) | `.env.example` | Agree? |
|---|---|---|---|
| `POLL_INTERVAL_MS` | `30000` (`config.js:29`) | `30000` | ✅ |
| `MAX_TURNS` | `50` (`config.js:34`, `llm-runner.js:172`) | `50` | ✅ |
| `TASK_TIMEOUT_MS` | `600000` (`config.js:35`, `llm-runner.js:173`) | `600000` | ✅ |
| `CHECK_INTERVAL_MS` | `300000` = `5*60*1000` (`auto-update.js:41`) | `300000` | ✅ |
| `GITHUB_ORG` | `jtpets` (`config.js:28`, `task-parser.js:19`) | `jtpets` | ✅ |
| `CLAUDE_BIN` | `/usr/local/bin/claude` (`config.js:40`, `llm-runner.js:171`) | `/usr/local/bin/claude` | ✅ |
| `WORK_DIR` | `/tmp/bridge-agent` (`config.js:41`, `auto-update.js:53`, `task-lock.js:57`, `task-queue.js:22`) | `/tmp/bridge-agent` | ✅ |
| `OLLAMA_*`, `LLM_*` | see appendix | matches | ✅ |

**Multi-site keys with the same default (no divergence):** `WORK_DIR` (4 sites),
`CLAUDE_BIN` (2), `MAX_TURNS` env default (2), `TASK_TIMEOUT_MS` (3), `GITHUB_ORG` (2) —
all consistent.

### The confirmed defect: `MAX_TURNS` names two different quantities

The known case, confirmed and located:

- **`lib/config.js:34`** — `MAX_TURNS: parseInt(process.env.MAX_TURNS || '50', 10)` and
  **`lib/llm-runner.js:172`** — `DEFAULT_MAX_TURNS = parseInt(process.env.MAX_TURNS || '50')`.
  This is the **default per-task turn budget** = **50**.
- **`lib/task-parser.js:56`** — `const MAX_TURNS = 100;`. This is the **hard ceiling** on
  the per-task `TURNS:` field (floor `MIN_TURNS = 5`, default `DEFAULT_TURNS = 50`).

Two constants named `MAX_TURNS` mean **different quantities** — one a *default* (50), one
a *cap* (100). They are not in conflict as values (50 ≤ 100 is correct behaviour), but the
**shared name is the footgun**: a reader who greps `MAX_TURNS` and equates the two will
mis-reason about turn limits. Recommend renaming `task-parser.js`'s constant to
`TURNS_CEILING` (or `MAX_ALLOWED_TURNS`) so the name states the quantity. No other
same-name/different-default divergence was found.

---

## Step 5 — Rebuild path (as far as reach allows)

What must exist on a fresh box for the **bridge stack** to run, in order. Every value is
a **named placeholder**. "Safe to commit" = repo; "Off-box encrypted" = never in git.

1. **Container host** with Docker/`docker compose` and access to the persistent share
   (on the NAS: `/share/CACHEDEV1_DATA/jt-agent`). — *Safe to commit* (infra fact).
2. **Deploy directory** = the repo checkout, bind-mounted to `/bridge`. Clone
   `jtpets/slack-agent-bridge` there. — *Safe to commit* (the repo itself).
3. **`docker-compose.yml`** beside the repo (currently untracked on the NAS; captured
   verbatim in appendix). Defines: `image: node:20`, `container_name: jt-agent`,
   `user: 1000:100`, `working_dir /bridge`, `env_file` → the NAS `.env`, `volumes`
   (deploy dir → `/bridge`, `…/sqtools/app` → `/repo:ro`), `restart: unless-stopped`,
   `command: sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"`.
   — *Safe to commit* **as a template** (it carries host paths, not secrets; commit a
   `docker-compose.example.yml` with paths as placeholders).
4. **`.env`** at the compose `env_file` path — every key from the appendix, credentials
   as placeholders. — **Off-box encrypted.** Never commit.
5. **Deploy key** (`.deploy_key` / `.deploy_key.pub`, default path `/bridge/.deploy_key`,
   overridable by `DEPLOY_KEY_PATH`) with push access to the repo. — **Off-box
   encrypted** (private key). The `.pub` half may be committed as documentation.
6. **Claude Code CLI** — installed by the compose command (`npm install -g
   @anthropic-ai/claude-code`); `CLAUDE_BIN` must point at it. — *Safe to commit* (the
   command), *off-box* (any auth the CLI needs).
7. **Runtime state files** are self-healing (`.bridge-agent-state.json`,
   `.auto-update-state.json`, `agents/shared/*.json`) — created on first run; nothing to
   restore. — *N/A*.

**Notable rebuild facts discovered (not yet reflected in the repo docs):**

- **The live compose already runs `npm ci`, not `npm install`.** CLAUDE.md's
  "ACTION REQUIRED … move from `npm install` to `npm ci`" is **already done** on the
  box. The doc is stale on this point.
- **The compose service starts only `node bridge-agent.js`.** `auto-update.js` is **not
  launched by the `jt-agent` service.** This is load-bearing for rebuild: without it,
  self-deploy does not happen.
  - **Resolved repo-side, 2026-09-14:** nothing in the repository starts it either — no
    npm script (`test`, `test:smoke`, `validate` only), no spawn or fork, no compose
    file, Procfile or systemd unit. Combined with the compose finding above, **the
    self-update daemon does not run at all**; deploys are a manual
    `docker compose restart jt-agent`. A host cron or a second compose service remains
    the only unchecked possibility and must be ruled out **on the NAS**
    (`crontab -l`, and `grep -n "auto-update" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`).
    Tracked as WORK-TODO item #17; corrected across `CLAUDE.md`, `README.md`,
    `docs/AGENTS.md` and `docs/WIRING-AND-SEAMS.md`.
- **Timezone mismatch.** Compose sets `TZ: America/New_York` (and the live env agrees),
  but CLAUDE.md and the app documentation say **America/Toronto**. Same UTC offset, but a
  different zone id than documented. Flag for reconciliation.
- **`/repo` is the read-only SqTools mount** and contains `ecosystem.config.js` (a PM2
  config) — consistent with COMMANDMENT 11 (SqTools is PM2-managed production; the bridge
  is not).

---

## Step 6 — What could not be determined, and who must determine it

**Unreachable from inside this container (host level — John / infra owner must supply):**

- **NAS host share root** `/share/CACHEDEV1_DATA` and anything outside the two bind
  mounts. Confirmed absent. Only `…/jt-agent` and `…/sqtools/app` are visible.
- **Host crontab** (morning digest, security review, watercooler schedules per CLAUDE.md
  run as cron on the host). Not visible; must be exported from the NAS by the owner.
- **Tailscale auth** — not present under `/bridge`; host-level. Owner must supply.
- **The other two deploy keys.** Only **one** deploy key pair exists under `/bridge`
  (the bridge's own). The task's "three deploy keys" implies two more for the other
  stacks — host-level, outside reach.
- **The other two stacks' compose/config.** Only the `jt-agent` compose is at `/bridge`.
  The **SqTools stack** (PRODUCTION) is visible read-only at `/repo` but its deploy
  wiring (its `ecosystem.config.js`/PM2 setup, its own `.env`, its compose if any) is
  **not** writable or fully mapped here and must **not** be touched. The **third stack**
  named in the task context was not identified from inside this container.
- **`auto-update.js` invocation** (see Step 5) — how/whether the self-update daemon is
  started on the box.

**Cross-stack ownership question (required answer):** No repository in reach obviously
owns **cross-stack infrastructure**. `jtpets/slack-agent-bridge` owns only the bridge;
`/repo` (SqTools) owns only itself. The compose file, the host crontab, Tailscale, and
the three deploy keys are **infra that belongs to no application repo today.** That gap
is itself the finding: cross-stack infra is currently unowned and lives only on the NAS.

---

## Proposals (decisions for John — this task does not execute them)

**Where a permanent runbook should live:** a **new dedicated infra repository** (e.g.
`jtpets/nas-infra` or `jtpets/deployment`) that owns the cross-stack concerns no app repo
owns today: the three stacks' compose templates (paths as placeholders), the host
crontab, the Tailscale setup steps, and a pointer to the encrypted secrets store. A
per-app runbook fragment can live in each app repo (`docs/RUNBOOK.md`), but the
cross-stack index needs a home, and forcing it into `slack-agent-bridge` would misfile
SqTools and host concerns. **If a single infra repo is not created, this remains
unowned** — that is the explicit answer to the ownership question, not a detail to skip.

**Mechanism for the encrypted off-box copy:** an encrypted-at-rest secrets store that is
**not** a plaintext `.env` on a second disk. Options to weigh (decision deferred to
John): (a) `age`/`sops`-encrypted `.env` files committed to the infra repo with keys held
in a password manager; (b) a hosted secrets manager (1Password / Bitwarden / cloud KMS)
with the runbook holding only references. Either keeps credentials off every repo while
making them recoverable. **Not chosen here.**

---

## Appendix — full name→site map & compose

**Live `/bridge/.env` keys that no code in THIS repo reads** (legacy/other-stack config
carried in the shared env file): `PM2_PROCESS_NAME` (legacy — CLAUDE.md states PM2 no
longer exists in the bridge image; the key survives in `.env` regardless),
`ALERTS_CHANNEL_ID`, `CODE_REVIEW_CHANNEL_ID`, `MEMORY_CHANNEL_ID`,
`SECRETARY_CHANNEL_ID`, `SOCIAL_CHANNEL_ID`, `STORE_CHANNEL_ID` (channel IDs; the bridge
resolves agent channels from `agents/agents.json`, not these env vars). These are the
"undocumented behavioural configuration carried in the env file" the task flagged:
present on the box, documented by no repo file, read by no bridge code. `PM2_PROCESS_NAME`
in particular directly contradicts the code's documented invariant that PM2 is gone.

**Own-process env also carried harness-injected vars** (`CLAUDECODE`, `CLAUDE_CODE_*`,
`AI_AGENT`, `CLAUDE_EFFORT`, `NODE_VERSION`, etc.) that are runtime/CLI, not app config.

**docker-compose.yml (verbatim, no secrets present):**

```yaml
services:
  bridge:
    image: node:20
    container_name: jt-agent
    user: "1000:100"
    working_dir: /bridge
    env_file:
      - /share/CACHEDEV1_DATA/jt-agent/.env
    environment:
      TZ: America/New_York
      HOME: /bridge/.claude-home
      NPM_CONFIG_PREFIX: /bridge/.npm-global
      PATH: /bridge/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - /share/CACHEDEV1_DATA/jt-agent:/bridge
      - /share/CACHEDEV1_DATA/sqtools/app:/repo:ro
    command: sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"
    restart: unless-stopped
```
