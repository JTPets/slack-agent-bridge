# Wiring map & bridge-agent.js extraction seams

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

## 1. Entry points (processes that actually start)

Six files are process entry points. Everything else is a library reached only by
being `require`d from one of these (or from a test).

| Entry point | How it starts | Role |
|-------------|---------------|------|
| `bridge-agent.js` | `node bridge-agent.js` (container `command:`) | The bridge: polls Slack, runs tasks, handles ASK commands |
| `auto-update.js` | `node auto-update.js` (separate container process) | Git-poll → verify → `process.exit(0)` self-deploy |
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
`owner-tasks` (3), `task-parser` (2) — these are the modules a change ripples through.
Note three of those counts include `task-decomposer`, which is itself dead (§3): drop it
and `task-parser`'s only *live* caller is `bridge-agent.js`, and `llm-runner`'s live
callers fall to 4.

`bridge-agent.js` alone has **19** first-party `require` lines
(`grep -c "require('\./" bridge-agent.js`), which is itself the argument for §4.

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
  refs are `fs`, `execSync`, `process.env.DEPLOY_KEY_PATH`.
- **Already guarded:** `tests/undelivered-work.test.js` exercises `detectUndeliveredWork`
  and the finally-block gate — extraction is refactor-under-test.
- **Caller left behind:** `processTask` calls all three; pass nothing new, they are pure.

### Seam B — State persistence → `lib/bridge-state.js`
- **Lines:** 218–347, ~130 LOC (processed-tasks CRUD, `loadState`/`saveState`,
  `getLastChecked`/`setLastChecked`, `cleanupProcessedTasks`).
- **Why:** file-backed, deterministic, no Slack/LLM. The one shared mutable is
  `channelLastChecked` / `processedTaskTimestamps` — export accessors, keep the module
  as the single owner of both files.
- **Watch:** `STATE_FILE`/`PROCESSED_TASKS_FILE` paths are `__dirname`-relative; keep
  them anchored to repo root, not the new module's dir.
- **New tests required:** none exist for these today — a moved function still "ships,"
  but per the no-new-function rule add a temp-dir CRUD test on extraction.

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
