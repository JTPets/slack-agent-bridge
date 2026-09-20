# The dispatch and batch operating model — a proposal

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
>
> **A proposal. Nothing here is built.** No branch is cut, no lock is taken, no queue
> policy is enforced and no code changes in the branch that filed this. §2 records
> decisions; §4 records what they require that does not exist; §5 records what the model
> would have prevented, from evidence already in this repository.
>
> **In the series with** [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md),
> [`COMMAND-SURFACE.md`](COMMAND-SURFACE.md),
> [`STATE-AND-MEMORY-DESIGN.md`](STATE-AND-MEMORY-DESIGN.md),
> [`CAPABILITY-AND-ISOLATION-DESIGN.md`](CAPABILITY-AND-ISOLATION-DESIGN.md) and
> [`KNOWLEDGE-BASE-PROPOSAL.md`](KNOWLEDGE-BASE-PROPOSAL.md). **It does not replace the
> loop design and does not restate it** — §3 says exactly which of that document's
> decisions this model reuses, and where the two are in tension.
>
> **The decisions in §2 were made by the owner** in a 2026-09-20 working session. They are
> written down with their reasoning so a future executor does not reopen them. They are
> **not** derived here and are **not** open questions. If you disagree with one, say so to
> the owner — do not quietly implement the other choice.

**Why this document exists.** The model existed only in chat. An operating procedure that
lives in conversation is re-derived from memory every night, and re-derivation is where the
drift starts — the same argument [`CANONICAL-HELPERS.md`](CANONICAL-HELPERS.md) makes about
behaviour and [`COMMAND-SURFACE.md`](COMMAND-SURFACE.md) makes about verbs.

**Every claim about current state carries the command that regenerates it.** Anything
supplied by the owner and not checkable from a checkout is labelled
**operator-supplied** at the point it is used.

---

## 0. Why this is a new document rather than a section, and why it is a proposal

This repository's rule is that an executor does **not** create a long-lived document
unilaterally — it proposes one and stops
([`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) §6, "Do not create a new long-lived
document unilaterally: propose it and stop").

**A document explicitly framed as a proposal is the established shape here, and that is
what this is.** All five documents named in the banner were created by a dispatch, and each
opens by declaring that nothing in it is built:

```bash
# the declaration each of the five opens with (five lines, one per file)
grep -n "Nothing here is built\|nothing in it is built\|Status: design only\|Nothing is built by the change that filed this" \
  docs/AUTONOMOUS-LOOP-DESIGN.md docs/COMMAND-SURFACE.md docs/STATE-AND-MEMORY-DESIGN.md \
  docs/CAPABILITY-AND-ISOLATION-DESIGN.md docs/KNOWLEDGE-BASE-PROPOSAL.md
# each was added by one dispatch: bc2ce7f (2026-09-14) and four on 2026-09-16
git log --diff-filter=A --format='%h %ad %s' --date=short -- \
  docs/AUTONOMOUS-LOOP-DESIGN.md docs/COMMAND-SURFACE.md docs/STATE-AND-MEMORY-DESIGN.md \
  docs/CAPABILITY-AND-ISOLATION-DESIGN.md docs/KNOWLEDGE-BASE-PROPOSAL.md
```

So the choice is between a section inside
[`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) and a document of its own.
**A section was rejected on subject, not on size.** That document describes a *machine*
loop inside *one* repository in which the merge gate is mechanical and no human approves
each merge (its D1). This model describes an *operator's* nightly cycle across the *estate*
in which the morning review is the merge gate and is the scarce resource (B7). Folding the
second into the first would put two different answers to "who merges" in one document, and
the next reader would take whichever they hit first.

**What this document is not:** it is not a living document and must not become one. It
records decisions and the state they depend on. It changes when a decision changes, or when
a cross-referenced item closes — not as work proceeds.

---

## 1. Scope — what is being modelled

The unit is a **batch**: one evening's worth of dispatched work across the estate, landing
as one review in the morning.

| | [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) | This document |
|---|---|---|
| Unit | one task | one night's batch |
| Scope | this repository | the estate (see below) |
| Who merges | nobody — a mechanical gate (D1) | **the operator, in the morning** (B1, B7) |
| Gate runs | per branch, then against `main` after each merge (D2) | **once**, against one integration branch (B1) |
| Status | design only, blocked on merge-state knowledge (its §4 part five) | **proposal**, blocked on the same thing plus §4 below |

**The estate is three repositories, and the harness can dispatch into one of them.** Two
are node (`jtpets/slack-agent-bridge`, `jtpets/SquareDashboardTool`), the third is python
(`jtpets/dayz-discord-bot`). Regenerate the configured half:

```bash
grep -n "\`REPOS\`" CLAUDE.md                # the row, carrying the default
node -e "console.log(require('./lib/config').getConfiguredRepos())"
# -> [ 'jtpets/slack-agent-bridge', 'jtpets/SquareDashboardTool' ]   (the default; .env may widen it)
```

The bridge has never had access to `jtpets/SquareDashboardTool` — that boundary is
deliberate and its constraints are recorded as **WORK-TODO #57**. The python repository
cannot be dispatched to at all — **#68**. See §4.

---

## 2. The model, as decided

Lettered `B1`–`B8` so a dispatch can cite one. **These are the owner's decisions.**

### B1 — One integration branch per batch: cut from `main`, merged into, gated once, reviewed and merged in the morning, then deleted

A batch gets exactly one integration branch, cut fresh from `main`. Each of the night's
green branches is merged into it. The gate runs **once**, against that branch. In the
morning the operator reviews it and merges it to `main`. **Then the integration branch is
deleted.**

**Reasoning — a dated disposable branch cannot drift; a long-lived parallel `main` does.**
The failure being avoided is a second trunk. A branch that survives more than one batch
accumulates its own history, acquires its own merge conflicts against `main`, and becomes a
thing whose relationship to `main` has to be worked out before anything can be read. A
branch that is cut in the evening and deleted by lunchtime has no time in which to diverge:
its base is `main` as of one known moment, and the only thing on top of it is the batch.

**The deletion is part of the decision, not tidying.** The branch's purpose ends at the
merge; the record is the merge commit and the source branches' commit bodies (B2). Keeping
it is what turns it into the parallel trunk the decision exists to prevent.

**Gating once is the point, not a saving.** A per-branch gate answers "does this branch
pass against its own base", which is a different claim from "does the tree that will exist
after all of tonight's work pass" — the distinction
[`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) D2 makes and which is not
re-argued here. The integration branch **is** that tree, so one run against it is a
statement about what will ship.

### B2 — The batch is built by MERGING, never cherry-picking and never rebasing

`git merge` each source branch into the integration branch. Do not `cherry-pick`, do not
`rebase`, do not squash.

**Reasoning — the commit body is the record, and each branch's `Closes` bodies must survive
intact.** This repository's closure convention is that a closed item is purged from
`WORK-TODO.md` and the `Closes <ID>` commit body becomes the only record of it
([`WORK-TODO.md`](../WORK-TODO.md) header; [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md)
§4). `lib/repo-history.js` `claimsFrom` reads those bodies to answer what was claimed
(`lib/repo-history.js:153-161`). A squash collapses several bodies into one and a
cherry-pick copies a subset; either loses claims that nothing else holds.

**A rebase preserves the body and destroys the address.** It replays commits as new
objects, so every SHA changes while every message survives — which is the worst shape,
because the record still *reads* correct while every citation of it has become
unresolvable. That is not hypothetical here:

```bash
# five commits authored 2026-09-16, committed 2026-09-20: replayed, not merged
git log --format='%h author=%ad committer=%cd %s' --date=short -6 38d165b
```

Those five carry the design documents this one joins. Their pre-rebase SHAs are reachable
from nothing in this repository. **What that breaks is how this repository cites its own
history:** `WORK-TODO.md` refers to commits by short SHA throughout, and a replayed commit's
old SHA resolves to nothing —

```bash
grep -oE '\b[0-9a-f]{7}\b' WORK-TODO.md | sort -u | wc -l   # distinct short SHAs cited in the backlog alone
```

— and `#67` records a second cost of the same operation: the renumbering it forced.

**What this decision does not say.** It does not say a source branch may be stale. A
branch's own base must be current when its author pushes
([`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) §1: `git log HEAD..origin/main` empty).
B2 is about how the batch is assembled from branches, not about how a branch reaches the
batch.

### B3 — The batch holds a lock on `main`: nothing new is gated until it merges or is abandoned

While a batch is open, no other work may be gated. The batch is the only candidate for
`main`.

**Reasoning.** The gate's verdict is a statement about one tree. A second gated candidate
means two trees, each unaware of the other, each claiming to be the next `main` — and
whichever merges second was gated against a base that no longer exists. That is the same
failure [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) D2 describes, arriving
from the other direction.

**Abandoning is cheap, and is the right move when the review cannot happen.** If the
morning review does not happen — the operator is unavailable, the batch is wrong, a
decision is needed first — the batch is abandoned and the lock is released. **The source
branches are durable; the integration branch is scaffolding.** Abandoning loses the merge
and the gate run, and loses no work: every branch in it is still pushed, still green, and
still available to the next batch. That asymmetry is what makes the lock affordable — a
lock you cannot release without losing work becomes a lock nobody takes.

**The lock is not a file.** Nothing in this repository implements it; see §4.

### B4 — One code-change dispatch in flight per repository

At most one dispatch that changes code may be open against a given repository at a time.
Different repositories may be dispatched to in parallel.

**Reasoning — repositories share no base, so they parallelise; two branches in one
repository collide.** Two branches cut from the same base in the same repository contend for
the same files, the same backlog IDs and the same migration or config slots, and the
collision surfaces at merge time rather than at dispatch time.

**Three collisions were observed on 2026-09-20 — this repository twice, SqTools once.**
The count is **operator-supplied**. One of the three is verifiable here and is filed:
`#57`–`#61` were allocated independently by two branches cut from the same base and had to
be renumbered to `#62`–`#66` before the second could land (**WORK-TODO #67**, and the
"`### 43.` collision" section above it in that file). The SqTools instance cannot be
checked from here at all — the bridge has no access to that repository (#57).

**"Code-change" is the qualifier that does the work.** A read-only dispatch — an audit, an
investigation, a document — does not contend for the same files and is not covered by this
limit. That is what makes B5 possible.

### B5 — Skew queued work toward what verifies by READING, not by running

Given a choice of what to dispatch, prefer work whose verification is a read: an audit, an
enumeration, a design record, a documentation correction, a finding filed with evidence.

**Reasoning — code changes are the scarce thing because verification is serial.** B4 caps
code changes at one per repository and B3 caps gated candidates at one, so a night's
throughput in code is bounded by the gate, not by executor time or tokens. Work that is
verified by reading is bounded by neither: it can run in parallel, it cannot collide with a
code change in the same repository, and its review is a read the operator can do in the
same pass as the diff.

**This is a queueing decision, not a quality one.** It does not say reading work matters
more. It says the serial resource should be spent on the work that requires it.

### B6 — On a failed gate: bisect by dropping the last-merged branch and re-gating, capped at THREE attempts, then stop and report

If the batch's gate run is red, drop the most recently merged source branch from the
integration branch, re-gate, and repeat. **At most three attempts.** Then stop and report
what was tried.

**Reasoning — an uncapped bisect can consume a whole night.** The cap is external to the
thing being bounded, which is the same argument
[`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) §3 makes about the Ralph
technique's iteration limit and its D5 generation cap: a bound that depends on the process
deciding it has finished is not a bound. Three attempts is where the evidence stops being
about which branch is bad and starts being about whether the batch was assembled correctly.

**Dropping the last-merged branch first is an ordering heuristic, not a search.** It is not
a binary bisect and does not claim to be: the most recent merge is the likeliest culprit,
and re-gating after each drop is what costs. A batch whose failure is not found in three
drops is reported, not searched further.

**This does not conflict with halt-don't-heal.** The bisect happens on a disposable branch
that has not merged (B1). [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) D3
forbids auto-reverting and auto-fixing a **red `main`** — a tree that is already in an
unexpected state and whose evidence a revert would erase. Nothing here touches `main`, and
a dropped branch is not reverted: it is still pushed and still green on its own. The
prohibition and the cap are about different trees.

### B7 — THE CONSTRAINT: the ceiling is the operator's review time

Not executor time. Not tokens. Not the gate's wall clock.

**Reasoning, and why it is written as a decision rather than an observation.** Every other
lever is elastic — more dispatches can be sent, longer turn budgets can be granted, more
gate runs can be paid for. The morning review is not: it is one person, once, and
everything in the batch has to pass through it. So the batch is sized to what can be
reviewed, and B5 follows from it directly rather than being a separate preference.

**What this predicts, and it is worth stating so the model can be judged against it:** the
first symptom of a batch that is too large is not a failed gate. It is a review that
approves something it did not read.

### B8 — A P0 discovered mid-batch invalidates the batch's BASE, not just its priority

**Two options are recorded. Neither is chosen.**

The point of the decision is the reframing: a P0 found while a batch is open is not simply
the most important item in the queue. If it is fixed, the fix lands on `main`, and every
branch in the open batch was cut from a `main` that no longer describes the tree. The batch
has a stale base, which B3's lock was holding precisely to prevent.

| Option | What it costs |
|---|---|
| **(a) Rebase on merge** — land the P0 on `main`, then bring the batch's base forward before gating | It re-gates the whole batch, and B2's objection applies to the mechanism: bringing a base forward by rebasing the integration branch replays every source branch's commits and destroys their SHAs. A merge of `main` into the integration branch does not, and is the shape to prefer if this option is ever taken |
| **(b) The P0 rides the next batch** — unless money is actively leaking | The defect stays live for the length of one batch. "Money is actively leaking" is the stated exception and is deliberately a judgement, not a threshold |

**Not chosen, deliberately.** The choice depends on how long a batch is open and how bad
the P0 is, and neither is known from one session. **Do not implement either.** A dispatch
that needs an answer asks the owner.

---

## 3. What this model reuses from the loop design — cited, not restated

Read [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) §2 for the reasoning behind
each of these. It is not reproduced here.

| Its decision | How this model relates to it |
|---|---|
| **D1** — the merge gate is the review verdict plus a green suite, not a human | **Replaced for this model.** B1/B7 put a human at the gate, once per batch rather than once per task. The two documents describe different regimes; this is the one that is operated today |
| **D2** — the suite runs against the merged tree, not only the branch | **Reused, and B1 is its cheapest implementation.** The integration branch *is* the merged tree, so one run answers D2's question for every branch in the batch at once |
| **D3** — a red `main` halts and reaches the owner; no auto-revert, no auto-fix | **Reused unchanged.** B6's bisect runs on an unmerged disposable branch and never touches `main` |
| **D4/D5** — findings become tasks; generations capped at two | **Not addressed here.** This model says nothing about how a review finding becomes work; it is orthogonal to how a batch is assembled |
| **D6** — the same finding recurring is a stop, not a retry | **Not addressed here.** Same reason |
| **D7** — a spawned fix task preempts the queue | **Related to B8 and not the same question.** D7 is about a fix task concerning *merged* code jumping the queue. B8 is about a P0 invalidating the *base* of an open batch. D7's mechanism does not answer B8, which is why B8 is left undecided |
| **§3** — the Ralph technique: an external iteration limit is the primary safety mechanism | **Reused as the justification for B6's cap of three.** Do not re-derive the argument; cite §3 |
| **§4 part five** — nothing knows whether a branch merged (WORK-TODO **#39**) | **This model needs it too.** See §4 |

**Also already covered elsewhere, and deliberately not repeated:** the branch gate a source
branch must satisfy ([`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) §1); what counts as
proof and when `Closes` is allowed (§4 there); that a merge to `main` deploys nothing
without a human restarting the container (`CLAUDE.md` → "Self-update — DESIGNED AND TESTED,
NOT WIRED", **#17**).

---

## 4. What this model requires that does not exist — cross-referenced, not re-filed

Each of these is already filed. **Nothing in this section is a new backlog item**; the
gaps are cited so the model's dependencies are readable, and re-filing them would create
the duplicate addresses `#67` is about.

### 4.1 There is no lock, anywhere

B3 is the load-bearing decision and nothing implements it. The only lock in this repository
is per-task and is not mutual exclusion:

```bash
grep -n "DEFAULT_LOCK_FILE" lib/task-lock.js        # $WORK_DIR/.task-running
sed -n '500,516p' bridge-agent.js                   # "Best effort: a task that cannot write its lock still runs"
```

`lib/task-lock.js` exists to tell `auto-update.js` not to restart mid-task
(`CLAUDE.md` → "Task lock and self-update deferral"), and `auto-update.js` is never
started (**#17**). It is not a gate lock and was never meant to be one.

**PRIOR ART, cited and not read: SqTools' merge gate has no lock either.** Its runner
shares one review clone and one `sqtools_it` database, so two concurrent runs produce a
verdict that is untrustworthy in **either** direction — and the discipline that prevents
that is an operator rule, not a mechanism. **This is operator-supplied and cited from the
owner's account only.** The bridge has no access to `jtpets/SquareDashboardTool` (**#57**),
so nothing here has read that runner's code, compose file or output, and no claim about its
contents should be read into this paragraph. Verifying it is a separate dispatch against
that repository. The same citation rule is already used by **#70** for the same runner.

### 4.2 The harness cannot serve the whole estate

B4's parallelism across repositories assumes each repository can be dispatched to. **Two of
the three cannot be, and the two reasons are different:**

- **#68 — the image serves node only**, so the python third of the estate
  (`jtpets/dayz-discord-bot`) fails at dependency install with `INSTALLER_ABSENT` before
  the LLM writes anything. Correct, loud, and still a repository that cannot be batched.
- **#57 — SqTools access is deliberately absent**, so the second node repository is not
  reachable from the bridge either. The constraints that must hold before that changes are
  recorded on the item; none is designed here.

**And #70 is why #68 is stuck rather than fixable:** `image: node:20` with no `build:` key
and no `Dockerfile` in the repository's entire history, so the toolchain is whatever
resolved at the last container start and there is nowhere for anything needing root to go.
Adding a runtime to the image is a build step this deployment does not have.

So the model as decided describes an estate of three and the bridge can currently dispatch
into one. That is a statement about the harness, not about the model.

### 4.3 Nothing can tell a completed dispatch from a landed one, and nothing observes `main`

B1's morning merge and B3's lock release are both events about **merge state**, and merge
state is unknowable here:

- **#39** — the queue row has no branch, commit or merge field; a task reaches `completed`
  when the executor's process exits. Already cited by
  [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) §4 part five as the blocker for
  that loop; it blocks an automated version of B3 for the same reason.
- **#66** — nothing watches the repository, so a merge is observed by nothing.
- **#17** — nothing can say which commit the running process is on, so "merged" and
  "deployed" remain unrelated facts.

**None of this stops the model being operated by hand today**, which is what it is: the
operator knows the batch merged because they merged it. The gaps matter only for a version
that tracks or enforces any of it.

### 4.4 The bridge cannot run two dispatches at once at all — reported here, not previously filed

B4 permits one code-change dispatch per repository in parallel. **The bridge permits one
dispatch, period, across every repository and every channel:**

```bash
sed -n '1866,1868p' bridge-agent.js     # async function poll() { if (isRunning) return;
grep -n "await currentTaskPromise" bridge-agent.js   # 1902, 1980 — processTask is awaited inside poll()
```

`poll()` returns immediately while a task is running, and `processTask` is awaited inside
the per-channel loop, so a ten-minute task blocks every other channel's intake for its
whole duration. Nothing in `docs/` or `WORK-TODO.md` states this:

```bash
# stated nowhere else: excluding this file, it prints nothing
grep -rn "isRunning" WORK-TODO.md docs/ | grep -v DISPATCH-AND-BATCH-MODEL
```

**What follows, and what does not.** B4's cross-repository parallelism therefore cannot be
served by one bridge container; parallel dispatches today come from somewhere the bridge's
queue and lock do not see — a second session or a hand-run executor — which is also why
`ASK: what's queued` cannot describe a batch. **This is reported, not fixed, and no item is
filed for it by this document**, because whether the poll loop *should* be concurrent is a
decision with a blast radius (`WORK_DIR` is shared, dedup is by message `ts`, the task lock
is a single file) and this is a documentation change. It is named here so the next reader of
B4 does not assume a capability that does not exist.

### 4.5 "Verified" does not mean the same thing in the two repositories

The two gates are not comparable, and a batch spanning both must say which one it ran.

| | This repository | SqTools |
|---|---|---|
| The gate | `npm test` in the scratch clone, classified by `lib/test-verdict.js` (`lib/code-review-pipeline.js:362-368`), plus `npm run test:smoke` (**1 suite, 29 tests, 1.7 s** — measured 2026-09-20) and `npm run validate` | A pinned-clone runner, ~30–35 min, 49 real-Postgres suites, all-or-nothing, no subset runs — **operator-supplied, not readable from here (#57)** |
| A skip | **Not a live hazard here — measured, not assumed.** `npm test` at this commit: **78 suites, 2443 tests, 0 skipped, 14.9 s** (2026-09-20, after `npm ci`). There is no Postgres and no suite gated on one | **A skip-green is not a green** — an executor container without Postgres skips ~47 suites and still reports "0 failed" |

**A cited-vs-actual correction, because the shorthand is wrong in a way that matters.**
"The bridge gate is `node --check` plus the smoke suite" describes `verifyEntryPoints` and
`runSmokeTest` in `lib/update-verifier.js` (entry-point list at
`lib/update-verifier.js:47-55`), reached only from `checkForUpdates()` in `auto-update.js`
(`auto-update.js:694`) — **which nothing starts** (**#17**). That is the *self-update*
gate and it has never run outside tests. The gate that actually runs on a dispatch is
Phase 3's full `npm test` in the scratch clone. Both are far weaker than SqTools'; they are
weaker in different ways, and a report comparing the two must name which it means.

---

## 5. What this model would have prevented, from evidence already here

Not a justification — a check that the decisions are about observed failures rather than
imagined ones, which is the standard
[`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) §3 sets.

| Observed | Which decision addresses it |
|---|---|
| `#57`–`#61` allocated twice by two branches cut from the same base, resolved by renumbering the unmerged side (**#67**) | **B4** — one code-change dispatch per repository. The colliding side was not in the tree, so no pre-flight check could have caught it; only not having two open branches could |
| Five commits authored 2026-09-16 and replayed on 2026-09-20 (`git log --format='%h author=%ad committer=%cd' -6 38d165b`), their original SHAs now unreachable | **B2** — merge, never rebase. The bodies survived; the addresses did not |
| Six pull requests merged one at a time on 2026-09-20, each cut from the then-current tip (`for m in e93b839 8ad5791 5749d08 57436d8 ae1c97c b901742; do git rev-list --count $(git merge-base $m^1 $m^2)..$m^1; done` → six zeros) | **B1/B3** — six serial review-and-merge cycles is what a batch replaces with one, and B7 is why that is the figure worth reducing |
| `#61` closed by `723dfed` while its heading stayed in `WORK-TODO.md`, found by a later pass rather than by a check (**#69**) | **B1's morning review**, as the single place a batch's claims are reconciled against the file. Note what it does *not* fix: nothing *detects* the mismatch, which is #69's own point |

---

## 6. Not decided here

- **B8's two options.** Recorded, neither chosen. A dispatch that needs one asks the owner.
- **Whether any of this is mechanised.** The model is operated by hand. Automating B3's
  lock or B1's gate needs §4.3, and §4.1 says there is nothing to build on yet.
- **Whether the poll loop should be concurrent** (§4.4). Reported; the decision has a blast
  radius and belongs to the owner.
- **Batch size.** B7 names the constraint and does not put a number on it. A number
  asserted without a night's evidence behind it would be a figure with no regeneration
  command, which this repository does not accept.
