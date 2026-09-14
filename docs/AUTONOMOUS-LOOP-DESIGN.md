# The autonomous task loop — design of record

> **Working on this repo?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
> This document records *decisions*, not code. Nothing described here is wired.

**Filed 2026-09-14.** Authorised by the owner. The decisions in §2 were **made by the
owner**, not derived here; they are written down with their reasoning so that a future
executor implementing a piece of this does not reopen them. If you disagree with one,
say so to the owner — do not quietly implement the other choice.

**Status: design only.** No part of the loop exists. §4 lists the four things that must
exist before any of it can be built, three of which are being built alongside this
document; the fourth is not.

---

## 1. The loop

The target is a closed cycle. A task leaves the queue, is worked, is judged, and either
lands or comes back as more work — and only when it has landed does the next task start.

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼                                                          │
   ┌─────────┐   dispatch   ┌────────┐   push    ┌──────────────┐  │
   │  queue  │ ───────────▶ │ worked │ ────────▶ │ review phase │  │
   └─────────┘              └────────┘           └──────┬───────┘  │
        ▲                                               │          │
        │                          clean verdict        │ findings │
        │                          + green suite        │          │
        │                                ▼              ▼          │
        │                          ┌──────────┐   ┌───────────────┐│
        │                          │  merge   │   │ spawn a task  ││
        │                          └────┬─────┘   │ (preempts the ││
        │                               │         │  queue)       ││
        │                               ▼         └───────┬───────┘│
        │                     ┌───────────────────┐       │        │
        │                     │ suite against the │       └────────┘
        │                     │ merged main       │
        │                     └─────┬───────┬─────┘
        │              green        │       │  red
        └───────────────────────────┘       ▼
                                     ┌─────────────────────┐
                                     │ HALT the queue,     │
                                     │ tell the owner.     │
                                     │ No auto-revert,     │
                                     │ no auto-fix.        │
                                     └─────────────────────┘
```

Seven states, and the transitions between them are the whole design:

| State | Enters from | Leaves to |
|---|---|---|
| `queued` | a `TASK:` message, or a spawned fix task | `dispatched` |
| `dispatched` | the loop picking the next item | `worked` |
| `worked` | the executor pushing a branch | `reviewed` |
| `reviewed` | the review phase returning a verdict | `merging` (clean) or `spawning` (findings) |
| `merging` | a clean verdict **and** a green suite | `verifying-main` |
| `verifying-main` | the merge landing | `queued` (green) or `halted` (red) |
| `halted` | a red `main` | **the owner**, and nothing else |

---

## 2. Decisions

These are the owner's, recorded with their reasoning. **They are not open questions.**

### D1 — The merge gate is the review verdict plus a green suite, not a human

A human does not approve each merge. The gate is mechanical: the review phase returns a
clean verdict, and the suite is green.

**Reasoning.** Git makes a bad merge recoverable. The cost of a wrong merge is a revert;
the cost of a human in every cycle is that there is no loop, only a queue with a person
at the front of it. Recoverability is what makes the mechanical gate affordable, and it
is why D2 exists — recoverability decays with every commit built on top of the bad one.

**What this does not say.** It does not say the gate is weak. It says the gate is the
verdict and the suite, which is exactly why parts 2 and 3 of this work (a verdict that
can be read, and a suite that cannot report a pass without running) are prerequisites
rather than improvements.

### D2 — The suite runs against `main` after each merge, not only against the branch

Every merge is followed by a run of the suite against the merged tree.

**Reasoning.** The expensive failure is not a bad merge. It is a bad merge that later
tasks build on before anyone notices — by then the revert is not one commit, and the
tasks that were worked on top of it were worked against a broken base.

**A branch that passes alone and a tree that passes after merging are different claims,
and only the second one describes what shipped.** A branch suite runs against the branch's
own base, which may be several merges behind; it cannot see a semantic conflict with work
that landed while the branch was open (two branches each adding a differently-named helper
for the same behaviour, one branch renaming a function another branch started calling).
Git reports no textual conflict for either. Only the post-merge run is a statement about
the tree that exists.

### D3 — A red `main` halts the queue and reaches the owner; it does not self-heal

On a red post-merge run: stop dispatching, tell the owner. Do **not** auto-revert. Do
**not** auto-dispatch a fix.

**Reasoning.** Both automatic responses are guesses about a tree that is already in an
unexpected state, and both make the next diagnosis harder — a revert erases the evidence
of what the merge did, and an auto-dispatched fix adds a second unreviewed change on top
of a broken base while the loop is, by definition, not able to judge its own output
correctly. Revert versus fix-forward is a judgement about what the change was for, and
that judgement is the owner's when they look.

Halting is not a cost being accepted reluctantly; it is the point. A loop that keeps
dispatching against a red `main` produces work that must be redone.

### D4 — A review finding creates a task, reviewed like any other

A finding does not go into a report a person reads. It becomes a task, and that task
goes through the same dispatch → work → review cycle. The loop closes through the rework
path as well as the happy path.

**Reasoning.** A rework path that is not itself reviewed is an unreviewed write path into
the same repository — the exact thing the review gate exists to prevent. Making rework
ordinary is also what keeps the design honest: if the review verdict is not good enough
to act on automatically, that is a defect in the verdict, not a reason for a side channel.

**Bounded, because an unbounded rework path is a loop that never terminates.** Every
spawned task carries its **lineage**:

| Field | What it is | Why it must be there |
|---|---|---|
| `originatingTaskId` | the task whose review produced the finding | without it the chain cannot be reconstructed after the fact |
| `ruleId` | the finding's stable rule identifier (see §4, part two) | this is what makes "the same finding again" answerable |
| `generation` | 0 for an owner-submitted task, +1 per spawn | the only thing that can stop the chain |
| `findingRef` | file, line, severity as the review reported them | so the spawned task states the defect, not a paraphrase of it |

### D5 — Cap generations at two, then escalate to the owner

`generation` 0 is the original task. A finding on it spawns generation 1. A finding on
that spawns generation 2. **A finding on generation 2 escalates to the owner instead of
spawning generation 3.**

**Reasoning.** Two attempts is where the evidence stops being about the code and starts
being about the loop's ability to understand the task. A third attempt is cheap to run
and expensive to trust.

### D6 — The same finding recurring in a later generation is a stop, not a retry

If a spawned fix task's own review produces a finding with the **same `ruleId`** as the
finding that spawned it, the chain stops there and the owner is told — even if the
generation cap has not been reached.

**Reasoning.** A fix that produces the identical warning is not converging. More attempts
do not help; they produce more commits that each fail the same way. This is the reason
§4 part two is a prerequisite and not a nicety: **string-matching prose drifts.** A
finding rendered as `"No LOGIC CHANGE comment found in modified file: lib/foo.js"` and
the same finding on the next generation rendered as
`"No LOGIC CHANGE comment found in modified file: lib/foo.js, lib/bar.js"` are the same
rule and different strings. Comparison must be by rule identifier or this decision cannot
be implemented at all.

### D7 — A spawned fix task preempts the queue rather than queueing behind it

A spawned fix task goes to the **front**. Queued work waits.

**Reasoning.** A spawned fix task is about the current state of merged code. Everything
behind it in the queue will be worked against that code. Letting unrelated work run first
means each of those tasks is dispatched against a state the loop has already judged
defective, and their reviews will be arguing about a base that is about to change.
Preemption also keeps D5's generation chain short in wall-clock time, which is what makes
the lineage legible when the owner is eventually shown it.

---

## 3. Prior art: the Ralph technique — what transfers and what does not

Worth naming because someone will otherwise re-derive it, and because two of its lessons
apply directly.

**What it is:** a shell loop feeding an agent the same prompt file over and over, each
iteration starting with a fresh context. State lives on the filesystem rather than in
conversation history — the agent reads what previous iterations wrote and writes what the
next one will read.

**The two lessons that transfer:**

1. **The iteration limit is the primary safety mechanism, not a completion string.** An
   agent asserting it is finished is a claim from the thing being bounded. A generation
   cap (D5) is external and holds regardless of what the agent believes. This is why D5
   is a count and not "stop when the review says it is clean".
2. **Guardrails are added in response to observed failures, not designed up front.** The
   guards worth having are the ones some specific failure demanded. Applied here: §4 does
   not list everything that could go wrong. It lists four things, three of which have a
   named prior failure behind them.

**Where it differs, so do not model this design on it:** Ralph has **no reviewer** and a
**single agent** — the thing doing the work is the thing judging it, which is why its only
real bound is the iteration count. This loop has a separate review phase producing a
verdict, and the verdict is the merge gate (D1). That changes what can go wrong: Ralph's
failure mode is drift with nobody watching; this loop's failure mode is a **verdict that
lies** — a green with no assertions behind it (§4 part three), or a finding that cannot be
compared to the previous one (§4 part two). Those are the failures worth guarding, and
they are not Ralph's.

---

## 4. What the loop requires that does not exist yet

Four things. Three are being built alongside this document; the fourth is not, and is the
reason none of the loop can be wired today.

### Part two — a verdict that can be consumed by something other than a person

The review phase (`validateOutput`, `lib/code-review-pipeline.js`) already returns a value
to its caller rather than only posting. What it returns is prose in string arrays. D6
needs findings comparable by a stable identifier; prose cannot supply one.

**Built in this change.** See `lib/review-findings.js`.

### Part three — a test gate that cannot report a pass without running assertions

D1 makes the suite the merge gate. A gate that can return green while executing zero
assertions is not a gate, and this has already happened here: the post-task review ran
under an install that omitted development dependencies, the runner was absent, and the
result read as a tooling hiccup rather than a failed gate.

**Built in this change.** See `lib/test-verdict.js` and `tests/test-gate-honesty.test.js`.

### Part four — every failure reaching a human

The loop's halt state (D3) and its escalations (D5, D6) are only real if the message
arrives. Today several failure paths end at a `console.error` in a container nobody tails.

**Partly built in this change** — the unambiguous destinations are wired; the judgement
calls are proposed and stopped on. See §5.

### Part five — knowledge of merge state. **Not built. This is the blocker.**

The loop's central transition is `merging → verifying-main`, and **nothing in this system
knows whether a branch merged.** The task queue's row is created by `enqueue()`
(`lib/task-queue.js`) with `{ id, msgTs, channelId, text, description, repo, status,
enqueuedAt, startedAt, completedAt, error }` and nothing else; there is no branch, no
commit, no merge field. Regenerate:

```bash
grep -n "const queuedTask = {" -A 14 lib/task-queue.js
grep -rniE "merged|landed|pull_?request|isMerged" --include='*.js' lib/ bridge-agent.js | grep -v node_modules
```

The second command returns nothing about merges. A task reaches `completed` when the
executor's process exits successfully — which says the work was *done*, not that it
*landed*. **A completed task and a landed task are indistinguishable in this system**,
and D1, D2 and D7 all depend on telling them apart.

This is compounded by a second gap that is already filed: **nothing can answer which
commit the running process is on** (`WORK-TODO.md` #17, final section). So even a loop
that knew a branch had merged could not tell whether the merged code was running.

**Until part five exists, the loop cannot be built.** Parts two, three and four are worth
landing regardless — each closes a real defect on its own — but they are prerequisites,
not the thing.

---

## 5. Failure paths and their destinations

*(Written in the part-four change; see the commit that adds this section.)*
