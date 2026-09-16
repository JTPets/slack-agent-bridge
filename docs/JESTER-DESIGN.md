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

## 3. The digest

*(Specified in `lib/critique-digest.js`. This section is the contract; the module is
the implementation and `tests/critique-digest.test.js` is the guard.)*

---

## 4. The critique

*(See `lib/weekly-critique.js`.)*

---

## 5. He cannot gate anything

*(See `lib/weekly-critique.js` and `tests/weekly-critique.test.js`.)*

---

## 6. The one thing this repository cannot do

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
