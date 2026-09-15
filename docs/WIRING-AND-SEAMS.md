# Wiring map & bridge-agent.js extraction seams

> **Working on this repo?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first —
> the branch gate, the blast-radius rule, what counts as proof, and the tests that
> enforce each convention. This document tells you *where* the seams are; the contract
> tells you what a change to one has to satisfy before it ships.

Two questions this doc answers, from the code as it actually runs on 2026-09-13,
not from the architecture wish-list:

1. **What is actually wired?** — which modules a live process reaches, which are
   reachable only from tests, and which the LLM-fallback chain actually covers.
2. **Where does `bridge-agent.js` (2209 lines) split?** — the cohesive seams, ranked
   by leverage per unit of risk, with the dependencies each seam drags along and the
   test that already guards it.

This is the detail behind WORK-TODO items **#10** (split the god-files) and **#11**
(a helpers map). It does not replace them; #10 is the task, #11 is a different
deliverable (a per-`lib` responsibility index).

**Every figure carries the command that regenerates it.** A number with no command
was removed.

---

## 0. Where the deployment topology lives

This document maps wiring **inside** the repository. The shape of the machine it runs
on — one `jt-agent` container, `/bridge` bind-mounted **read-write** over the deploy
directory (which *is* this git checkout), `/repo` mounted **read-only** over SqTools,
scratch clones in container-local `/tmp` — is captured in
[`CONFIG-SURFACE-AND-REBUILD.md` → Step 0](CONFIG-SURFACE-AND-REBUILD.md), with each
fact labelled repository-verified or owner-supplied. Read it before reasoning about
where a process can write; two of its three consequences (the scratch clone that does
not survive a container recreation, and the read-write live tree) change what an
"entry point" can reach.

---

## 1. Entry points (processes that actually start)

Six files are *shaped* like process entry points. Everything else is a library reached
only by being `require`d from one of these (or from a test).

**"Entry point" is a property of the file, not proof that anything starts it.**
`auto-update.js` is the standing counter-example: it has a shebang, a `main()`, and a
`setInterval` loop, and no launcher anywhere — so the whole self-deploy path, guards and
all, is dead code in this deployment. When adding a row here, say what starts it and how
that is checkable, not just that it could be started.

| Entry point | How it starts | Role |
|-------------|---------------|------|
| `bridge-agent.js` | `node bridge-agent.js` (container `command:`) | The bridge: polls Slack, runs tasks, handles ASK commands. Since 2026-09-14 it also starts an **additive** Socket Mode connection for slash commands (§7) — started after the poll interval is armed, never awaited, and off by default |
| `auto-update.js` | **Nothing starts it** (verified 2026-09-14) | Git-poll → verify → `process.exit(0)` self-deploy — *designed, tested, not running* |
| `morning-digest.js` | cron `0 8 * * *` | Daily digest DM |
| `security-review.js` | cron `0 1 * * *` | Nightly commit audit |
| `scripts/watercooler.js` | cron (Mon 8:30 / Fri 17:00) + manual | Multi-agent standup |
| `bots/storefront.js` | `node bots/storefront.js` | Express chat-widget server |

Regenerate the "is an entry point" test (has a shebang or a top-level start/listen):

```bash
grep -rl "setInterval\|app.listen\|^#!/usr/bin/env node" --include='*.js' . \
  | grep -v node_modules | grep -v /tests/
```

`lib/validate.js` is a **seventh, CLI-only** entry: it is never `require`d
(`grep -rn "require(.*validate')" --include='*.js' . | grep -v node_modules` → nothing)
but is invoked as `npm run validate` → `node lib/validate.js`. Not dead — just reached
by argv, not by `require`.

---

## 2. Wiring map — lib module → production callers

Regenerate the full edge list:

```bash
for f in lib/*.js lib/integrations/*.js memory/*.js; do
  b=$(basename "$f" .js)
  echo "== $f"
  # NB: paths print without a leading ./, so filter "tests/" not "/tests/".
  grep -rl "require('[^']*${b}')" --include='*.js' . \
    | grep -v node_modules | grep -v "tests/" | grep -v "$f" | sed 's/^/   /'
done
```

Everything below has **≥1 production caller** unless flagged. The high-fan-in hubs
(non-test callers) are `agent-registry` (7), `bulletin-board` (6), `llm-runner` (5),
`task-parser` (4), `owner-tasks` (3) — these are the modules a change ripples through.
Note three of those counts include `task-decomposer`, which is itself dead (§3); drop it
and `llm-runner`'s live callers fall to 4.

**`task-parser` moved 2 -> 4 on 2026-09-15** and its live callers are now
`bridge-agent.js`, `lib/dispatch-message.js` and `lib/dispatch-modal.js` — the `/dispatch`
form reads the parser's own `FIELD_LABELS`, `MIN_TURNS`/`MAX_TURNS` and `normalizeRepo`
rather than restating any of them, which is the point (§7).

`bridge-agent.js` alone has **24** first-party `require` lines
(`grep -c "require('\./" bridge-agent.js`), which is itself the argument for §4.
**That figure read 19 until 2026-09-15 and was already wrong before this change**: it was
written at commit `e2a19e2` and `origin/main` measured **23** — regenerate it with the
command beside it rather than trusting the number.

---

## 3. Dead / unwired code (no production caller)

Reachable only from tests — a live process never loads these:

| Module | Prod callers | Documented as if live? |
|--------|--------------|------------------------|
| `lib/task-decomposer.js` | **0** (only `tests/task-decomposer.test.js`) | Yes — the whole "Task Decomposition" section of `CLAUDE.md`, and `skills/decompose/SKILL.md` |
| `lib/integrations/httpsms.js` | **0** (no prod caller, no test) | Yes — `docs/SMS-INTEGRATION.md` |

Regenerate:

```bash
# task-decomposer: any non-test caller?
grep -rn "task-decomposer\|decomposeTask\|analyzeComplexity" --include='*.js' . \
  | grep -v node_modules | grep -v /tests/ | grep -v 'lib/task-decomposer.js'
# httpsms: any caller at all?
grep -rn "httpsms\|sendSMS" --include='*.js' . | grep -v node_modules | grep -v 'lib/integrations/httpsms.js'
```

**Why `task-decomposer` is genuinely unreachable, not just indirectly wired:** the only
skill-loading path in the bridge reads `skills/<skill>/SKILL.md` and prepends it to the
prompt as *markdown* (`bridge-agent.js:698-710`). It never invokes the decomposer's
code. So `analyzeComplexity`/`decomposeTask` run only under Jest. The CLAUDE.md
"Task Decomposition" section describes a capability that has no call site.

Not a defect on its own — but it means CLAUDE.md oversells what the running system does,
and the decomposer's `runLLM` call (`lib/task-decomposer.js:341`) is dead weight in the
"who bypasses fallback" analysis below.

---

## 3a. The scheduled inbox check — rewired 2026-09-14

**What it was.** `lib/agent-scheduler.js` fired the email-monitor agent's
`check-inbox` cron (`*/30 9-21 * * *`, America/Toronto) by posting a prose TASK:
message to channel `C0AQH3KC31S`. `bridge-agent.js`'s poll loop picked it up
(allowed because `msg.user === BOT_USER_ID`), and — TASK: messages always execute as
the **bridge** agent, never as the channel's agent (**re-cited at HEAD 2026-09-14**:
the routing is `bridge-agent.js:1768` for `processTask` versus `:1792`/`:1812` for
`processConversation`; the previously cited range `:1704-1711` had drifted into the
body of `processConversation`. `agentConfig` is bound once to `getAgent('bridge')` at
`bridge-agent.js:194`, which still resolves. Regenerate with
`grep -n "agentConfig = getAgent('bridge')\|processTask(msg, channelId\|processConversation(msg, channelId" bridge-agent.js`.
This is now filed as **WORK-TODO #38** — it is not an email-path quirk, it is the rule
for every scheduled agent) — built
a no-REPO prompt of `bridge.system_prompt + "Check the email inbox and triage
messages"` and handed it to an LLM running in `WORK_DIR`.

That LLM had **no mailbox access of any kind**. `lib/integrations/gmail.js` had
exactly one non-test caller in the whole repository — `morning-digest.js:368` — and
this was not it. `lib/agent-context.js` injects real data for `secretary`,
`security`, `jester`, `story-bot` and the three code agents; `email-monitor` falls to
`buildGenericContext()` ("No specific data context available for this agent"), and
that path is `processConversation` (ASK:) anyway, not `processTask`. There is no MCP
server, connector, or Gmail tool anywhere in this repository.

**What it is now.** `DETERMINISTIC_TASKS['check-inbox']` in `lib/agent-scheduler.js`
runs `lib/email-check.js` → `runInboxCheck()`:

| Step | Module | Notes |
|------|--------|-------|
| Window | `lib/email-check.js` `resolveWindow()` | `agents/email-monitor/memory/check-state.json` (`lastSuccessfulCheckAt`), capped at `EMAIL_CHECK_MAX_LOOKBACK_MS` |
| Fetch | `lib/integrations/gmail.js` `fetchRecentEmails()` | messages.list + messages.get. **Read-only.** Returns `{ ok, emails, reason, error, listed, failed }` |
| Filter | `lib/integrations/email-categorizer.js` `categorizeEmails()` | rules from `agents/email-monitor/memory/rules.json`, read per run by `loadRules()` |
| Report | `slack.chat.postMessage` to `agent.channel` | Only on success |
| Escalate | `lib/notify-owner.js` `taskFailed()` | `#sqtools-ops` post + CRITICAL owner notification |

**Empty vs failed.** `getRecentEmails()` returned `[]` for an empty inbox, for
missing credentials, and for an API error alike, and `morning-digest.js:363-378`
skips its email section on an empty array — so an expired token produced a digest
that read exactly like a quiet mailbox. `fetchRecentEmails()` never collapses those:
`ok:false` with `reason` in `no_credentials` / `service_account_key_missing` /
`list_failed` / `all_messages_failed`. `getRecentEmails()` still flattens to `[]` for
its existing caller, so `morning-digest.js` is unchanged.

`runInboxCheck()` statuses: `ok` (check ran; `fetched` may be 0), `not_configured`,
`fetch_failed`, `categorize_failed`. Only `ok` posts a summary; every other status
escalates to a human and writes **no** state, so the window is retried rather than
lost.

**Still unwired, by design:** no mailbox write of any kind. The email-monitor agent
declares a `gmail-unsubscribe` permission in `agents/agents.json` and its retired
prose template told the model to "process any safe unsubscribe requests" — nothing in
this repository has ever implemented that, and the only OAuth scope requested is
`gmail.readonly` (`lib/integrations/gmail.js:83`). See WORK-TODO #29.

---

## 4. The LLM path — who gets failover, who gets one shot

`runWithFallback` is the chain (try provider → on rate-limit/timeout/malformed, fall to
the next). `runLLM` is a single provider attempt. **Both** record exactly one metrics
verdict (`recordVerdict` at `lib/llm-runner.js:309,323` for `runLLM`; `:806,827,859,883`
for `runWithFallback`), so the "every call is measured" claim in CLAUDE.md holds for
both — the difference is *failover*, not *visibility*.

Regenerate the call sites:

```bash
grep -rn "runWithFallback(\|runLLM(" --include='*.js' . \
  | grep -v node_modules | grep -v /tests/ | grep -v 'function run'
```

| Caller | Uses | Gets failover? |
|--------|------|----------------|
| `bridge-agent.js:869` (`processTask`, TASK:) | `runWithFallback` | ✅ |
| `bridge-agent.js:1704` (`processConversation`, ASK:) | `runWithFallback` | ✅ |
| `security-review.js:277` | `runLLM` | ❌ one shot |
| `bots/storefront.js:444` | `runLLM` | ❌ one shot |
| `lib/watercooler.js:536` | `runLLM` | ❌ one shot |
| `lib/task-decomposer.js:341` | `runLLM` | ❌ — and the caller is itself dead (§3) |

This matches CLAUDE.md's "No silent fallback" section exactly: only the two
`bridge-agent.js` entry points are on the chain; the other three live callers bypass it.
Called out here so the seam work in §6 does not accidentally "fix" it by routing
everything through one helper — that is a behaviour change, not a refactor.

---

## 5. `bridge-agent.js` anatomy (line ranges)

Regenerate section boundaries:

```bash
grep -n "^// ----\|^async function \|^function \|^const .* = require" bridge-agent.js
```

| Lines | ~LOC | Section | Nature |
|-------|------|---------|--------|
| 1–162 | 162 | 24 `require`s + banner | imports |
| 164–216 | 53 | config destructure, `slack`/`slackClient` init, `notifyOwner.init` | wiring |
| 218–347 | 130 | **State persistence**: processed-tasks CRUD + per-channel `lastChecked` | pure fs, no Slack |
| 349–420 | 72 | **Rate-limit state machine**: pause/backoff/clear | in-memory + notifyOwner |
| 422–454 | 33 | Slack helpers: `react`, `unreact`, `postToOps` | Slack |
| 459–610 | 152 | **Git/clone lifecycle**: `cloneRepo`, `cleanupDir`, `detectUndeliveredWork` | child_process/fs |
| 612–624 | 13 | `truncate`, `msgLink` | pure |
| 626–1171 | **546** | **`processTask`** — clone → pipeline → LLM + retry → Phase 3 → bulletin → delivery-gated cleanup | the core |
| 1173–1261 | 89 | `formatStatusResponse` | reads queue+memory |
| 1263–1741 | **479** | **`processConversation`** — a 9-branch built-in command ladder, then the LLM ASK path | the other core |
| 1743–1948 | 206 | `describeSkipReason` + `poll` | poll loop |
| 1950–2077 | 128 | `runStartupMemoryMaintenance`, `buildChannelsToPoll` | startup |
| 2079–2156 | 78 | top-level startup sequence (the async IIFE that calls `poll`) | boot |
| 2158–2209 | 52 | `gracefulShutdown` + signal handlers | lifecycle |

Two functions (`processTask` 546, `processConversation` 479) are **46%** of the file.

---

## 6. Extraction seams, ranked

Ranking axis (same spirit as WORK-TODO): **lowest risk × highest LOC removed first**,
because each extraction must keep `node -e "require('./bridge-agent.js')"` green
(the CLAUDE.md refactor rule) and pass `tests/bridge-agent-scope.test.js` (the AST
`X is not defined` guard). Do them in this order; each is independently shippable.

### Seam A — Git/clone lifecycle → `lib/clone-lifecycle.js`  — DONE 2026-09-14
Extracted verbatim into `lib/clone-lifecycle.js`; `bridge-agent.js` now imports the
three helpers. `tests/undelivered-work.test.js` was re-pointed at the module source and
`tests/clone-lifecycle.test.js` added for `cloneRepo`/`cleanupDir`. Full suite green.
- **Lines:** was 459–610 (`cloneRepo`, `cleanupDir`, `detectUndeliveredWork`), ~152 LOC.
- **Why first:** zero coupling to module state. Inputs are `(repo, branch, dir)` and a
  dir path; outputs are fs effects + a `{undelivered, reason}` object. Only external
  refs are `fs`, `path`, `child_process.execFileSync`, `process.env.DEPLOY_KEY_PATH`.
  (Was `execSync`; 2026-09-14 converted every git call in the module to an
  `execFileSync` argv array — no function here builds a shell command string.)
- **Already guarded:** `tests/undelivered-work.test.js` exercises `detectUndeliveredWork`
  and the finally-block gate — extraction is refactor-under-test.
- **Caller left behind:** `processTask` calls all three; pass nothing new, they are pure.

### Seam B — State persistence → `lib/bridge-state.js`  — DONE 2026-09-14
Extracted into `lib/bridge-state.js`; `bridge-agent.js` now `require`s it, calls
`bridgeState.init({ bridgeChannel: BRIDGE_CHANNEL })` once at startup, and destructures
the five accessors it uses (`getLastChecked`, `setLastChecked`, `isTaskProcessed`,
`markTaskProcessed`, `cleanupProcessedTasks`). The module is the single owner of both
files; the two mutable maps (`channelLastChecked`, `processedTaskTimestamps`) are no
longer module state in bridge-agent. `tests/bridge-state.test.js` added (temp-dir CRUD,
legacy migration, dedup + cleanup). Full suite green; `bridge-agent.js` 2209 → 1979 LOC.
- **Lines:** was 218–347, ~130 LOC (processed-tasks CRUD, `loadState`/`saveState`,
  `getLastChecked`/`setLastChecked`, `cleanupProcessedTasks`).
- **Why:** file-backed, deterministic, no Slack/LLM. The one shared mutable is
  `channelLastChecked` / `processedTaskTimestamps` — export accessors, keep the module
  as the single owner of both files.
- **Paths anchored to repo root:** `STATE_FILE`/`PROCESSED_TASKS_FILE` were
  `__dirname`-relative at repo root; the module resolves them via
  `path.join(__dirname, '..')` so they stay put after the move to `lib/`.
- **`loadState` migration dependency:** the legacy single-channel → multi-channel
  migration needed `BRIDGE_CHANNEL` (a closure var in bridge-agent). It is now passed
  through `init({ bridgeChannel })`, so the module has no config/env coupling and
  `init()` can take temp-dir path overrides for testing.

### Not a seam, but landed here — `lib/task-lock.js` (2026-09-14)
Not an extraction from `bridge-agent.js`'s line ranges: the task lock was ~10 lines of
inline `fs` calls in `processTask` plus an `fs.existsSync` probe in `auto-update.js`.
It is listed here because it is the one module both entry points share, and §1's table
says why that matters — `auto-update.js` is designed to run as a **separate process**, so
the lock is the only thing that would tell it a task is in flight.

> **Live today: only the `bridge-agent.js` half.** `auto-update.js` is never started
> (§1), so `evaluateTaskDeferral` has no live caller and nothing currently protects a
> running task from a deploy. The deploy today is a manual `docker compose restart`,
> which ignores the lock entirely and kills the task. That is the gap, not a safeguard.

- **Owns:** `$WORK_DIR/.task-running` — `acquire`, `release`, `inspect`, `releaseIfStale`.
- **Why it exists:** `processTask`'s `finally` does not run when the process is killed,
  and a self-update restart is exactly that kill, so an orphaned lock was cleaned up by
  nothing. That was survivable only because `waitForTaskCompletion()` gave up after 5
  minutes and restarted anyway — which was itself the bug that killed long tasks.
- **Callers:** `bridge-agent.js` (acquire/release around every task, plus a startup
  orphan sweep) and `auto-update.js` (`evaluateTaskDeferral`, ahead of any git mutation).
- **Guarded by:** `tests/task-lock.test.js` and `tests/auto-update-defer.test.js`;
  `tests/smoke.test.js` loads it, which matters because the smoke suite is guard (a)
  part 3 of the self-update and this module is on both entry points' critical path.

### Seam C — Built-in command router → `lib/ask-commands.js`  *(largest win)*
- **Lines:** the 9-branch ladder inside `processConversation`, ~373 LOC (1285–1658):
  status, owner-tasks, create-channel, staff-tasks, bulletins, standup, approval
  (approve/reject/show-task). Every branch is `if (isX(text)) { … post …; return; }`.
- **Shape:** turn it into `handleCommand(text, ctx) → boolean` (handled?) where `ctx`
  carries `{ slack, sourceChannel, msg, agentId, config, slackClient }`. `processConversation`
  becomes: try router; if not handled, fall to the LLM ASK path (1660–1724).
- **Why not first:** highest LOC but touches the most collaborators
  (`staffTasks`, `bulletinBoard`, `watercooler`, `approvalQueue`, `owner-tasks`,
  `slackClient`) — more import surface to move, higher scope-guard risk.
- **Payoff:** removes ~370 lines and makes each command unit-testable in isolation
  (today they are only reachable through the full `processConversation`).

### Seam D — Rate-limit state machine → `lib/rate-limit-state.js`
- **Lines:** 349–420, ~72 LOC. Self-contained except `notifyOwner` + `INITIAL_PAUSE_MS`.
- **Caveat — mostly cosmetic:** per WORK-TODO's "closed" table, the auto-pause path is
  hard-disabled (`isBandwidthExhausted → false`); `rateLimitState.failedTask` is set
  nowhere live, so the retry branch at `poll()` 1804–1821 is effectively dead. Extracting
  this is a good moment to decide: delete the dead pause path, or keep it parked. Don't
  do both in one commit.

### Seam E — Poll loop → `lib/poll-loop.js`
- **Lines:** 1743–1948 (`describeSkipReason` + `poll`), ~206 LOC.
- **Depends on:** nearly everything (state accessors, `processTask`, `processConversation`,
  auth, dedup). Extract **last** and only after A/B land, so the dependencies it imports
  are already stable module boundaries rather than file-locals.
- **Guarded by:** `tests/silent-drop-logging.test.js` (`describeSkipReason` + skip
  logging) and `tests/multi-channel-routing.test.js`.

### Not a seam (leave in place)
- `processTask` (546 LOC) — the retry loop, Phase-1/2/3 pipeline calls, delivery-gated
  cleanup and memory bookkeeping are tightly interleaved with try/catch/finally spanning
  the whole body. Extract the **pieces it calls** (Seam A already removes the clone
  helpers) before attempting the orchestrator itself. Splitting the orchestrator is a
  separate, higher-risk project — do it after A–E have shrunk the file and proven the
  extraction discipline.

---

## 7. The Socket Mode connection — additive, commands only (2026-09-14)

`lib/slack-socket.js` opens one Socket Mode WebSocket. **It is not an entry point** — it
has no `main()` and nothing starts it on its own; `bridge-agent.js` starts it, which is
the distinction section 1 exists to make.

### What it is for, and why the parser is not the thing to fix

A dispatch reaches the bridge as a Slack message whose first lines carry
`TASK:`/`REPO:`/`BRANCH:`/`TURNS:`/`INSTRUCTIONS:`. Flatten that block onto a single line
— which is what Slack does to some pasted multi-line input — and the labels are no longer
at the start of a line, so `REPO:` absorbs the rest of the message and the task runs
against no repository, at the default turn budget rather than the one asked for. Three
tasks failed that way on 2026-09-14, each after ten to fifteen minutes of work.

`lib/task-parser.js` is behaving correctly. `FIELD_LABELS` are uppercase and line-anchored
deliberately (CLAUDE.md -> "Field Label Rules"), and the 2026-09-14 change that refuses a
non-canonical label rather than silently downgrading the task is the right shape. The loss
happens **before** the parser sees anything: it is a property of the transport. A form with
separate inputs cannot be flattened, a slash command is what opens a form, and a slash
command needs a socket.

### What the 2026-09-14 change built, and what it deliberately did not

| Built | Not built (all three landed 2026-09-15 — see below) |
|---|---|
| A Socket Mode connection that opens, reports ready, reconnects, and reports an outage that does not recover | Any registered slash command |
| The `onSlashCommand` seam, plus a defensive `ack` so an unhandled command never hangs | Any modal / form |
| `SLACK_APP_TOKEN`, documented, with its absence handled as a normal state | Any submission -> task-message path |

### Additivity — how it is enforced, not asserted

The poll loop is the only way a task arrives, **including the task that would repair the
poll loop**. So the socket may never be on its critical path. Three mechanisms, each with
a test in `tests/slack-socket.test.js`:

1. **Ordering.** `startSocketMode()` is called after `setInterval(poll, POLL_INTERVAL)`
   and is not awaited (`describe('the wiring in bridge-agent.js')`). The poll loop is
   already running before the socket is touched.
2. **Total failure containment.** `startSocketMode()` never throws and never rejects.
   Every failure — `not_configured`, `invalid_token_shape`, `dependency_missing`,
   `start_failed` — resolves to `{ started: false, reason }` and posts to `#sqtools-ops`.
3. **Lazy dependency.** `@slack/socket-mode` is `require`d inside the start call, not at
   module load, so a dependency that is absent or broken cannot stop
   `require('./bridge-agent.js')`. The container installs dependencies at start, so
   "absent" is a state that can actually happen here.

A fourth property is asserted for the same reason: the socket subscribes to exactly
`connected`, `disconnected`, `reconnecting` and `slash_commands` — never `message` or
`app_mention`. If it ever received messages, message intake would have two owners and the
dedup/authorisation gate in `poll()` would no longer be the single one.

### Relationship to WORK-TODO #4

#4 proposes **replacing** the poll loop with Socket Mode. This is not that, and does not
close it. #4's risk is exactly what this change refuses to take: it would make the only
message path depend on a connection that is new, unconfigured on the box, and dependent on
an app setting no repository controls. This change makes the connection exist and be
observable first. If it proves boring for a while, #4 becomes a much smaller decision; if
it does not, the poll loop never noticed.

### What the NEXT change had to do — DONE 2026-09-15 (`/dispatch`)

All six steps are landed. Left in place as written, each with what actually happened,
because the steps were the plan and the record of a plan is worth more than a tidy
summary of it.

1. **Register the command in the Slack app configuration** (`/task`, say). In Socket Mode
   a slash command needs **no Request URL** — that is the point of the socket.
   → **Owner action, NOT done by this repository and NOT verifiable from a checkout.**
   The command is `/dispatch` (`COMMAND_NAME`, `lib/dispatch-modal.js`). The exact
   steps — Socket Mode on, app-level token, the slash command, **Interactivity on**,
   reinstall — are in `CLAUDE.md` → "The `/dispatch` command". Interactivity is the one
   that is easy to miss and is not optional: without it Slack never delivers the
   `view_submission`, so the modal opens and submitting it does nothing.

2. **Attach a handler**: pass `onSlashCommand({ ack, body })` to `startSocketMode()`. The
   seam is marked `THE COMMAND SEAM` in `lib/slack-socket.js`. Acknowledge within 3
   seconds and open the modal from the `trigger_id`; do the work after the ack, never
   before it.
   → Done, in `bridge-agent.js`'s `startSocketMode({ ... })` call.
   `handleSlashCommand` acks first and opens after; a test leaves `views.open` pending and
   asserts the ack has already gone out. **The seam needed a second half nobody had
   noticed:** a modal comes back as an **`interactive`** envelope, not a `slash_commands`
   one, so `onInteractive` was added beside it. A command that opens a form is inert
   without both.

3. **Open a modal with SEPARATE inputs** — task, repo, branch, turns, instructions. Five
   fields is the entire point: nothing a user types into a multiline input can merge two
   of them.
   → `lib/dispatch-modal.js`. The blocks are built **from** `lib/dispatch-message.js`'s
   `FIELD_KEYS`, so the form and the generator cannot gain or lose a field independently.
   Only instructions is multiline.

4. **Build the task the way the parser reads it back.** Uppercase, line-anchored labels.
   That round trip is already pinned in `tests/integration.test.js` (three modules in this
   repo generate task messages that `parseTask` reads back) — the new generator belongs in
   that pin.
   → `lib/dispatch-message.js`, and the pin now covers **four** generators. Two mechanisms
   rather than one: `buildDispatchMessage` emits uppercase line-anchored labels with
   `INSTRUCTIONS:` last, and `assertRoundTrip` parses its own output back and **throws**
   on any mismatch before it can be posted. `normalizeRepo` was extracted from `parseTask`
   and exported so the generator applies the parser's own normalisation instead of a
   second copy of it.

5. **Reuse the existing gates, do not re-derive them.** `lib/git-identifiers.js` validates
   `REPO:`/`BRANCH:` (reject, never sanitise); `isUserAuthorized` is the allowlist;
   `lib/bridge-state.js` owns dedup. A modal submission is Slack-controlled input reaching
   a `git` argv array, exactly like a message body.
   → All three reused; the validator adds no pattern of its own.
   **One thing this step's wording obscures, and it is the sharpest finding of the
   change:** `lib/bridge-state.js` owns dedup, but the poll loop is **not** a second
   authorisation gate for what the form posts. Its check is
   `!isUserAuthorized(msg.user) && !isBotMessage`, and the form's post is a **bot** post —
   bot posts bypass the allowlist deliberately, so scheduled tasks are not dropped. So the
   `isUserAuthorized` call in `handleSlashCommand` is the **only** gate, and it is checked
   again in `handleViewSubmission` because a `view_submission` is its own envelope, not a
   continuation of the command. Reusing the check was right; relying on a downstream one
   would not have been.

6. **Decide where the resulting task enters the pipeline** — and say so. Posting the
   assembled message to `#claude-bridge` and letting `poll()` pick it up keeps one intake
   path and one dedup owner, at the cost of up to `POLL_INTERVAL_MS` latency. Calling
   `processTask` directly is faster and creates a second intake path. That is a decision,
   not a detail.
   → **Decided: post to `#claude-bridge`.** `processTask` is never called from the form
   (asserted in `tests/slack-socket.test.js`). One intake path, one dedup owner, and a
   task that survives a restart because it exists as a message. The latency is paid
   against work that runs for ten minutes.

### Failure paths, and the one that has no good answer

A rejected field acks with `response_action: 'errors'` keyed by `block_id`: the modal
**stays open** and the reason sits on the offending input. That shape is reused for every
post-submission failure, because acking `{}` closes the modal and takes the operator's
five inputs with it.

**The socket is connected but the channel post fails** — the case worth stating plainly.
The post is attempted **before** the ack and bounded by `SUBMIT_POST_TIMEOUT_MS`
(2500 ms, inside Slack's ~3 s ack window):

| Outcome | What the operator sees | What ops sees |
|---|---|---|
| Posted | The modal closes; `poll()` takes it from here | nothing |
| Slack refused | Modal stays open, the Slack error named, inputs intact | a `#sqtools-ops` post |
| Exceeded the ack window | Modal stays open, outcome stated as **UNKNOWN**, told to check the channel before resubmitting | a `#sqtools-ops` post |

The timeout row never claims the post failed. It may well have landed, and dedup is by
message `ts` — two posts are two tasks, each running for ten minutes. The pending promise
is left permanently guarded so a late rejection cannot become an unhandled rejection, and
whichever way it eventually settles is logged.

A `views.open` that fails happens **after** the ack, where there is no modal to report
into, so it reaches the operator as an ephemeral and `#sqtools-ops` as a post. If the
ephemeral fails too, ops still hears and nothing throws.

---

### The form, as changed 2026-09-15, and two things PROPOSED rather than done

**Changed.**

1. **The turn budget default is now the ceiling.** `DISPATCH_DEFAULT_TURNS` in
   `lib/dispatch-message.js` is **defined as `MAX_TURNS`**, not written as `100`. The
   parser's `DEFAULT_TURNS` (50) is unchanged and still the right default for a hand-typed
   message with no `TURNS:` line; the form is not that, and the standing convention is
   `TURNS: 100` on every bridge dispatch. **What enforces the ceiling, so the two cannot
   disagree:** they are the same constant. `MAX_TURNS` is what the `parsed > MAX_TURNS`
   rejection in `validateDispatchFields` compares against, and the default is that
   constant, so a default above its own ceiling is not expressible and raising the ceiling
   moves both. The tests assert the **identity** (`DISPATCH_DEFAULT_TURNS === MAX_TURNS`),
   not the number — hardcoding either side turns them red.

2. **The repository field is a select sourced from `REPOS`.** `getConfiguredRepos()` in
   `lib/config.js` is now the single owner of that list; `security-review.js`, which had
   the only copy of the default, calls it too. Adding a repository is a `.env` change and
   `docker compose up -d --force-recreate jt-agent` — not an edit to a form file. The
   field stays **optional** (a task with no repository is a legitimate dispatch), an empty
   `REPOS` falls back to a text input rather than failing the modal open (Slack rejects a
   `static_select` with zero options), and the list is capped at Slack's 100. **Validation
   does not move**: the submitted payload is whatever Slack sends, so the select is a
   convenience and `lib/git-identifiers.js` is still the boundary. **The branch field is
   left as free text**, deliberately — a branch is per-task and is not enumerable from
   configuration.

**PROPOSED — should the form prepend the standing preamble automatically?**
*Not changed. The owner decides; nothing was altered about what gets sent.*

Every dispatch to this repository carries the same opening: read
`docs/EXECUTOR-CONTRACT.md` in full, commit after each part, treat every supplied
`file:line`/path/host as an unverified lead, report cited vs. actual. It is already
written down once, in the contract, and re-typing it into every instructions body is the
duplication this repo files as a defect anywhere else.

*For:* the operator's instructions field would carry only the task-specific part, which
is the only part that varies. A preamble typed by hand is a preamble that drifts — three
dispatches with three slightly different versions of "treat citations as leads" is the
same class as a hand-maintained command list. It cannot be forgotten.

*Against, and these are real:*
- **It is invisible.** The operator would no longer see the text that governs the run, so
  a change to the prepended block changes every future dispatch with nobody reading the
  diff at dispatch time. Today the preamble is visible in the message.
- **It consumes the instructions budget.** The modal input is capped at 3000 characters
  and the emitted message grows by the preamble's length, against `MAX_TURNS` work.
- **`assertRoundTrip` constrains what it may contain.** A prepended block is part of the
  `INSTRUCTIONS:` body, so no line in it may begin with a field label in any case —
  including the lines quoting the contract, which names `TASK:`/`REPO:` repeatedly. A
  preamble would have to be written to pass `matchesFieldLabel`, and a future edit to it
  could make every dispatch refuse.
- **A pointer may be enough.** `CLAUDE.md` already opens by telling executors to read the
  contract first, and it is auto-read. If that is working, prepending is redundant; if it
  is not, the fix is a check that the executor confirmed the read, not more text.

*Recommendation if it is taken:* prepend a **one-line pointer**, not the preamble —
"Read `docs/EXECUTOR-CONTRACT.md` in full before writing anything; it governs this work."
— asserted by a test to be label-free, and rendered in the modal as a hint so it is
visible before submission rather than only after. **Not implemented.**

**REPORTED — can the modal be opened pre-filled from a previous dispatch?**

**Yes, and the form half now supports it.** `buildModalView({ initial: { ... } })` takes a
value per field; every element Slack offers here accepts one (`initial_value` on a text
input, `initial_option` on a `static_select`). Re-running with one line changed is a form
concern, not a new mechanism. Two edge cases are handled because Slack fails the whole
`views.open` on either: an `initial_value` longer than the field's `max_length` is
truncated, and an `initial_option` absent from the current `options` is dropped — so a
repository since removed from `REPOS` loses its pre-fill instead of breaking the command.

**What does NOT exist is the store.** Nothing records a submission, so there is no "last
dispatch" to pass in. That needs a persisted file, a per-user key, a retention rule and a
decision about whether the *instructions* body is kept (it is the largest field and the
most likely to be stale). It is a separate change; the `initial` parameter is the seam it
plugs into, exercised by `tests/dispatch-modal.test.js` and by nothing in production yet.

---

## After each extraction (the CLAUDE.md gate)

```bash
node -e "require('./bridge-agent.js')"   # refactor rule: process must load
npx jest tests/bridge-agent-scope.test.js tests/silent-drop-logging.test.js
npm test                                 # full suite before commit
node lib/validate.js                     # Check 2 re-counts files over 300 lines
```

`node lib/validate.js` regenerates the over-limit file count (WORK-TODO #10 cites 59);
each landed seam should lower `bridge-agent.js`'s own line count toward the 300 rule.

*Written 2026-09-13. Figures from the repo at commit `e2a19e2`; regenerate with the
commands inline above.*
