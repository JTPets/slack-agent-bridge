# Work Backlog

Re-derived from the system as it actually runs, not from a comparison wishlist. The
original list was seeded from [tomeraitz/claude-slack-bridge](https://github.com/tomeraitz/claude-slack-bridge);
several of its assumptions (PM2, a Raspberry Pi host, HTTP-polling-is-fine) are no
longer true. See "What changed since the last revision" at the bottom for the full
classification of every item that used to be here.

**Ranking axis:** blast radius on the *live single-container deployment* first — can
the item brick the bridge, silently corrupt its state, or does it unblock the
hardening that prevents those — then leverage per unit of effort. This is a different
axis from the previous revision, which ranked on "value borrowed from the reference
repo." That is why Docker moved from P3 to done and Socket Mode stayed P1 for a new
reason. The top item was a syntax-only deploy gate (#1, closed 2026-09-13); as of
2026-09-14 it is #17 — there is no deploy path at all, so nothing merged reaches the
running process.

**Every figure below carries the command that regenerates it.** If a number has no
command, it was removed. A figure that can only be regenerated off-repo (on the NAS, or
from the live container) says so and names the command anyway; it is an unverified lead
from this checkout, not a repo fact.

**Item numbers are stable IDs, not ranks.** Order *within* a tier is the rank. Numbers are
append-only so that cross-references ("see item #3") keep pointing at the same item; a
re-ranked item moves position and keeps its number.

Priority tiers: **P1** = can brick or silently degrade the running bridge, or unblocks
something that can | **P2** = real gap, no risk to the live process | **P3** = nice to
have / uncertain ROI

---

## P1 — Protects or unblocks the live deployment

### 17. Nothing starts `auto-update.js` — merged code does not reach the running process
**Filed 2026-09-14.** *Originally filed on the unmerged branch
`claude/ecstatic-dijkstra-8joyou` (commit `b749d97`); carried here so the item and the
`#17` references across the docs resolve, with the standing instruction "if that branch
merges, this is the same item — reconcile, do not keep two."* **That branch merged and the
file did carry two, until 2026-09-14:** two `### 17.` headings, ~59 lines apart, describing
the same item at two different dates. The older copy has been deleted and its one unique
paragraph folded in above. Regenerate the check:
`grep -n "^### " WORK-TODO.md | awk -F'[.#]' '{print $4}' | sort | uniq -d` — and more
simply, `grep -c "^### 17\." WORK-TODO.md` must be `1`.

**Status 2026-09-14: documentation corrected, deploy path unchanged.** The false claims
are fixed (see below); the gap itself is open and is the owner's decision.

**Problem (repo-side, verified from this checkout):** no file in this repo starts
`auto-update.js`. Regenerate:
- `node -e "console.log(Object.keys(require('./package.json').scripts))"` → `[ 'test', 'test:smoke', 'validate' ]` — none of them runs it.
- `grep -rn "auto-update" --include=*.js --include=*.json . | grep -v node_modules | grep -v package-lock | grep -v '^./tests/'` → comments, doc prose, and `auto-update.js`'s own body only. Nothing spawns or forks it.
- The repo carries no compose file, Procfile, systemd unit or supervisor config.

**Problem (off-repo, owner-supplied — NOT verifiable from a checkout):** the live compose
runs `sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"`
(`docker-compose.yml:17` on the NAS). The compose file is deliberately untracked. A check
run from inside the container independently recorded "the compose service starts only
`node bridge-agent.js`" (`docs/CONFIG-SURFACE-AND-REBUILD.md`, Step 5). Regenerate **on
the NAS**: `grep -n "command\|entrypoint\|auto-update" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`
and `crontab -l` (a host cron is the last unchecked way it could be started).

**Impact, observed not theorised (owner, 2026-09-14):** three branches merged to `main`
and pushed while the container had been up 11 hours; it kept running the code it loaded at
start. A manual `docker compose restart` was what actually deployed them.

**Why this outranks everything else in P1** (carried from the duplicate copy of this
item, reconciled 2026-09-14): every other item in this file is fixed by merging a commit,
and merging a commit is exactly the step that is not connected to the running process.
This is the deploy path itself.

**It would not start cleanly today either (verified here).** `validateConfig()`
(`auto-update.js:803-823`) hard-fails when `LOCAL_REPO_DIR` does not exist, and the
default is the dead Pi path `/home/jtpets/jt-agent` (`auto-update.js:40`). Observed:
`node auto-update.js` with no `LOCAL_REPO_DIR` exits **1**. Under `restart:
unless-stopped` that is a restart loop — so `LOCAL_REPO_DIR` must be set *before*
anything starts this daemon. Whether the live `.env` sets it is unverified from here.

**A green suite for an unstarted daemon.** `tests/auto-update-restart.test.js`,
`tests/auto-update-defer.test.js` and `tests/update-verifier.test.js` pass (62 tests) by
injecting a dependency bag into `checkForUpdates()`. `main()` and `validateConfig()` are
neither exported nor exercised, so the startup path that fails above is untested. This is
the verification-integrity class, not a passing gate.

**Done 2026-09-14 — the documentation no longer claims this works.** Corrected in
`CLAUDE.md` (self-update section retitled "DESIGNED AND TESTED, NOT WIRED" with the
evidence; deploy-command block; task-queue coordination steps marked not-live; task-lock
deferral section), `README.md` (feature bullet, architecture diagram, Auto-Update
section), `docs/WIRING-AND-SEAMS.md` (entry-point table and the task-lock seam),
`docs/AGENTS.md` (**agent-facing** — the "Auto-Deploy … restarts PM2 process" step was
false in both halves), `agents/bridge/memory/context.json` (**agent-facing**),
`COMMANDMENTS.md` (commandment 11 named a non-existent auto-update process), and
`docs/CONFIG-SURFACE-AND-REBUILD.md` (Step 5 "undetermined" → resolved repo-side).
Regenerate the claim list:
```bash
grep -rniE "self-updat|self-deploy|deploys itself|restarts itself|updates itself|auto-update(r| daemon| detects)|deploy_policy|CHECK_INTERVAL_MS|polls its own git" \
     --include=*.md --include=*.json . | grep -v node_modules | grep -v package-lock
```

**Still open — the owner's decision, stated not decided.** The two shapes (start the
daemon / declare manual restart the deploy), a third (push-triggered restart), and their
costs are written up in `CLAUDE.md` → "Two open questions". **This repo cannot implement
any of them**: the compose file is untracked and off-repo, and belongs to no repository
today (`docs/CONFIG-SURFACE-AND-REBUILD.md`, Step 6).

**The independent requirement: nothing can answer "is the running process on `main`?"**
Not the repo, not the container, not Slack. "Merged" and "deployed" are unrelated facts
and nobody is told when they diverge — the 11-hour gap was found by a person noticing.
Whatever reports it must be the *running* process (a boot line to `#sqtools-ops`, an
`ASK: version`, a heartbeat field, a state file); anything computed from the working tree
at query time answers a different question and would have read "current" throughout that
gap. Land this **before** arming any self-restart, so the first real self-update is
observable.
**Effort:** Low for the commit-report; Low–Medium to wire the daemon (off-repo either way).
**Risk:** Wiring it is Medium — it arms a self-restarting daemon whose guards have never
run outside tests, and whose startup config is currently wrong.

---

### 25. The preserved scratch clone does not survive a container recreation — silent data loss inside the feature that prevents silent data loss
**Filed 2026-09-14,** from the deployment-topology capture. Full write-up with the
topology it depends on: [`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md)
→ Step 0, consequence 2.

**What the feature promises.** `detectUndeliveredWork(dir)` (`lib/clone-lifecycle.js:237-330`,
called from `bridge-agent.js:964-981`) refuses to delete a scratch clone that holds
uncommitted changes, or local commits `git ls-remote origin` does not show on the remote,
or whose delivery state cannot be read. It keeps the clone and posts its path to
`#sqtools-ops` so the work can be recovered and pushed by hand. It exists because three
tasks' work was destroyed by unconditional cleanup on 2026-09-13. `docs/EXECUTOR-CONTRACT.md`
§7 tells every executor it is there.

**What the deployment does to it.** Clones live under `WORK_DIR`, default
`/tmp/bridge-agent` (`lib/config.js:41`, used at `bridge-agent.js:503-508`). That path is
neither bind mount — the compose mounts only `…/jt-agent → /bridge` and
`…/sqtools/app → /repo:ro` — so it is in the container's own writable layer:

| Operation | Preserved clone survives? |
|---|---|
| `docker compose restart jt-agent` (the documented deploy step) | yes — same container, same layer |
| `docker compose up -d --force-recreate jt-agent` (**required for any `.env` change**) | **no** |
| `down`/`up`, an image change, a container prune, a daemon restart that recreates it | **no** |

Row 2 is the defect: `CLAUDE.md` and `docs/EXECUTOR-CONTRACT.md` both *instruct*
`--force-recreate` for an environment change, so the documented operational procedure
destroys preserved work, with no warning, days after the alert that named it.

**Second mechanism, live today regardless of restarts.** The alert posts a
container-internal path. `/tmp` is not mounted, so `/tmp/bridge-agent/task-…` does not
exist on the NAS host: an owner reading the alert cannot `cd` there. Recovery needs
`docker exec -it jt-agent sh` first, and the alert does not say so.

**Regenerate:**
```bash
# repo side — the default and its consumers
grep -rn "WORK_DIR" lib/config.js bridge-agent.js lib/task-lock.js lib/task-queue.js auto-update.js
grep -n "detectUndeliveredWork" -A 20 bridge-agent.js     # the alert text and the path it posts
# NAS side — the mounts, and whether .env overrides the default
grep -n "volumes" -A 3 /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml
grep -n "^WORK_DIR=" /share/CACHEDEV1_DATA/jt-agent/.env   # names only — never print the file
```

**Unverified:** whether the live `/bridge/.env` sets `WORK_DIR`. If it already points
somewhere under `/bridge`, the durability half of this item is closed and that grep's
output is the evidence. The path-in-the-alert half stands either way.

**Fix — two halves, only one of which this repo can land.**
1. *Off-repo (the real fix, and not ours):* put `WORK_DIR` on a mount. Either add a volume
   for it or set `WORK_DIR` to a path under `/bridge` in the live `.env`. Note the second
   also drops the preserved clone into the live git working tree, so it wants a gitignored
   subdirectory, not the repo root. Deployment change; the compose file belongs to no
   repository today (item #4b, Step 6).
2. *Repo side (available now):* say the true thing in the alert — that the clone lives in
   container-local storage, that it is lost on a container recreation, and the
   `docker exec` needed to reach it. A regression test on the alert text is the close.
   Do **not** "fix" this by making cleanup delete the clone anyway.

**Priority:** P1 — it is the silent-data-loss class, which is the top of this file's
ranking axis, and the loss is of work a human was told had been saved for them.
**Effort:** Low for half 2; Low for half 1 but it is the owner's to make.
**Risk:** Low — half 2 is message text plus a test.

---

### 1. ~~Make the deploy gate a real load check, not just a syntax check~~ — DONE 2026-09-13
**Was:** The bridge deploys itself by exiting; the container's `restart: unless-stopped`
policy re-runs `npm install && node bridge-agent.js` (`auto-update.js:8-13`). Guard (a)
was `node --check` only — a *syntax parse*. A commit that deletes a required file or adds
a dependency missing from `package.json` parses clean and still bricks the bridge. The
designated closer, `npm run test:smoke`, could not be wired in because jest never exited:
a module-scope `setInterval(cleanExpiredSessions, …)` at `bots/storefront.js:112` was
never `.unref()`'d, so `require`-ing storefront (which `tests/smoke.test.js` does) pinned
the event loop open.

**Fixed (both parts):**
- **1a — `.unref()`'d the storefront cleanup interval** (`bots/storefront.js:111`). The
  smoke suite now exits on its own; so does the full `npx jest` run (38 suites, 1445
  tests, ~16s, clean exit — the storefront handle was the only leak). The other three
  module-scope intervals (`bridge-agent.js`, `auto-update.js`, `lib/heartbeat.js`) were
  already behind entry-point/start guards.
- **1b — wired `runSmokeTest()` in as guard (a) part 3** (`lib/update-verifier.js`,
  `auto-update.js` after `npm install`, before the exit). Bounded by
  `SMOKE_TEST_TIMEOUT_MS` (120s, well under the 300s check interval); a timeout or a
  non-zero exit is scored as a FAILURE that reverts, never a hang of the update loop. The
  smoke suite is hermetic (no network/Slack/spawn — `require()` + export assertions only),
  so it is safe to gate on. Covered by `tests/auto-update-restart.test.js` (guard a part 3)
  and `tests/update-verifier.test.js` (`runSmokeTest`).

---

### ~~Scratch clone cleanup destroyed undelivered work~~ — DONE 2026-09-13 (later same day)
This defect class was not in the list when this file was first revised earlier on
2026-09-13; it landed the same afternoon and is recorded here for the trail. It was a
**silent data-loss** bug, the worst category by the ranking axis above (silently corrupt
state), so it would have opened as P1 had it survived to the next revision.

**Was:** `processTask`'s `finally` block deleted the scratch clone unconditionally. When
a push never landed — a READ-ONLY clone, or a failed push — the agent's commits lived
only in that clone and cleanup erased them. **Three tasks were lost this way.**

**Fixed (two parts):**
- **Pushable by construction** — `cloneRepo` now re-points `origin` at the SSH remote and
  sets `core.sshCommand` to the deploy key, then verifies with a `fetch`, so a clone is
  deliverable before any work starts (`bridge-agent.js:485-500`; LOGIC CHANGE 2026-09-13).
  Missing key → the clone is logged READ-ONLY rather than silently un-pushable. Task
  completed 2026-09-13 21:43.
- **Cleanup gates on delivery** — `detectUndeliveredWork(dir)` (`bridge-agent.js:528`)
  classifies the clone before `cleanupDir` (`bridge-agent.js:1132`): uncommitted changes
  or local commits absent from the remote → **kept**, with a `#sqtools-ops` alert carrying
  the path; delivered/clean clones → deleted as before. Delivery is checked with
  `git ls-remote origin`, not `git log --not --remotes`, because `--single-branch` clones
  never create an `origin/feature/*` tracking ref (`bridge-agent.js:518-527`). Commit
  `2a6bbcb`, task completed 2026-09-13 23:27. Regression tests:
  `tests/undelivered-work.test.js` (classifier + the finally-block gate).

Documented in `CLAUDE.md` → "Scratch Clone Lifecycle".

---

### 3. The scheduler never checks `planned` status — CONFIRMED FIRING LIVE 2026-09-14
**Problem:** `startScheduler` iterates `loadAgents()` (all agents) and registers a cron
job for any agent that has *both* a `schedule` and a `channel`
(`lib/agent-scheduler.js:168`, `:179`). It never consults `status: "planned"`.
`getActiveAgents()` (which *does* filter `status !== 'planned'`, `lib/agent-registry.js:79`)
is not used here — but it **is** used by `buildChannelsToPoll()` in `bridge-agent.js`, and
that split is the whole defect.

The CONTEXT said "four agents are planned and their schedules never register." Half right.
Regenerate the registry table:
```
node -e "const a=require('./agents/agents.json');(Array.isArray(a)?a:a.agents).forEach(g=>console.log([g.id,g.status||'active',g.channel||'null',g.schedule||'-'].join(' | ')))"
```
→ 11 agents; four planned (`storefront`, `social-media`, `marketing`, `story-bot`). Their
schedules mostly don't run for incidental reasons, not by design:
- `storefront` — no `schedule`, nothing to register.
- `social-media`, `marketing` — have a `schedule` but `channel: null`, so the
  `!agent.channel` guard skips them.
- **`story-bot` — `status: "planned"`, `schedule: "0 18 * * 5"`, task `draft-weekly-posts`,
  and a real `channel` (`C0AP8CHCV1U`).** Its template exists
  (`lib/agent-scheduler.js:56`). Its job registers and fires.

**Confirmed live 2026-09-14 (owner, against the running container) — and it is worse than
"the channel is unused":**
- Startup reports `Scheduled story-bot:draft-weekly-posts` with cron `0 18 * * 5`.
- Startup also reports `Joined 5/5 agent channels` — five, against eleven agents.
- On task completion: `[bulletin-watcher] Failed to notify story-bot: An API error occurred: not_in_channel`.

**The mechanism, verified in this checkout.** The two paths disagree by construction:

| Path | Source | story-bot? |
|------|--------|-----------|
| `startScheduler` (`lib/agent-scheduler.js:168`) | `loadAgents()` — **all** agents | **scheduled** |
| `buildChannelsToPoll` (`bridge-agent.js`) | `getActiveAgents()` — excludes `planned` | **not joined** |

So the scheduler arms a weekly job to post into a channel the join path deliberately
excluded. Every Friday at 18:00 story-bot runs, produces drafts, and posts them nowhere.
The failure is one log line in a container nobody tails: the job succeeding and the job's
output reaching a human are different events, and only the first is observed.

**The mirror-image instance, same root cause: `jester`.** `status: active`,
`schedule: "0 18 * * 5"`, `channel: null`. The `!agent.channel` guard skips it, so an
*active* agent's weekly schedule silently never arms — no error, no log, no channel. Both
directions of the same missing invariant: **nothing asserts that the scheduled set and the
joined set are the same set.**

**Blocks the channel-consolidation work.** The routing table cannot be written until the
current mapping is enumerated, and the mapping is currently split between
`agents/agents.json` and environment variables with no file describing either — the live
`.env` carries six `*_CHANNEL_ID` keys that no code in this repo reads (see item 4b and
`docs/CONFIG-SURFACE-AND-REBUILD.md`).

**Fix (three parts, all small):**
1. Gate scheduling on active status — call `getActiveAgents()` in `startScheduler`, or add
   `if (agent.status === 'planned') continue;` alongside the existing skips.
2. **Make the disagreement loud, not silent.** At startup, log (and post to
   `#sqtools-ops`) any agent that is scheduled-but-unjoined or has a schedule it cannot
   run for lack of a channel. `jester` would have surfaced years of silence this way.
3. Regression tests in `tests/agent-scheduler.test.js` (it already mocks `node-cron`):
   a planned agent with schedule+channel registers **zero** jobs; an active agent with a
   schedule and `channel: null` is **reported**, not silently skipped. The second test is
   the anti-drift enumerator for this class — it fails when the two sets diverge again.
**Effort:** Low.
**Risk:** Low — part 1 narrows what registers and cannot start anything new; parts 2-3 are
reporting and tests.

---

### 2. Per-agent LLM provider lives only in tracked `agents.json`; on-box edits are silently discarded
**Problem:** An agent's provider comes from `agentConfig.llm_provider`, read straight
from `agents/agents.json` (`bridge-agent.js:713`, `bridge-agent.js:746`). `lib/config.js`
has no provider override at all (`grep -in provider lib/config.js` → nothing). The global
`LLM_PROVIDER` env var only sets a *default* inside `runLLM`/`runWithFallback`; there is
no env path to change *one agent's* provider without editing the tracked file.

The CONTEXT for this task said changing a provider "conflicts on pull." That is not what
happens — I could not reproduce a conflict and the code says otherwise. `auto-update.js:479`
runs `git reset --hard HEAD` *before* every pull, so an uncommitted edit to `agents.json`
made on the box is **silently thrown away** the next time any commit lands on `main` — no
conflict, no message, the change just vanishes. This is worse than a conflict, not
better, because it is invisible. Evidence it is live right now:
`git -C <deploy> status --short agents/agents.json` on the running checkout shows
` M agents/agents.json` today — an uncommitted edit sitting one commit away from deletion.

**Fix:** add a provider override with explicit precedence, e.g.
`LLM_PROVIDER_<AGENTID>` env > `agentConfig.llm_provider` > global `LLM_PROVIDER` >
`claude`. Resolve it where `llmProvider` is read (`bridge-agent.js:713` and the
`processConversation` sibling near `bridge-agent.js:1536`). Document the new var in
`CLAUDE.md` per the env-var rule. This is the same class of problem as item under
"reconcile" for `context.json` — a tracked file doubling as runtime-mutable state.
**Effort:** Low.
**Risk:** Low — additive; unset env preserves today's behaviour exactly.

---

### 4. Replace HTTP polling with Slack Socket Mode (event triggers)
**Source:** tomeraitz/claude-slack-bridge
**Problem:** The bridge still polls: `setInterval(poll, POLL_INTERVAL)` at
`bridge-agent.js:1985`, default `POLL_INTERVAL_MS=30000`. No `@slack/socket-mode`
dependency exists (`grep -c socket-mode package.json` → 0). Up to 30s latency, steady
API pressure, and — the reason this is *more* valuable than when it was first listed —
the poll loop's per-message skip path was the surface where messages were silently
dropped (now mitigated by `describeSkipReason`, `bridge-agent.js:1589`/`:1767`, but the
polling model is still the thing generating skip decisions on every tick).
[Owner direction — stated in the 2026-09-12/13 context, not verifiable from the repo — is
event triggers over polling.]
**Fix:** swap the poll loop for a `SocketModeClient` (`@slack/socket-mode`). One
persistent WebSocket, near-instant delivery, no per-tick skip sweep. Requires a
`SLACK_APP_TOKEN` (`xapp-`) and Socket Mode enabled in the app config.
**Effort:** Medium. Replaces the message-detection half of the poll loop; the
per-message processing path (`processTask`/`processConversation`) is unchanged.
**Risk:** Medium — changes how every message arrives. Keep the dedup
(`processed-tasks.json`) and channel-join startup logic intact; they are not
polling-specific.

---

## P2 — Real gaps, no risk to the running process

### 4b. Config surface is undocumented and cross-stack infra is unowned — INVENTORY FILED 2026-09-14
**Source:** Pi→NAS migration; config-surface inventory task.
**Evidence:** [`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) —
full env-var inventory (56 code-read keys + 1 dynamic pattern vs 33 in `.env.example` vs
31 in the live `/bridge/.env`), classification, defaults comparison, a rebuild draft, and
the list of what remains unreachable. Regenerate the figure with the grep in Step 2.
**Findings needing a decision (John):**
- **25 keys the code reads that `.env.example` never documents** (List A), several of
  them credentials. A rebuilder working from the example alone misses them. → update
  `.env.example`.
- **`MAX_TURNS` names two different quantities** — a *default* (50, `config.js:34` /
  `llm-runner.js:172`) and a *ceiling* (100, `task-parser.js:56`). Confirmed. Not a value
  conflict, but a name footgun → rename the parser constant to `TURNS_CEILING`.
  **Superseded 2026-09-14 by item #20:** it is four quantities, not two, and the
  `MAX_TURNS` env var turns out to be unreachable on every non-test path. Act on #20.
- **Live `/bridge/.env` carries 7 keys no bridge code reads** (`PM2_PROCESS_NAME` +
  six `*_CHANNEL_ID`), documented by no repo file. `PM2_PROCESS_NAME` contradicts the
  code's "PM2 is gone" invariant.
- **CLAUDE.md is stale:** the live compose already runs `npm ci` (the doc's "ACTION
  REQUIRED" is done); `auto-update.js` is not started by the `jt-agent` service (self-update
  wiring undetermined); compose `TZ` is `America/New_York`, docs say `America/Toronto`.
  **Escalated 2026-09-14 to P1 #17:** the self-update wiring is no longer "undetermined" —
  nothing starts it, and merged code demonstrably did not reach the running process.
- **Cross-stack infra (3 compose files, host crontab, Tailscale, 3 deploy keys) is owned
  by no app repo.** Proposal: a dedicated infra repo owns the runbook; an encrypted
  off-box secrets store (`sops`/`age` or a hosted manager) holds credentials. **Decisions
  deferred to John — not executed by this task.**
**Effort:** Low for the doc fixes; Medium for standing up the infra repo + secrets store.
**Risk:** None to the running process (documentation + read-only inventory only).

### 22. An interrupted task reaches no human
**Filed 2026-09-14, from the #18 fix.** Now that `recoverInterrupted()` can actually
fire, the thing it records goes nowhere a person will see. It writes `interrupted` into
`task-queue.json` and logs one stdout line
(`bridge-agent.js`: `Recovered N interrupted task(s) from queue`); nothing posts to
Slack. Every *other* lifecycle event on this path does post to `#sqtools-ops` — a stale
lock release, a deferred update, a task failure, an undelivered scratch clone. This one
does not, so the observable is "the task just never answered".

It is visible only via `ASK: what's queued` (`formatStatusResponse` → `getRecentCompleted`),
which a human has to think to run, and only inside the 24-hour `COMPLETED_RETENTION_MS`
window before `cleanup()` removes the row.

Regenerate: `grep -n "recoverInterrupted" bridge-agent.js` → one call site at startup,
its result logged and never posted. Compare with the lock's own release path a few lines
below, which builds a verdict string and posts it.

**Fix:** post a `#sqtools-ops` line when `recoverInterrupted()` returns non-zero, naming
the task description and its source message link (both are already on the queue row).
Deliberately *not* done in the #18 change, which was scoped to making the state machine
real; reporting it is a separate decision about noise.
**Priority:** P2 | **Effort:** Low.

---

### 23. A task killed mid-run is re-read and re-run on the next poll
**Filed 2026-09-14, from the #18 fix.** Both message-dedup guards are written only
*after* a task completes, so neither survives a kill:
- `markTaskProcessed(msg.ts)` (`bridge-agent.js`, poll loop) runs **after**
  `await currentTaskPromise`.
- the `done`/`failed` reaction `alreadyProcessed()` looks for is added by
  `heartbeat.stop()`, which runs in `processTask`'s `finally` — and a `finally` does not
  run when the process is killed. The reactions present *during* a task are
  `eyes`/`hourglass_flowing_sand`/`gear`, none of which `alreadyProcessed()` matches
  (`lib/task-parser.js:435-440`, `lib/heartbeat.js`).

So a task that kills the bridge is re-read from the channel on the next poll and run
again — on the same input, with the same result. `restart: unless-stopped` makes that a
loop. The queue is **not** the loop's source: `recoverInterrupted()` writes a *terminal*
`interrupted` state, never back to `pending`, and `enqueue()` dedups by `msgTs` so no
second row is created.

Regenerate: `grep -n "markTaskProcessed\|alreadyProcessed" bridge-agent.js` and
`grep -n "EMOJI_DONE\|EMOJI_FAILED" lib/task-parser.js lib/heartbeat.js`.

**Partially mitigated by #18's fix, not closed by it:** `_startRunning()` in
`lib/task-queue.js` now bumps `attempts` and preserves `previousStatus`/`previousError`
on a re-attempt, so the interruption verdict survives the re-run and the repetition is at
least *recorded*. Nothing acts on that count.

**Fix:** mark the message processed (or add the reaction) *before* the LLM is invoked
rather than after, or refuse a task whose queue row shows `attempts` over a threshold.
The first is the smaller change and closes the loop; the second is the safety net.
**Priority:** P2 | **Effort:** Low-Medium.

---

### 26. `docker-compose.yml` is untracked **and** unignored in the live working tree — `git clean -fd` deletes the deployment definition
**Filed 2026-09-14,** from the deployment-topology capture
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 0,
consequence 1).

**Problem.** `/bridge` is a bind mount of the NAS deploy directory and that directory *is*
the git checkout the bridge runs, so `docker-compose.yml` sits inside a git working tree.
It is not tracked and — unlike `.env`, `.deploy_key*` and the state files — it is not in
`.gitignore` either. Verified from this checkout:
```bash
git ls-files | grep -i compose          # -> nothing (untracked)
git check-ignore -v docker-compose.yml  # -> no match, exit 1 (not ignored)
```
So `git status` in the deploy directory reports it as untracked clutter every time, and
`git clean -fd` — the ordinary command for clearing untracked clutter — deletes the only
copy on the box of the file that defines the deployment. `git reset --hard HEAD`, which
`auto-update.js:170`/`:191` runs, does *not* touch untracked files, and nothing in this
repo runs `git clean` (`grep -rn "git clean" --include=*.js . | grep -v node_modules` →
nothing). The exposure is a human at a prompt, not an automated path.

**Recoverability today, and where it is written down.** The file is reproduced verbatim in
the Appendix of `docs/CONFIG-SURFACE-AND-REBUILD.md`, and its fields are restated as step 3
of that document's Step 5 rebuild path. That copy is in this repository, on GitHub — the
only copy not on the NAS. Losing the file is therefore recoverable, which is why this is
P2 and not P1.

**Fix.** Add `docker-compose.yml` to `.gitignore`. `git clean -fd` skips ignored files
without `-x`, so one line moves it out of reach, and it stops appearing as untracked noise
in `git status` on the box. Not taken unilaterally in the topology commit: it is a
one-line repository change whose only purpose is a deployment-side consequence, so it is
the owner's call. The stronger version — commit a `docker-compose.example.yml` with host
paths as placeholders, as Step 5 item 3 already proposes — makes the rebuild path a file
rather than a prose appendix; both are cheap and they are not exclusive.

**Priority:** P2 | **Effort:** Low (one line) | **Risk:** None to the running process.

---

### 27. A task has write access to the entire live deployment, including every credential — recorded, undecided
**Filed 2026-09-14,** from the deployment-topology capture
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 0,
consequence 3, which carries the full list).

**Not a new exposure and not a regression** — this has been true since the container was
built. It is filed because it was the blast radius of every task this system runs and it
was written down nowhere, so no one was weighing it when deciding what a task may do.

**The asymmetry.** `/repo` (SqTools — PRODUCTION, money and customer PII) is mounted
read-only. That is a real containment boundary and the reason a bridge-side compromise,
a prompt injection, or a plainly wrong task cannot damage that system. **It must never be
made read-write.** `/bridge` has no equivalent: it is read-write, tasks run through the
Claude Code CLI with `--dangerously-skip-permissions` (a shell) as the mount's owner
(`uid 1000:100`), so a task can write `/bridge/.env` (the Slack token, the Gemini key, the
Google OAuth trio and refresh token, the Square access token, the httpSMS key),
`/bridge/.deploy_key`, `/bridge/docker-compose.yml` (including the `:ro` flag on `/repo`),
`/bridge/agents/agents.json`, `/bridge/CLAUDE.md`, `/bridge/COMMANDMENTS.md`,
`/bridge/.git` and `/bridge/.claude-home/` (the CLI's live OAuth credential).

**What exists today is an authorisation boundary and a convention, not containment:**
`ALLOWED_USER_IDS` on who may submit a task, the approval queue for anything
auto-generated, the turn cap and `TASK_TIMEOUT_MS`, branch protection on `main`, and the
executor-contract rule that work happens in a scratch clone. The first group decides *who*
may start a task; none of it constrains what a started task can reach.

**Stated where both audiences look (done 2026-09-14):** `docs/EXECUTOR-CONTRACT.md` §7
now says plainly that an executor is not sandboxed out of `/bridge`, only asked to stay
out, and lists what is writable; Step 0 consequence 3 carries the reviewer-facing version
and the reason the approval queue is load-bearing rather than procedural.

**Open — the owner's decision, not this file's.** Narrowing it is a deployment change and
the compose file belongs to no repository today (item #4b, Step 6). The shapes, unranked:
run tasks as a second uid that does not own the deploy directory; mount `/bridge`
read-only with a writable sub-path for state and `WORK_DIR` (interacts with item #25);
run tasks in a child container. Each costs something and one of them may be the right
answer; **accepting the risk explicitly is also a valid outcome** and is better than the
current state, which is that it was never considered.

**Regenerate** (on the NAS — not reachable from a checkout):
```bash
grep -n "volumes\|user\|working_dir" -A 3 /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml
docker exec -u 1000:100 jt-agent sh -c 'ls -la /bridge/.env /bridge/.deploy_key; touch /repo/.wtest 2>&1'
```
The second confirms both halves at once: readable/writable on the left, permission denied
on the right.

**Priority:** P2 | **Effort:** Low to accept and record; Medium to narrow.
**Risk:** Changing it is Medium — every narrowing shape can break task execution or the
push path; none of it should be attempted without a way to verify the bridge still runs.

---

### 19. `tests/approval-queue.test.js` flakes under parallel workers — a green suite that can lie
**Filed 2026-09-14.** Owner-observed at roughly 1 run in 6. **Reproduced in this checkout,
and the rate is scheduling-dependent, not fixed** — which is the part that makes it
dangerous. Regenerate:
```
npx jest                       # 46 suites, 1758 tests — passed
for i in $(seq 8); do npx jest tests/approval-queue.test.js \
  tests/security-followup.test.js tests/integration.test.js; done
```
→ the full run passed; the three-suite run **failed 6 of 8 times**, with a *different*
number of failing assertions each time (5, 7, 8, 4, 7, 11, then two clean runs). Every
failure was in `approval-queue.test.js` (`getPendingTasks`, `getTaskById`, `approveTask`,
`rejectTask`, `rejectAllTasks`, `formatPendingTasks`, `formatTaskDetails`) — a varying
failure set from an unchanged tree is the signature of a shared-file race, not a bad
assertion.

**The full suite passing is not evidence against this.** Whether the colliding suites land
on the same worker at the same moment is a scheduling accident; `npm test` going green
says nothing about whether it raced. A gate that is green by luck is the
verification-integrity class.

**Root cause, verified:** `lib/approval-queue.js:21` binds `QUEUE_FILE` as a module-level
`const` pointing at the **real repo file**, `agents/shared/approval-queue.json`. There is
no override path — no `init()`, no constructor argument, no env var. Every consumer in the
process writes that one path (`:90` `fs.writeFileSync(QUEUE_FILE, …)`).

`tests/approval-queue.test.js` does not isolate: its `beforeEach`/`afterEach` call
`approvalQueue.clearQueue()`, which truncates that same live file. Three suites reach the
module and therefore the file:
```
grep -rln "approval-queue\|approvalQueue\|security-followup" tests/
```
→ `tests/approval-queue.test.js`, `tests/integration.test.js`, `tests/security-followup.test.js`.
`package.json` sets no `jest` config and there is no `jest.config.js`, so jest runs at its
default worker count — those three suites race a single shared file. `lib/security-followup.js`
and `bridge-agent.js` both write it in production too, so the collision is not test-only in
principle, just test-only in practice today.

**Why this is P2 and not noise.** Three merges on 2026-09-14 were gated on runs of this
suite. A gate that fails ~1 in 6 for reasons unrelated to the diff trains the reader to
re-run rather than read, and the next real failure gets re-run too. This is
verification-integrity, not tidying.

**Fix:** an `init({ queueFile })` path override of exactly the shape
`lib/bridge-state.js:60-65` already uses (`if (options.stateFile) STATE_FILE = options.stateFile;`)
— same repo, same problem, already solved once. Point each suite at its own `os.tmpdir()`
directory in `beforeEach`. Do **not** fix this by serialising jest (`--runInBand`); that
hides the shared-mutable-path defect rather than closing it, and the production writers
still share it.
**Effort:** Low.
**Risk:** Low — additive; unset option preserves today's path exactly.

**Fixed 2026-09-14 (branch `fix/approval-queue-path-override-19`):** `lib/approval-queue.js`
now takes an `init({ queueFile })` override of the same shape `lib/bridge-state.js` uses —
`QUEUE_FILE` became a `let` defaulting to `DEFAULT_QUEUE_FILE`, and `init` is a no-op for
the two production callers (`bridge-agent.js`, `lib/security-followup.js`), which never
call it. `tests/approval-queue.test.js` and `tests/security-followup.test.js` now
`init({ queueFile })` a per-suite `os.tmpdir()` file in `beforeEach`. Reproduced the flake
first (`for i in $(seq 8); do npx jest tests/approval-queue.test.js
tests/security-followup.test.js tests/integration.test.js; done` → 8/8 failed, counts
13/5/4/7/6/5/6/8), then re-ran the same command 10× after the fix → 10/10 clean (148
tests each). Full suite green: 47 suites, 1776 tests. Regression: `init (path override)`
in `tests/approval-queue.test.js` asserts a write lands on the override file and not on
`DEFAULT_QUEUE_FILE`. See item #24 for the sibling class this surfaced.

### 24. Four sibling modules resolve a shared writable path at module scope with no override — the same class as #19
**Filed 2026-09-14, from the #19 fix.** The #19 dispatch asked whether the
module-scope-const-writable-path shape is a class rather than one defect. It is.
Regenerate the candidate list:
```
grep -rn "path.join(__dirname, '\.\.'" --include=*.js lib/ memory/ bots/ | grep -iv test
```
Splitting those by whether the path is **writable state** and whether an **override path
exists**:

| Module | Module-scope path | Writable? | Override path? |
|--------|-------------------|-----------|----------------|
| `lib/approval-queue.js` | `approval-queue.json` | yes | **now `init({queueFile})`** (#19) |
| `lib/bridge-state.js` | poll cursors + processed-tasks | yes | `init({stateFile,…})` |
| `lib/task-queue.js` | `task-queue.json` | yes | constructor arg |
| `lib/llm-metrics.js` | `llm-metrics.json` | yes | `LLM_METRICS_FILE` env, read per-call |
| `bots/storefront.js` | `delivery-quotes.json` | yes | `DELIVERY_QUOTES_FILE` env |
| **`lib/bulletin-board.js`** | `bulletin.json` | yes | **none** |
| **`lib/slack-client.js`** | `channel-map.json` | yes | **none** |
| **`lib/staff-tasks.js`** | `staff-tasks-state.json` | yes | **none** |
| **`lib/watercooler.js`** | `watercooler-state.json` | yes | **none** |

The bottom four are the exact pre-fix shape of #19: a writable file resolved as a
module-scope `const` with no `init`/arg/env override. Their tests confirm it — they
operate on the **real** project file, not a temp copy: `tests/bulletin-board.test.js:12-19`
unlinks the real `agents/shared/bulletin.json`; `tests/slack-client.test.js:532` builds a
`tempDir` the module ignores (its own comment: "The actual CHANNEL_MAP_FILE path is inside
the project"); `tests/staff-tasks.test.js:305` unlinks the real `staffTasks.TASKS_STATE_FILE`.

**Why they do not flake today, and why that is not safety:** each of those four files is
written by exactly **one** test suite, so nothing races it. #19 flaked only because *two*
suites wrote `approval-queue.json` (`approval-queue.test.js` + `security-followup.test.js`).
The defect is latent in the other four — the day a second writing suite appears for any of
them (or two of these suites' production writers run under one test), the identical
scheduling-dependent race returns. Not fixed here to keep the #19 change scoped; filed so
the class is visible.

**Fix:** give each of the four the `init({ file })` override `lib/bridge-state.js` /
`lib/approval-queue.js` already model, and point their suites at `os.tmpdir()`. **The
durable close is an enumerator, not four edits:** a test that walks `lib/` + `bots/`,
flags any module exporting a writer whose target path has no override seam, and fails when
a new one appears — the `tests/no-shell-execution.test.js` pattern applied to
shared-mutable-path. Without it a fifth sibling lands unnoticed.
**Priority:** P2 | **Effort:** Low per module; Medium for the enumerator.
**Risk:** Low — additive overrides; unset option preserves each current path exactly.

### 20. `MAX_TURNS` names four different quantities, and the env var is dead config
**Filed 2026-09-14.** Supersedes and extends the `MAX_TURNS` bullet in item 4b, which
recorded two of the four.

**Problem:** the name `MAX_TURNS` / `max_turns` / `maxTurns` is bound to four unrelated
quantities. Regenerate:
`grep -rn "MAX_TURNS\|max_turns\|maxTurns" --include=*.js . | grep -v node_modules | grep -v '^./tests/'`

| Binding | Quantity | Value |
|---------|----------|-------|
| `lib/config.js:34`, `lib/llm-runner.js:172` | env-driven **default** | 50 |
| `lib/task-parser.js:56` | hard **ceiling** on the `TURNS:` header | 100 |
| `lib/task-parser.js:14` `DEFAULT_TURNS` | **default when no header**, a hardcoded literal | 50 |
| `bridge-agent.js:1498` | conversation path's **own** default *and* ceiling | 10 / 20 |

`bridge-agent.js:1498` is the source of the `max-turns=20` the owner observed in
`[llm-runner] Spawning Claude in /tmp/bridge-agent (max-turns=20)` and could not place:
`const maxTurns = Math.min(currentAgent?.max_turns || 10, 20);`. It reads neither the env
var nor either parser constant. `secretary`, `email-monitor` and `story-bot` carry
`max_turns: 20` in `agents.json`; `jester` carries 10; every code agent carries 50 and is
silently clamped to 20 on the `ASK:` path.

**Correction to the dispatch — `MAX_TURNS=200` in the live `.env` raises nothing.** It is
unreachable on every non-test path:
- `lib/llm-runner.js:348` `options.maxTurns || DEFAULT_MAX_TURNS` — but **every** non-test
  callsite passes `maxTurns` explicitly, so the `||` arm never fires. Regenerate:
  `grep -rn "runLLM(\|runWithFallback(" --include=*.js . | grep -v node_modules | grep -v '^./tests/'`
  → `security-review.js:294` (10), `bots/storefront.js:444` (15), `bridge-agent.js:665`
  (`currentTurns`), `bridge-agent.js:1503` (`maxTurns`), `lib/watercooler.js:536` (5),
  `lib/task-decomposer.js:341` (`maxTurns`). Six of six explicit.
- `lib/config.js:34` feeds only `bridge-agent.js:208`
  (`agentConfig?.max_turns || config.MAX_TURNS`), which for the bridge agent resolves to
  its registry value 50, not the env 200 — and that binding is consumed by exactly one
  line, the startup banner at `:1897`.

So `MAX_TURNS` in `.env` changes one thing: nothing. **The standing convention of putting
`TURNS: 100` on every dispatch is correct, but not for the stated reason** — without the
header a task gets 50 from the `task-parser.js:14` literal (not from the env), and with it
up to 100 from the `:56` ceiling. The header is load-bearing; the env var is not.

**Fix (naming and reachability are separate changes — do the rename first, it is safe):**
1. Rename `lib/task-parser.js:56 MAX_TURNS` → `TURNS_CEILING` (it is exported at `:463`,
   so grep consumers). Rename the `bridge-agent.js:1498` literals to named constants
   (`CONVERSATION_TURNS_DEFAULT`, `CONVERSATION_TURNS_CEILING`).
2. Decide what `MAX_TURNS` in `.env` is *for*. Either wire it to something reachable (the
   conversation ceiling is the honest candidate) or delete it from `CLAUDE.md`'s env table
   and `.env.example` and say in the commit body that it was dead. Do not leave a
   documented knob that moves nothing — that is the doc-vs-reality drift class.
3. Add a test asserting the conversation path's effective turns for an agent with
   `max_turns: 50`, so the clamp is stated somewhere other than one un-commented
   `Math.min`.
**Effort:** Low.
**Risk:** Low for (1) and (3). (2) is a behaviour decision, not a refactor — if
`MAX_TURNS=200` is wired to anything it will actually raise turn counts for the first
time, so land it alone.


### 5. Mid-task `ask_on_slack` capability
**Source:** tomeraitz/claude-slack-bridge
**Problem:** Tasks run fully autonomously. If the model needs a decision mid-run it
guesses or aborts.
**Fix:** inject a tool into the task prompt that posts a question to the originating
thread and blocks on the reply; the bridge listens for the thread reply and resumes.
**Dependency (now explicit):** this assumes Claude Code is the executor — true again as
of 2026-09-13, since `processTask` runs through `runWithFallback` with `claude` as the
default provider for the bridge/code agents (`bridge-agent.js:741`, `agents.json`
`llm_provider: "claude"`). If those agents move to Gemini/Ollama (single-shot adapters,
no tool loop) this capability does not apply to them.
**Effort:** High — thread-reply listener, tool injection, per-task session state.
**Risk:** Medium — changes the execution model; must not break fire-and-forget.

### 6. Structured task result format
**Problem:** Task results are raw text dumps; no consistent success/failure/files/tests
shape.
**Fix:** define a result schema and render it as a Block Kit card. Note that Phase 3
already extracts test pass/fail counts (`lib/code-review-pipeline.js:348-353`) — build on
that rather than re-parsing.
**Effort:** Medium.

### 7. Task timeout escalation tiers
**Problem:** `TASK_TIMEOUT_MS` (default 600000) is a single hard kill with no warning.
No soft-timeout logic exists (`grep -in 'soft\|80%\|will be killed' bridge-agent.js` →
nothing).
**Fix:** at ~80% of the limit, post a "running X min, will be killed in Y" warning to
ops. Don't change the kill itself.
**Effort:** Low.

### 8. Surface deduplication in status
**Problem:** `processed-tasks.json` dedupes silently; a re-submitted task is skipped with
no feedback to the user. Dedup is real (`CLAUDE.md` "Task Deduplication") but there is no
reply-on-duplicate path.
**Fix:** when a duplicate is detected, post a brief threaded reply: "Already processed
(ID: xxx). Reply `retry` to force." Wire `retry` through the existing dedup check.
**Effort:** Low.

### 9. `ASK: task history [n]` command
**Problem:** The status command returns the last 5 completed tasks; there is no
`task history N`. `grep -in 'task history' bridge-agent.js lib/task-parser.js` → nothing.
**Fix:** add a built-in `ASK: task history 20` that reads N back from memory with
timestamps and outcomes.
**Effort:** Low.

### 10. Split the god-files that break the repo's own 300-line rule
**Problem:** The repo enforces a 300-line-per-file rule (`lib/validate.js:18`,
`MAX_LINES = 300`) but 59 `.js` files exceed it, including the two most load-bearing:
`bridge-agent.js` at **2210** lines and `lib/llm-runner.js` at **1103**. Behaviour keeps
getting re-derived inline in files too big to hold in one read. Both figures grew since
this file's first 2026-09-13 revision (2040 / 1020) — the scratch-clone fix alone added
~170 lines to `bridge-agent.js`, so the god-file is getting *worse*, not holding steady.
Regenerate the count and the list: `node lib/validate.js` (Check 2 prints every
offending file and its line count; exits 1 while any exist). (The task CONTEXT said "58";
the count is 59 — the rule counts `split('\n').length`, which is why `bridge-agent.js`
reads one line higher than `wc -l`.)
**Fix:** carve cohesive modules out of `bridge-agent.js` first (command handlers, poll
loop, task pipeline are the natural seams). Each extraction must keep
`node -e "require('./bridge-agent.js')"` green (the CLAUDE.md refactor rule).
**Effort:** High, incremental.
**Risk:** Medium per extraction — moving variables/imports is exactly what the
scope-guard test (`tests/bridge-agent-scope.test.js`) and the load check exist to catch;
run both after each move.

### 11. A helpers/utilities map and an owning-doc rule
**Problem:** There is no index of what the `lib/` helpers do or which doc owns each
behaviour. `docs/` holds per-agent design docs only (no `HELPERS.md`/`UTILITIES.md` —
`ls docs/` confirms). New code re-implements behaviour that already exists in `lib/`
because nothing points to it.
**Fix:** add a `docs/HELPERS.md` mapping each `lib/*.js` to its responsibility (the
`CLAUDE.md` Architecture block is a starting inventory), and a CLAUDE.md rule that a new
file names its owning doc. Doc-and-convention only.
**Effort:** Low.

### New (2026-09-13) — `DEPLOY_KEY_PATH` is read but undocumented
**Problem:** The scratch-clone push fix reads a new env var,
`process.env.DEPLOY_KEY_PATH || "/bridge/.deploy_key"` (`bridge-agent.js:487`), but it
was never added to `CLAUDE.md`'s Environment Variables section or `.env.example`
(`grep -rn DEPLOY_KEY_PATH CLAUDE.md .env.example` → nothing). This violates the repo's
own env-var rule ("When adding a new env var to code you MUST … update the Environment
Variables section in this CLAUDE.md"). The default path is container-specific
(`/bridge/…`), so an operator on a different layout has no signposted way to point it at
their key — the clone silently falls back to READ-ONLY and pushes fail.
**Fix:** document `DEPLOY_KEY_PATH` (description + default `/bridge/.deploy_key`) in the
`CLAUDE.md` Optional env table and in `.env.example`. Doc-only.
**Effort:** Low.

### Reconcile — per-agent memory: entry caps vs. the tiering that already landed
**Problem:** The old backlog asked for "per-agent memory size limits (max entries,
evict oldest)." Tiered memory with TTL and time-based decay already shipped
(`lib/memory-tiers.js` — `ttl` at `:40`, `decayMs` at `:134`; tests in
`tests/memory-tiers.test.js`). What is *not* there is a hard **max-entries cap** per
tier. Don't re-file the whole item — the only open piece is the count cap.
**Fix:** add an optional max-entries cap per tier in `lib/memory-tiers.js`, evicting
oldest-by-TTL when exceeded. Keep it consistent with the existing decay logic.
**Effort:** Low.

---

## P3 — Nice to have / uncertain ROI

### 12. Docker/container deployment — CORRECTED (this is now the deployment)
**Status:** The previous entry marked this "P3, low priority since PM2 works." That is
inverted and both halves are now false: Docker on the QNAP NAS **is** the deployment
(`CLAUDE.md:7`), and **PM2 does not exist** anywhere in the codebase — the self-restart
is `process.exit(0)` under `restart: unless-stopped` (`auto-update.js:299-321`,
`README.md:168-197`). Kept here as a correction, not a task. The compose-side item this
entry used to carry — move the NAS `command:` from `npm install` to `npm ci` — is **done**
(the live compose already runs `npm ci`; see item 4b and
`docs/CONFIG-SURFACE-AND-REBUILD.md`). `CLAUDE.md:11-16` still carries it as "ACTION
REQUIRED" and is stale there. The compose-side item that replaced it is **P1 #17**: that
same `command:` never starts `auto-update.js`, so the self-restart this entry describes has
no process to run in.

### 21. `already_in_channel` warns five times per boot — and the obvious fix is in the wrong place
**Filed 2026-09-14.** `joinAgentChannels` (`lib/slack-client.js:385`) calls
`conversations.join` unconditionally for every channel at startup; the bot is already in
all of them, so every boot produces the same five warnings. Harmless, and it trains the
reader to skip WARN lines — which matters because item #3's `not_in_channel` and item #17's
"is the running process on main?" both surface as exactly that kind of line.

**Correction to the dispatch — the warning is not emitted by this repo.**
`lib/slack-client.js:397-402` already treats `already_in_channel` as success: it increments
`joined` and `continue`s **without logging**. So patching that catch block changes nothing.
Slack returns HTTP 200 with a `response_metadata.warnings` field for this case, and the SDK
forwards those straight to `logger.warn`. **Verified**, not inferred:
`node_modules/@slack/web-api/dist/WebClient.js:204-206`
(`result.response_metadata.warnings.forEach(this.logger.warn.bind(this.logger))`) and
`:151`, which defaults the logger to `LogLevel.INFO` when the constructor is given no
`logLevel` — which is exactly how `lib/slack-client.js:80` constructs it
(`new WebClient(token)`). Regenerate:
`grep -n "warnings\|LogLevel.INFO" node_modules/@slack/web-api/dist/WebClient.js`.

**Fix (pick one, both cheap):** pass `logLevel: LogLevel.ERROR` (or a custom `logger`) when
constructing the `WebClient`; or check membership before joining and only call
`conversations.join` for channels the bot is actually missing — which has the side benefit
of making a *real* join (the case channel auto-join exists for) visible instead of buried
among four no-ops. Do not "fix" it in the catch block; that code never runs for this case.
**Effort:** Low. **ROI:** log legibility only.


### 13. MCP server wrapper
**Source:** tomeraitz/claude-slack-bridge
**Idea:** expose bridge capabilities (post to Slack, read the queue, query memory) as MCP
tools so Claude Code sessions call them directly.
**Dependency (now explicit):** only meaningful while Claude Code is the executor (see
item 5) and mostly only worth it alongside the mid-task ask capability.
**Effort:** High. **ROI:** unclear.

### 14. Watercooler retro → LinkedIn draft
**Idea:** after the Friday retro, aggregate the week's highlights into a LinkedIn draft
for review.
**Blocked by:** `story-bot` is `status: "planned"` (see item 3); its `draft-weekly-posts`
template exists (`lib/agent-scheduler.js:56`) but the agent is not active. Activate
story-bot first.
**Effort:** Low once story-bot is live.

### 15. Task complexity auto-scaling TURNS
**Problem:** `TURNS` is manual (`lib/task-parser.js:13` `DEFAULT_TURNS = 50`, floor 5,
cap 100). `analyzeComplexity()` exists (`lib/task-decomposer.js`) but its score does not
feed TURNS.
**Fix:** when `TURNS` is not explicitly set, derive a baseline from
`analyzeComplexity()` (e.g. 1-2 → 20, 3-5 → 50, 6+ → 80).
**Dependency (now explicit):** turns are a Claude-CLI concept; single-shot adapters
(Gemini/Ollama) ignore `maxTurns` (`lib/llm-runner.js` adapter contracts), so this only
affects Claude-executed tasks.
**Effort:** Low.

### 16. Channel-per-task archive mode
**Idea:** for long-running/high-value tasks, auto-create a dedicated channel, post all
I/O there, archive on completion.
**Effort:** High. **ROI:** probably only audit/compliance.

---

## What changed since the last revision

Previous revision: **2026-04-05**. Last full revision: **2026-09-13**.
This revision: **2026-09-14** (see "Filed 2026-09-14" below).

### Closed since 2026-04-05 (verified done — removed from the active list)
| Old item | Evidence it is closed |
|----------|-----------------------|
| Thread-based task conversations | Output is threaded off the source ts throughout `bridge-agent.js` (`thread_ts: msg.ts`, 26 occurrences — `grep -c thread_ts bridge-agent.js`). |
| Approval queue expiry | 7-day auto-expiry implemented: `MAX_PENDING_AGE_MS = 7 * 24 * 60 * 60 * 1000` (`lib/approval-queue.js:30-31`). |
| `npm test` failure diff in Slack | Phase 3 parses jest output and posts counts + output to ops (`lib/code-review-pipeline.js:348-353`). |
| Rate-limit backoff tuning | Superseded. The auto-pause path is hard-disabled (`isBandwidthExhausted` returns `false`, `lib/llm-runner.js:83-85`); rate limits now trigger the provider fallback chain (`runWithFallback`, `lib/llm-runner.js:713`) instead of a static wait. `CLAUDE_RATE_LIMIT_PAUSE` remains documented but is no longer the mechanism. |

### Defects fixed since the last revision (from the task context — each verified closed)
| Defect | Verified fix |
|--------|--------------|
| `agentId` undefined in `processTask` | Declared `const agentId = agentConfig?.id \|\| 'bridge'` (`bridge-agent.js:729`). |
| Silent drop of unprefixed messages | Skips are now logged with a reason (`describeSkipReason`, `bridge-agent.js:1589`; used at `:1767`). |
| `runWithFallback` never called | Wired at both LLM entry points (`bridge-agent.js:741` in `processTask`, `:1536` in `processConversation`). |
| `CLAUDE_BIN` pointed at a dead host path | Default is `/usr/local/bin/claude` (`lib/config.js:40`, `lib/llm-runner.js:118`). |
| `agents/*/memory/` never gitignored | Ignore-all-with-seed-allowlist rule in place (`.gitignore:31-36`). |
| No lockfile | `package-lock.json` is committed (`git ls-files package-lock.json`). |
| `npm run validate` hanging forever | `validate.js` now `process.exit(0)`s after the load check and has a 30s spawn timeout (`lib/validate.js:26-69`). |
| Scratch-clone cleanup deleted undelivered work (3 tasks lost) | Two-part fix landed later on 2026-09-13: clones are pushable by construction (`cloneRepo`, `bridge-agent.js:485-500`) and cleanup gates on `detectUndeliveredWork` (`bridge-agent.js:528`, `:1132`; commit `2a6bbcb`). Tests: `tests/undelivered-work.test.js`. Full write-up under P1 above. |

### Landed later on 2026-09-13 (after this file's first revision that day)
- ~~Scratch-clone cleanup destroyed undelivered work~~ → **DONE** (pushable-by-construction
  clone + delivery-gated cleanup; see the DONE block under P1 and the defects table above).
- New gap surfaced by that fix: `DEPLOY_KEY_PATH` is read in code but undocumented →
  **P2, new item** (see "New (2026-09-13)" under P2).
- File-count figures for item #10 refreshed: `bridge-agent.js` 2040 → 2210,
  `lib/llm-runner.js` 1020 → 1103 (the clone fix added ~170 lines to `bridge-agent.js`).

### Still open, and none of it was in the old file (now ranked above)
- ~~Syntax-only deploy gate + the jest open-handle hang that blocks the smoke gate~~ → **P1 #1, DONE 2026-09-13**.
- Per-agent provider only in tracked `agents.json`, on-box edits silently reset → **P1 #2**.
- Scheduler ignores `planned` status; story-bot's cron would fire → **P1 #3**.
- 59 files over the 300-line rule → **P2 #10**.
- No helpers/utilities map or owning-doc rule → **P2 #11**.
- `DEPLOY_KEY_PATH` read but undocumented → **P2, new item** (added 2026-09-13, later same day).
- Nothing starts `auto-update.js`; merged code never reaches the running process → **P1 #17** (2026-09-14).
- ~~The task queue never enters `running`, so `recoverInterrupted()` is a guaranteed no-op~~ → **P1 #18, DONE 2026-09-14**.
- `tests/approval-queue.test.js` races a hardcoded shared file under parallel workers → **P2 #19** (2026-09-14).
- `MAX_TURNS` names four quantities and the env var reaches nothing → **P2 #20** (2026-09-14).
- `already_in_channel` boot noise, emitted by the SDK not by this repo → **P3 #21** (2026-09-14).
- The preserved scratch clone lives in container-local `/tmp` and is destroyed by the
  `--force-recreate` the docs themselves prescribe → **P1 #25** (2026-09-14).
- `docker-compose.yml` is untracked *and* unignored in the live working tree, so
  `git clean -fd` deletes it → **P2 #26** (2026-09-14).
- A task can write the whole live deployment, credentials included; `/repo:ro` is the
  only real boundary → **P2 #27**, recorded not decided (2026-09-14).
- `context.json` is seeded, tracked, and the only write target of `addPermanent()` — which has **no production caller** today (`grep -rn addPermanent` finds only `lib/`, `memory/`, and tests). So it is seed-only in practice. If a production caller of `addPermanent('bridge', …)` is ever added it will dirty the tracked `agents/bridge/memory/context.json` and hit the same silent-reset failure as item #2. Track together, not separately.

### Filed 2026-09-14 — from a live check against the running container

Six findings, all owner-verified against the running `jt-agent` container on 2026-09-14.
The repo-side half of each was re-verified in this checkout before filing; the
container-side half is owner-supplied and labelled as such in each item, because it is
**not** reachable from the repo (the compose file is untracked, the live `.env` is not).

| Filed as | Item | Tier |
|----------|------|------|
| **#17** | Nothing starts `auto-update.js` — merged code does not reach the running process | P1, ranked first |
| **#3** (amended, not re-filed) | story-bot is scheduled into a channel it is not in — weekly silent failure | P1 |
| **#18** | ~~The task queue never enters `running`, so crash recovery can never fire~~ — **DONE 2026-09-14** | P1 |
| **#19** | `tests/approval-queue.test.js` flakes under parallel workers | P2 |
| **#20** | `MAX_TURNS` names four quantities; the env var is dead config | P2 |
| **#21** | `already_in_channel` warns five times per boot | P3 |
| **#22** | An interrupted task reaches no human (filed from the #18 fix) | P2 |
| **#23** | A task killed mid-run is re-read and re-run on the next poll (filed from the #18 fix) | P2 |
| **#25** | The preserved scratch clone does not survive a container recreation (filed 2026-09-14 from the topology capture) | P1 |
| **#26** | `docker-compose.yml` is untracked and unignored in the live tree — `git clean -fd` deletes it | P2 |
| **#27** | A task has write access to the whole live deployment; `/repo:ro` is the only containment boundary | P2 |

**Two existing items were amended rather than duplicated**, per the repo's
anti-duplication rule:
- **#3** already *predicted* the story-bot failure on 2026-09-13 ("its job does register
  and will post a TASK to that channel every Friday at 18:00 … the only reason this hasn't
  been noticed may be that the channel is unused"). The 2026-09-14 evidence confirms the
  prediction and shows the channel is not merely unused but **unjoined**, with
  `not_in_channel` as the observable. #3 was rewritten in place with that evidence and
  moved up the P1 order; it keeps its number.
- **#4b**'s `MAX_TURNS` bullet and its "self-update wiring undetermined" bullet are both
  marked superseded, pointing at #20 and #17.

**Where this revision corrects the dispatch it was filed from.** Each of these was checked
against the code, not inherited:
- **`MAX_TURNS=200` in the live `.env` does not raise any default.** The dispatch said it
  raised the global default and was capped to 100 by an explicit header. Neither consumer
  is reachable: all six non-test LLM callsites pass `maxTurns` explicitly, and
  `config.MAX_TURNS` reaches only a startup banner. Without a `TURNS:` header a task gets
  50 from a hardcoded literal in `lib/task-parser.js:14` — not from the env. The
  `TURNS: 100` convention is correct, but for that reason, not the stated one. (#20)
- **The third turn ceiling's source is identified**, and there are four quantities, not
  three: `bridge-agent.js:1498` `Math.min(currentAgent?.max_turns || 10, 20)` is the
  `max-turns=20` seen in the logs — a default *and* a ceiling on one line, reading neither
  the env var nor either parser constant. (#20)
- **The task-queue finding is stronger than "no transition between".** `dequeue()` — the
  sole writer of `RUNNING` — has **zero non-test callers in the repo**. It is fully
  exercised by `tests/task-queue.test.js` and never called in production: a green suite
  asserting a state machine the running system does not drive. (#18 — closed
  2026-09-14: `markRunning()` wired into `processTask`; the enumerating guard is
  `tests/task-queue-lifecycle.test.js`, which extracts the lifecycle from
  bridge-agent.js's source rather than calling the module.)
- **`already_in_channel` is not logged by this repo.** `lib/slack-client.js:397-402`
  treats it as success and `continue`s without logging, so patching that catch block fixes
  nothing; the line comes from the Slack SDK's default logger on a 200-with-warning
  response (`@slack/web-api/dist/WebClient.js:204-206` and `:151`, both verified after an
  `npm ci` in this checkout). (#21)
- **`jester` is the mirror image of story-bot, not a separate bug.** Active, has a
  `0 18 * * 5` schedule, `channel: null` — so the `!agent.channel` guard skips it and an
  *active* agent's weekly job silently never arms. Same missing invariant: nothing asserts
  that the scheduled set and the joined set are the same set. (#3)

**What could not be verified from this checkout, and is recorded as owner-supplied:**
the compose `command:` line and its file/line reference, the live `.env` contents
(`MAX_TURNS=200`, the six unread `*_CHANNEL_ID` keys), the container uptime and the
11-hour undeployed window, the `Joined 5/5 agent channels` and
`Scheduled story-bot:draft-weekly-posts` startup lines, the `not_in_channel` bulletin-watcher
error, the `startedAt: null` queue entries, and the ~1-in-6 flake rate for #19. Each is
named at its item with the command that regenerates it on the box. (#19's flake was
independently reproduced here — see the item — so only the owner's *rate* is unconfirmed;
the defect is not.)

### Corrected, not deleted
- Docker deployment is P3-inverted → now the deployment (**P3 #12**).
- Socket Mode is *more* valuable, not less (**P1 #4**).
- `ask_on_slack`, MCP wrapper, complexity-scaled TURNS all depend on Claude Code being
  the executor — stated explicitly in items #5, #13, #15.
- Per-agent memory caps overlap the tiering that already landed — reconciled to just the
  entry-cap piece (P2 "Reconcile").

### Stated plainly: what in the task context I could NOT confirm, or found wrong
- **"Conflicts on pull" for provider changes — wrong.** `auto-update.js:479` runs
  `git reset --hard HEAD` before pulling, so on-box `agents.json` edits are *silently
  discarded*, not conflicted. Corrected in item #2.
- **"58 files over 300 lines" — off by one.** The current count is 59 by the repo's own
  rule (`node lib/validate.js`). `bridge-agent.js` = 2040, `auto-update.js` = 711 (both
  by `split('\n').length`, the rule's semantics).
- **"Four planned agents' schedules never register" — half wrong.** Four are planned, but
  story-bot has a schedule *and* a channel and the scheduler never checks status, so its
  job does register. Corrected in item #3.
- **Owner's stated direction (event triggers over polling)** — taken from the task
  context; not derivable from the repo, flagged as such in item #4.
- **Deployment facts** (dead Pi, QNAP `jt-agent` container, non-root uid, Max-plan auth,
  write-capable deploy key) — consistent with `CLAUDE.md`/`README.md` and with this task
  having cloned and pushed over the deploy key, but the container internals themselves
  are not observable from inside the repo.

### Filed 2026-09-14 (later the same day) — from the deployment-topology capture

Three items (**#25**, **#26**, **#27**), all following from one fact nothing in this
repository had written down: the deployment is a single container with two asymmetric
mounts — `/bridge` read-write over the deploy directory (which *is* this git checkout),
`/repo` read-only over SqTools — and scratch clones in neither. The topology is now
recorded, fact by fact and labelled repository-verified or owner-supplied, in
[`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 0.

**Housekeeping in the same pass:** this file carried **two `### 17.` headings**, ~59 lines
apart, describing the same item at two different dates — the older copy arrived when
`claude/ecstatic-dijkstra-8joyou` merged, and the newer copy had explicitly instructed
"reconcile, do not keep two". Reconciled: the older copy is deleted and its one unique
paragraph ("Why this outranks everything else in P1") folded into the survivor. Regenerate
the check: `grep -c "^### 17\." WORK-TODO.md` must be `1`.

**Where this revision corrects the dispatch it was filed from.** The dispatch's third
defect — the recovery reason string naming a process manager this deployment does not use
— **was already fixed on `main`** before this work started. At HEAD,
`INTERRUPTED_ON_STARTUP_REASON` (`lib/task-queue.js:52-54`) reads "Task interrupted: the
bridge process did not survive to record an outcome (container restart or crash)", changed
in `6454fb0` and guarded by `tests/task-queue-lifecycle.test.js:223`. What was *not* done
was the dispatch's second half — the same stale name survived in twelve other places, all
of them present-tense claims about how this deployment runs, including runnable `pm2`
instructions in `docs/STOREFRONT-WIDGET.md` and two modules pointing an operator at
"pm2 logs" for output that goes somewhere else. Those are fixed; dated historical records
of the pm2 → `process.exit(0)` change are deliberately kept.

**Two enumerators added, because a rule that is only prose gets broken silently:**
`tests/timezone-explicit.test.js` (no source file may read `process.env.TZ`; every
date-format and cron site names its zone) and `tests/architecture-tree.test.js` (every
source file appears in CLAUDE.md's Architecture block, and every file the block names
exists — the second direction is what catches a removal). The architecture guard was
written because seventeen files were missing from that tree, five of them modules
`bridge-agent.js` `require`s directly.

*Last updated: 2026-09-14 (later the same day) — topology capture: #25, #26, #27 filed;
the duplicated #17 reconciled to one heading; the timezone, architecture-tree and stale
process-manager defects fixed with two new enumerating guards.
Earlier on 2026-09-14: six findings from a live container check filed as #17-#21, item #3
amended in place and re-ranked, item #4b's superseded bullets cross-referenced.
Previous revision: 2026-09-13 (later same day — scratch-clone fix landed, `DEPLOY_KEY_PATH`
gap added, item #10 counts refreshed); previous full revision: 2026-04-05.*
