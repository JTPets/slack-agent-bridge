# The Jester — what he can see, what he is given, and what he may do

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
> This document is the design of record for the `jester` agent: the sixth in the
> per-agent design series alongside `STORY-BOT-DESIGN.md`,
> `MARKETING-AGENT-DESIGN.md`, `SOCIAL-MEDIA-DESIGN.md`,
> `SECRETARY-PHONE-DESIGN.md` and `EMAIL-MONITOR-DESIGN.md`.

It answers the backlog item that blocked him, **WORK-TODO #53** — *"an active
commentary agent with a weekly schedule, no channel, and no defined material"* — by
deciding the third of its three gaps (the material) and leaving the first (the
channel) where it belongs: with the owner, because nothing in this repository creates
a Slack channel.

**Every figure and citation below carries the command that regenerates it.** A number
with no command was not written down.

---

## 0. The role, and why it has no authority

Jester looks at a period of activity and pushes back on what was wasted, what was
absurd, and what has been ignored longer than it should have been. He controls
nothing. He blocks nothing. He is read when the owner chooses to read him.

**That powerlessness is a design constraint, not an omission.** The moment his opinion
gates anything, it becomes an unaccountable check with taste instead of rules — a
reviewer with no definition of done, no appeal, and a personality prompt telling it to
be contrarian. Section 5 states how the constraint is enforced rather than asserted.

---

## 1. What he can actually see today — established from code

Four questions, answered from the source at HEAD. The dull answer is right in three
of the four: **he sees much less than the architecture diagram implies.**

### 1.1 Message history from other channels — **NO. He cannot read any Slack history at all.**

Not other agents' channels. **Not even his own.**

An agent's task is not a process with a Slack token. It is a string handed to an LLM:
either a spawned `claude` CLI (`runClaudeAdapter`, `lib/llm-runner.js:362`) or an HTTPS
POST to Gemini/Ollama. The Slack client lives in `bridge-agent.js` and is never passed
into a prompt.

```bash
# Every conversations.history / conversations.replies call in production code:
grep -rn "conversations.history\|conversations\.replies" --include='*.js' . \
  | grep -v node_modules | grep -v "tests/"
# -> bridge-agent.js:1879   (the poll loop)
# -> lib/staff-tasks.js:248 (staff task escalation)

# Any MCP server, connector, or tool allowlist that could reach Slack from a model:
grep -rniE "mcp|--allowedTools|modelcontextprotocol" --include='*.js' . \
  | grep -v node_modules | grep -v "tests/"
# -> nothing
```

`bridge-agent.js:1879` fetches **`limit: 5`** messages per channel per poll, newer than
that channel's cursor, and hands the *text of one message* to `processTask` /
`processConversation`. The model receives that one message, not the channel.

**Consequence for the critique:** "read the week's conversation and roast it" is not
implementable without a new Slack read path and the history scopes to go with it. It
is also the input worth least — see section 2.

### 1.2 The bulletin stream — **YES, and it is the only conversational thing he can reach.**

`formatBulletinsForContext(agentId, limit = 10)` (`lib/bulletin-board.js:397`) is what
every agent's prompt gets. At HEAD it carries, per bulletin:

- the **type** (one of seven: `milestone`, `alert`, `vendor_deal`, `customer_insight`,
  `task_completed`, `security_finding`, `content_idea` — `BULLETIN_TYPES`,
  `lib/bulletin-board.js:20`),
- the **posting agent id**,
- an **America/Toronto local timestamp** (`lib/bulletin-board.js:409`),
- **every scalar payload field**, each value capped at 200 chars (`formatBulletinData`,
  `lib/bulletin-board.js:351`).

It does **not** carry the bulletin id, any link back to the work, anything past the
newest 10, or anything past the 7-day retention (`DEFAULT_CLEANUP_DAYS`,
`lib/bulletin-board.js:31`; swept by `morning-digest.js:485`, the only production
caller of `cleanupOldBulletins`).

Two properties that matter for a weekly post:

- **`unreadBy` is applied and nothing marks anything read.** The filter is
  `unreadBy: agentId` (`lib/bulletin-board.js:398`), and `markRead` has **no production
  caller** (`grep -rn "markRead" --include='*.js' . | grep -v node_modules | grep -v tests/`
  -> three hits, all inside `lib/bulletin-board.js` itself). So "unread" is currently
  a no-op filter that always passes. Harmless today; it would silently start hiding
  material the day anything calls `markRead`.
- **Seven days of retention against a weekly schedule is exactly enough and no more.**
  A cron tick that is late, or a week where `morning-digest.js` swept before the
  critique ran, loses the far end of the window. The digest therefore does not depend
  on bulletins for anything it can compute from a durable source.

> **Doc correction landed with this change.** `docs/CANONICAL-HELPERS.md` §5 and
> WORK-TODO **#32** both said `formatBulletinsForContext` emits **no timestamp at
> all**. That stopped being true at commit `d77cdfa`
> (`git log --oneline -L 397,420:lib/bulletin-board.js`). Both are corrected; the
> other half of #32 — three renderings of one timestamp and no shared
> `formatTimestamp` helper — is still open and still correct.

### 1.3 What the task queue records about outcomes — **enough, and more than #39 implies.**

```bash
grep -n "const queuedTask = {" -A 14 lib/task-queue.js     # the row at creation
grep -n "task.attempts\|previousStatus\|task.outcome" lib/task-queue.js
```

At creation (`lib/task-queue.js:154`): `id`, `msgTs`, `channelId`, `text`,
`description`, `repo`, `status`, `enqueuedAt`, `startedAt`, `completedAt`,
`completionSeq`, `error`.

Written later by the transitions: `outcome` (`complete`), `error` (`fail` /
`interrupt`), and — the two the critique actually wants — **`attempts`,
`previousStatus` and `previousError`**, stamped by `_startRunning` when an entry that
already reached a terminal state is re-run.

So all three signals the role needs are on disk today:

| Signal | Computed from |
|---|---|
| **Outcome** | `status` ∈ `completed` / `failed` / `interrupted` |
| **Duration** | `completedAt − startedAt` (both ISO; `startedAt` is real since `markRunning` was wired in) |
| **Attempts** | `attempts` (absent = 1), plus `previousStatus` / `previousError` for what it was before |

**What it does NOT record, and the critique must say so rather than guess:** whether
the work **landed**. There is no branch, commit or merge field anywhere on the row —
that is WORK-TODO **#39**, verified again here. `completed` means the executor's
process exited successfully, not that anything merged.

**Retention is 24 hours** (`COMPLETED_RETENTION_MS`, `lib/task-queue.js:52`; swept by
`cleanup()` at every bridge startup). **A weekly critique reading a 24-hour queue sees
at most the last day**, and after a restart-heavy week possibly less. This is the
sharpest limit on the whole design and it is stated in the digest itself rather than
papered over: the digest reports the queue's coverage window next to its counts, so a
thin task section reads as *"the queue only goes back this far"* and never as *"nothing
failed."*

### 1.4 The repository's own history in a scratch clone — **NO. The clone is depth 1.**

```bash
grep -n "'clone'" -A 2 lib/clone-lifecycle.js
# -> git(['clone', '--depth', '1', '--branch', branch, '--', url, targetDir], …)  :139
# -> the main-branch fallback clone is also --depth 1                             :147
```

A task's scratch clone contains **one commit**. `git log`, `git log --grep`, blame and
any "what changed this week" question are unanswerable inside it. `--single-branch` is
implied by `--branch`, which is separately why `detectUndeliveredWork` asks the remote
rather than a local tracking ref (`lib/clone-lifecycle.js:214-220`).

**Consequence, and it decides the architecture of part 2:** the git-derived signals
cannot be gathered by the agent. They are gathered by **the bridge process, in its own
checkout**, and handed to the model as text. That is not a workaround — it is the
correct shape, and it is the same shape `check-inbox` already has: code fetches, a
rules file filters, the model is not asked to do the reaching.

### 1.5 Summary — reachable now vs. needs something added

| Material | Reachable today without new permissions? |
|---|---|
| `WORK-TODO.md` — filed dates, tiers, statuses, ages | **Yes.** A tracked file in the bridge's own checkout. |
| Git history of the bridge's own checkout — `Closes` vs `Addresses`, merge times | **Yes**, from the bridge process. **No** from a scratch clone (§1.4). Degrades to "unavailable" if the deploy checkout is shallow or has no `.git`. |
| Task outcomes, durations, attempts | **Yes**, for the last **24 hours** only (§1.3). |
| Scheduled output that reaches nobody | **Yes.** `findOrphans(buildSurface())`, `lib/agent-surface.js` — already computed and already printed by `scripts/agent-surface.js`. |
| Bulletins | **Yes**, newest 10, 7-day retention (§1.2). |
| Which commit the running process is on | **No, and nothing can answer it** — WORK-TODO **#17**. Not a permission gap; the capability does not exist. |
| Whether a merged change reached the deployment | **No** — the same gap. The digest reports the *absence* as a finding rather than omitting the row. |
| Slack message history, any channel | **No.** Needs a new read path plus history scopes (§1.1). |
| SqTools (`/repo`) state | **No.** Mounted read-only into the container; nothing in this repo reads it. |

---

## 2. The material — and why the obvious input is the worst one

Handing a model a transcript produces remarks about wording. The useful input is the
**gap between what was claimed and what happened**, and most of that is computable with
no model at all. WORK-TODO #53 said this; this section is the implementation of it.

The rule the digest is built on: **where a signal is computable, compute it.** A model
is never asked to notice something a `grep` can prove.

See section 3 for the exact contents.

---

## 3. The digest — exactly what he is given

Built by `lib/critique-digest.js` `buildDigest()` from the five sources in
`lib/critique-signals.js`. Rendered for the prompt by `formatDigestForPrompt()`.
Guarded by `tests/critique-digest.test.js`.

**Six signals. Five are computed. One is conversational and it is the smallest.**

| # | Signal | Source | What it contributes |
|---|---|---|---|
| 1 | **Backlog deferral** | `lib/backlog-report.js` + `revisionsSince` | Open count by tier; how many items carry **no filed date at all** (so every age is a floor); the oldest open items with their ages; and how many times `WORK-TODO.md` was edited in the window — each edit being an occasion on which every open item was in front of someone and not closed |
| 2 | **Claimed vs done** | `lib/repo-history.js` `claimsFrom` | `Closes <ID>` against `Addresses <ID>` in commit bodies, and — the sharp one — **items addressed more than once and still open**: work that keeps being touched and keeps not finishing |
| 3 | **Task outcomes** | `lib/task-queue.js` `getRecentCompleted` | Completed / failed / interrupted; each failure with its error and attempt number; tasks **re-run after an earlier attempt**; duration outliers against the median. **The 24-hour retention is printed beside the counts**, because without it an empty section reads as "nothing failed this week" |
| 4 | **Merged vs running** | `commitsSince` + a stated absence | What landed in the window, and that **nothing can say which commit is running** (WORK-TODO #17). The absence is the finding and is rendered as a line, not omitted |
| 5 | **Output that reaches nobody** | `lib/agent-surface.js` `findOrphans` | Reused, not re-derived: the same rows `node scripts/agent-surface.js` prints |
| 6 | **Bulletins** | `lib/bulletin-board.js` | Up to **5**, in-window only. The only conversational input, and deliberately the shortest section |

**Raw conversation is a minor part by construction, not by instruction.** Signal 6 is
capped at five bulletin lines; signals 1–5 are unbounded computations over files and
`git log`. Nothing in the digest is a Slack transcript, because §1.1 established that
no such thing is reachable.

### Three properties that are not negotiable

**(a) An unavailable signal is never an empty one.** Every signal returns
`{ available, reason, … }`. A shallow checkout, an unreadable queue or a corrupt
bulletin file renders as `UNAVAILABLE — <reason>. Do not report this as "nothing to
report".` A critique that went quiet because a sensor broke would be the false-green
this repository files as its worst defect class, delivered in a voice designed to be
believed. `tests/critique-digest.test.js` exercises every source in both states.

**(b) Thinness is judged on the *windowed* signals only** — commits, terminal tasks,
bulletins. The standing backlog is excluded on purpose: an item open for eleven days is
not news on the twelfth, and counting it would make every week look eventful and
guarantee the padded post §4 exists to prevent. **An unavailable signal is not thin** —
it is unknown, and unknown is not quiet.

**(c) `Closes WORK-TODO P1 #18.` means item 18.** The first version of the claim parser
made the `#` optional and read that line — a real commit body here, `6454fb0` — as a
claim about item **#1**, because `P1` supplies a digit first. A parser that fabricates a
citation is worse than one that finds nothing, because the invented one is repeated to a
human as a fact. Regression test:
`tests/repo-history.test.js` → `describe('claimsFrom')` → the `REGRESSION` case, which
fails against the optional-`#` pattern.

---

## 4. The critique — one post, per batch, in his own voice

`lib/weekly-critique.js` `runWeeklyCritique()`, reached from
`DETERMINISTIC_TASKS['weekly-critique']` in `lib/agent-task-catalogue.js`. Guarded by
`tests/weekly-critique.test.js` (38 tests).

**`weekly-critique` moved from `TASK_TEMPLATES` to `DETERMINISTIC_TASKS`** on
2026-09-16. As a template it posted the prose *"Review the week's activities and provide
contrarian takes"* as a `TASK:` message with **no material attached** — and §1 shows
why that could never have worked: the model it reached could read no Slack history and
had a one-commit clone. It would have written something that read like a review. Same
defect as `check-inbox` before 2026-09-14, same fix.

*"Deterministic" here means the material is computed and the destination is decided by
code.* The critique itself is a judgement, and that is the one part a model is for.

### Per batch, never per task

One post per run over one window. Nothing here is invoked per task, per commit or per
event, so there is no path by which he comments on a thing while it is in flight.

### It resolves to the jester, and that is tested rather than assumed

The dispatch's lead — *"the identity fix has landed, so this should hold"* — is true and
re-verified: `bridge-agent.js:1941` passes `channelAgentConfig` into `processTask`, so a
scheduled `TASK:` executes as the channel's agent. (**Cited vs. actual:**
`docs/WIRING-AND-SEAMS.md` §3a cites `:1913`; at HEAD it is `:1941`. Line numbers are
leads. Regenerate with
`grep -n "processTask(msg, channelId\|processConversation(msg, channelId" bridge-agent.js`.)

**The critique does not depend on it.** It is no longer a `TASK:` message, so it never
enters the poll loop. `resolveCritic()` derives the agent from **the same declaration the
cron registrar reads** — the agent whose `schedule.task` is `weekly-critique` — so:

- the cron tick passes jester and gets jester;
- the on-demand verb passes whichever agent's channel the command was typed in (the
  bridge) and **still** gets jester, his channel, his provider and his metrics id.

`tests/weekly-critique.test.js` → `describe('it resolves to the jester, not to the
caller's agent')` asserts all of that, including that the post lands in `C0JESTER` when
the bridge invoked it.

### No fallback chain — the one place this departs from the bridge's LLM path

It calls `runLLM`, not `runWithFallback`. The chain can land on `claude`, whose adapter
spawns a CLI with `--dangerously-skip-permissions` in `cwd` (`lib/llm-runner.js:357`).
Jester's definition **denies `file-system` and `github`**; routing him automatically onto
a tool-capable engine to save a weekly joke is not a trade worth making. A provider
failure is reported to `#sqtools-ops` instead — a missed roast costs nothing.

Defence in depth for an operator who pins him to `claude` on purpose: `maxTurns: 1` and
a **fresh empty temp directory** as `cwd`, removed in a `finally`. Both asserted.

### A thin week calls no model at all

`isThin` (§3) decides, and on a thin week the post is a fixed short line:

> :jester: *Weekly critique* — nothing worth the breath.
> No commits, no finished tasks and no bulletins in the last 7 days. A quiet week is not
> a failure and I am not going to invent one.

**No model is invoked on that path.** A model handed an empty digest and a contrarian
persona will produce a complaint, because that is what it was asked to be. The only
reliable way to get an honest "nothing to report" is not to ask. Every post — thin or
not — carries the coverage line from `formatCoverage()`, which names the sensors that
ran, so a short post is evidence rather than an absence of evidence.

### Failures are reported, never posted around

| Outcome | What happens |
|---|---|
| No resolved channel | Refuses; `#sqtools-ops` is told it is an owner action; nothing posted |
| Provider throws | Reported with the provider's error; nothing posted |
| Provider returns empty | **A failure, not an empty post** |
| The Slack post fails | Reported with the Slack error |
| `notifyOps` itself fails | Logged; the task still returns its verdict rather than throwing |

Reporting is `notifyOps`, **not** `taskFailed`. `taskFailed` also raises a CRITICAL owner
notification, and a weekly CRITICAL for an agent the owner reads at his own convenience
would train the alert to be ignored. A missed joke is an operational note.

---

## 5. He cannot gate anything — enforced, not asserted

The constraint from §0, made executable. `tests/weekly-critique.test.js` →
`describe('HE CANNOT GATE ANYTHING — enforced, not asserted')`:

1. **It writes no state.** The module's source is walked with comments stripped and must
   name **none** of: the approval queue, any task-queue transition, the task lock, agent
   activation, the bulletin board, any `child_process` API, owner-task state, or any
   durable write. Its only filesystem calls are `fs.mkdtemp` and its own `fs.rm` — the
   test asserts that the complete set of `fs.*` calls is exactly those two.
2. **It has one production call site.** A disk walk over every production `.js` file
   asserts that exactly one calls `runWeeklyCritique`: `lib/agent-task-catalogue.js`. A
   second route would fail the test.
3. **The task name is declared in exactly two places** — the catalogue (what exists) and
   the command table (what verb spells it). A third would be a second registry, which
   WORK-TODO #45 forbids.
4. **The verdict is a report.** Both consumers are asserted to use it only to choose what
   text to say: `lib/command-router.js`'s `const ok = verdict?.ok !== false;` and
   `lib/agent-scheduler.js`'s `return { success: verdict?.ok !== false, … }`.
5. **The prompt says so too**, which is the weakest of the five and is not relied on:
   *"You decide nothing and block nothing."*

The guard carries its own negative controls, because assertions of the form "this list is
empty" pass against a broken enumerator.

---

## 6. On demand — the mechanism, reported rather than assumed

**What the command mechanism in this repository actually is, at HEAD:**
`lib/command-router.js`, a verb -> handler table added 2026-09-15. It is reached from
`processConversation` in `bridge-agent.js:1298-1315` — so the spelling is
**`ASK: <verb>`**, and only in the bridge channel, because an agent channel is how an
*agent* is addressed (WORK-TODO #45). `runCommand` returns `{ handled: false }` for
anything it does not own, so the older hand-written `isStatusQuery` / `isOwnerTasksQuery`
ladder below it still runs.

**Not `/dispatch`.** That is the Socket Mode slash command added the same day, and it
does a different job: it composes a `TASK:` message and posts it to `#claude-bridge` for
the poll loop. A critique is not a dispatch — it needs no repository, no clone and no
turn budget.

**`critique` is registered in that table and nowhere else.**

| | |
|---|---|
| Verb | `critique` |
| Kind | `scheduled` — the catalogue owns the operation, the table adds only the spelling |
| Task | `weekly-critique` in `lib/agent-task-catalogue.js` |
| Reached by | `getDeterministicTask('weekly-critique').run()` — **the same call the cron tick makes** |

**One route, two triggers.** The cron registrar and the verb both go through
`getDeterministicTask`, so a scheduled critique and an on-demand one cannot diverge —
that is `lib/command-router.js`'s own stated principle and this follows it rather than
adding a third path. `tests/command-router.test.js` asserts the verb reaches the
catalogue handler, and `tests/weekly-critique-gating.test.js` asserts there is exactly
one production caller of `runWeeklyCritique`.

**The verb is `critique`, not `jester`.** WORK-TODO #45: a command is a verb; an agent is
addressed by its channel. Asserted — `COMMANDS.jester` must not exist, and neither may
the raw task name.

**It posts where the handler decided, and the verdict says so.** `handleScheduledTask`
reported `ctx.agent.channel` unconditionally, which was correct only while every
deterministic task posted where it was pointed. The critique posts into the jester's
channel whichever channel the verb was typed in, so the verdict now names
`verdict.channel` when the handler supplies one (`check-inbox` does not, and is
unchanged). A verdict naming the wrong channel would be a confident false statement about
where to go and look.

**The caller needing no channel of its own.** The entry carries
`resolvesOwnChannel: true`, so the "needs an agent with a channel" refusal — right for
`check-inbox`, which posts into the agent it is handed — does not fire for a handler that
resolves its own destination. Refusing a critique because the *invoking* channel was
unresolved would be a refusal about the wrong thing.

---

## 7. The one thing this repository cannot do

**`#jester-agent` does not exist and has never resolved.** Reconstructing this
workspace's channel map from git history reports it explicitly:

```bash
node scripts/channel-map.js --from-git
# Not recoverable from history — these had no id in the legacy registry:
#   jester (active) declares #jester-agent
```

He is declared and active, and his schedule is **refused at every boot** for that
reason — visibly, since WORK-TODO #3 (`lib/agent-scheduler.js`), and printed by
`node scripts/agent-surface.js` as
`jester: schedule declared but #jester-agent has not been resolved to a channel id`.

**Creating the channel is an owner action** (`ASK: create channel #jester-agent`,
needs `channels:manage`) and no dispatch may do it. Until it is done, everything in
this document is built, tested and inert: the scheduled job stays refused and the
on-demand verb refuses with that exact reason rather than posting somewhere else.
