# Configuration Surface Inventory & Rebuild Path

**Filed:** 2026-09-14 · **Branch:** `claude/config-surface-inventory` · **Status:** backlog / evidence — for John to review and act on.

> **Credential rule observed throughout.** This document records **variable names
> only**. No token, key, secret, or `.env` value was printed, logged, committed, or
> reproduced anywhere below. Where a value was read (e.g. to count keys), only its
> **name** left the tooling. Deploy keys and the live `.env` were never opened for
> their contents — only their filenames and the `KEY=` left-hand sides were read.

> **Addendum 2026-09-15:** **Step 7 — NAS host hardening** is appended at the end of
> this document. Steps 0-6 and the Appendix are unchanged.

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

## Step 0 — Deployment topology, and the three consequences that follow from it

**Added 2026-09-14.** Steps 1-6 below inventory *configuration*. This step states the
**shape of the deployment** — one container, two mounts, one env file — because three
load-bearing consequences follow from that shape alone, and none of them was written
down anywhere in this repository before now.

Every row is labelled **repository-verified** (regenerable from a checkout, command
given) or **owner-supplied** (established on the NAS on 2026-09-14; the regenerating
command is given but can only be run on the box). Nothing here is inferred from memory.

| Fact | Label | Regenerate with |
|---|---|---|
| One service: image `node:20`, `container_name: jt-agent`, `user: "1000:100"`, `working_dir: /bridge`, `restart: unless-stopped` | **owner-supplied** | `cat /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml` (on the NAS) — captured verbatim in the Appendix of this document |
| Start command: `sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"` | **owner-supplied** | same file, `command:` line |
| Mount 1: `/share/CACHEDEV1_DATA/jt-agent` → `/bridge`, **read-write** | **owner-supplied** | same file, `volumes:` |
| Mount 2: `/share/CACHEDEV1_DATA/sqtools/app` → `/repo`, **read-only** | **owner-supplied** | same file, `volumes:`; confirmed from inside the container in Step 1 |
| Environment comes from an `env_file` on the host (`/share/CACHEDEV1_DATA/jt-agent/.env`) | **owner-supplied** | same file, `env_file:` |
| Compose `environment:` sets `TZ: America/New_York` | **owner-supplied** | same file, `environment:` |
| No code in this repo reads `process.env.TZ`; every date-format and cron site pins `America/Toronto` explicitly | **repository-verified** | `npx jest tests/timezone-explicit.test.js` (the enumerator); one-off: `grep -rn "env\.TZ" --include=*.js . \| grep -v node_modules` → nothing |
| Scratch clones live under `WORK_DIR`, default `/tmp/bridge-agent` | **repository-verified** | `grep -rn "WORK_DIR" lib/config.js lib/task-lock.js lib/task-queue.js bridge-agent.js auto-update.js` → `lib/config.js:41` is the default; four siblings repeat the same literal |
| `/tmp/bridge-agent` is **not** either mount, so it is container-local storage | **derived** (owner-supplied compose × repository-verified default) | the two rows above |
| `docker-compose.yml` is **untracked and not gitignored** | **repository-verified** | `git ls-files \| grep -i compose` → nothing; `git check-ignore -v docker-compose.yml` → no match (exit 1) |
| Nothing in this repo runs `git clean`; `auto-update.js` runs `git reset --hard HEAD`, which does **not** remove untracked files | **repository-verified** | `grep -rn "git clean\|'clean'" --include=*.js . \| grep -v node_modules` → nothing; `grep -n "reset', '--hard" auto-update.js` → `:170`, `:191` |

---

### Consequence 1 — the deploy directory and the repository working tree are the same files

`/bridge` is a bind mount of `/share/CACHEDEV1_DATA/jt-agent`, and that host directory
**is the git checkout** the container runs (Step 2 and Step 5 item 2). There is no copy
step between "the repo" and "the deployment": a commit made inside the container at
`/bridge` is a commit in the live deployment tree, and an edit there changes the code
that runs at the next restart.

`docker-compose.yml` — the file that defines the deployment — sits **inside that same
working tree**, untracked and, unlike `.env`, **not covered by `.gitignore`** (verified
above). So:

- `git status` in the deploy directory reports it as an untracked file, every time.
- **`git clean -fd` in the deploy directory deletes it.** That is the "one clean command
  from being lost" case, and it is the ordinary command someone reaches for to tidy an
  untracked tree. (`git reset --hard HEAD`, which `auto-update.js` runs at
  `auto-update.js:170`, does *not* touch untracked files — this is the one destructive
  path, and nothing in this repo takes it.)

**Rebuild path for the compose file, and where it is recorded:** the file is reproduced
**verbatim in the Appendix of this document**, and its fields are restated as step 3 of
the Step 5 rebuild path. That copy — in this repository, on GitHub — is the only copy
that is not on the NAS. To rebuild: write the Appendix block to
`/share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`, substituting the host paths if the
share layout differs, then `docker compose up -d`. Everything else it needs (`.env`,
the deploy key) is covered by Step 5 items 4 and 5.

**Not fixed here, filed instead:** adding `docker-compose.yml` to `.gitignore` would put
it out of `git clean -fd`'s reach (which skips ignored files without `-x`) at the cost of
nothing. It is a one-line repository change with a deployment-shaped consequence, so it
is filed as a WORK-TODO item rather than taken unilaterally.

---

### Consequence 2 — the preserved scratch clone does not survive a container recreation

This one is a silent data-loss path *inside a feature written to prevent silent data
loss*, so it is stated in full.

**What the feature does** (repository-verified, `lib/clone-lifecycle.js:237-330`,
called from `bridge-agent.js:964-981`): before deleting a task's scratch clone,
`detectUndeliveredWork(dir)` classifies it. A clone with uncommitted changes, or with
local commits that `git ls-remote origin` does not show on the remote, or whose delivery
state cannot be read at all, is **kept** — `cleanupDir` is not called — and an alert goes
to `#sqtools-ops` naming the directory so the commits can be recovered and pushed by
hand. On any uncertainty it errs toward preserving. It exists because three tasks' work
was destroyed by unconditional cleanup on 2026-09-13.

**Where it keeps them:** `path.join(WORK_DIR, 'task-<msg.ts>')`, `WORK_DIR` defaulting to
`/tmp/bridge-agent` (`lib/config.js:41`, used at `bridge-agent.js:503-508`).

**Why the deployment defeats it:** `/tmp/bridge-agent` is not `/bridge` and not `/repo`.
It is in the container's own writable layer, which is a property of the *container*, not
of the image or the mounts. Therefore:

| Operation | Preserved clone survives? |
|---|---|
| `docker compose restart jt-agent` (the documented deploy step) | **yes** — the same container is restarted, its writable layer is intact |
| `docker compose up -d --force-recreate jt-agent` (**required for any `.env` change**) | **no** — a new container is created and the old layer is discarded |
| `docker compose down` / `up`, an image change, a host or Docker daemon restart that recreates the container, a container prune | **no** |

The second row is the finding. `CLAUDE.md` and `docs/EXECUTOR-CONTRACT.md` both instruct
`--force-recreate` for an environment change, so the *documented* operational procedure is
one of the operations that destroys preserved work — with no warning, because the alert
that named the directory was posted hours or days earlier and nothing re-checks it.

**A second, weaker failure that is live today regardless of restarts:** the alert posts a
**container-internal** path (`/tmp/bridge-agent/task-…`). That path does not exist on the
NAS host — `/tmp` is not bind-mounted — so an owner reading the alert on their phone
cannot `cd` to it. Recovery requires `docker exec -it jt-agent sh` first, and the alert
does not say so.

**Not fixed here**, because the fix is a deployment change (bind-mount `WORK_DIR`, or
point `WORK_DIR` at a path under `/bridge`) and this repository cannot make deployment
changes — the compose file is off-repo (Step 6). Filed as a WORK-TODO item with this
evidence. Note the repository-side half of a fix *is* available and is named in that
item: the alert can state the recovery command and the durability caveat, and
`WORK_DIR`'s default can be documented as needing to be a mounted path.

**Unverified:** whether the live `/bridge/.env` sets `WORK_DIR` to something other than
the default. Step 2 records that the live env sets 31 keys but not which. Regenerate on
the NAS: `grep -c . /share/CACHEDEV1_DATA/jt-agent/.env` and
`grep -n "^WORK_DIR=" /share/CACHEDEV1_DATA/jt-agent/.env` (names only — never print the
file). If it points somewhere under `/bridge`, consequence 2 does not apply and the item
should be closed with that output as the evidence.

---

### Consequence 3 — the blast radius of every task this system runs

There are two mounts and they are not symmetrical.

**`/repo` is read-only, and that is a real boundary.** The SqTools application tree —
PRODUCTION, money and customer PII — is mounted `:ro`. A task executor with a shell
inside this container cannot write to it. Not "is asked not to": cannot. That mount flag
is the reason a bridge-side compromise, a prompt injection, or a plainly mistaken task
cannot damage SqTools. **It must never be made read-write.**

**`/bridge` is read-write, and there is no equivalent boundary.** Tasks run through the
Claude Code CLI with `--dangerously-skip-permissions` (`CLAUDE.md` → Security), which is
a shell. That shell runs as `uid 1000:100`, the owner of the bind-mounted deploy
directory. So a task executor can, today, write to:

- **`/bridge/.env`** — every live credential the system holds: the Slack bot token, the
  Gemini key, the Google OAuth trio and refresh token, the Square access token, the
  httpSMS key. Readable *and* writable.
- **`/bridge/.deploy_key`** — the private key with push access to this repository
  (`DEPLOY_KEY_PATH`, default `/bridge/.deploy_key`).
- **`/bridge/docker-compose.yml`** — the file that defines the container, its mounts
  (including the `:ro` flag on `/repo`), and its start command.
- **`/bridge/agents/agents.json`, `/bridge/COMMANDMENTS.md`, `/bridge/CLAUDE.md`** — the
  registry and the instruction files that shape every subsequent task.
- **`/bridge/.git`** — the git repository the deployment runs from, and `/bridge`'s
  working tree, which is the code that loads at the next restart.
- **`/bridge/.claude-home/`** — `HOME` for the container, holding the Claude Code CLI's
  live OAuth credential.

That is the blast radius of every task. It is not hypothetical and it is not new — it has
been the case since the container was built. What was missing is anyone writing it down.

**The mitigations that actually exist** (`CLAUDE.md` → Security): the `ALLOWED_USER_IDS`
allowlist on who may submit a task, the per-task turn cap and `TASK_TIMEOUT_MS`, GitHub
branch protection on `main`, and the executor contract's rule that work happens in a
scratch clone under `WORK_DIR` and never in the live tree. Note what that list is: an
*authorisation* boundary on the input side and a *convention* on the executor side.
There is no containment boundary on the `/bridge` side comparable to `:ro` on `/repo`.

**Consequences for how tasks are reviewed, stated plainly for both audiences:**

- *For an executor:* you are in a scratch clone under `WORK_DIR`, but you are not
  sandboxed out of `/bridge`. `cd /bridge` works. Nothing stops you; the rule that you do
  not touch it is a rule, not a wall. `docs/EXECUTOR-CONTRACT.md` §7 carries this.
- *For a reviewer:* a task that can be induced to run one wrong shell command in the live
  tree can exfiltrate every credential the system holds and rewrite the code that runs
  next. Instructions that reach the executor from outside the dispatch — a security
  finding's text, an email body, a Slack message, a repository file — are the injection
  surface. That is why auto-generated tasks go through the approval queue rather than
  executing directly (`CLAUDE.md` → "Why approval queue exists"), and why that queue is
  load-bearing rather than procedural.

**Recorded, not fixed.** Narrowing this is a deployment change (a separate unprivileged
uid for task execution, a read-only `/bridge` with a writable sub-path, or running tasks
in a child container), and the compose file belongs to no repository today (Step 6).

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
7. **Runtime state files** — `.bridge-agent-state.json`, `.auto-update-state.json`,
   `agents/shared/*.json`. Created on first run. **CORRECTED 2026-09-15: one of them is
   not self-healing in the sense this step claimed, and it cost an outage.**

   `agents/shared/channel-map.json` maps a declared channel **name** to a Slack id and
   is the only record of that mapping anywhere. It is gitignored, correctly — a
   workspace id is not portable — so a rebuilt box starts with none. The boot path does
   re-resolve it (`bridge-agent.js` startup IIFE → `resolveAgentChannel()`), which is
   what "self-healing" meant, **but only for declared names that are real**. On
   2026-09-15 seven of eleven declared names were a convention that named no existing
   channel: five active agents resolved to nothing and two scheduled agents stopped. The
   names are now verified (`docs/AGENTS.md` → "Declared channel name vs. the workspace's
   real one"), and there is a command for the rest:

   ```bash
   node scripts/channel-map.js              # read-only report: name -> resolved id, per agent
   node scripts/channel-map.js --from-git   # rebuild THIS workspace's ids from git history
   node scripts/channel-map.js --resolve    # rebuild ANY workspace's from Slack, by name
   ```

   `--from-git` needs no token and no network: it reads `agents/agents.json` as it stood
   when the markdown migration deleted it, which every clone carries as history. Run it
   on the rebuilt box **before** the first `docker compose up`, and the first boot is a
   cache hit for every agent that already had a channel.

   **What is still missing, filed as WORK-TODO #55:** nothing exports the resolved map
   off-box, so if the NAS and Slack are both unavailable the mapping is gone; and the
   history reconstruction recovers ids as of the deletion commit, not later changes.
   This is the same class as Step 7.3 — a record that lives only on the box it describes.
   — *Safe to commit*: the commands. *Not committed*: the ids they produce.

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
- **Timezone mismatch — RESOLVED 2026-09-14, in the documentation.** Compose sets
  `TZ: America/New_York` (and the live env agrees), while CLAUDE.md said
  **America/Toronto**. The reconciliation went to the documentation, not the
  deployment, because **no code reads `process.env.TZ`**: every `toLocale*String` call
  passes `timeZone: 'America/Toronto'` and `lib/agent-scheduler.js:224` passes
  `timezone: 'America/Toronto'` to `cron.schedule`, so the container's value reaches no
  behaviour (the two zones also share an offset and DST rule, which is why the
  disagreement was invisible). `CLAUDE.md` → Tech Stack now states both values and which
  one the code depends on. The property is held by an enumerator, not by prose:
  `tests/timezone-explicit.test.js` fails when a new date-format or cron site omits its
  zone, or when anything begins reading `process.env.TZ`. Regenerate:
  `npx jest tests/timezone-explicit.test.js`.
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

## Addendum 2026-09-14 — two new config keys: `SLACK_APP_TOKEN`, `SOCKET_MODE_DOWN_ALERT_MS`

Appended rather than merged into the Step 2/3/4 tables above: those are a dated snapshot
of the surface as it stood when this was filed, and the figures in them carry their own
regeneration commands. Re-run those commands and the new keys appear; edit the frozen
counts in place and the snapshot stops being one.

| Key | Classification | Default | Read at |
|---|---|---|---|
| `SLACK_APP_TOKEN` | **Credential** — Slack app-level token (`xapp-`). Treat exactly like `SLACK_BOT_TOKEN`: off-box, encrypted, never printed. | unset (Socket Mode off) | `lib/slack-socket.js` `readAppTokenConfig()` |
| `SOCKET_MODE_DOWN_ALERT_MS` | Behavioural | `300000` (5 min) | `lib/slack-socket.js` `readDownAlertMs()` |

**Both are documented in `.env.example`, so neither joins List A.** Regenerate that
comparison with the Step 2 command.

**Redaction is already covered, and was before this change:** `SENSITIVE_NAME` in
`lib/redact-secrets.js:24` matches on `TOKEN`, so the live value is value-scrubbed by
name, and `lib/redact-secrets.js:35` carries an `xapp-` pattern as a second layer. No
change to that module was needed — confirm with
`grep -n "xapp-\|SENSITIVE_NAME" lib/redact-secrets.js`.

**Rebuild impact (Step 5).** `SLACK_APP_TOKEN` is a new item for the off-box credential
copy. It cannot be regenerated from any repository or from the NAS: it is issued by the
Slack app configuration (Basic Information -> App-Level Tokens, scope `connections:write`),
and losing it means issuing a new one there. Its absence degrades **only** slash commands
— the bridge starts and polls normally without it — so it does not belong in the
minimum set needed to bring the bridge back up.

**Owner action, unverifiable from this repository:** Socket Mode must be enabled in the
Slack app (Settings -> Socket Mode) for the token to connect at all. Nothing in a checkout
can confirm whether it is. Adding the key to `.env` needs
`docker compose up -d --force-recreate jt-agent` — Consequence 2 above applies: that
operation discards any preserved scratch clone.

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

---

# Step 7 — NAS host hardening (addendum, 2026-09-15)

**This is an addendum to a dated snapshot. Steps 0-6 and the Appendix above are
unchanged** — they record what was observed from inside the running container on
2026-09-14 and are not rewritten here.

## 7.0 What this step is, and what it is not

Steps 0-6 inventory the *bridge container* and stop at the container boundary. Step 6
names what lies past it — the NAS share root, the host crontab, Tailscale, the other two
stacks, the other deploy keys — and says plainly that it is **owned by no repository**.
Step 7 is the first pass at the thing Step 6 deferred: the host itself.

**Nothing in this step was observed.** It was written from a checkout, on a machine with
no route to the NAS. Every line describing current state is therefore a **question with
the command that answers it**, never a claim. Three labels are used throughout and each
one is load-bearing:

| Label | Means |
|---|---|
| **repository-verified** | Regenerable from any checkout; the command is given and was run. |
| **owner-supplied** | Established on the NAS by the owner (dates given). Not regenerable from a checkout; re-confirm before depending on it. |
| **UNVERIFIED** | Nobody has established this. It is a question, not a finding. Answering it is the first task, not the last. |

**QNAP menu paths below are from QTS convention and are UNVERIFIED for this box's
firmware.** Menus move between QTS releases. Treat every "Control Panel → …" as a lead
to confirm on the appliance, in exactly the way `docs/EXECUTOR-CONTRACT.md` §2 treats a
supplied file:line.

## 7.1 What is actually being hardened

| Fact | Label |
|---|---|
| The appliance is a QNAP **TS-264** | **owner-supplied** (2026-09-15 dispatch). Confirm: Control Panel → System → System Status, or `getsysinfo model` over SSH |
| It hosts the `jt-agent` container, whose `env_file` holds **9 credential keys** (Step 3) and whose deploy directory holds the repository deploy key | **owner-supplied** (compose + `.env` capture, Step 0 / Appendix) |
| It hosts SqTools — **PRODUCTION**, money and customer PII — as `sqtools-db` (postgres) + `sqtools-app` + `sqtools-tunnel` under `/share/CACHEDEV1_DATA/sqtools/` | **owner-supplied** (standing statement; `/repo` confirms the app tree exists, Step 1) |
| It hosts the DayZ discord bot under `/share/CACHEDEV1_DATA/discordbot/` | **owner-supplied** (standing statement) |
| It holds **the only copies of every backup**: nightly `pg_dump` 02:15 → `sqtools/backups/` (14-day retention), DayZ mirror 02:45 (8-day) | **owner-supplied** (standing statement) |
| Access is via Tailscale (`alexandernas`); Supremo to `msi` as a last resort | **owner-supplied** (standing statement) |
| Firmware updates wipe `/etc/config/crontab`, so both backup jobs stop and nothing reports it | **owner-supplied** (standing statement — an observed failure, not a theory) |

**The shape those rows make is the finding, and it is one sentence:** the NAS is
simultaneously the production host, the credential store, and the backup target for all
three stacks. One successful ransomware run, or one disk or controller failure, takes the
running systems *and* every restore path at the same moment. Nothing below matters more
than 7.2 and 7.3, which are the two items that change that.

## 7.2 Inbound exposure — establish it before anything else

**Why this is first.** QNAP appliances are not a generic hardening target; they are a
*specific* ransomware target with a history (Qlocker, DeadBolt, eCh0raix), and every one
of those campaigns worked by reaching a NAS management or service port from the internet.
If nothing on this box is reachable from outside, most of 7.4-7.6 is defence in depth and
can be paced. If something is reachable, it is the only item on the list.

**UNVERIFIED — nobody has established which of these is true.** Answer in this order:

| # | Establish (on the box / router) | Hardened target |
|---|---|---|
| 1 | The router's port-forward / virtual-server table: is anything forwarded to the NAS's LAN IP? | No forward to the NAS. Tailscale needs none — it is outbound-only. |
| 2 | Control Panel → Network & File Services → **UPnP / service discovery**, and myQNAPcloud → **Auto Router Configuration** | Both **off**. Auto Router Configuration punches port forwards on your behalf; a forward you never made is the one you never audit. |
| 3 | **myQNAPcloud** account link, DDNS, and "myQNAPcloud Link" (relay) | Off, if Tailscale is the access path. A relay is an inbound path that no router table shows. |
| 4 | An **off-LAN probe** of the public IP: from a phone on cellular (Wi-Fi off), try the QTS ports (8080, 443), SSH (22 or the configured port), and the SqTools app port (5001) | All refused / timed out. |

Record the answer to each in this document as a dated line. **A "no" that nobody wrote
down gets re-asked every six months and eventually gets guessed at.**

**Then close the gaps found, if any.** Removing a forward is immediate and reversible;
the cost is that whatever used it stops working, which is the point — establish what used
it *before* removing it, not after.

**Supremo deserves its own line.** It is a remote-desktop path into the LAN that does not
go through Tailscale, so it is not covered by "access is via Tailscale". **UNVERIFIED:**
whether it is set to start automatically, whether its access is fixed-password or
one-time, and who else holds that credential. If it is a last resort, it should be
started when needed and not left running; if it must run, its password is a credential
with a rotation story like any other.

## 7.3 The backups are on the box they back up

**This is the highest-value item that is fully in the owner's hands, and it is cheap.**

A nightly `pg_dump` into `sqtools/backups/` on the same NAS protects against exactly one
failure — someone dropping a table — and against none of the failures that actually take
a NAS out. Ransomware encrypts the backup directory in the same pass as the data.
A failed disk or controller takes both. 14-day retention on the same volume is 14 days of
the same single point of failure.

**The target is one off-box copy, and "off-box" has a test:** could the copy be restored
if the NAS were powered off and gone? A second share on the same appliance fails that
test. A USB disk left permanently mounted fails it against ransomware. What passes: an
external disk rotated and disconnected, another machine that pulls (rather than the NAS
pushing, so a compromised NAS cannot reach in and delete), or an object store with
versioning and a retention lock.

**Pull, not push, if a second machine is used.** A push credential stored on the NAS is a
credential an attacker on the NAS holds. The direction of the pull is the control.

**Do not skip the restore.** A backup nobody has restored is a hypothesis. The check is a
real `pg_restore` of the newest dump into a scratch database and a row count against the
live one — the same discipline `SQTOOLS_REQUIRE_PG=1` exists for, applied to the restore
path. Write the date of the last successful restore down.

## 7.4 Backup liveness — check the artifact, never the cron entry

**owner-supplied, and already observed:** a firmware update wipes `/etc/config/crontab`.
Both backup jobs stop, and **nothing reports it**. The failure is silent by construction:
the job that would have complained is the job that no longer runs.

This is the same class as `auto-update.js` (item #17) — a scheduled thing that nobody is
told has stopped — and it has the same shape of fix: **the check must be on the artifact,
not on the schedule.** `crontab -l` showing the entry proves nothing about last night;
only the file's timestamp does.

```bash
# On the NAS. Newest dump and its age — this is the check, not `crontab -l`.
ls -lt /share/CACHEDEV1_DATA/sqtools/backups/ | head -5
find /share/CACHEDEV1_DATA/sqtools/backups/ -name '*.sql*' -mtime -1 | wc -l   # 0 = last night did not run
crontab -l    # second, only to explain a 0 above
```

**The durable form is an alert, not a habit.** Anything that surfaces "newest dump is
older than 26 hours" to a human works — and this repository already owns a path that
does: `#sqtools-ops` via `lib/notify-owner.js` → `notifyOps`, which every other
operational failure in the bridge already uses. A small scheduled check posting there is
a better answer than a reminder to run the command, because the reminder has the same
failure mode as the cron entry.

**Whatever is added must itself be re-added after a firmware update** — see 7.8.

## 7.5 Accounts and authentication

Ordered by what it costs an attacker. All rows **UNVERIFIED**.

| Item | Target | Note |
|---|---|---|
| Built-in **`admin`** account | Disabled, after a second named administrator exists and has been logged in with | `admin` is the username every QNAP-targeting script tries first. Disabling it invalidates the whole guess. Create the replacement and **verify you can log in as it** before disabling the original — locking yourself out of a NAS you reach only over Tailscale is a physical-access problem. |
| **2-step verification** (TOTP) on every administrator | On | Control Panel → Privilege → Users → account → 2-step verification. Save the recovery path somewhere that is not the NAS. |
| **IP Access Protection** (auto-block after N failed logins) | On, for SSH, HTTP/HTTPS, and any enabled file service | Control Panel → System → Security. Turns credential-stuffing from unlimited into a few tries. |
| **Account Access Protection** | On | Locks a single account after repeated failures rather than blocking the source IP. |
| **Allow/Deny list** | Allow the LAN and the Tailscale CGNAT range `100.64.0.0/10`; deny the rest | Only meaningful once 7.2 is answered — and it is a second line of defence, never a substitute for removing an exposure. |
| Administrator **password** | Unique to this box, in the password manager, not reused from anything | |
| Web-session timeout, and "do not allow auto-login" | On | |
| **Unknown users, shares, and scheduled tasks** | None | Not a hardening step — a **compromise check**. An account or a cron entry nobody created is the finding, and it changes the task from hardening to incident response. Do this pass while you are in there. |

## 7.6 Service surface and appliance updates

**The rule is: everything not in use is off.** Each enabled service is a listener with its
own CVE history, and on this box most of them have no user at all.

| Service | Question | Expected here |
|---|---|---|
| Telnet | On? | **Off.** No exceptions. |
| SSH | On, on what port, which accounts may use it? | On is reasonable — it is how the stacks are administered. Key-based, non-default port, restricted to the administrator account, reachable only over LAN/Tailscale. |
| SMB / Microsoft Networking | Minimum protocol version? | **SMB2 or higher; SMB1 disabled.** |
| FTP, AFP, NFS, WebDAV, Rsync server | Any actual user? | Off unless one is named. |
| Web Server, SQL Server, Multimedia/DLNA, Photo/Music/Video stations, Qsync | Any actual user? | Off. These are consumer-NAS features with no role in this deployment. |
| QTS web UI | HTTP allowed? | **Force HTTPS.** Change from the default 8080/443 ports if it costs nothing. |
| **Malware Remover** | Installed, run recently? | Run it. QNAP-supplied; it is the cheapest compromise check available. |
| **Security Counselor** | Installed, run recently? | Run it and read the report. It enumerates much of this section against the *actual* firmware, which is worth more than this table's conventions. Its output is the right thing to paste into the dated record 7.2 asks for. |
| Firmware and App Center updates | Auto-update on? Current version? | Current. Every named QNAP ransomware campaign exploited a flaw with a patch already published. |

**Snapshots are recovery, not prevention, and they are the fast half of 7.3.** If this
box and volume support them (Storage & Snapshots), a snapshot schedule turns "restore
from last night's dump" into "roll back". Use locked / secure snapshots if the firmware
offers them — an unlocked snapshot is deletable by whoever holds admin, which after a
compromise is the attacker. **A snapshot is not the off-box copy.** It lives on the same
volume and dies with it. 7.3 still stands.

## 7.7 The container's own blast radius — concrete shapes for item #27

Step 0 consequence 3 records that a task can write `/bridge/.env` (every credential),
`/bridge/.deploy_key`, `/bridge/docker-compose.yml`, `/bridge/.claude-home/` (the CLI's
live OAuth credential) and the working tree that loads at the next restart. WORK-TODO #27
holds that open as the owner's decision. This section adds only what was missing: the
changes written out against the captured compose, with their verification and their
failure mode, so the decision is a review rather than a design exercise.

**They are in `docker-compose.example.yml` in this repository, commented out**, each with
a one-line reason and a `docker inspect` verification. **None has been tested against the
live bridge.** Apply one at a time, with `docker compose logs -f jt-agent` open, and
confirm a real `TASK:` runs end to end before the next. Revert = re-comment and
`docker compose up -d --force-recreate jt-agent`.

| Shape | Closes | Honest cost |
|---|---|---|
| `logging` `max-size`/`max-file` | Unbounded container log on the volume that also holds the production postgres data | None. |
| `mem_limit` / `cpus` / `pids_limit` | A task's `npm ci` + jest burst starving the production database — the same reasoning as CLAUDE.md's ollama systemd fence | Set too low, the container is OOM-killed mid-task and looks like a crash. Tune to the box. |
| `security_opt: no-new-privileges`, `cap_drop: ALL` | Privilege escalation from the task shell | An `npm` postinstall needing a capability would break. Unlikely here; not impossible. |
| Read-only `/bridge` + writable sub-path | The real #27 exposure | **Not a one-line change** — the start command runs `npm ci` into `/bridge/node_modules` and the CLI installs into `/bridge/.npm-global`, both of which need write. It requires moving those and `WORK_DIR` first, and it interacts with #25. Do not attempt it as part of a hardening pass. |
| A second uid for task execution, or a child container | The real #27 exposure | The genuine fix, and the largest. Out of scope for an appliance hardening pass; it stays in #27. |

**The `:ro` on `/repo` is the one containment boundary this deployment has.** It is the
reason a bridge-side compromise cannot damage SqTools. `docker-compose.example.yml` now
carries that statement next to the line, where someone editing the mount will read it.
**Never make it writable.**

## 7.8 The standing re-run list

Hardening is not a one-time pass; the specific thing that undoes it here is known.

**After every firmware update**, and quarterly regardless:

1. `crontab -l` — both backup jobs present? (`/etc/config/crontab` is wiped by firmware
   updates. This is not a precaution; it has happened.)
2. The artifact check in 7.4 — is last night's dump actually there? The cron entry being
   back is not the same answer.
3. Re-check 7.2 row 2: did the update re-enable UPnP / Auto Router Configuration?
4. Re-check the disabled services in 7.6 — an update can re-enable an app it upgraded.
5. Re-run Security Counselor; compare against the last dated record.
6. Confirm the `jt-agent` and SqTools containers came back: `docker ps`.

**The re-run list has the same defect it is written to catch** — it is a habit, and a
habit fails silently. Automating item 2 (7.4's alert to `#sqtools-ops`) converts the most
expensive item on the list from a habit into a report. That is the one worth building.

## 7.9 What this step changed, and what it did not

**Changed in this repository** (repository-verified):

| Change | Verify |
|---|---|
| `docker-compose.yml` added to `.gitignore` — `git clean -fd` in the deploy directory can no longer delete the deployment definition (WORK-TODO #26, repo-side half) | `git check-ignore -v docker-compose.yml` → matches, exit 0 |
| `docker-compose.example.yml` committed — the off-box copy of the deployment definition, as a file rather than prose in an appendix (Step 5 item 3), carrying the proposed hardening as commented blocks | `git check-ignore -v docker-compose.example.yml` → no match, exit 1 (it is tracked) |

**Not changed, and not verified: anything on the NAS.** No setting was read, altered, or
confirmed on the appliance by this work. The `.gitignore` line reaches the deploy tree
only when someone pulls on the box — nothing starts `auto-update.js` (#17), so a merge to
`main` deploys nothing. Until that pull, the live tree's `docker-compose.yml` is still
untracked *and* unignored there.

**Filed as backlog items rather than done here:** WORK-TODO #41 (exposure and the
single-point-of-failure posture — 7.1 to 7.3) and #42 (the backups' off-box copy and
liveness — 7.3 and 7.4). Both are P1 and both need the box.

---

# Step 8 — Every piece of state held outside the repository (addendum, 2026-09-16)

**This is an addendum. Steps 0–7 and the Appendix above are unchanged.** Step 5 item 7
said "runtime state files … created on first run" and corrected itself once, for the
channel map. This step is the full enumeration that sentence stood in for: **what each
store is, where it lives, what writes it, what reads it, what destroys it, and what its
loss costs** — and, for each, whether it is *declared by the repository*, *learned by the
deployment*, or *both*.

**Why it is here rather than in a new document.** Step 5 is the rebuild path and this is
the list a rebuild has to reconstruct; Step 7.3's "could the copy be restored if the NAS
were powered off" test applies to every row below. Extending the document that already
owns the rebuild beat opening a second one that would have to be kept in step with it.

**Method.** Every row was established from code at `cdb5afd`, not from memory. The write
surface was enumerated first, and every store below is downstream of one of these sites:

```bash
# THE write surface. Every durable store in this system is written by one of these.
grep -rn "writeFileSync(\|appendFileSync(" --include=*.js . \
  | grep -v node_modules | grep -v '^./tests/'
# The path constants those sites resolve
grep -rnE "^(const|let) [A-Z_]*(FILE|PATH|DIR|STATE)[A-Z_]* *=" --include=*.js \
  lib/ memory/ bridge-agent.js auto-update.js bots/ | grep -v node_modules
# Tracked / ignored / neither, for any path
git check-ignore -v <path> ; git ls-files --error-unmatch <path>
```

## 8.0 The three categories, because they have three different failure modes

| Category | Survives `git reset --hard` + pull? | Survives `git clean -fd`? | Survives container recreation? | Survives box loss? |
|---|---|---|---|---|
| **Tracked** (in git) | yes — and it *overwrites* any on-box edit | yes | yes | yes |
| **Gitignored** (untracked, ignored) | yes | yes (`-fd` skips ignored; **`-fdx` does not**) | yes, if under `/bridge` | **no** |
| **Neither tracked nor ignored** | yes | **NO — deleted** | yes | **no** |
| **Container-local** (`$WORK_DIR`, default `/tmp/bridge-agent`) | n/a | n/a | **NO** | no |

The fourth row is the one that is easy to miss: `WORK_DIR` defaults to `/tmp/bridge-agent`,
which is neither bind mount (Step 0), so it is the container's own writable layer —
Consequence 2 above, applied to three more files than the scratch clone it was written about.
**Updated 2026-09-20:** drain-one (`fdf489d`) added a third container-local coordination file,
`$WORK_DIR/.update-pending` — row **26** below. The complete container-local set is now the
task lock (12), the task queue (11), the pending-update marker (26) and the scratch clones
themselves. All four are kept by `docker compose restart` and discarded by
`docker compose up -d --force-recreate`, which **every `.env` change requires**. The
operational consequence of that asymmetry — and the separate finding that a plain `restart`
`SIGKILL`s a running task without ever signalling it — is WORK-TODO **#73**.

## 8.1 The enumeration

Ordered by what the loss costs, worst first. **Cost is classified three ways** — *loudly
refused* (a human is told, and the system stops rather than guessing), *silently degraded*
(the system keeps running and produces different output with nobody told), *unnoticed*
(nothing observable changes until someone asks a question that needed it).

| # | Store | Path | Class | Declared / learned | Written by | Read by | Destroyed by | Cost of loss |
|---|---|---|---|---|---|---|---|---|
| 1 | Channel map | `agents/shared/channel-map.json` | gitignored | **learned** | `resolveAgentChannel` (`lib/agent-activation.js`), `ensureChannel` (`lib/slack-client.js`), `scripts/channel-map.js` | `applyWorkspaceState()` in `lib/agent-registry.js`, via `loadAgents()` — so transitively every consumer of an agent record | `git clean -fdx`, box loss, volume loss | **Loudly refused, then silently degraded.** Boot re-resolves and posts what it could not resolve to `#sqtools-ops` — but only *declared names that are real* resolve. Everything else stops being joined, polled and scheduled at once (`activeChannels()`), so an agent does not fail, it disappears |
| 2 | Activation decisions | `agents/shared/agent-activation.json` | gitignored | **learned** | `activateAgent`/`deactivateAgent`/`resetActivation` → `lib/bridge-state.js` | `applyWorkspaceState()` | `git clean -fdx`, box loss | **Silently degraded.** Every agent reverts to its definition's `default_status`. This file **wins over** the definition (`lib/agent-registry.js:106-112`), so losing it changes which agents run, and nothing reports the change |
| 3 | Approval queue | `agents/shared/approval-queue.json` | gitignored | **learned** | `lib/approval-queue.js` | same, and `ASK: pending approvals` | `git clean -fdx`, box loss | **Silently degraded.** Auto-generated security tasks awaiting owner approval vanish. Nothing re-derives them — the nightly review that produced them has moved on |
| 4 | Email filter rules | `agents/email-monitor/memory/rules.json` | **TRACKED** | **both, and that is the defect** | a human, on the box | `loadRules()` on **every** check (`lib/integrations/email-categorizer.js:89`) | `git reset --hard HEAD`, any `git checkout`/pull on the box | **Silently degraded, and this is the sharpest one.** Routing reverts to the committed file. The owner stops being shown a class of mail and is told nothing — the failure mode part 4 of the memory design exists to prevent |
| 5 | Activation checklists | `agents/activation-checklists.json` | **TRACKED, written at runtime** | **both** | `lib/owner-tasks-store.js` (`addTask` from an `ACTION REQUIRED:` line, `completeTask`) | `ASK: my tasks`, agent readiness | `git reset --hard HEAD`, any pull | **Silently degraded.** Completed items un-complete and auto-captured owner actions disappear. Same class as #4 and as WORK-TODO **#51** |
| 6 | Agent definitions' mutable fields | `agents/<id>/agent.md` (`default_status`, `schedule`, `llm_provider`) | **TRACKED** | **declared** | a human, on the box | `loadAgents()` | `git reset --hard HEAD` | **Silently degraded.** Already happened twice — `.gitignore`'s own comment records it: *"a tracked status field was destroyed twice by auto-update's `git reset --hard HEAD`"*. The surviving workaround is `LLM_PROVIDER_<AGENTID>` in `.env`, i.e. a second store for one field |
| 7 | Staff task state | `data/staff-tasks-state.json` | **NEITHER tracked NOR ignored** | **learned** | `lib/staff-tasks.js:143` | assignments, overdue checks, escalation, morning digest | **`git clean -fd` — no `-x` needed**; box loss | **Silently degraded**, plus a disclosure risk: it is not ignored, so `git add -A` on the box commits staff names and assignments into a repository that is going open source |
| 8 | Square catalog cache | `data/catalog-cache.json` (`CATALOG_CACHE_FILE`) | **NEITHER tracked NOR ignored** | **learned** | `lib/integrations/square-catalog.js` | storefront chat search | `git clean -fd`; box loss | **Unnoticed** — it re-fetches on a 1 h TTL. The disclosure risk is the same as #7: an accidental `git add -A` commits the product catalogue |
| 9 | Bulletin stream | `agents/shared/bulletin.json` | gitignored | **learned** | `postBulletin` — five call sites | **every active agent's prompt** (`formatBulletinsForContext`, newest 10), `ASK: bulletins`, `lib/critique-signals.js` (5, in-window) | `git clean -fdx`, box loss; swept at 7 days by `cleanupOldBulletins`, whose only production caller is `morning-digest.js:485` | **Silently degraded in the prompt path.** An empty stream and a quiet week render identically to an agent. The critique digest labels its own coverage; the per-agent prompt injection does not |
| 10 | Legacy task memory | `memory/tasks.json`, `memory/history.json`, `memory/context.json` | gitignored | **learned** | `memory/memory-manager.js` `addTask`/`completeTask`/`failTask` | `buildTaskContext()` → the **last 10** history entries into every task prompt | `git clean -fdx`, box loss | **Silently degraded.** This is the only memory the system actually writes (§8.2) and the only cross-task record it has. `history.json` is append-only and **never pruned** |
| 11 | Task queue | `$WORK_DIR/task-queue.json` (default `/tmp/bridge-agent`) | **container-local** | **learned** | `lib/task-queue.js` | `ASK: what's queued`, `recoverInterrupted()`, `lib/critique-signals.js` | **`docker compose up -d --force-recreate`**, host reboot, `/tmp` sweep; terminal rows self-expire at **24 h** | **Silently degraded.** `recoverInterrupted()` finds nothing to recover, so a task killed by the recreation is never marked interrupted — and WORK-TODO **#22** already records that an interrupted task reaches no human anyway |
| 12 | Task lock | `$WORK_DIR/.task-running` | **container-local** | **learned** | `lib/task-lock.js` | `lib/task-lock.js`, `evaluateTaskDeferral` (no live caller) | same as #11 | **Unnoticed, and benign.** bridge-agent clears any lock at startup, so losing it is what startup would have done |
| 13 | Poll cursors | `.bridge-agent-state.json` | gitignored | **learned** | `lib/bridge-state.js` | `poll()` | `git clean -fdx`, box loss | **Unnoticed on its own.** The poll re-reads the newest 5 per channel; dedup (#14) is what stops re-execution. Losing **both** re-runs up to 5 messages per channel — WORK-TODO **#23** |
| 14 | Processed-task dedup | `agents/shared/processed-tasks.json` | gitignored | **learned** | `lib/bridge-state.js` `markTaskProcessed` | `isTaskProcessed` before every `TASK:`/`ASK:` | `git clean -fdx`, box loss; entries self-expire at **7 days** (`cleanupProcessedTasks`, `lib/bridge-state.js:136`) | See #13 |
| 15 | Inbox check window | `agents/email-monitor/memory/check-state.json` | gitignored | **learned** | `lib/email-check.js` on a successful check only | `resolveWindow()` | `git clean -fdx`, box loss | **Silently degraded into noise.** The window falls back to `EMAIL_CHECK_MAX_LOOKBACK_MS` (24 h), so up to a day of mail is re-reported as new |
| 16 | LLM verdict counter | `agents/shared/llm-metrics.json` | gitignored | **learned** | `recordVerdict` on every LLM call | `getStats()` | `git clean -fdx`, box loss; 30-day retention (`LLM_METRICS_RETENTION_DAYS`) | **Unnoticed.** The one store whose entire job is answering a question nobody asks daily; its loss is invisible until someone asks "how often did we fall back?" |
| 17 | Watercooler state | `agents/shared/watercooler-state.json` | gitignored | **learned** | `lib/watercooler.js` | last-standup timestamp | `git clean -fdx`, box loss | **Unnoticed** |
| 18 | Delivery quotes | `data/delivery-quotes.json` (`DELIVERY_QUOTES_FILE`) | gitignored | **learned** | `bots/storefront.js:249` | `GET` path in the same file | `git clean -fdx`, box loss | **Silently degraded — and it is the only store holding customer PII.** Business name, contact name, phone, email, pickup and delivery addresses (`bots/storefront.js:333-373`). Unbounded, no retention rule, no backup path, and it is the one row on this page where loss is not the worst outcome |
| 19 | Per-agent tiered memory | `agents/<id>/memory/{working,short-term,long-term,archive}.json` | gitignored by an inverse rule | **learned** | **nothing in production except `clearAgentWorkingMemory` and `startupCleanup`** — see §8.2 | `getRelevantMemory` (no production caller) | anything | **Nothing.** They are empty by construction today |
| 20 | Seeded agent memory | `agents/<id>/memory/{context,backlog,rules}.json` | **TRACKED** (re-included by name in `.gitignore`) | **declared** | committed | as above | — | — |
| 21 | auto-update state | `.auto-update-state.json` | gitignored | **learned** | `auto-update.js:458` | `auto-update.js` | anything | **Nothing.** Nothing starts the daemon (WORK-TODO **#17**) |
| 22 | The environment file | `/bridge/.env` | off-repo, owner-managed | **learned** | a human | `lib/config.js` and 55 other read sites | a firmware event, box loss, a mistaken edit | **Loudly refused** for the three required keys (`validateConfig` exits); **silently degraded** for everything else, including every `LLM_PROVIDER_<AGENTID>` override |
| 23 | The deploy key | `/bridge/.deploy_key` (`DEPLOY_KEY_PATH`) | off-repo | **learned** | a human | `lib/clone-lifecycle.js` | box loss | **Loudly refused** — pushes fail |
| 24 | The deployment definition | `/bridge/docker-compose.yml` | off-repo, untracked on the box | **both** | a human | `docker compose` | `git clean -fd` **on the box** (the repo-side `.gitignore` line reaches the box only when someone pulls there) | **Loudly refused** — and the off-box copy is `docker-compose.example.yml` (Step 7.9) |
| 26 | Pending-update marker | `$WORK_DIR/.update-pending` | **container-local** | **learned** | `lib/update-drain.js` `markPending`, via `auto-update.js` (no live caller — **#17**) | `drainStateForDispatch()` in `bridge-agent.js:459` on **every** `TASK:` — the live half | same as #11 | **Unnoticed, and benign in isolation.** Losing it stops dispatches being refused, which is the pre-drain-one behaviour; a live updater re-marks on its next cycle and `checkForUpdates()` clears it explicitly when the head already matches (`auto-update.js:587`). What is *not* benign is that the same event takes row 11 with it |
| 25 | The Slack workspace | not a file | external | **learned** | Slack | everything | an owner action, an app reinstall | **Loudly refused** at boot for a name that stops resolving; **unnoticed** for a channel nobody declared (WORK-TODO **#52**) |

### Two rows that are new findings, not restatements

**Rows 7 and 8 — `data/` is neither tracked nor gitignored.** `.gitignore` names
`data/delivery-quotes.json` specifically, so the other two files the code writes into that
directory are covered by nothing. Regenerate:

```bash
for f in data/staff-tasks-state.json data/catalog-cache.json data/delivery-quotes.json; do
  printf '%-34s ' "$f"
  git check-ignore -q "$f" && echo IGNORED || echo NOT-IGNORED
done
# -> data/staff-tasks-state.json      NOT-IGNORED
# -> data/catalog-cache.json          NOT-IGNORED
# -> data/delivery-quotes.json        IGNORED
```

This is WORK-TODO **#26**'s class — a file the deployment needs sitting where the ordinary
tidying command deletes it — reopened for two more files, with a second consequence #26
did not have: an unignored runtime file can be **committed** as easily as deleted, and one
of these two carries staff names into a repository that is going open source.

**Row 4 and row 5 — two tracked files are written at runtime.** `git reset --hard HEAD` is
the documented first step of the self-update cycle, and a human pulling on the box does the
same thing. Both files hold decisions a person made on the box. The repository already has
the right pattern for this and applies it to exactly one file class: activation decisions
were moved to a gitignored file *because* the tracked equivalent was destroyed twice. Rules
and checklists were not moved with them.

## 8.2 The tiered memory system is implemented and unwired

This is the largest gap between what the documentation describes and what the process does,
and it is the reason the memory design is a redesign rather than a configuration change.

```bash
# The tier write API — who calls it in production?
grep -rn "addAgentShortTerm\|promoteAgentMemory\|setAgentPermanent\|addShortTerm\|addPermanent" \
  --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> only lib/memory-tiers.js (the definitions) and memory/memory-manager.js (the pass-through)

# What bridge-agent actually calls
grep -on "memory\.[a-zA-Z]*(" bridge-agent.js | sort -u -t: -k2
# -> memory.addTask, memory.buildTaskContext, memory.clearAgentWorkingMemory,
#    memory.completeTask, memory.failTask, memory.loadMemory, memory.migrateAgentMemory,
#    memory.startupMemoryCleanup
```

`lib/memory-tiers.js` implements TTL expiry (`:118`), decay to archive (`:131`),
auto-promotion at three re-adds (`AUTO_PROMOTE_THRESHOLD`, `:13`) and startup cleanup.
**Nothing in production adds a short-term, long-term or permanent entry.** The promotion
threshold can therefore never be reached, the decay sweep has nothing to decay, and the
archive is written by nothing. `docs/AGENTS.md` → "Memory Tiers" describes all of it in the
present tense.

What runs instead is the **legacy, pre-tier** path: `memory/tasks.json` and
`memory/history.json`, which are **global rather than per-agent** (`memory/memory-manager.js:11-13`
resolves them next to the module, with no agent id in the path) and reach a prompt as the
**last 10** history entries (`:141`). So the memory an agent actually has is: the ten most
recent task outcomes of *any* agent, plus whatever is in the tracked seed `context.json`.

That is not a defect to fix in passing — it is the finding the memory model in
`docs/STATE-AND-MEMORY-DESIGN.md` is built on.

## 8.3 The two retention findings, confirmed

Both were supplied as leads and both are real. The figures differ from the leads and the
difference matters.

**Finding one — the commentary agent reports on seven days from a queue that holds one.**

```bash
grep -n "DEFAULT_WINDOW_DAYS" lib/critique-signals.js      # :21  -> 7
grep -n "COMPLETED_RETENTION_MS" lib/task-queue.js         # :53  -> 24 * 60 * 60 * 1000
```

`buildDigest()` opens a 7-day window; `cleanup()` removes terminal queue rows after 24
hours and runs at every bridge startup. Signal 3 therefore covers at most the last day of a
seven-day claim, and less on a restart-heavy week.

**It is not a silent loss, and that is the part worth recording.** `lib/critique-digest.js:194`
prints the retention beside the counts — *"the queue retains 24 hours, so this covers AT
MOST the last day of a 7-day window"* — so a thin task section reads as a coverage limit
rather than as "nothing failed". The defect is that the reader sees less than it should,
not that it lies about seeing it. A durable task record (part 3 of the design) is what
closes it; widening `COMPLETED_RETENTION_MS` would only move the point at which a
container recreation (row 11) empties the file anyway.

**Finding two — and from ten bulletins.** Confirmed with a correction to the number:

```bash
grep -n "function formatBulletinsForContext" lib/bulletin-board.js   # :397  limit = 10
grep -n "LIMITS = " lib/critique-signals.js                          # :37   bulletins: 5
grep -n "DEFAULT_CLEANUP_DAYS" lib/bulletin-board.js                 # :31   7
```

Ten is the cap on the stream injected into **every agent's prompt**. The critique's own cap
is **five**, in-window. Both sit on top of a 7-day retention swept by a single caller
(`morning-digest.js:485`), so a week in which the digest ran before the critique loses the
far end of the window regardless of either cap. Seven days of retention against a weekly
schedule is exactly enough and no more — `docs/JESTER-DESIGN.md` §1.2 says so, and this
confirms it at HEAD.

## 8.3a Leads that did not survive contact with the code

Reported rather than quietly corrected, per §2 of the executor contract.

| Lead | Actual at `cdb5afd` |
|---|---|
| "a channel mapping … held entries for two agents out of seven" | **Refuted as stated.** The map was not short of entries; it held the **real** channel names. Seven of **eleven** declared `channel_name` values were a convention that named no channel in the workspace, so the lookups missed a key that had never existed (`docs/AGENTS.md` → "Declared channel name vs. the workspace's real one"). The map was correct and the declaration was fiction — the opposite diagnosis, and it is why the fix was correcting names rather than rebuilding the map |
| "recovery required a human reading terminal scrollback" | **Not verifiable from the repository, and the repository records a different recovery.** The ids were recovered from `agents/activation-checklists.json` — a *tracked* file pairing each "Create #X" task with its "Assign channel `<ID>`" task — and the reproduction path is now `node scripts/channel-map.js --from-git`. Whether scrollback was also read on the night is an off-repo fact this cannot confirm either way |
| "a deploy left five active agents unresolved and two scheduled agents silently stopped" | **Confirmed**, and it is the repository's own account (`docs/CONFIG-SURFACE-AND-REBUILD.md` Step 5 item 7) |
| "Task queue and processed-task records, retained roughly twenty-four hours" | **Half right.** Task queue: 24 h (`lib/task-queue.js:53`). Processed tasks: **7 days** (`lib/bridge-state.js:136`). They are different stores with different retentions and only the first is container-local |
| "a scheduled job's interval, edited live and destroyed twice by a hard reset" | **Confirmed as a class, corrected as to the field.** `.gitignore` records the destroyed field as the **status/activation** field, not a cron interval. Both live in the same tracked definition file, so the class is identical and the count of two is the repository's own |
| "Per-agent provider overrides, in an environment file because a tracked file did not survive" | **Confirmed.** `LLM_PROVIDER_<AGENTID>` wins over the definition (`lib/config.js:165`), and `docs/AGENTS.md` states the reason in those terms |

## 8.4 What this changes about the rebuild path

Step 5 lists seven things a fresh box needs. This enumeration adds the rule that governs
rows 1–3 and 7–18: **every one of them is learned, none of them is exported, and the only
one with a reproduction path is the channel map.** Restoring the bridge from Step 5 gives a
running process with no activation decisions, no approval queue, no bulletins, no task
history and no staff task state — and the process will not say so, because with one
exception (row 1's boot-time report) nothing in the system distinguishes an empty store
from a store that was never there.

That distinction — absent versus empty — is the property the design in
`docs/STATE-AND-MEMORY-DESIGN.md` is built to hold, and it is the same property
`lib/test-verdict.js`, `lib/critique-signals.js` and `fetchRecentEmails()` already hold in
their own domains. The pattern exists in this repository three times. It is the stores that
do not have it.

---

# Step 9 — The image's toolchain inventory (addendum, 2026-09-20)

## 9.0 Why the image's toolchain is a config fact at all

Until 2026-09-20 the image's contents were an implementation detail of Step 5 item 1:
"container host with Docker". They stopped being one when `lib/dependency-install.js`
landed (WORK-TODO #61). That module installs a **dispatched repo's own dependencies**
into its scratch clone using whatever binaries the `jt-agent` image happens to carry —
so the image's toolchain now decides which repositories in `REPOS` the bridge can verify
at all. That is a configuration surface, and it belongs in this inventory.

## 9.1 The stated list

| Ecosystem | Manifest that selects it | Installer run | Status |
|-----------|--------------------------|---------------|--------|
| node | `package.json` (`package-lock.json`/`npm-shrinkwrap.json` → `npm ci`, else `npm install`) | `npm` | **SUPPORTED** |
| python | `requirements.txt`, `pyproject.toml`, `setup.py` | `python3 -m pip` | **NOT SUPPORTED** — `pip` absent |
| *(none)* | no recognised manifest | nothing | nothing installed; task proceeds |

The same table, with the reasoning, is in `CLAUDE.md` → Scratch Clone Lifecycle →
"Supported toolchains". It is held against the code by `tests/toolchain-support.test.js`,
which reads `detectEcosystem`'s own source: an ecosystem or manifest added there without
a declared status here is a failing test, not a silently stale list.

## 9.2 The python row — operator-supplied, dated, off-box

```bash
# On the NAS, 2026-09-20. NOT regenerable from a checkout.
docker exec -i jt-agent sh -c 'python3 -m pip --version'
# -> /usr/bin/python3: No module named pip
```

So `python3` exists in `node:20` and `pip` does not. The consequence is bounded and
loud: `installDependencies` returns `INSTALLER_ABSENT`, a HARNESS failure that stops the
dispatch **before** the LLM writes anything. Nothing is silently skipped and no
unverifiable branch is produced. What it costs is that one of the three repositories in
the estate — `jtpets/dayz-discord-bot` (pytest, `setup.py`, no lockfile) — cannot be
dispatched to at all.

## 9.3 Where a package install would have to go, and why none of it is here

Three facts from `docker-compose.example.yml`, all regenerable from a checkout:

```bash
grep -n "image:\|user:\|command:\|build:" docker-compose.example.yml
git log --all --oneline --diff-filter=A --name-only | grep -i dockerfile   # prints nothing
```

1. **There is no image build step.** `image: node:20` is a stock upstream tag pulled
   as-is. There is no `build:` key, and no `Dockerfile` has ever existed in this
   repository (the second command prints nothing).
2. **The only thing that installs anything is the compose `command:`**, which runs at
   every container **start**, not at build time:
   `sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"`.
3. **That command runs as `user: "1000:100"` — not root.** `npm install -g` works there
   only because `NPM_CONFIG_PREFIX: /bridge/.npm-global` redirects npm's global prefix
   into the writable bind mount. `apt` has no equivalent, so `apt-get install
   python3-pip` cannot be appended to that line: it would fail on permissions at every
   container start, inside a `restart: unless-stopped` service.

**So adding python is an image change, not a config edit**, and this repository does not
define the image. Which shape it takes — a `Dockerfile` plus a `build:` key, a base image
that already carries both runtimes, or an unprivileged user-level pip bootstrap — is an
owner decision with different costs, enumerated in **WORK-TODO #68**. No shape is invented
here.

## 9.4 What this adds to the rebuild path

Step 5 item 1 gains a clause: the container host must provide an image whose toolchain
covers the repositories listed in `REPOS`. Today that is node only, and `REPOS` defaults
to two node repositories, so the rebuild path in Step 5 is complete **for the repositories
it currently names**. It would not be complete for an estate that includes a python repo,
and adding one to `REPOS` without changing the image buys a repository the bridge refuses.

**And the pin, which outlives whichever shape is chosen.** A toolchain baked into this
image is a version resolution that the target repo does not control.
`jtpets/dayz-discord-bot`'s working test setup is `pytest-asyncio` **0.21.2**, pinned in
prose only — its `setup.py` declares the dependency unpinned and 1.4.0 produces errors
(operator-supplied 2026-09-20; unverified and unverifiable from here — the bridge has no
access to that repository, WORK-TODO #57). An image resolving a different version would
install cleanly, run the suite and report a green that does not hold on the box. That is
the same class as a Postgres-major mismatch, and it is why the list above is a list of
**supported** toolchains rather than a list of installed binaries.

---

# Step 10 — What `/repo:ro` actually exposes, and a `WORK_DIR` correction (addendum, 2026-09-20)

**This is an addendum to a dated snapshot. Steps 0–9 and the Appendix above are
unchanged** — they record what was observed from inside the running container on
2026-09-14 and are not rewritten here. Two statements made in those steps are corrected
below, in place of editing them.

## 10.1 Correction to Step 0, consequence 3 — `:ro` is an integrity boundary, not a confidentiality one

Consequence 3 says of the SqTools mount: *"A task executor with a shell inside this
container cannot write to it. Not 'is asked not to': cannot. That mount flag is the reason
a bridge-side compromise, a prompt injection, or a plainly mistaken task cannot damage
SqTools."*

**Every clause of that is correct, and the section is incomplete in a way that has been
read as a stronger claim than it makes.** It enumerates the `/bridge` blast radius
file by file and enumerates nothing for `/repo`, so the mount reads as out of reach.
It is not:

| Direction | Verdict | Enforced by |
|---|---|---|
| Write `/repo` | **Cannot** | the `:ro` flag, in the kernel. **Never remove it.** |
| Read `/repo` | **Can, and nothing is in the way** | nothing |

`/repo` is `/share/CACHEDEV1_DATA/sqtools/app` — SqTools' **production working tree**, not
a checkout of its repository. This document already names, without having read them, what
such a tree carries: Step 6 lists "its own `.env`" among the SqTools things at `/repo` that
must not be touched, and Step 5 item 5 records that a deploy key sits beside a tree of this
kind. **Nothing under `/repo` was read to establish this correction, and nothing should be:
that the path is readable by the process is the finding.**

**The execution-location question, which decides whether this matters, answered from the
code** (repository-verified, regenerable from any checkout):

| Question | Answer | Site |
|---|---|---|
| Where does a dispatch's clone live? | `path.join(WORK_DIR, 'task-<ts>')` — a path **in this container** | `bridge-agent.js:646`, `lib/config.js:41` |
| Where does the agent CLI run? | an ordinary **child process** of the bridge, `--dangerously-skip-permissions`, `cwd` = the clone | `lib/llm-runner.js:385` (argv `:369-374`), from `bridge-agent.js:896-897` with `cwd` set at `:648` |
| Does a dispatch run code before any review or test? | **yes** — the clone's own `npm ci`, i.e. the branch's dependency install scripts | `bridge-agent.js:660` → `lib/dependency-install.js:161` |
| Is there a second container, or a route to one? | **no** | `grep -rn "docker\.sock\|dockerode" --include=*.js . \| grep -v node_modules` → nothing; `docs/COMMAND-SURFACE.md` §5 |

`cwd` is a working directory. It is not a root, not a namespace and not a permission. So a
dispatch against **any** repository of valid shape — `isValidRepo` admits any public one —
runs code in the same mount namespace as `/repo`, and the first such code runs before the
LLM's first turn.

**No code in this repository reads `/repo`** (`grep -rnE "['\"\`]/repo(/|['\"\`:])"
--include=*.js --include=*.json --include=*.yml . | grep -v node_modules` → only two test
files using `/repo` as a dummy `repoDir` string), which
`docs/CAPABILITY-AND-ISOLATION-DESIGN.md:306` and `docs/JESTER-DESIGN.md:174` already
record independently. **The mount therefore serves no feature this repository can name.**
Its origin is not establishable from here: every commit mentioning it is a documentation
pass observing it (`git log --oneline -S "sqtools/app"` → `9d951f3`, `04af5c3`, `bbf9a7d`,
`9017b24`, `fb51d5a`).

Filed with the shapes as **WORK-TODO #75**; `docs/EXECUTOR-CONTRACT.md` §7 and §7.1 row 1
now carry the executor-facing version. §7.7's line *"The `:ro` on `/repo` is the one
containment boundary this deployment has"* should be read with the table above: it is the
one containment boundary, and it contains writes.

## 10.2 Correction to Step 0 consequence 2 / §8.1 — `WORK_DIR` may be a bind mount on the live box

Consequence 2 and the §8.1 durability rows derive "`/tmp/bridge-agent` is container-local
storage" from the compose file **as captured 2026-09-14** (Appendix; reproduced at
`docker-compose.example.yml:75-80`), which declares two mounts and neither covers `/tmp`.

On **2026-09-20** the operator ran `docker inspect jt-agent` and reports `/tmp/bridge-agent`
as a **bind mount from `/share/CACHEDEV1_DATA/jt-agent/work`**. If that holds, the
"discarded on `--force-recreate`" verdict is wrong for the task lock, `task-queue.json`,
`.update-pending` and preserved scratch clones.

**This cannot be an `.env` override** — a `WORK_DIR=` value moves the path, it cannot make
`/tmp/bridge-agent` a bind mount; only a `volumes:` entry does. So **the live compose has
gained a third volume since the 2026-09-14 capture, and both the Appendix here and
`docker-compose.example.yml` are stale as rebuild artifacts**: a rebuild from either would
silently reinstate the container-layer behaviour. That is #26's class — the compose file
belongs to no repository, so it drifts and nothing notices.

**Neither source is assumed.** Settle it on the NAS and update the Appendix, the example
file, WORK-TODO **#73** and **#25** together:

```bash
grep -n "volumes:" -A 6 /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml
docker inspect -f '{{range .Mounts}}{{.Source}} -> {{.Destination}} (rw={{.RW}}){{"\n"}}{{end}}' jt-agent
grep -n "^WORK_DIR=" /share/CACHEDEV1_DATA/jt-agent/.env   # names only — never print the file
```

## 10.3 What this step changed, and what it did not

**Changed in this repository:** `docs/EXECUTOR-CONTRACT.md` §7 (two bullets) and §7.1 row 1;
`WORK-TODO.md` #73, #25, #27 corrected and **#75** filed; this addendum.

**Deliberately not changed:** `docker-compose.example.yml:77-79`, whose comment beside the
mount line carries the same incomplete claim (*"the one real containment boundary … a
bridge-side mistake or prompt injection cannot damage that system"* — accurate about damage,
read as a claim about reach), and the missing third `volumes:` entry. The dispatch that
produced this addendum forbade compose edits. Both are recorded as remainder on #75 and #73.

**Nothing was read under `/repo`, and no mount, container or deployment was altered.**
