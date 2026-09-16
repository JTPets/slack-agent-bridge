# The command surface — the intended map, what is built, and what each gap is waiting on

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
>
> This is a **design of record**, in the series with
> [`AUTONOMOUS-LOOP-DESIGN.md`](AUTONOMOUS-LOOP-DESIGN.md) and
> [`JESTER-DESIGN.md`](JESTER-DESIGN.md): it states an intended shape, what exists at
> HEAD, and what each unbuilt piece is blocked on. It is **not** a description of the
> running system — `CLAUDE.md` → "Built-in Commands" is that, and it lists only what is
> registered today. Nothing in the "blocked" sections below is implemented, and nothing
> here should be read as if it were.
>
> **Nothing is built by the change that filed this.**

**Why it exists.** The intended command surface lived only in conversation. A command map
that is not in the repository is re-derived from memory every time someone asks "what
should `/jt status` do", and re-derivation is where the drift starts — the same argument
`docs/CANONICAL-HELPERS.md` makes about behaviour and this file makes about verbs.

**Every claim about current state carries the command that regenerates it.**

---

## 1. Two slash registrations, and the reason the number is two

A slash command is not a code change. It is a row in the Slack app configuration —
Features → Slash Commands → Create New Command — which nothing in this repository can
create, read, or verify (`CLAUDE.md` → "The `/dispatch` command", steps 3–5). Each one is
therefore:

- a **manual step** an owner performs in a web UI, and
- for a public repository, a **setup instruction someone else has to follow** to make a
  fork work, in a file that cannot be tested.

So the count is a budget, not an aesthetic. **Two registrations, permanently:**

| # | Command | What it is | Status |
|---|---|---|---|
| 1 | `/dispatch` | The **form**. Five separate inputs the transport cannot flatten | **Built** 2026-09-15 (`lib/dispatch-command.js`, `lib/dispatch-modal.js`, `lib/dispatch-message.js`) |
| 2 | `/jt` | The **namespace**. One registration carrying every verb | **Not built.** The verb table it would front already exists (`lib/command-router.js`), reached today by `ASK: <verb>` |

Everything else is a **verb inside registration 2**. A third registration is the thing
this document exists to refuse.

### 1.1 `/dispatch` — the two things the dispatch asked to be recorded are already done

**Cited versus actual at `cdb5afd`.** Both leads describe the form as it stood before
2026-09-15 and neither is true at HEAD. Recorded here rather than silently skipped,
because a stale requirement that gets "fixed" again is how a working thing breaks.

| Lead | Actual |
|---|---|
| "its turn budget defaults below the standing convention" | **Refuted.** `DISPATCH_DEFAULT_TURNS` is **defined as** `MAX_TURNS`, not written as a number (`lib/dispatch-message.js:77`). The standing convention is `TURNS: 100` on every bridge dispatch and `MAX_TURNS` is 100 (`lib/task-parser.js:83`), so the form already defaults to the convention. The parser's own `DEFAULT_TURNS` is still 50 (`:81`) and is still correct for a hand-typed message with no `TURNS:` line — the two are different quantities, which is WORK-TODO **#20** |
| "its repository field should be a selection sourced from configuration rather than free text" | **Refuted.** It is a `static_select` whose options come from `getConfiguredRepos()` (`lib/dispatch-modal.js:24,69`), which reads `REPOS` and is the single owner of that list. Adding a repository is a `.env` change plus `docker compose up -d --force-recreate jt-agent`, not an edit to a form file |

```bash
grep -n "DISPATCH_DEFAULT_TURNS = " lib/dispatch-message.js   # :77  = MAX_TURNS
grep -n "getConfiguredRepos" lib/dispatch-modal.js lib/config.js
grep -n "MIN_TURNS\|MAX_TURNS\|DEFAULT_TURNS" lib/task-parser.js   # :81-83
```

**What is genuinely still open on the form** is neither of those: the **branch** field is
free text deliberately (a branch is per-task and not enumerable from configuration), and
nothing records a submission, so `buildModalView({ initial })` — the pre-fill seam — has
no store to read from (`docs/WIRING-AND-SEAMS.md` §7, "What does NOT exist is the store").
That store is part 3 of the persistence design.

### 1.2 `/jt` — the namespace, specified

**One registration, every verb.** The design has four properties and three of them are
already true of `lib/command-router.js`; the registration is what is missing.

| Property | Behaviour | Built? |
|---|---|---|
| **Bare invocation prints the table** | `/jt` with no argument renders the verb table | The renderer exists — `handleHelp` builds it **from** `COMMANDS` (`lib/command-router.js:69-80`). The bare-invocation path does not |
| **An explicit `help` verb prints the same table** | `/jt help` — the *same* function, not a second copy | **Yes.** `help` is a registered verb whose handler is the renderer |
| **An unrecognised verb prints the same table, naming what was not recognised** | `/jt frobnicate` → "`frobnicate` is not a verb", then the table | **No.** `parseCommand` returns `{ verb: null }` for an unknown first word and `runCommand` returns `{ handled: false }`, so the ASK path falls through to the LLM. That is correct *today* — the router was added under a rule that it takes no behaviour away — and is wrong for a namespace, where there is nothing below to fall through to |
| **The table is the single source** | A handler that exists without a table entry fails the suite | **Yes, and it is enforced.** `tests/command-router.test.js:41` — *"every handler defined in the module is reachable from the table"* — enumerates `async function handle*` from the module's own source and fails on any that the table does not reach. It carries its own negative control (`:274`, a synthetic `handleGhost`) |

**One renderer, three entry points.** Bare, `help`, and unrecognised must all call the
same function. Three renderings of one table is the defect
`docs/CANONICAL-HELPERS.md` §5 files about a timestamp, applied to the thing a user reads
first.

#### The usage hint is in Slack, and it will drift

Slack's slash-command registration has a **Usage Hint** field. Its contents are what
renders in the client's autocomplete as the user types `/jt`, and that autocomplete is the
entire reason one registration is viable instead of ten: without it, a namespace is a
command with an invisible vocabulary.

**It lives in the Slack app configuration. Not in this repository, not in
`lib/command-router.js`, not in any file a test can read.** Therefore:

1. **The help output is canonical.** `/jt` and `/jt help` render from `COMMANDS`, so they
   cannot be wrong. The hint can.
2. **The hint will drift, and no guard can catch it.** Adding a verb changes the table and
   does not change the hint. There is no mechanism in this repository — or available to
   one — that compares them.
3. **So the hint is a signpost, not a list.** Write it as
   `help | status | agents | queue | …` with a trailing marker and let the table be the
   authority, rather than enumerating every verb into a field that silently ages.

This is the same class as every other fact that lives only in the Slack app configuration
(Socket Mode on/off, Interactivity on/off, the `/dispatch` registration itself) and the
same class as the host crontab in `docs/CONFIG-SURFACE-AND-REBUILD.md` §7.4: a setting
that is load-bearing, off-repo, and unverifiable from a checkout.

---

## 2. The verbs, in three groups

**Group membership is by what a verb is waiting on, not by how useful it is.** A verb in
group B or C is not a small amount of work away from group A — it is waiting on a
mechanism that does not exist, and building it before that mechanism arrives produces the
failure the group is named for.

### Group A — ready: the material exists and the verb is a function call

Each of these reads something already computed, or runs an operation that already has a
deterministic implementation. None needs a model, a clone or a turn budget.

| Verb | What it does | What it reads | Registered today? |
|---|---|---|---|
| `help` | Renders the verb table | `COMMANDS` itself | **yes** |
| `agents` | The agent surface — channel, joined, polled, scheduled job, provider with provenance, reader | `lib/agent-surface.js` `buildSurface()` / `findOrphans()`, the same rows `node scripts/agent-surface.js` prints | **yes** |
| `queue` | The task queue: running, pending, recent terminal rows | `lib/task-queue.js` `formatStatusResponse`'s sources | **no** — reachable only as the phrase-matched `ASK: what's queued` in the hand-written ladder below the router (`bridge-agent.js`). Registering it is a migration, not a new capability |
| `check-inbox` | Runs the inbox check now — the **same operation** the cron tick runs | `getDeterministicTask('check-inbox').run()` → `lib/email-check.js` | **yes** |
| `critique` | Runs the jester's weekly critique now — same operation as the Friday tick | `getDeterministicTask('weekly-critique').run()` → `lib/weekly-critique.js` | **yes** |
| `memory <agent>` | What this agent believes it knows, tiered: standing rules, long-term, short-term, and the window each covers | `lib/memory-tiers.js` / `memory/memory-manager.js` — **read-only** | **no** |

**`memory` is in group A on purpose, and it is the only one here that is not already
half-built.** It reads and posts; it writes nothing; it needs no durable store to exist
first, because it can report what is there *and the fact that a tier is empty*. That makes
it the check that turns a confabulation into something visible rather than something
inherited, and it is buildable before anything in part 3 of the persistence design lands.
`docs/STATE-AND-MEMORY-DESIGN.md` specifies what it renders; **note what it will report at
HEAD**, which is the point of building it early: three of the four tiers are empty by
construction (WORK-TODO **#58**).

```bash
# what `agents` and `queue` would render, today, with no new code
node scripts/agent-surface.js
node -e "console.log(require('./lib/command-router').listVerbs().join(' '))"
# -> activate agents available check-inbox create critique deactivate help holidays status
```

### Group B — blocked on a deterministic implementation

**These reach a model that invents an explanation when it has no data.** That is not a
hypothetical: it is the defect `check-inbox` had until 2026-09-14 and no longer has, and
`weekly-critique` had until 2026-09-16 and no longer has. In both cases a cron tick posted
a prose `TASK:` message to an LLM that had no access to the thing it was being asked
about, and in both cases the output read like a report.

| Verb | Blocked on | The shape the fix takes |
|---|---|---|
| `calendar` | A deterministic calendar handler | `lib/integrations/google-calendar.js` exists and fetches events. What does not exist is a handler that fetches, formats, and reports **"the calendar is unreachable"** differently from **"there is nothing on it"** — `runInboxCheck`'s `ok` / `not_configured` / `fetch_failed` split, applied to calendar |
| `digest` | The same, for the morning digest | `morning-digest.js` is a cron script with **no `module.exports` at all**, so nothing can call it as a verb. Its email section already skips silently on an empty array, which `fetchRecentEmails` was written to stop for the inbox path and which `getRecentEmails` still flattens for this caller (`docs/WIRING-AND-SEAMS.md` §3a). Making it a verb means making it a deterministic handler first, and that means fixing the empty-vs-failed collapse it still carries |

**The rule these two are waiting on, stated once:** *a verb may reach a model only where a
model is the judgement and not the sensor.* `critique` passes it — the six signals are
computed and the model supplies only the opinion (`docs/JESTER-DESIGN.md` §2). A `digest`
verb that asks a model "what happened this morning" fails it.

### Group C — blocked on durable state

**Each of these writes a decision, and today there is nowhere durable to write it.** The
two available places both lose it:

- a **tracked** file is destroyed by `git reset --hard HEAD` — WORK-TODO **#51**, and the
  reason `ASK: create`'s verdict says so in those words;
- a **gitignored** file survives a pull and dies with the box — `docs/CONFIG-SURFACE-AND-REBUILD.md`
  §8.1, where every learned store has no export and no reproduction path but one.

| Verb | Writes | Why it cannot land yet |
|---|---|---|
| `provider <agent> <provider>` | The agent's provider | Today the only durable home is `LLM_PROVIDER_<AGENTID>` in `.env`, which **a command cannot write** — `.env` is owner-managed and off-limits, and a change to it needs `--force-recreate`. Writing the definition instead is #51. The requirement this verb must meet is already recorded as WORK-TODO **#47**: report a per-agent before/after table with the *source* of each value, and never flatten an agent that was explicitly pinned |
| `activate` / `deactivate` | Which agents run here | **Registered and working today**, into `agents/shared/agent-activation.json`. Listed in group C anyway because that file is the one learned store with a real durability story and *no export* — it survives a pull and dies with the box (§8.1 row 2). The verb is not blocked; its **durability** is the open half |
| `create <id> …` | A new agent definition | **Registered today**, and it writes a **tracked** file. It does not hide #51 — its verdict states that the next pull destroys the file unless it is committed. That honesty is what keeps it shipped; the durable version is what part 3 is for |
| `feedback <text>` | A change request against the invoking channel's agent | Nothing exists. See §4 |
| `label <label> → <agent> → <destination>` | A mail-label binding | Nothing exists, and the fetch path cannot scope by label at all. See `docs/CAPABILITY-AND-ISOLATION-DESIGN.md` |

---

## 3. The defect found tonight: the channel is a routing accident, not an argument

**Confirmed at `cdb5afd`.** The router runs **only in the bridge channel**:

```bash
grep -n "runCommand" bridge-agent.js          # :1299
sed -n '1288,1302p' bridge-agent.js           # the gate: if (sourceChannel === BRIDGE_CHANNEL)
```

`bridge-agent.js:1298` is `if (sourceChannel === BRIDGE_CHANNEL) {`. So:

- `ASK: agents` typed in `#claude-bridge` → the verb runs, deterministically, with no model.
- `ASK: agents` typed in `#email-monitor-agent` → the router is never consulted. The text
  falls through to `processConversation`'s LLM path and is answered as a **conversation
  with the email-monitor agent** — by a model, in that agent's persona, guessing at what
  "agents" means.

**Identical text, two behaviours, decided by where it was typed and reported nowhere.**
The second one is worse than a refusal: it produces an answer, in a confident voice, from
an agent that cannot see the thing it is describing.

The gate was deliberate and its reasoning is in the code
(`bridge-agent.js:1288-1291`): *"an agent channel is how an AGENT is addressed, and a verb
answering there would be the verb/name mixing #45 exists to prevent."* That is the right
principle and the wrong conclusion. Mixing a verb with an addressee means letting `jester`
be a *command name*; it does not mean a verb must be unavailable where an agent lives.

**A second half of the same defect:** even inside the bridge channel, the router is handed
`agent: agentConfig` (`bridge-agent.js:1301`) — the module-scope bridge record — not
`handlingAgent`, which the surrounding function has already resolved and passes to
everything else. So a verb has no notion of an invoking agent at all today.

### The intended behaviour

**The channel is an argument to the verb, not a router for it.**

1. **A verb is recognised in every polled channel.** One vocabulary, one meaning,
   everywhere.
2. **A verb inherits the invoking channel's agent** — its identity, its data context, and
   its declared capability. `/jt memory` in `#email-monitor-agent` reports the
   *email-monitor's* memory, because that is what "here" means. The same verb in the
   bridge channel reports the bridge's.
3. **A verb the invoking agent has no capability for is REFUSED, with the reason** — never
   silently reinterpreted as conversation. `/jt provider secretary claude` typed in an
   agent channel whose agent may not change configuration gets *"the email-monitor agent
   may not set a provider"*, not a chatty paragraph from a model.
4. **An unrecognised verb prints the table** (§1.2), so the boundary between "not a verb"
   and "a verb you may not run" is visible rather than inferred.

**Point 3 is the one with teeth, and it does not work yet.** "The agent's capability" is
`permissions` / `denied` in the definition, and **no production code reads either field** —
`docs/CAPABILITY-AND-ISOLATION-DESIGN.md` §2 establishes that with a grep. So the intended
behaviour depends on the capability model, which is why the two are designed together and
neither is built here.

---

## 4. `feedback` — a change request, never a silent edit

**It targets the agent whose channel it was invoked from.** That is point 2 of §3 applied
to the one verb where the target matters most: "stop showing me these" typed in
`#email-monitor-agent` is about the email monitor, and typing it somewhere else should
reach a different agent, not the same one by default.

**It is a change request with three possible outputs**, and which one it produces is part
of the verb's answer, not an implementation detail:

| Output | When | What lands |
|---|---|---|
| A **memory** | The feedback is an observation about this agent's world | An entry in this agent's memory, with its origin recorded as owner-stated |
| A **rules change** | The feedback would alter routing, filtering or inclusion | A **proposal**, rendered with the before and after, that the owner accepts or rejects |
| A **suggestion** | The feedback implies a change the agent cannot make — a capability, a schedule, a channel | A stated proposal and nothing else |

**A filter never rewrites itself.** Two reasons, and they are different:

1. **A filter that quietly rewrites itself means the owner stops seeing things without
   knowing why.** This is not a prediction. It is §8.1 row 4 of the rebuild document: a
   `git reset --hard` reverting `agents/email-monitor/memory/rules.json` produces exactly
   this outcome today, from the other direction. Both are the same failure — the rule set
   changed and nobody was told.
2. **A routing rule that touches customer data is a privacy decision.** "Send customer
   emails to `#store-tasks`" reads as a convenience and is a decision about who in the
   workspace sees customer correspondence. A model inferring that from a sentence typed in
   frustration is not the right author of it.

So `feedback` **proposes**, for the same reason `create` refuses to commit on the owner's
behalf and `activate` refuses when the channel does not exist: a command reachable from a
Slack message that can change what the owner sees is a larger blast radius than anything
in this repository has today.

**Blocked on:** the proposal has to live somewhere between being made and being accepted.
That is the approval queue's shape (`lib/approval-queue.js`) and it is a gitignored file
that dies with the box (§8.1 row 3). Part 3 of the persistence design decides where it
goes.

---

## 5. Two things that are not commands, and the reason is the container, not the design

Both are operations someone will reasonably ask for as verbs. Neither can be one **from
inside `jt-agent`**, and the reason is structural rather than a matter of effort.

**The container has no route to the host's container runtime.** The compose service mounts
exactly two paths and neither is a Docker socket:

```bash
grep -n "volumes:" -A 8 docker-compose.example.yml
# -> /share/CACHEDEV1_DATA/jt-agent:/bridge
# -> /share/CACHEDEV1_DATA/sqtools/app:/repo:ro
# no socket, no client library anywhere in the code:
grep -rn "docker\.sock\|dockerode" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> nothing
# "docker compose" DOES appear -- five times, every one of them a comment or a Slack
# message telling a HUMAN to run it. None is an invocation:
grep -rn "docker compose" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> bridge-agent.js:24, lib/llm-metrics.js:12, lib/agent-activation.js:279,
#    auto-update.js:46, auto-update.js:379
```

No `/var/run/docker.sock`, no Docker CLI in the image, no client library. A process inside
`jt-agent` cannot restart `jt-agent`. **And it must not be given the ability:** the socket
is root-equivalent on the host, and `docs/CONFIG-SURFACE-AND-REBUILD.md` Step 0
consequence 3 already records that a task executor is a shell with write access to every
credential the deployment holds. Mounting the socket would hand that shell the host.

### 5.1 The review gate — specified, not built here

A verb that answers *"does this branch actually pass?"* rather than *"did the executor say
it passes?"*:

> Clone a ref into a **fresh scratch directory**, install, run the suite, and report
> **counts and exit status in one line** — with a **missing runner reported as failure**.

Every piece of that exists except the trigger. `lib/clone-lifecycle.js` clones into a
scratch directory (and is already `--depth 1`, which this operation must override — it
needs the ref, not the history). **`lib/test-verdict.js` is the missing-runner rule,
already written and already enforced everywhere:** `classifyTestRun` distinguishes
`passed` / `failed` / `runner_absent` / `no_assertions` / `timed_out` / `not_run`, a pass
requires exit 0 **and** a positive parsed assertion count, and
`tests/test-gate-honesty.test.js` asserts by disk walk that every test invocation in the
repository routes through it.

**So why is it not a command?** Because the clone-install-test cycle takes minutes, needs a
turn budget's worth of wall time, and produces the kind of output a `TASK:` already
carries. It is a **dispatch**, and `/dispatch` is the registration for dispatches. Making
it a verb would put a long-running job behind a synchronous acknowledgement, which is the
mistake `/dispatch` was built to avoid (`lib/dispatch-command.js`: ack first, work after).

### 5.2 The deploy — specified, not built here, and not buildable here

> Pull, test, restart, **refuse on red**, and record what it deployed.

`auto-update.js` is this operation, written and tested, with four guards and a deferral
gate, and **nothing starts it** (WORK-TODO **#17**). Its restart mechanism is
`process.exit(0)` under `restart: unless-stopped` — the supervisor is what restarts, which
is exactly the workaround for having no route to the runtime.

Two things are missing and only one of them is code:

- **"Record what it deployed"** does not exist and cannot be faked. Nothing in this
  system can answer *which commit the running process is on* — not the repository, not the
  container, not Slack (`docs/JESTER-DESIGN.md` §1.5; WORK-TODO **#17**). A value read
  from the working tree at query time answers a different question and would have read
  "current" throughout the observed 11-hour gap.
- **The decision of which deploy shape to adopt** is the owner's, and is written out with
  its costs in `CLAUDE.md` → "Two open questions (stated, not decided)".

**Recorded here so nobody builds it as a verb:** a `/jt deploy` that shells out would need
the Docker socket, and §5's first paragraph is why that is not on the table.

---

## 6. What this document does not do

It registers nothing, builds nothing, and changes no behaviour. The one thing it asks of a
future change is that a verb added to `lib/command-router.js` gets a row in §2, in the
group that matches what it was waiting on — and that a verb which *cannot* be added says
which group it is stuck in and why. `tests/command-router.test.js` keeps the table and the
handlers honest with each other; nothing keeps this file honest with the table, which is
the standing weakness of every prose map here and the reason §2's tables carry the
regeneration command rather than a list.
