# The persistence split and the memory model — a design

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
>
> **A design of record. Nothing here is built.** No database is provisioned, no migration
> is written, no module is added and no behaviour changes in the branch that filed this.
> Part 1 is the argument, part 2 is the schema at the level of what is stored and why, and
> part 3 is the list the owner has to act on.
>
> It rests on the enumeration in
> [`CONFIG-SURFACE-AND-REBUILD.md` §8](CONFIG-SURFACE-AND-REBUILD.md), which established
> from code what every store is, who writes it, who reads it and what its loss costs. Do
> not re-derive that here; cite it.

---

# Part 1 — What the repository declares and what the deployment learns

## 1.1 The two halves, defined so the boundary is checkable

| | **Declared** | **Learned** |
|---|---|---|
| Authored by | a commit, reviewed | the running system or a person on the box |
| Identical in every workspace? | **yes, by definition** — a fork gets the same value | **no** — it is a fact about *this* workspace |
| May contain a workspace id, a credential, a customer? | **never** | yes |
| Survives a pull | yes — and **overwrites** anything on the box | must survive a pull, and today mostly does |
| Survives the box | yes | **today: almost nothing does** |

The repository already enforces one half of this and has a test for it:
`lib/agent-markdown.js` **refuses** a tracked definition carrying a value shaped like a
Slack channel id, and `tests/agent-markdown.test.js` walks every `agents/<id>/agent.md`
from disk and fails on one. That is the declared/learned boundary, already executable, for
exactly one field. The design below is that rule applied to the rest.

## 1.2 The split, per store

Derived from §8.1. **"Store" is the destination, not the file that holds it today.**

### Declared — stays tracked, stays in git

| Store | Today | Change |
|---|---|---|
| Agent definitions (`agents/<id>/agent.md`) | tracked | none — this is the model |
| The **default** provider, schedule, status per agent | tracked, inside the definition | none. They become *defaults* that a learned override may shadow (§1.3) |
| The **seed** email categorisation rules | tracked (`agents/email-monitor/memory/rules.json`) | becomes a **seed**: what a fresh install starts with, never the live rule set (§1.3) |
| The **template** activation checklist | tracked (`agents/activation-checklists.json`) | split: the checklist is declared, the **completions** are learned |
| `lib/validate-exceptions.json`, `agents/shared/daily-tasks-template.json`, `agents/shared/staff.json` | tracked | none. `staff.json` is a judgement call and it is deliberate: it is a handful of names and roles that a fork would want to replace, not accumulate. It is declared, and the *assignments* over it are learned |

### Learned and boot-critical — stays a **file**, gains an **export**

These four gate whether the bridge can poll at all. If they lived in a store that can be
unreachable, an unreachable store would be a dead bridge — which fails constraint 1 before
anything else is considered.

| Store | Why a file | What is added |
|---|---|---|
| Channel map | Read at boot, before anything works. A few dozen lines. A round trip cannot be on this path | **Mirrored to the store on every write**, and restorable by an explicit command. This is precisely WORK-TODO **#55**'s missing half: *"nothing exports the resolved map off-box"* |
| Activation decisions | Same — it decides the poll set | Same mirror |
| Poll cursors | Written on every poll cycle. A store round trip per channel per 30 s is the wrong shape, and a store outage must not stop polling | none. Cheap to lose (§8.1 row 13) |
| Processed-task dedup | Checked before **every** message. Hot path | none — but see §1.5, the record makes a lost dedup detectable after the fact |

**The mirror is a backup, not a second source of truth.** The file is authoritative; the
store's copy is read only by a restore command a human runs. Two authoritative copies of
one fact is how they disagree, and the whole channel-map outage was two places disagreeing
about a name.

### Learned and append-heavy — goes in the **store**

| Store | Why |
|---|---|
| **The shared record** (part 2) | Unbounded, append-only, queried by time, agent and kind. The strongest case on the page, and it does not exist in any form today |
| **Summaries** | Derived rows queried by window. A file per window is a directory that grows forever with no index |
| **Standing rules** with origin and history | Small — and the *history* is the case, not the volume. Never-update-in-place with a supersession chain is a table, and is a nightmare as a JSON file |
| **Task outcomes**, with branch and merge state | WORK-TODO **#39**. Append-heavy and queried; and the 24-hour retention that empties it is a consequence of it being a hot file |
| **Live routing rules** (what `rules.json` becomes) | They change without a deploy, they are per-workspace, and a tracked file is destroyed by a pull (§8.1 row 4) |
| **Per-agent provider pins** | Same reason. This is what retires the `.env` workaround — see the part-six finding |
| **Checklist completions** | Learned half of a declared template |
| **Staff task assignments** | Append-heavy, queried by day. Also removes half of WORK-TODO **#62** |
| **Delivery quote requests** (customer PII) | The one store with a compliance dimension; it needs a retention rule, and a retention rule over a JSON array is a script nobody runs |
| **Dispatch submissions** | The pre-fill store `buildModalView({ initial })` has no source for (`docs/WIRING-AND-SEAMS.md` §7) |

### Learned and neither — stays exactly where it is

| Store | Why not the database |
|---|---|
| **Task lock** (`$WORK_DIR/.task-running`) | It is a mutex on *this container*. A shared store would make it a distributed lock, which is a bigger problem than the one being solved, and it must work when the store is down. **It should move off `/tmp` to a mounted path** — WORK-TODO **#25**'s class — and that is the only change it needs |
| **Live task queue** (in-flight rows) | Hot, local, and must work when the store is down. Terminal rows **append to the record**; the live queue stays a file |
| **Working memory** | Per-task scratch, cleared after the task. It is session state and dies with the session by design |
| **LLM verdict counter** | Already an aggregate: roughly `days × agents` rows with a 30-day retention, read by one command. Putting a pre-aggregated 300-row counter in a database buys a query language for a question that is already answered by a function call. **Keep it a file** — and this row exists to show the rule cuts both ways |
| **Square catalog cache** | A cache with a 1-hour TTL. It re-fetches. `.gitignore` is the only thing it needs (#62) |
| **`.env`, the deploy key, the compose file** | Credentials and deployment definition. They belong off-box and encrypted (Step 5), and **never** in a store the bridge can write |

## 1.3 The rule, stated once so a future store can be placed without re-arguing

> **A store goes in the database when it is append-heavy, queried across time, or must
> survive the box. It stays a file when the bridge must be able to boot and poll without
> it. Where both are true — a small file that gates boot *and* must survive the box — the
> file is authoritative and the database holds a mirror that only a human restores from.**

And the corollary that decides the tracked-file cases:

> **A tracked file may be a seed or a default. It may not be the live value of anything a
> person changes on the box.** The live value is learned; the tracked file is what a fresh
> install starts from and what a fork receives.

That corollary alone closes §8.1 rows 4, 5 and 6 — the three stores where a
`git reset --hard` silently reverts a decision someone made — and it is the generalisation
of the fix already applied to exactly one of them (activation, moved to a gitignored file
because a tracked status field was destroyed twice).

## 1.4 Assessing the owner's intent, rather than assuming it

**The intent:** a database for the learned half, on the existing database server, as its
own database with its own role, never sharing credentials with the production system the
bridge mounts read-only.

**Verdict: right on three of four counts, and the fourth is a real cost that must be
priced rather than waved through.**

**Right — its own database and its own role.** This is the part that matters most and it
is not negotiable. See constraint 4 (§1.6).

**Right — not everything goes in it.** §1.2 puts eight stores in and eight out. The
temptation with a new database is to move everything into it, and two of the rows above
(the poll cursors, the verdict counter) are there specifically as the counter-examples: a
hot local cursor and a pre-aggregated 300-row counter are worse in a database, not better.

**Right — Postgres rather than SQLite.** Not because of scale: this is a single-writer
system and SQLite would serve the volume. Because of **location**. A SQLite file lives on
the box, which is the failure mode §8.1 exists to describe — it would be store number
twenty-six with no backup path. A server already has a backup discipline to inherit (and,
per WORK-TODO **#42**, one that needs fixing regardless).

**The real cost — a shared server is a shared failure domain and a shared resource pool.**
Two consequences, both addressable, neither free:

1. **Resource.** A runaway bridge query competes with the production database for the
   same memory and CPU. The precedent for the fix is already in this repository:
   `CLAUDE.md` → "Pi-side resource fencing" fences ollama with `MemoryMax`, `CPUQuota` and
   an `OOMScoreAdjust` for exactly this reason. The database equivalent is per-role:
   `ALTER ROLE bridge_app SET statement_timeout`, `SET idle_in_transaction_session_timeout`,
   and a `CONNECTION LIMIT` on the role. Cheap, and it must be in the provisioning list
   rather than remembered later — it is item 3 of §3.
2. **Failure.** The production database going down takes the bridge's store with it.
   **This is acceptable and constraint 1 is why**: the bridge is designed to run without
   the store, so a shared outage degrades the bridge rather than stopping it. The
   asymmetry is the point — the bridge depending on production's *availability* is
   survivable; the bridge holding production's *credentials* is not.

**Unverified, and it must be said plainly:** every fact about that server is owner-supplied
and cross-repository. This checkout cannot confirm the container name, the Postgres
version, the app role's name or its attributes. `docs/AGENTS.md` already carries a stale
Pi-era SqTools deploy command as a standing example of what happens when this repository
asserts things about that one. **Re-verify on the box before writing any of it into a
provisioning script**, and treat a role attribute that "came back" from a restore as a
finding rather than as permission.

## 1.5 The four constraints, each addressed

### Constraint 1 — the bridge starts and runs when the store is unreachable

**Addressed by shape, not by a try/catch.** Every store read returns
`{ available: false, reason }` rather than throwing or returning an empty result.

This is not a new invention and that is the argument for it: **the repository already does
this three times, in three different domains**, and each one exists because the collapsed
version caused a real failure.

| Module | Distinguishes | Because |
|---|---|---|
| `lib/test-verdict.js` | `runner_absent` / `no_assertions` / `failed` / `passed` | `jest: not found` under `npm ci --omit=dev` read as a pass |
| `lib/critique-signals.js` | `{ available, reason }` per signal; "UNAVAILABLE" is rendered, never omitted | a critique that went quiet because a sensor broke would be a false green in a believable voice |
| `lib/integrations/gmail.js` `fetchRecentEmails` | `ok:false` with `no_credentials` / `list_failed` / … | an expired token produced a digest that read like a quiet mailbox |

A fourth instance is a pattern, not a novelty. Concretely:

- **Boot never blocks on the store.** The connection is attempted asynchronously *after*
  the poll interval is armed and is never awaited — the same ordering
  `lib/slack-socket.js` uses and `tests/slack-socket.test.js` pins, for the same reason:
  the poll loop is how the task that would repair the store arrives.
- **An unreachable store is reported once to `#sqtools-ops` and re-reported on an
  interval**, recovering loudly — `SOCKET_MODE_DOWN_ALERT_MS`'s behaviour, reused.
- **Every consumer renders the absence.** A `memory` verb against an unreachable store
  says *"the store is unavailable: <reason>"*, never an empty tier list. A summary
  computed while the store was down records which sources were unavailable in the row
  itself (§2.2).
- **Writes that cannot land are dropped, and the drop is counted.** Not queued to a local
  spool: a spool is store number twenty-seven with the same durability problem, and the
  record is a log of what happened, not a ledger that must balance. A gap in the record is
  acceptable **only because the gap is recorded** — the outage window is itself an event
  written on recovery.

### Constraint 2 — a fresh install works against an empty store

- **Schema on connect, idempotent.** The store creates its own tables if absent, the way
  `ensureSchema` does for SqTools. There is no "run the migration first" step for a fresh
  install, because a fresh install of this system is `git clone` + `.env` +
  `docker compose up` and anything else will be forgotten.
- **Empty is a valid state everywhere, and is rendered as empty rather than as broken.**
  This is where constraint 1's distinction earns its keep in the opposite direction: a
  fresh install has an *available* store with *no rows*, and that must read differently
  from an unreachable one. The three modules above all get this right; the stores in §8.1
  get it wrong.
- **Nothing in the store is required for any boot-critical decision** — §1.2 put all four
  of those in files precisely so this is true by construction rather than by care.
- **The seeds are the declared files.** A fresh install's rule set is
  `agents/email-monitor/memory/rules.json`, loaded into the store on first connect and
  thereafter owned by the store.

### Constraint 3 — the store has its own backup path

**A new single point of failure is not an improvement**, and this is the constraint most
likely to be skipped because it is the one with no code in it.

- **Its own dump, its own retention, its own schedule** — not a line added to the
  production database's job, so that a change to one cannot silently stop the other.
- **Off-box, and "off-box" has the test `docs/CONFIG-SURFACE-AND-REBUILD.md` §7.3
  already states:** could it be restored if the NAS were powered off and gone? A second
  share on the same appliance fails that test. So does a snapshot.
- **The liveness check is on the artifact, never the schedule.** §7.4, unchanged: a
  firmware update wipes `/etc/config/crontab` and the job that would complain is the job
  that stopped. The check is "is the newest dump younger than 26 hours", and the
  repository already owns a path that can say so (`notifyOps` → `#sqtools-ops`).
- **A restore that has never been run is a hypothesis.** Date the last successful one.

**Note what this constraint does to the ordering:** WORK-TODO **#42** — every backup lives
on the box it backs up — is P1 and open. Adding a second database to that box before #42
is settled adds to the pile it describes. **The honest sequencing is #42 first, or at
minimum the new database's backup path built correctly on day one so it is the example
rather than another instance.**

### Constraint 4 — nothing in it requires credentials to the production system

**Addressed by the role, and it is the strictest line in this document.**

- A **separate database** (`bridge`, name the owner's) owned by a **separate role**
  (`bridge_app`), created by an administrator, not by the application.
- That role is **explicitly denied** on the production database:
  `REVOKE CONNECT ON DATABASE <prod> FROM bridge_app`, and `REVOKE ALL ON SCHEMA public
  FROM PUBLIC` in the production database so the default grant does not hand it back.
  Verification is a command, in §3.
- **No `SUPERUSER`, no `CREATEROLE`, and no `CREATEDB`.** The last one matters here for a
  reason that is not generic: the production role's `rolcreatedb = false` is a deliberate
  policy that has repeatedly stopped automated processes silently creating databases on
  that box. The bridge's role inherits the policy. It owns one database that already
  exists and needs no power to make another.
- **The credential is one new variable in the bridge's `.env`** and it is worth nothing
  against production. That is the whole design goal: §8.1 row 22 records that a task
  executor can read `/bridge/.env`, so the correct question is never "can this credential
  leak" but "what is it worth when it does".
- **The `/repo` read-only mount is untouched.** Nothing in this design reads SqTools, and
  `docs/CONFIG-SURFACE-AND-REBUILD.md` Step 0 consequence 3's rule stands: never make it
  writable.

**The one genuinely new exposure, stated rather than buried:** the bridge container has
**no network route to the database container today** — they are separate compose stacks
with no shared network. Giving it one is a new path from a container running
`--dangerously-skip-permissions` shells to the machine hosting the production database.
Mitigation is in §3 item 2 and it is narrow on purpose: a user-defined Docker network
containing those two containers and nothing else, **no published port**, so the database
remains unreachable from the host LAN.

---

# Part 2 — The schema, as what is stored and why

**Not a migration and not DDL to copy.** Column *names* are illustrative; the content of
each table, and the reason it is a separate table, is the deliverable.

## 2.1 `event` — the shared record

**One append-only table, and it is the centre of the whole design.**

| Holds | Why |
|---|---|
| `seq` — a monotonic integer, not a timestamp | `completedAt` at millisecond resolution already produced a real, random test failure (25 of 40 isolated runs) because two rows compared equal and a stable sort handed them back oldest-first. `lib/task-queue.js`'s `completionSeq` is the fix and the same reasoning applies here at higher volume. A database sequence is the same idea with the uniqueness guaranteed by the server rather than by induction over a file |
| `occurred_at` | when it happened, distinct from when it was written |
| `agent_id` | who published it. **Never null** — an event with no author cannot be filtered by an agent asking "what did the others do" |
| `kind` | a **closed vocabulary**, like `BULLETIN_TYPES` and for the same reason: `customer_interaction` was watched by two agents and was not a valid bulletin type, so those watches could never fire and nothing failed. A closed set with an enumerating guard is what made that visible |
| `subject` | a short human-readable line — the thing a reader sees first |
| `payload` (JSON) | the structured detail. JSON because event kinds differ and a column per kind is a migration per kind |
| `channel_id`, `message_ts`, `task_id` (nullable) | **the link back to the work.** The single sharpest thing the bulletin board does not carry: an agent can see that a task completed and cannot open it |
| `visibility` | see part 3 of the capability design. An event is what one agent publishes to all the others, so this column is where declassification is recorded |

**Why one table and not one per kind:** "what happened in this window" is the question
every consumer asks — the memory view, the daily summary, the critique digest, a `memory`
verb. One table makes that one query. Per-kind tables make it a union that grows a term
every time a kind is added, which is the failure mode by construction.

**Retention: long, and deliberately not "forever" without a number.** The record is cheap
(text and small JSON), and §1.2 put it in a database precisely so it need not be swept at
seven days to stay readable. The design position is: **keep the raw record for as long as
it is cheap, and say what "as long" is in a column the sweeper reads** — not in a constant
nobody revisits. What is *not* acceptable is what happens today, where the sweep interval
(7 days for bulletins, 24 hours for the queue) is shorter than the window the consumers
claim to report on.

## 2.2 `summary` — views over the record, never replacements for it

| Holds | Why |
|---|---|
| `grain` (`day` \| `week`), `window_start`, `window_end` | **The window is a column.** A summary that does not say what it covers cannot be told from one that covers nothing |
| `agent_id` (nullable — null = all agents) | per-agent and whole-system summaries are the same shape |
| `spine` (JSON) | the **computed** layer — §2.4 |
| `written` (text, nullable) | the **written** layer. Nullable is load-bearing: a summary with no written layer is complete and honest, and a missing written layer must never look like a missing summary |
| `computed_from` (JSON) | **which sources ran and which were unavailable, with the reason.** This is `formatCoverage()` from `lib/critique-digest.js` promoted from a rendered line into a stored column |
| `generated_at`, `generator` | when, and by what |

**Summarising a summary compounds loss, so the raw record stays queryable behind them.** A
weekly summary is computed from **the record**, not from seven daily summaries. The daily
summaries are *also* views of the record. Nothing in this design reads a summary in order
to produce another one — which is the single rule that stops a confident weekly claim
being an artefact of a bad Tuesday.

**A reader can always tell absence from silence**, because `computed_from` says which
sensors ran. This system has got that distinction wrong repeatedly and in every case the
fix was the same shape: name the sensor.

## 2.3 `rule` — standing rules, with origin and history

**Never updated in place. A change inserts a new row that supersedes the old one.**

| Holds | Why |
|---|---|
| `scope` (global \| agent), `agent_id` | *"the owner does not want vendor newsletters"* is global; a talk track belongs to one agent |
| `subject`, `statement` | what it is about, and what it says |
| `origin` — `stated` \| `inferred` | **the distinction the whole table exists for.** A stated rule is authoritative. An inferred one — derived by an agent from observed behaviour — is a **proposal** |
| `status` — `proposed` \| `active` \| `superseded` \| `rejected` | an inferred rule is `proposed` until a human accepts it. Nothing writes an `active` rule from an inference |
| `proposed_by`, `proposed_at`, `decided_by`, `decided_at` | who asked and who agreed |
| `supersedes` | the chain. Reading it backwards is the history of that rule |

**Why history is the case rather than the volume.** There may only ever be forty rules.
The requirement is that *"a rule nobody recognises six weeks later has a trail"* — who
asked for it, when, and what it replaced. That is cheap to record at the moment of change
and **impossible to reconstruct afterwards**, which is the only kind of requirement worth
building before it is needed.

**Where standing rules live: here, with the store — not with the knowledge base.** Argued
in full in [`KNOWLEDGE-BASE-PROPOSAL.md`](KNOWLEDGE-BASE-PROPOSAL.md) §6; the short form is
that a rule is read by an **agent** on every relevant action and must be machine-checkable,
while a wiki page is read by a **person** who went looking. A page may *explain* a rule; it
may never *be* one, because enforcement in prose means an agent parsing prose to decide
whether it may act.

**And a rule can never widen a capability** — see
[`CAPABILITY-AND-ISOLATION-DESIGN.md`](CAPABILITY-AND-ISOLATION-DESIGN.md) §4. That is the
property that keeps this table editable from Slack at all.

## 2.4 `task` — the entity, beside the events that log it

The live queue stays a file (§1.2). This table is the **durable** record of a task, and it
carries the three fields WORK-TODO **#39** established are missing: `branch`, `head_sha`,
and a resolved `merged_at`. "Completed" today means the executor's process exited, which
is *done*, not *landed*.

`event` logs what happened to the task; `task` is what it is. Both, because "show me every
attempt at this" is a query over events and "is it merged" is a column.

## 2.5 The remaining tables, in one line each

| Table | Holds | Note |
|---|---|---|
| `state_mirror` | key → JSON, updated_at | The off-box backup of the four boot-critical files. **One table, not one per file**, because it is a backup rather than a working store. Restored only by an explicit command |
| `routing_rule` | what `rules.json` becomes | Same origin/status/supersession columns as `rule`; a routing change is a rule change |
| `agent_setting` | per-agent provider, model, schedule override | The learned shadow over a declared default. This is what retires `LLM_PROVIDER_<AGENTID>` |
| `checklist_completion` | agent, item, completed_at, by | The learned half of a declared template |
| `staff_assignment` | task, assignee, due, state | Append-heavy, queried by store-day. Use a **Toronto** day key, not UTC — WORK-TODO **#33** is that exact bug in the file version |
| `contact_request` | the delivery quotes | **Customer PII, and the only table with a mandatory retention rule.** It is also the table a privacy decision applies to first |
| `dispatch_submission` | user, fields, created_at | The pre-fill store `buildModalView({ initial })` has no source for |

---

# Part 3 — What the owner must provision

Precise enough to act on without guessing. **Every name is a placeholder to confirm on the
box** — this checkout cannot verify one of them, and `docs/AGENTS.md` carries a stale
Pi-era command as the standing reminder of what happens when it tries.

**1. The database and the role.** As an administrator, on the existing Postgres container:

- a role `bridge_app` — `LOGIN`, **no** `SUPERUSER`, **no** `CREATEROLE`, **no**
  `CREATEDB`, with a `CONNECTION LIMIT`;
- a database `bridge` owned by `bridge_app`;
- on the **production** database: `REVOKE CONNECT ... FROM bridge_app`, and
  `REVOKE ALL ON SCHEMA public FROM PUBLIC` so the default grant does not hand it back.

Verify — and **record the output**, because a negative nobody wrote down gets re-asked:

```sql
-- attributes: rolsuper, rolcreaterole, rolcreatedb must all be false
SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolconnlimit
  FROM pg_roles WHERE rolname = 'bridge_app';
-- must be FALSE: the bridge role cannot reach production
SELECT has_database_privilege('bridge_app', '<production db>', 'CONNECT');
```

**2. A network path, and only one.** The bridge container has none today. A user-defined
Docker network containing **only** the bridge and the database, with **no published port**,
so the database stays unreachable from the host LAN. This is a compose change to two
stacks; it is the item on this list with the largest security consequence and it is why the
role restrictions in item 1 come first.

**3. Resource fencing on the role**, at provisioning time and not later —
`statement_timeout`, `idle_in_transaction_session_timeout`, and the connection limit from
item 1. The reasoning is `CLAUDE.md`'s ollama fence: a workload sharing a box with
production is fenced when it is installed, not after it starves something.

**4. One credential into the bridge's `.env`** (`BRIDGE_DB_URL` or discrete vars —
`ACTION REQUIRED` either way), then
`docker compose up -d --force-recreate jt-agent`. **Not `restart`** — a restart reuses the
baked-in environment. Note Step 0 consequence 2: a recreation discards any preserved
scratch clone.

**5. A backup path for the new database, separate from production's** — its own dump, its
own retention, an off-box copy that passes §7.3's test, and an **artifact-freshness** check
rather than a cron entry (§7.4). Plus a dated, actually-executed restore.

**6. A decision on `contact_request` retention** before the table holds anything. It is
customer PII and the default cannot be "forever by omission".

**Not on this list, deliberately:** anything in this repository. No code change is required
to *provision*, and the repository-side work does not start until items 1–4 exist, because
a client written against an unprovisioned store is a client tested against a mock.

---

# Part 4 — The memory model

## 4.1 The problem, established rather than assumed

**An agent's task can read no Slack history — not another channel's, and not its own.**
`docs/JESTER-DESIGN.md` §1.1 establishes it from code: a task is a string handed to an LLM,
the Slack client lives in `bridge-agent.js` and is never passed into a prompt, and the only
two `conversations.history` calls in production are the poll loop (`limit: 5`) and staff
escalation. There is no MCP server, connector or tool allowlist anywhere.

So the only shared input any agent has is the bulletin stream: **ten entries, seven days,
no id, no link back to the work** (§8.1 row 9). An agent cannot see what another published
beyond that, and nothing records what happened.

**And the per-agent memory that would hold it is empty by construction** — WORK-TODO
**#63**, established in §8.2: `lib/memory-tiers.js` implements TTL, decay, archive and
auto-promotion, and no production code adds a short-term, long-term or permanent entry.

## 4.2 Assessed against `lib/memory-tiers.js` — keep the vocabulary, replace the store

The module is not wrong. It is a **file-shaped implementation of the right idea**, and
three of its four ideas transfer unchanged.

| What it has | Verdict |
|---|---|
| **Auto-promotion at three re-adds** (`AUTO_PROMOTE_THRESHOLD`) | **Keep, and it is the best thing in the module.** Promotion is *computed from a count*, not judged by a model — which is exactly §4.5's requirement, already written down here in 2026-03 |
| **Archive** — "decayed items preserved for reference, **not injected into prompts**" | **Keep the idea and the name.** That sentence is the record/prompt split (§4.7) named correctly before anything needed it |
| **Working memory**, cleared after each task | **Keep as a file.** Session scratch that dies with the session. It is the one tier that is right as it is, and it is the one tier production actually calls |
| **TTL expiry that deletes** | **Replace.** It conflates two different things: how long a fact is *kept* and how long it is *eligible for a prompt*. The record is kept; eligibility is a view. Deleting at 48 hours is what makes a seven-day question unanswerable |
| **Tier = file** | **Replace.** Per-agent files cannot answer "what did the others do", which is the whole requirement |

**WORK-TODO #35 dissolves rather than being fixed.** It asks for a max-entries cap per
tier. Under this model a cap belongs on **what reaches a prompt** (§4.7), and the record is
uncapped on purpose. A cap on a tier that nothing writes would have capped nothing anyway
(#63).

## 4.3 The shared record is short-term memory

**Every task, message, post, prompt and outcome an agent publishes is an `event`** (§2.1).
That table *is* short-term memory, and it is what agents read to know what others did.

Three properties follow directly and none of them is true today:

- **An agent can see what another published**, because it is a query filtered by window
  rather than ten rows filtered by `unreadBy`.
- **Every event links back to the work** (`channel_id`, `message_ts`, `task_id`), so
  "an agent can see that a task completed; it cannot open it" stops being true.
- **The bulletin board becomes a view of the record**, not a second store. Its five
  producers write events; `formatBulletinsForContext` selects from them. One writer, one
  vocabulary, and `tests/bulletin-types.test.js`'s enumeration of the type vocabulary
  carries over unchanged to `kind`.

**The volume is the point, not a problem.** Append-heavy and unbounded is what a database
is for, and it is the strongest of the §1.2 cases.

## 4.4 Summaries are views, and they say what they cover

A day compresses to a daily summary, a week to a weekly one, **both computed from the
record** (§2.2). The raw record stays queryable behind them for as long as it is cheap.

**A summary names its window and what it was computed from.** So a reader can tell whether
an absence means *nothing happened* or *nothing was captured* — the distinction this system
has got wrong repeatedly, in the queue (an empty section reading as "nothing failed"), in
the mailbox (an expired token reading as a quiet inbox), and in the test gate (a missing
runner reading as a pass). Three instances, one fix, already written three times.

## 4.5 Two layers: a computed spine and a written layer over it

**The spine is calculable and is carried forward automatically** — what merged, what
failed, what was decided, what changed. It **must not depend on being noticed**, which is
the whole reason it is separate: a summary that depends on an agent remembering to mention
something loses whatever the agent found boring that day.

**The written layer adds context and relevance** and is work for the agent that already
does the daily pass. It is nullable (§2.2) and its absence is not a gap in the summary.

Two consequences worth stating because they are the payoff:

- **If the written layer misses something, the spine still holds it.**
- **If a later summary contradicts the spine, that is a confabulation caught rather than
  inherited.** The spine is stored, so the contradiction is checkable — which is what
  turns "the model said something wrong" from an anecdote into a detectable event.

This is `lib/critique-digest.js`'s architecture generalised: five computed signals and one
conversational one, where the model supplies judgement and never acts as a sensor.

## 4.6 Promotion to long-term is computed, not judged

**An item addressed repeatedly, a defect that recurred, a decision that changed
behaviour** — all three are calculable, and two are already calculated:

- `lib/repo-history.js` `claimsFrom` computes `Closes` versus `Addresses` and **items
  addressed more than once and still open**;
- `lib/review-findings.js` `findRecurrence` compares findings **by rule identifier, not by
  prose**, precisely so a defect that moved file still counts as the same defect;
- `AUTO_PROMOTE_THRESHOLD` counts re-adds.

**A model asked to decide importance will promote the wrong things**, and the objection is
not theoretical here: this system has twice produced confident false claims about its own
infrastructure from recalled rather than computed input — the `already_in_channel`
paragraph in `docs/AGENTS.md` (corrected in place, with the reasoning error kept) and the
`formatBulletinsForContext` timestamp claim in `docs/CANONICAL-HELPERS.md` §5. Both were
written confidently, both were wrong, and both were caught by running a command.

So promotion is a rule over counts, and the rule is stored beside the promoted item so the
promotion can be explained.

## 4.7 The volume split: the record is complete, the prompt is not

**The constraint on what reaches a model is volume; the constraint on the record is
nothing.** Keep them separate — `lib/weekly-critique.js` is the proof this works: it runs
in a **single turn** because its digest is computed in advance, and a single turn on a
denied-file-system agent is a security property as well as a cost one.

So:

| | The record | What reaches a prompt |
|---|---|---|
| Bounded by | retention, generously | a budget, tightly |
| Shape | rows | a rendered digest |
| Selected by | a query | a **rule**, stated and testable |
| When it is short | that is the truth | that is a choice, and the digest says which sources it drew from |

`memory-tiers.js`'s archive already names this: *"preserved for reference, not injected
into prompts"*. The model keeps that sentence and gives it a store that can honour it.

## 4.8 Memory is pollable, and it is the first thing to build

```
/jt memory <agent>
```

**The owner can ask what an agent believes it knows, tiered** so standing rules are
distinguishable from a summary, and a summary from raw events:

| Section | Source | Says |
|---|---|---|
| **Standing** | `rule`, `status = active` | statement, origin (**stated** or **inferred-and-accepted**), who accepted it, when |
| **Long-term** | promoted items | the item, **and the count that promoted it** |
| **Recent** | the newest summaries | the window each covers and what it was computed from |
| **Raw** | the last N events | with their links back |

**Every section names its window, and an empty section says whether it is empty or
unavailable.** That is the check that makes a confabulation visible rather than inherited:
an owner who reads a confident claim in a channel can ask what the agent thinks it knows
and see that the claim is not in there.

**It is read-only, so it is buildable before the durable store exists** — it is in group A
of `docs/COMMAND-SURFACE.md` §2 for exactly that reason. Built today it reports three
empty tiers and the legacy global history, which is not a disappointing result: **it is the
finding**, rendered where the owner can see it, instead of sitting in a backlog item.

---

## 5. What this design does not do

It provisions nothing, writes no migration, adds no dependency (`pg` is not in
`package.json` and this change does not put it there), and changes no behaviour. It makes
three decisions the dispatch left open and states each one's reasoning: **which stores go in
the database and which stay files** (§1.2, with the rule at §1.3 and two counter-examples
kept in deliberately), **that standing rules live with the store rather than with the
knowledge base** (§2.3), and **that the file is authoritative for the four boot-critical
stores with the database holding a restore-only mirror** (§1.2). The first thing to build
from it is the one thing that needs none of it: the `memory` verb.
