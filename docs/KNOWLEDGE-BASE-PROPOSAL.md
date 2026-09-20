# A business knowledge base his agents and his staff can both read — a proposal

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
>
> **This is a proposal and nothing in it is built.** No repository is created, no content
> is written, no retrieval is implemented, and no agent is activated by the change that
> filed it. The deliverable is the argument and the constraints it ran into.

---

## 1. What is being asked for

A wiki of how JT Pets actually works, with **two readers who want different things from
the same page**:

- **Staff**, at a counter, with a customer waiting. Short, findable, task-shaped. The
  answer must be readable in the time it takes to look down at a phone.
- **An agent**, answering the same question with no time pressure and a larger budget for
  nuance.

**The shape that serves both is one file per subject: a plain title, the answer near the
top, the reasoning below.** Staff read the top. An agent can use the whole file. There is
no second "agent version" to keep in step with the first — which matters, because the
moment there are two documents about one subject, the interesting one and the accurate one
diverge and nobody is told.

A plain title matters for the same reason: **the title is the retrieval index** until
something better exists. "Return a bag of food" beats "Returns & Exchanges Policy v2".

---

## 2. Where it lives

**Recommendation: a separate private repository.** `jtpets/jt-knowledge` or similar; the
name is the owner's.

### The argument for a separate repository

**Reading a repository needs no new mechanism.** A task already clones a GitHub repository
into a scratch directory and hands the executor the tree. That is the whole retrieval
story for a first version: a task with `REPO: jtpets/jt-knowledge` produces an agent that
can read every file in the wiki. No index, no embedding store, no vector database, no
chunking strategy — a `grep` and a file read, which is what `reviewTask()` already does
to a cloned repository (`lib/code-review-pipeline.js`).

**A wiki wants the properties a repository has anyway**: history (what did the return
policy say in March?), review before a change lands, a diff, and an off-box copy that is
not the NAS. `docs/CONFIG-SURFACE-AND-REBUILD.md` §7.3 spends a page on the fact that every
backup this system has lives on the box it backs up. A GitHub repository is, incidentally,
the one durable store in this whole estate that already passes that test.

### The argument against putting it in *this* repository, which is decisive

**`jtpets/slack-agent-bridge` is going open source.** A wiki holds vendor terms, margins,
supplier relationships, pricing logic and staff matters. None of that can ship with a
public repository, and "we will remember to strip it before we flip the switch" is not a
control — a `git rm` does not remove anything from history.

This is not hypothetical here. WORK-TODO **#62**, filed from the state enumeration the same
day as this proposal, is exactly this failure in miniature: `data/staff-tasks-state.json`
holds staff names and is neither tracked nor gitignored, so an ordinary `git add -A` on the
box commits them. A wiki in this repository is that mistake made deliberately and at scale.

### The two alternatives, and why they lose

| Option | Why not |
|---|---|
| **A Slack canvas / Notion / Google Doc** | Staff can read it; an agent cannot, without a new integration, a new credential and a new rate limit. And it has no diff — "who changed the return policy and when" becomes unanswerable, which is the property the audit case needs most |
| **`docs/` in this repository** | See above. Also §5: this repository's documentation describes *systems*, and mixing "how to handle a return" into a tree guarded by `tests/architecture-tree.test.js` puts two different kinds of truth under one set of rules |

---

## 3. What it would actually take, using only existing mechanisms

This is the section that decides whether "no new mechanism" is true. **It is nearly true,
and the gap is one specific thing.**

### 3.1 The clone is anonymous HTTPS — a private repository cannot be read today

**Verified at `cdb5afd`, and it is the load-bearing constraint on this whole proposal:**

```bash
grep -n "const url = " lib/clone-lifecycle.js        # :135  https://github.com/${repo}.git
grep -n "DEPLOY_KEY_PATH" lib/clone-lifecycle.js     # :173  read AFTER the clone
sed -n '135,196p' lib/clone-lifecycle.js
```

`cloneRepo` clones over **`https://github.com/<repo>.git` with no credential**, and only
*afterwards* rewrites the remote to SSH and points `core.sshCommand` at the deploy key —
because the key exists to make the **push** work, not the clone
(`LOGIC CHANGE 2026-09-13`, in the function). Against a private repository the first
`git clone` fails and the function never reaches the key.

**And one deploy key does not solve it.** `DEPLOY_KEY_PATH` is a single path, and a GitHub
*deploy key* is bound to one repository — the same public key cannot be added to a second
one. So reading a private wiki needs a decision between:

| Shape | Cost |
|---|---|
| Clone over SSH from the start, with a **per-repository key** | `DEPLOY_KEY_PATH` becomes a map rather than a path, and `cloneRepo` grows a key-selection step. Small, and it is the shape #24's path-injection work is already moving toward |
| A **machine user** account with one key that has read access to both repositories | No code change to key handling; a new GitHub account to own, and a credential whose blast radius is "every repository that user can see" — which, given Step 0 consequence 3, a task executor can already read out of `/bridge/.env` |
| A **fine-grained PAT** scoped to read-only on the wiki repository only, used for an HTTPS clone | Smallest blast radius of the three, and the only one that is read-only by construction. Costs a new secret in `.env` and a second code path in `cloneRepo` |

**Recommendation: the fine-grained PAT, read-only, wiki repository only.** It is the only
option where the credential cannot write anything, and the wiki is a read-only concern for
every agent that touches it. It is a decision, not a detail, so it is stated rather than
assumed.

### 3.2 `target_repo` does not clone anything — reported, because the lead says it does

The dispatch's lead — *"an agent already clones a declared target repository"* — is
**refuted as stated**:

```bash
grep -rn "target_repo" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> lib/agent-create.js only: written and validated, never read by a clone path
grep -rn "cloneRepo(" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> bridge-agent.js:575 (task.repo), security-review.js:258 (its own helper)
```

The clone is driven by **`task.repo`**, which is the `REPO:` line of the task message.
`target_repo` in a definition is declarative — it feeds `getProductionAgentForRepo()` and
the created system prompt, and no clone consults it.

**Consequence for the trigger:** the first version needs the wiki repository named on the
task, or a small change teaching the scheduled/ASK path to default `task.repo` to the
handling agent's `target_repo`. The second is better and is not free; the first works now.

### 3.3 The reading agent: `storefront`

**Name it, per the dispatch, and correct the lead while doing so.**

```bash
sed -n '1,20p' agents/storefront/agent.md
```

| Field | Value at HEAD |
|---|---|
| `default_status` | `planned` |
| `channel_name` | `store-inbox` — **not "no channel"**. `agents/activation-checklists.json` records `#store-inbox` as created, and `STORE_INBOX_CHANNEL_ID` names the same channel for the SMS/call log (`docs/AGENTS.md`) |
| `role` | "Customer-facing AI for product inquiries, nutrition consults, order creation" |
| `permissions` | `square-catalog-read`, `square-orders-write`, `twilio-sms` |
| `denied` | `github`, `file-system` |

So the lead's "planned with no channel" is half right: **planned, yes; no channel, no.** It
declares a channel that exists and has never been activated, which is a one-command step
(`ASK: activate storefront`) rather than an owner action with a cost.

**Is it the right home?** Two things say yes and one says no, and the "no" is the
interesting one.

*Yes:* it is the only declared agent whose role is answering a question about the business
rather than about the system, and it already has `square-catalog-read`, which is where
product facts live.

*No, and it must be recorded:* its declaration **denies `github` and `file-system`**.
Reading a wiki repository is a `github` read and a file-system read. Those denials enforce
nothing today — no production code reads either field
([`docs/CAPABILITY-AND-ISOLATION-DESIGN.md`](docs/CAPABILITY-AND-ISOLATION-DESIGN.md) §2) —
so nothing *stops* it, which is precisely why this needs deciding now rather than
discovering later. Under the inverted capability model proposed there, "may read
`jtpets/jt-knowledge`" would be a **declared** capability and the blanket `github` denial
would be replaced by a narrower grant. **Giving the agent blanket `github` to read a wiki
is the wrong fix**, and it is the fix someone reaches for when the capability model is not
there yet.

### 3.4 The trigger

**What makes it run, stated so nobody builds a fifth intake path:**

A staff question in `#store-inbox` (or the storefront widget, which already posts there) is
an `ASK:` in a polled channel, which `processConversation` already routes to the channel's
agent with that agent's persona and data context. The one missing piece is that the agent
needs the wiki's text in its prompt — which is `lib/agent-context.js`'s job. It already has
a per-agent data switch (`buildAgentDataContext`, seven agents wired, `storefront` falling
to `buildGenericContext()`), and that switch is the seam.

**Two shapes, and the cheaper one is right first:**

| Shape | What runs | When it is right |
|---|---|---|
| **Read on demand, in the ASK path** | `buildAgentDataContext('storefront')` reads the wiki from a clone kept fresh by a scheduled task, greps for the question's terms, injects the matching files' top sections | First version. It is the `check-inbox` shape — code fetches, the model judges — and it needs no index |
| **A dispatched task with `REPO:`** | A full `TASK:` against the wiki repository | When the question needs the *reasoning* half of several files, not the answer half of one. It costs a clone and minutes |

**What must not be built:** an embedding index, before there is any evidence that title and
`grep` are insufficient. The corpus is a few dozen files. `docs/JESTER-DESIGN.md` §2's rule
applies unchanged — *where a signal is computable, compute it* — and "which file is about
returns" is computable from its title.

---

## 4. Vendor costs are not a document question

**Stated plainly so nobody builds document extraction for data that is already
structured.** Vendor catalogue data is standardised into SqTools by an existing import
tool. An agent that wants a vendor cost, a margin or a reorder point must **query SqTools**,
not read a PDF or a wiki page.

**Label on that claim: owner-supplied, and not verifiable from this repository.** SqTools
is `jtpets/SquareDashboardTool`; in the deployment it is mounted at `/repo` **read-only**
and nothing in this repository reads it. This checkout cannot confirm the import tool
exists or what it normalises. What *is* repository-verified is the interface that would be
used: `docs/INTEGRATION-SPEC.md` specifies an `X-API-Key` read-only HTTP interface at
60 req/min — and carries its own correction that the `127.0.0.1` allowlist was written for
the dead Pi and is **unverified** for the container layout.

**The rule, regardless:** a number that has a system of record is fetched from that system.
Writing it into a wiki page creates a second place it can be true, and the wiki has no
`ensureSchema`, no import job and nobody watching it go stale. A wiki page about a vendor
should say *how the relationship works* — terms, minimums, who to call, what "damaged on
arrival" means for them — and point at SqTools for every figure.

That division also decides §5.

---

## 5. How it stays distinct from this repository's documentation

**One sentence: this repository's `docs/` describes the *systems*; the wiki describes the
*business*.** They cannot drift into disagreeing because they are not about the same
things.

| | This repository's `docs/` | The wiki |
|---|---|---|
| Subject | How the bridge, its agents and its deployment work | How the shop works |
| Reader | An executor and a reviewer | Staff and a customer-facing agent |
| Guarded by | Tests. `tests/architecture-tree.test.js` fails when a module is missing from the tree; `tests/no-shell-execution.test.js`, `tests/timezone-explicit.test.js`, `tests/bulletin-types.test.js` and `tests/command-router.test.js` each fail when reality moves away from what is written | **Nothing, and nothing can.** There is no test that "the return window is 30 days" |
| Figures | Carry a regeneration command or they do not go in (`EXECUTOR-CONTRACT.md` §6) | Carry a **date and an owner**, because there is no command to regenerate a policy |

**The boundary rule, in one line each way:**

- **Nothing about the bridge goes in the wiki.** If an agent's behaviour needs explaining
  to staff, the wiki says what the agent does *for them* and links to nothing — the
  systems answer lives here, where a test can contradict it.
- **Nothing about the business goes in `docs/`.** Including examples. A worked example
  using a real vendor's terms is that vendor's terms, in a public repository.

**And the third case, which is the one that actually bites:** a fact that has a system of
record — a price, a cost, a stock level, a customer's order — belongs in **neither**. §4.

---

## 6. How standing rules relate to it

[`docs/STATE-AND-MEMORY-DESIGN.md`](docs/STATE-AND-MEMORY-DESIGN.md) proposes **standing
rules** — statements with no expiry that are not summaries of events: *"the owner does not
want vendor newsletters"*, *"this supplier is not to be reordered from"*, a talk track for a
recurring product question. That design argues they live in the durable store rather than
in time-tiered memory. This section answers the obvious follow-up: **why not in the wiki?**

**They are different things and the difference is who acts on them.**

| | A standing rule | A wiki page |
|---|---|---|
| Read by | An agent, on **every** relevant action, as input to a decision | A person, when they go looking |
| Shape | A machine-checkable statement with an origin, a subject and a history | Prose |
| Changes via | `feedback`, proposed and accepted (`docs/COMMAND-SURFACE.md` §4) | A commit and a review |
| If it is wrong | The agent does the wrong thing, every time, silently | Someone reads something wrong once and usually notices |

**The overlap is real and it is one-directional.** A rule *may* have a wiki page explaining
it — "why we don't reorder from that supplier" is a paragraph worth having — and the page
is the **explanation**, never the enforcement. The rule in the store is what the agent
reads. Putting the enforcement in the wiki would mean an agent parsing prose to decide
whether it may act, which is the model-as-sensor failure `docs/COMMAND-SURFACE.md` §2's
group B exists to refuse.

**The practical join:** a standing rule carries its origin and its history (that design's
requirement), so a rule may cite a wiki page as its origin. The citation goes one way —
from the rule to the page — so the page can be rewritten without silently changing what an
agent enforces.

---

## 7. What this proposal asks for, and what it does not

**Asks for a decision on three things, in this order:**

1. **The repository**, private, name the owner's. Nothing else can start until it exists,
   and nothing in this repository may create it.
2. **The credential shape** for reading it — §3.1. The recommendation is a read-only
   fine-grained PAT; the alternatives and their costs are stated so the choice is a review
   rather than a design exercise.
3. **Whether `storefront` is the reader** — §3.3 — knowing that its declaration currently
   denies the two things reading a repository needs, and that those denials enforce nothing
   today.

**Does not ask for, and explicitly refuses to build ahead of the decision:** the repository,
any content, any retrieval, any index, any activation, any Slack channel.

**The one thing worth writing down before any of it:** the first ten subjects. A wiki whose
shape is decided before its content exists gets a template and no answers. The corpus is
what makes the retrieval question answerable — and at ten files, §3.4's "title and grep"
is obviously enough, which is itself the finding that stops an index being built.
