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

### 17. Nothing starts `auto-update.js` — merged code does not reach the running process
**Filed 2026-09-14.** Owner-verified live against the running container; the repo-side
half is verified here.

**Problem (repo-side, verifiable from this checkout):** no file in this repo starts
`auto-update.js`. `package.json` has three scripts (`test`, `test:smoke`, `validate`) and
none of them is it; `bridge-agent.js` never spawns or forks it. Every in-repo mention is a
comment or a doc.
Regenerate: `grep -rn "auto-update" --include=*.js --include=*.json . | grep -v node_modules | grep -v '^./tests/'`
→ comments and `auto-update.js`'s own body only. `node -e "console.log(Object.keys(require('./package.json').scripts))"`
→ `[ 'test', 'test:smoke', 'validate' ]`.

**Problem (off-repo, owner-supplied — NOT verifiable from this checkout):** the live
compose runs one command,
`sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"`
(`docker-compose.yml:17` on the NAS). The compose file is deliberately untracked, so this
is an unverified lead from here. Regenerate **on the NAS**:
`grep -n "command\|entrypoint\|auto-update" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`

**Impact, observed not theorised (owner, 2026-09-14):** three branches merged to `main`
and pushed while the container had been up 11 hours; it kept running the code it loaded at
start. The command-injection sink, the task-lock wait cap, and the shell-execution class
closure all sat on disk unloaded for hours. A manual `docker compose restart` was what
actually deployed them.

**Why this outranks everything else in P1:** every other item in this file is fixed by
merging a commit, and merging a commit is exactly the step that is not connected to the
running process. This is the deploy path itself.

**The documentation is fiction until this is settled.** `auto-update.js` exists, is
covered by `tests/auto-update-restart.test.js` and `tests/update-verifier.test.js`, and is
described in `CLAUDE.md` ("Self-update (how the bridge deploys itself)", "Task lock and
self-update deferral") and in this file (P3 #12) as running every `CHECK_INTERVAL_MS`.
The four restart guards and the 2026-09-14 deferral gate all describe a process that is
not started. A green test suite for an unstarted daemon is the verification-integrity
failure class, not a passing gate.

**Two viable shapes — the choice is John's, not this file's:**
- **(a) Wire it in:** the compose command starts `auto-update.js` alongside (or instead of
  supervising) `bridge-agent.js`. Everything already written stays true. Note the exit-based
  restart (`process.exit(0)` under `restart: unless-stopped`) assumes the *container* dies
  on exit, so which process the container's PID 1 is matters — a backgrounded updater whose
  exit does not stop PID 1 restarts nothing.
- **(b) Declare manual restart the deploy:** then `auto-update.js` and its whole guard
  apparatus are dead code, and `CLAUDE.md` + this file must say so rather than describing it
  as live.

**Either way, one thing is needed that does not exist today: a way to answer "is the
running process on `main`?"** Nothing in the repo or on the box reports the deployed
commit. Until it does, "merged" and "deployed" are unrelated facts and no one is told when
they diverge. This is the scheduled-job-with-no-liveness-check class applied to the deploy
itself.
**Effort:** Low for (b) (doc-only) or for a commit-reporting heartbeat; Low-Medium for (a).
**Risk:** (a) is Medium — it arms a self-restarting daemon that has never actually run in
this deployment; its guards have never been exercised outside tests. Land the
deployed-commit report *first* so the first real self-update is observable.

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

### 18. The task queue never enters `running`, so crash recovery can never fire
**Filed 2026-09-14.** Owner-observed live; verified here, and the repo evidence is
stronger than the observation.

**Problem:** `dequeue()` (`lib/task-queue.js:142`) is the **sole** writer of
`STATUS.RUNNING` and `startedAt` (`:150-151`). It has **zero non-test callers in the
entire repo.**
Regenerate: `grep -rn "dequeue" --include=*.js . | grep -v node_modules`
→ every hit is `tests/task-queue.test.js` (18 calls), one comment in
`tests/auto-update-defer.test.js`, one comment in `auto-update.js:230`, and the definition
itself. Nothing in production ever calls it.

The live task path goes straight from `pending` to terminal: `bridge-agent.js:1671`
`queue.enqueue({…})`, then `:756` `complete(queueId, …)` or `:897` `fail(queueId, …)`.
There is no transition in between. Owner-observed: live queue entries show
`startedAt: null` on tasks that reached `completed`.

**Consequence:** `recoverInterrupted()` (`lib/task-queue.js:206`) rewrites **only**
`STATUS.RUNNING` entries. With nothing ever marked running, it returns `0` on every
startup, unconditionally — `bridge-agent.js:1908` calls it and it is a guaranteed no-op.
A task killed mid-run is never marked `interrupted`. It stays `pending` indefinitely:
counted by `getQueueDepth`, preserved by `cleanup`, retried by nothing, reported to nobody.

**This is the foundation the autonomous-queue design rests on, and it has never worked.**
It is also the interaction that `auto-update.js:228-234` already documents as a hazard
("a task killed between `enqueue()` and `dequeue()` stays 'pending' forever") and works
around with an age cutoff — the workaround is load-bearing because the transition it
compensates for does not exist. The 2026-09-14 deferral gate's staleness rule is
therefore carrying more weight than its own docs assume.

**A green suite that sanctions the defect.** `tests/task-queue.test.js` exercises
`dequeue()` 18 times and asserts the full `pending → running → completed/interrupted`
lifecycle. Every assertion passes. The suite is testing a state machine that production
never drives. Per the repo's own rule, a test that encodes behaviour the running system
does not have is part of the defect, not evidence against it.

**Not affected — the lock does work.** `bridge-agent.js` writes and removes
`$WORK_DIR/.task-running` around the task (owner-observed live, and `lib/task-lock.js` is
its sole owner). The lock and the queue are independent; only the queue is broken.

**Also stale on this path:** `recoverInterrupted()` stamps
`error: 'Task interrupted (PM2 restart or crash)'` (`lib/task-queue.js:216`). PM2 does not
exist in this deployment (P3 #12). Fix the string in the same change.

**Fix:** call `dequeue()` — or a narrower `markRunning(queueId)` — at the point
`processTask` begins work, so `enqueue` → `running` → `complete`/`fail` is the real path.
Prefer marking the *known* `queueId` over `dequeue()`'s "find the first pending", because
the bridge already holds the id and `dequeue()`'s search would pick the wrong entry if two
were ever pending. Then add a regression test asserting `startedAt !== null` on a completed
task and that `recoverInterrupted()` returns non-zero after a simulated kill — the second
assertion is what would have caught this.
**Effort:** Low.
**Risk:** Low-Medium — it makes `hasActiveTasks()` (`lib/task-queue.js:251` counts
`PENDING` *or* `RUNNING`) true for a window where it is currently true anyway via
`PENDING`, so the deferral gate's behaviour is unchanged; but re-check
`evaluateTaskDeferral()` against the new state shape before landing, since that gate is
what stops a self-update killing live work.

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
- The task queue never enters `running`, so `recoverInterrupted()` is a guaranteed no-op → **P1 #18** (2026-09-14).
- `tests/approval-queue.test.js` races a hardcoded shared file under parallel workers → **P2 #19** (2026-09-14).
- `MAX_TURNS` names four quantities and the env var reaches nothing → **P2 #20** (2026-09-14).
- `already_in_channel` boot noise, emitted by the SDK not by this repo → **P3 #21** (2026-09-14).
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
| **#18** | The task queue never enters `running`, so crash recovery can never fire | P1 |
| **#19** | `tests/approval-queue.test.js` flakes under parallel workers | P2 |
| **#20** | `MAX_TURNS` names four quantities; the env var is dead config | P2 |
| **#21** | `already_in_channel` warns five times per boot | P3 |

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
  asserting a state machine the running system does not drive. (#18)
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

*Last updated: 2026-09-14 — six findings from a live container check filed as #17-#21,
item #3 amended in place and re-ranked, item #4b's superseded bullets cross-referenced.
Previous revision: 2026-09-13 (later same day — scratch-clone fix landed, `DEPLOY_KEY_PATH`
gap added, item #10 counts refreshed); previous full revision: 2026-04-05.*
