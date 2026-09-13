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
repo." That is why Docker moved from P3 to done, Socket Mode stayed P1 for a new
reason, and a syntax-only deploy gate is now the top item.

**Every figure below carries the command that regenerates it.** If a number has no
command, it was removed.

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

### 3. The scheduler never checks `planned` status — a planned agent's cron will fire
**Problem:** `startScheduler` iterates `loadAgents()` (all agents) and registers a cron
job for any agent that has *both* a `schedule` and a `channel`
(`lib/agent-scheduler.js:168`, `:177-181`). It never consults `status: "planned"`.
`getActiveAgents()` (which *does* filter `status !== 'planned'`, `lib/agent-registry.js:79`)
is not used here.

The CONTEXT said "four agents are planned and their schedules never register." Half right.
Four agents are planned — regenerate:
`node -e "console.log(require('./agents/agents.json').filter(a=>a.status==='planned').map(a=>a.id))"`
→ `storefront, social-media, marketing, story-bot`. But the reason their schedules don't
run is incidental, not by design:
- `storefront` — no `schedule`, nothing to register.
- `social-media`, `marketing` — have a `schedule` but `channel: null`, so the
  `!agent.channel` guard skips them.
- **`story-bot` — has a `schedule` (`0 18 * * 5`, task `draft-weekly-posts`) AND a real
  `channel` (`C0AP8CHCV1U`).** Its template exists (`lib/agent-scheduler.js:56`). So its
  job *does* register and *will* post a TASK to that channel every Friday at 18:00,
  despite the agent being "planned"/inactive. The only reason this hasn't been noticed
  may be that the channel is unused, not that the scheduler declined to arm it.

**Fix:** gate scheduling on active status — either call `getActiveAgents()` in
`startScheduler`, or add `if (agent.status === 'planned') continue;` alongside the
existing skips. Add a regression test (`tests/agent-scheduler.test.js` already mocks
node-cron) asserting a planned agent with a schedule+channel registers zero jobs.
**Effort:** Low.
**Risk:** Low — narrows what registers; cannot start anything new.

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
`bridge-agent.js` at 2040 lines and `lib/llm-runner.js` at 1020. Behaviour keeps getting
re-derived inline in files too big to hold in one read.
Regenerate the count and the list: `node lib/validate.js` (Check 2 prints every
offending file and its line count; exits 1 while any exist). (The task CONTEXT said "58";
the current figure is 59 — the rule counts `split('\n').length`, which is why
`bridge-agent.js` reads as 2040 here and 2039 under `wc -l`.)
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
`README.md:168-197`). Kept here as a correction, not a task. The one open compose-side
item is documented in `CLAUDE.md:11-16`: the NAS `command:` should move from
`npm install` to `npm ci` now that the lockfile is committed — but that lives on the NAS,
not in this repo, so it cannot be closed from here.

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

Previous revision: **2026-04-05**. This revision: **2026-09-13**.

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

### Still open, and none of it was in the old file (now ranked above)
- ~~Syntax-only deploy gate + the jest open-handle hang that blocks the smoke gate~~ → **P1 #1, DONE 2026-09-13**.
- Per-agent provider only in tracked `agents.json`, on-box edits silently reset → **P1 #2**.
- Scheduler ignores `planned` status; story-bot's cron would fire → **P1 #3**.
- 59 files over the 300-line rule → **P2 #10**.
- No helpers/utilities map or owning-doc rule → **P2 #11**.
- `context.json` is seeded, tracked, and the only write target of `addPermanent()` — which has **no production caller** today (`grep -rn addPermanent` finds only `lib/`, `memory/`, and tests). So it is seed-only in practice. If a production caller of `addPermanent('bridge', …)` is ever added it will dirty the tracked `agents/bridge/memory/context.json` and hit the same silent-reset failure as item #2. Track together, not separately.

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

*Last updated: 2026-09-13 (previous: 2026-04-05)*
