# Work Backlog

**Format this file declares for itself, and is now in.** One `###` heading per **open**
item. Stable numeric IDs, never reused and never renumbered — order *within* a tier is the
rank, the number is only an address for cross-references. **Closed items are purged, not
struck through:** the git history and the `Closes <ID>` commit body are the record, and a
file that keeps its own dead entries stops being readable as a list of work. The index
below is **regenerated from the headings**, never appended to.

**Ranking axis:** blast radius on the live single-container deployment first — can the item
brick the bridge, silently corrupt its state, or does it unblock the hardening that
prevents those — then leverage per unit of effort.

Priority tiers: **P1** = can brick or silently degrade the running bridge, or unblocks
something that can | **P2** = real gap, no risk to the live process | **P3** = nice to have
/ uncertain ROI.

**Every figure in this file carries the command that regenerates it.** A number with no
command was removed. A figure only regenerable off-repo (on the NAS, or from the live
container) says so and names the command anyway; it is an unverified lead from a checkout,
not a repo fact.

## Every item carries a filed date, and age is therefore computable

**As of the 2026-09-16 audit pass, no open item is undated.** Seventeen were — sixteen
with no date at all, plus **#4b**, whose date sat in its heading where the check below does
not see it. That is a third of the list, so every age-based figure was a floor rather than a fact — and age is
the sharpest signal `lib/critique-digest.js` has. The command that proves it:

```bash
# must print nothing: every open item carries a Filed date
node -e "
const fs=require('fs');const lines=fs.readFileSync('WORK-TODO.md','utf8').split('\n');
let id=null,buf=[];const out=[];
const flush=()=>{if(id===null)return;const t=buf.join('\n');
  if(!/\*\*Filed\s+\d{4}-\d{2}-\d{2}/i.test(t))out.push(id);};
for(const l of lines){const h=l.match(/^### ([0-9]+[a-z]?)\. /);
  if(h){flush();id=h[1];buf=[l];}else if(id!==null)buf.push(l);}
flush();out.forEach(i=>console.log('UNDATED #'+i));"
```

**How the seventeen dates were derived, and what they do and do not mean.** Each is the
commit that introduced the item's heading into this file, found with
`git log -S'<heading or distinctive phrase>' --reverse -- WORK-TODO.md`. The derivation
command is recorded on the item itself, so the date is checkable rather than asserted.
Thirteen resolve to `20dc049` (2026-09-13, "re-derive backlog from the system as it
actually runs"), one to `e2a19e2` (2026-09-13), one to `3dacba8` (2026-09-14), one to
`20dc049` under an earlier unnumbered heading, and #4b to `9d951f3` (2026-09-14).

**The caveat that matters more than the dates.** A filed date is when the item entered
*this file in its current form*, not when the problem started. Eleven items — **#4, #5,
#6, #7, #8, #9, #13, #14, #15, #16, #35** — have an ancestor heading in the 2026-04-05
seed `4b6ee4a`, so their substance has been open about **five and a half months**, not
three days. Each says so on its own entry. Reading `Filed 2026-09-13` as the age of those
eleven understates it by that whole interval; any age report over this file should use the
seed date for them, and the two facts are recorded separately rather than averaged into
one misleading number. Regenerate the ancestor list with
`git show 4b6ee4a:WORK-TODO.md | grep -nE '^### '`.

**Not derivable, and not invented:** nothing. All seventeen resolved to a commit. Had one
not, it would say so here rather than carry a guess.

## Counts — as commands, not figures

```bash
# total open items
grep -cE '^### [0-9]+[a-z]?\. ' WORK-TODO.md
# per tier
awk '/^## P1/{t="P1"} /^## P2/{t="P2"} /^## P3/{t="P3"} /^### [0-9]/{print t}' WORK-TODO.md | sort | uniq -c
# the index below must match the headings
grep -E '^### [0-9]+[a-z]?\. ' WORK-TODO.md | sed 's/^### //'
# no duplicate IDs (must print nothing)
grep -oE '^### [0-9]+[a-z]?\.' WORK-TODO.md | sort | uniq -d
```

At the **2026-09-16 audit pass** those print **48** open items — 9 P1, **31** P2, 8 P3 — and
**no duplicate ID**. That pass purged **#45** (closed: the decision is recorded outside this
file and the name half it said nothing enforced is enforced by
`tests/command-router.test.js`), filed nothing, and gave every remaining item a filed date.
Earlier the same day the jester pass printed **49** — 9 P1, 32 P2, 8 P3 (#56 filed; nothing
closed). At the 2026-09-15 agent-wiring pass
they printed **48** — 8 P1, 32 P2, 8 P3. (Earlier the same day: the agent-identity pass printed 44 — 7/29/8;
the command-router pass 45; the size-gate pass 40 — 7/26/7.) That pass purged **#50**
(closed: the suite is green in a fresh clone and no longer writes live configuration) and
filed **#51**–**#55**.

**Do not read those numbers.** Run the four commands above — they are the count, and this
paragraph is a dated observation of what they printed.

**The `### 43.` collision is resolved, by closure rather than by renumbering.** Two items
shared that number: the P1 "A flattened dispatch loses its fields" and the P2
"`getRecentCompleted` sorts by a millisecond timestamp". The second is now closed and
purged, so one `### 43.` remains and the duplicate-ID command prints nothing. Renumbering
was never done — an ID is an address, and the P1 #43 keeps the one it has. **The cause is
not fixed:** "the next ID" is still read by eye rather than by the command in this block,
which is how the collision happened twice. The duplicate-ID check above is the guard; run
it before filing, not after.

The index anchors follow GitHub's slugger: lowercase, drop punctuation **except**
hyphen and underscore, spaces to hyphens. Four entries (#5, #20, #21, #34) previously
dropped the underscore too and were therefore broken links; regenerating fixed them.

## Twelve of the 48 are not engineering backlog

**Filed 2026-09-16 by the audit pass.** A quarter of this file is work no branch can do.
Mixed in with the rest it reads as a queue somebody could pick up, which is how #43 sat at
P1 for a day after the command it asks for was already built and green.

Two states, marked on the item itself so they are countable rather than remembered:

- **BLOCKED — OWNER ACTION (off-repo)** — the remainder cannot be done from a branch **at
  all**: it is a command on the NAS, a Slack app setting, or a Slack channel. Seven items:
  **#3, #26, #40, #41, #43, #53, #55**. In every one the repository's half is landed and
  verified; what is left is off-repo by construction.
- **BLOCKED — OWNER DECISION** — the remainder is a choice, and the code is small once it
  is made. Five items: **#27, #29, #37, #44, #51**. Three of them say so in their own
  words (#29 "decision, not work"; #44 "not to be decided by an executor"; #51 "no shape
  chosen").

```bash
# how many, and which
grep -cE '^\*\*BLOCKED — OWNER' WORK-TODO.md
awk '/^### [0-9]+[a-z]?\. /{id=$2}
     /^\*\*BLOCKED — OWNER ACTION/{print "#"id" OWNER ACTION (off-repo)"}
     /^\*\*BLOCKED — OWNER DECISION/{print "#"id" OWNER DECISION"}' WORK-TODO.md
# split by kind
grep -cE '^\*\*BLOCKED — OWNER ACTION' WORK-TODO.md
grep -cE '^\*\*BLOCKED — OWNER DECISION' WORK-TODO.md
```

**What this does NOT mean.** A marked item is still open and still real; the marker says
who can move it, not that it stopped mattering. #3 and #55 are P1 precisely because the
thing that would settle them is a restart nobody has done.

**Deliberately not marked, though it is tempting:** #17, #25, #42, #49, #52 and #54 each
have an owner-side half **and** repo-side work still available — #25's alert text and its
regression test, #42's age alert (the item says "(c) is buildable here"), #17's
report-the-running-commit requirement, #52's computable direction, #54's rule needing a
home in the tier definition, #49's answerable questions. Marking those would hide real
work behind an owner's name, which is the opposite of the point.

## Index

*Regenerated from the headings. Do not append to it by hand; re-run the command above.*

**P1 — protects or unblocks the live deployment** (9)

- **#55** — [The channel mapping had no reproduction path, and a deploy proved it](#55-the-channel-mapping-had-no-reproduction-path-and-a-deploy-proved-it)
- **#56** — [`npm test` fails intermittently inside jest's globalSetup — twice, unreproduced](#56-npm-test-fails-intermittently-inside-jests-globalsetup--twice-unreproduced)
- **#42** — [Every backup this system has lives on the box it backs up, and their liveness is checked by nothing](#42-every-backup-this-system-has-lives-on-the-box-it-backs-up-and-their-liveness-is-checked-by-nothing)
- **#41** — [The NAS is the single point of failure for every stack and every credential, and its exposure has never been established](#41-the-nas-is-the-single-point-of-failure-for-every-stack-and-every-credential-and-its-exposure-has-never-been-established)
- **#17** — [Nothing starts `auto-update.js` — merged code does not reach the running process](#17-nothing-starts-auto-updatejs--merged-code-does-not-reach-the-running-process)
- **#25** — [The preserved scratch clone does not survive a container recreation — silent data loss inside the feature that prevents silent data loss](#25-the-preserved-scratch-clone-does-not-survive-a-container-recreation--silent-data-loss-inside-the-feature-that-prevents-silent-data-loss)
- **#3** — [The scheduler never checks `planned` status — CONFIRMED FIRING LIVE 2026-09-14](#3-the-scheduler-never-checks-planned-status--confirmed-firing-live-2026-09-14)
- **#4** — [Replace HTTP polling with Slack Socket Mode (event triggers)](#4-replace-http-polling-with-slack-socket-mode-event-triggers)
- **#43** — [A flattened dispatch loses its fields — the connection for the fix exists, the command does not](#43-a-flattened-dispatch-loses-its-fields--the-connection-for-the-fix-exists-the-command-does-not)

**P2 — real gaps, no risk to the running process** (31)

- **#4b** — [Config surface is undocumented and cross-stack infra is unowned — INVENTORY FILED 2026-09-14](#4b-config-surface-is-undocumented-and-cross-stack-infra-is-unowned--inventory-filed-2026-09-14)
- **#30** — [Three `postToOps`, three `sendDM`, and secret redaction reaches 2 of 48 Slack post sites](#30-three-posttoops-three-senddm-and-secret-redaction-reaches-2-of-48-slack-post-sites)
- **#31** — [Three definitions of "is this a rate-limit failure?", and the morning digest tells the owner tasks will auto-retry when nothing will](#31-three-definitions-of-is-this-a-rate-limit-failure-and-the-morning-digest-tells-the-owner-tasks-will-auto-retry-when-nothing-will)
- **#22** — [An interrupted task reaches no human](#22-an-interrupted-task-reaches-no-human)
- **#23** — [A task killed mid-run is re-read and re-run on the next poll](#23-a-task-killed-mid-run-is-re-read-and-re-run-on-the-next-poll)
- **#26** — [`docker-compose.yml` is untracked **and** unignored in the live working tree — `git clean -fd` deletes the deployment definition](#26-docker-composeyml-is-untracked-and-unignored-in-the-live-working-tree--git-clean--fd-deletes-the-deployment-definition)
- **#27** — [A task has write access to the entire live deployment, including every credential — recorded, undecided](#27-a-task-has-write-access-to-the-entire-live-deployment-including-every-credential--recorded-undecided)
- **#24** — [Four sibling modules resolve a shared writable path at module scope with no override — the same class as #19](#24-four-sibling-modules-resolve-a-shared-writable-path-at-module-scope-with-no-override--the-same-class-as-19)
- **#20** — [`MAX_TURNS` names four different quantities, and the env var is dead config](#20-max_turns-names-four-different-quantities-and-the-env-var-is-dead-config)
- **#33** — [A UTC day key is used as the store's day, so evening staff tasks are filed against tomorrow](#33-a-utc-day-key-is-used-as-the-stores-day-so-evening-staff-tasks-are-filed-against-tomorrow)
- **#32** — [One bulletin timestamp, three renderings — no shared helper](#32-one-bulletin-timestamp-three-renderings--no-shared-helper)
- **#34** — [`DEPLOY_KEY_PATH` is read but undocumented](#34-deploy_key_path-is-read-but-undocumented)
- **#35** — [Per-agent memory has TTL and decay but no max-entries cap](#35-per-agent-memory-has-ttl-and-decay-but-no-max-entries-cap)
- **#10** — [Split the god-files that break the repo's own 300-line rule](#10-split-the-god-files-that-break-the-repos-own-300-line-rule)
- **#44** — [The 300-line rule is one rule over two different problems — scope it, or say it covers both](#44-the-300-line-rule-is-one-rule-over-two-different-problems--scope-it-or-say-it-covers-both)
- **#11** — [A helpers/utilities map and an owning-doc rule](#11-a-helpersutilities-map-and-an-owning-doc-rule)
- **#5** — [Mid-task `ask_on_slack` capability](#5-mid-task-ask_on_slack-capability)
- **#6** — [Structured task result format](#6-structured-task-result-format)
- **#7** — [Task timeout escalation tiers](#7-task-timeout-escalation-tiers)
- **#8** — [Surface deduplication in status](#8-surface-deduplication-in-status)
- **#9** — [`ASK: task history [n]` command](#9-ask-task-history-n-command)
- **#39** — [The queue cannot tell a completed task from a landed one — nothing here knows whether a branch merged](#39-the-queue-cannot-tell-a-completed-task-from-a-landed-one--nothing-here-knows-whether-a-branch-merged)
- **#40** — [Uncommitted edits in the live deployment tree — reported, NOT verifiable from a checkout](#40-uncommitted-edits-in-the-live-deployment-tree--reported-not-verifiable-from-a-checkout)
- **#37** — [`notifyOwner(msg, PRIORITY.HIGH)` goes nowhere and returns success](#37-notifyownermsg-priorityhigh-goes-nowhere-and-returns-success)
- **#46** — [`/dispatch` posts to one fixed channel — routing by the invoking channel needs two things that do not exist](#46-dispatch-posts-to-one-fixed-channel--routing-by-the-invoking-channel-needs-two-things-that-do-not-exist)
- **#47** — [A global provider switch must say what it changed, and must not flatten per-agent settings](#47-a-global-provider-switch-must-say-what-it-changed-and-must-not-flatten-per-agent-settings)
- **#49** — [`NATURAL_CONVERSATION_MODE` is off, and nothing establishes what turning it on does](#49-natural_conversation_mode-is-off-and-nothing-establishes-what-turning-it-on-does)
- **#51** — [A command that writes a tracked file is destroyed by the next pull, and every configuration-writing command shares it](#51-a-command-that-writes-a-tracked-file-is-destroyed-by-the-next-pull-and-every-configuration-writing-command-shares-it)
- **#52** — [The workspace's channels and the repository's agents have never been reconciled in either direction](#52-the-workspaces-channels-and-the-repositorys-agents-have-never-been-reconciled-in-either-direction)
- **#53** — [`jester` is an active commentary agent with a weekly schedule, no channel, and no defined material](#53-jester-is-an-active-commentary-agent-with-a-weekly-schedule-no-channel-and-no-defined-material)
- **#54** — [Two defects deferred on scope grounds were load-bearing — the deferral judgement, not the filing, is what failed](#54-two-defects-deferred-on-scope-grounds-were-load-bearing--the-deferral-judgement-not-the-filing-is-what-failed)

**P3 — nice to have / uncertain ROI** (8)

- **#48** — [A model list is enumerable for a local provider and is a guess for a hosted one — record the asymmetry, build neither yet](#48-a-model-list-is-enumerable-for-a-local-provider-and-is-a-guess-for-a-hosted-one--record-the-asymmetry-build-neither-yet)
- **#36** — [Three enumerating guards each carry their own source-tree walker, and `tests/` subdirectories are enumerated by none of them](#36-three-enumerating-guards-each-carry-their-own-source-tree-walker-and-tests-subdirectories-are-enumerated-by-none-of-them)
- **#21** — [`already_in_channel` warns five times per boot — and the obvious fix is in the wrong place](#21-already_in_channel-warns-five-times-per-boot--and-the-obvious-fix-is-in-the-wrong-place)
- **#29** — [`gmail-unsubscribe` is a declared agent permission that no code implements](#29-gmail-unsubscribe-is-a-declared-agent-permission-that-no-code-implements)
- **#13** — [MCP server wrapper](#13-mcp-server-wrapper)
- **#14** — [Watercooler retro → LinkedIn draft](#14-watercooler-retro--linkedin-draft)
- **#15** — [Task complexity auto-scaling TURNS](#15-task-complexity-auto-scaling-turns)
- **#16** — [Channel-per-task archive mode](#16-channel-per-task-archive-mode)

## P1 — Protects or unblocks the live deployment

### 55. The channel mapping had no reproduction path, and a deploy proved it
**BLOCKED — OWNER ACTION (off-repo).** The mechanism, the reconstruction command and the
guard all landed. Both remainders are the owner's: a real `docker compose restart jt-agent`
to exercise the live resolution path for the first time, and a decision about where
`node scripts/channel-map.js --report` output is kept off-box. Remainder for a branch: none.
**Filed 2026-09-15,** from the incident on the evening of 2026-09-15. **P1 because it
already happened**: a deploy left five active agents with no resolved channel and stopped
two scheduled agents, and the recovery was a human reading identifiers out of terminal
scrollback. Nothing in the repository recorded which channel an agent runs in.

**The mechanism, established from the repository rather than from the report.** Three
facts compose into it:

1. `agents/shared/channel-map.json` is gitignored and is the ONLY thing that maps a
   declared `channel_name` to a Slack id (`lib/agent-registry.js` `applyWorkspaceState`).
2. The only writer it had ever had was `ensureChannel()` (`lib/slack-client.js`), reached
   from `ASK: create channel` — so its keys are the channel names a human actually
   created: `claude-bridge`, `code-review`, `secretary-inbox`, `sqtools-alerts`,
   `email-monitor-agent`, `social-media`.
3. The 2026-09-15 markdown migration declared names by the convention `<id>-agent`
   (`scripts/migrate-agent-definitions.js` `channelNameFor`), so seven of eleven
   definitions asked for keys that had never existed in that file.

So the map resolved exactly the two declared names that happened to be real
(`claude-bridge`, `email-monitor-agent`) and nothing else — two of the seven distinct
names the eight active agents declare. The two scheduled agents that stopped, `secretary`
(`0 7 * * *`) and `security` (`0 1 * * *`), are two of the five that did not resolve.

**The migration's seeding step is the part that did not survive, and it could not have.**
Its header is right that seeding was the condition for safety — "First boot after the
migration is a cache hit for every existing agent" — and it does seed, from the legacy
file's ids, keyed by the new name. But its output is `agents/shared/channel-map.json`,
which is **gitignored**, and a dispatched task runs in a **scratch clone**
(`docs/EXECUTOR-CONTRACT.md` §7). The seed was written into a temp directory and
discarded with it. A step whose only output is an ignored file cannot travel with the
commit that needs it, by construction. Six name→id mappings would have been seeded
(`bridge`, `code-bridge`+`code-sqtools` sharing one, `secretary`, `security`,
`email-monitor`, `story-bot`); on the box, zero were.

**And the script can no longer run at all.** It reads `agents/agents.json`, which the
same commit deleted:

```bash
git log --diff-filter=D --format='%H %s' -1 -- agents/agents.json
node -e "require('./scripts/migrate-agent-definitions').migrate({dryRun:true})"  # ENOENT
```

**What was done about it (2026-09-15).** The declared names were corrected to the
workspace's real ones from the tracked evidence in `agents/activation-checklists.json`
(`docs/AGENTS.md` → "Declared channel name vs. the workspace's real one"), the bridge now
resolves an unresolved active agent's name against Slack at startup and reports what it
could not resolve, and `scripts/channel-map.js` reconstructs the whole map — from Slack,
or from the deleted `agents/agents.json` in git history — so the fresh-install path is a
command rather than archaeology.

**What is NOT closed, and is why this stays open:**
- **The live resolution path has never run against a real Slack workspace.** Every test of
  it uses a stub. The first real exercise is the next `docker compose restart jt-agent`,
  and this repository cannot verify a deployment (`CLAUDE.md` → "Self-update — DESIGNED
  AND TESTED, NOT WIRED").
- **The reconstruction from history is one-shot.** It recovers the ids that were in
  `agents/agents.json` when it was deleted. An id that changes after that date — a channel
  recreated, a workspace migrated — is recoverable only by resolving the name again.
- **`jester` still declares a channel that does not exist** and no real name exists to
  substitute; see #53.
- **Nothing exports the resolved map off-box.** If both the NAS and Slack are unavailable
  the mapping is gone. `node scripts/channel-map.js --report` prints it; where that output
  is kept is an owner decision that has not been made (same class as #42).

**Regenerate the whole picture:**
```bash
node scripts/channel-map.js --report      # declared name -> resolved id, per agent
node scripts/agent-surface.js             # and what each agent therefore gets
```
**Priority:** P1 | **Effort:** Medium (done); Low to close the remainder
**Risk:** Low — resolution never creates a channel and refuses rather than guessing
**Status:** open — mechanism fixed and reproducible (`lib/channel-map-rebuild.js`,
`scripts/channel-map.js`, guard `tests/channel-map-rebuild.test.js`); live verification
against a real Slack workspace and off-box export of the resolved map both outstanding

---

### 56. `npm test` fails intermittently inside jest's globalSetup — twice, unreproduced
**Filed 2026-09-16, second occurrence the same day.** **Two observations, message
captured neither time — filed because of the rule #54 records, not despite it.**

**What was seen, twice, with the same signature.** A full `npx jest` run failed *before
any suite ran*, with the stack ending in
`runGlobalHook` -> `ScriptTransformer.requireAndTranspileModule`. That is the
`globalSetup` module (`tests/helpers/live-state-setup.js`) failing to load, not a suite
failing. Both times the very next run, same working tree, was green.

**Frequency, as far as it is measured:** 2 failures across the full-suite runs of one
session — of the order of 35 runs, not precisely counted, so treat it as *"a few percent"*
rather than a rate.

**What was done, and what none of it established.** After the first: five warm runs,
then `npx jest --clearCache` and three more — eight green. After the second: twelve
consecutive isolated runs with the exit code checked and the full output redirected to a
file, then four more reproducing the exact compound shell shape both failures occurred
in (`git fetch && git log && git diff && npx jest`). All sixteen green. Disk was checked
during the second hunt: 30 GB free, so it is not the fixed-allowance exhaustion that
environment is prone to. **No cause is known and the cold-cache hypothesis is not
supported.**

**The instrumentation mistake, made TWICE, which is why there is still no message.** Both
times the command piped jest through `tail`, so the actual error was discarded and only
the stack frames survived. The capture that works, and that found nothing to capture on
sixteen subsequent runs:
```bash
npx jest --silent > /tmp/jest-out.txt 2>&1; echo "exit=$?"; head -40 /tmp/jest-out.txt
```
**Never react to a failing gate through `tail`.** Next steps if it recurs: the full
stderr from the above, and `--runInBand` to rule out a worker interaction.

**Why this is filed at P1 with one data point.** #54 records the rule: *a defect in the
apparatus that tests other work is P1 regardless of its symptom, because everything
downstream of it is unverified while it is open.* `globalSetup` is the guard that stops
a test run writing the configuration the deployment reads (`live-state-teardown.js`).
A run where it fails to load is a run where that guard did not run. The symptom was one
red run; the blast radius is every judgement made on a run that failed the same way and
was re-run without anyone noticing — which is precisely how the `getRecentCompleted`
flake survived, at 25 of 40.

**What would make this actionable, and the mistake that stopped it being actionable
now.** The output was piped through `tail`, so the actual error message was discarded
and only the stack survived. **Capture the whole output of a failing gate before
reacting to it.** Next steps if it recurs: the full stderr, and `--runInBand` to rule
out a worker interaction.

**Not claimed:** that this is a real defect rather than an environment hiccup, or that it
is related to the change that was in flight when it appeared (four new `lib/` modules and
five new suites, none of which `globalSetup` imports — and the second occurrence came
*after* that work was committed and green, which weakens the connection further).
**2026-09-16 audit pass: three more runs, all green, still unreproduced.** Run with the
capture that works, on a fresh `npm ci` in a clean container:
`npx jest --silent > out.txt 2>&1; echo "exit=$?"` -> `exit=0` three times, 74 suites /
2391 tests / 0 skipped each time. That is 19 consecutive green runs since the second
observation. **This is not evidence the defect is absent** — a few-percent intermittent
needs far more runs than this to rule out, and the item's own framing ("treat it as a few
percent") already says so. Recorded as three more data points, not as progress.

**Note for whoever picks this up:** the runner was **absent** in that container until
`npm ci` was run (`ls node_modules/.bin/jest` -> no such file). Under the #54 rule that is
the same class as this item — a gate that cannot start. It is an environment condition, not
a defect here, but a hunt for this flake that begins without confirming the runner is
installed will misread `jest: not found` as the very failure it is hunting.

**Priority:** P1 by the #54 rule | **Effort:** Low to instrument, unknown to fix
**Risk:** Unknown — a gate that can fail to start is the shape #54 is about
**Status:** open — two unreproduced observations, same signature; 19 green runs since;
instrument before hunting

---

### 42. Every backup this system has lives on the box it backs up, and their liveness is checked by nothing
**Filed 2026-09-15,** from the NAS hardening pass
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 7.3 and
7.4). **Placed at the top of P1 deliberately:** the existing P1s are about the bridge
failing to deploy or to run. This one is about there being nothing to restore from when
the box is gone. If the ranking is wrong, move it — but state the axis.

**Owner-supplied, not repository-verified** (the NAS is not reachable from a checkout):
nightly `pg_dump` at 02:15 → `/share/CACHEDEV1_DATA/sqtools/backups/`, 14-day retention;
DayZ mirror at 02:45, 8-day retention. Both write to the **same appliance** that runs the
thing they back up.

**Problem, in two independent halves.**

1. **No off-box copy.** A backup on the box it backs up survives exactly one failure —
   someone dropping a table. It survives neither of the two failures that actually take a
   NAS out: ransomware encrypts the backup directory in the same pass as the data, and a
   failed disk or controller takes both. QNAP appliances are a *specific* ransomware
   target with a campaign history (Qlocker, DeadBolt, eCh0raix), which is what moves this
   from prudent to overdue. **The test for "off-box" is: could it be restored if the NAS
   were powered off and gone?** A second share on the same appliance fails that test; so
   does a permanently-mounted USB disk, against ransomware. A snapshot fails it too — a
   snapshot is fast recovery, on the same volume, and dies with it.
2. **Silent stoppage, already observed.** A firmware update wipes `/etc/config/crontab`.
   Both jobs stop and **nothing reports it** — the job that would complain is the job that
   no longer runs. Same class as #17: a scheduled thing nobody is told has stopped.

**The check is the artifact's freshness, never the cron entry.** `crontab -l` showing the
entry proves nothing about last night.
```bash
# On the NAS — this is the check.
find /share/CACHEDEV1_DATA/sqtools/backups/ -name '*.sql*' -mtime -1 | wc -l   # 0 = last night did not run
ls -lt /share/CACHEDEV1_DATA/sqtools/backups/ | head -5
crontab -l    # second, only to explain a 0 above
```

**Fix, in order.** (a) One off-box copy, **pulled** by the other side rather than pushed —
a push credential stored on the NAS is a credential an attacker on the NAS holds; the
direction of the pull is the control. (b) A restore actually performed — a `pg_restore` of
the newest dump into a scratch database with a row count against live, dated and written
down. A backup nobody has restored is a hypothesis. (c) An age alert, not a habit:
"newest dump older than 26 hours" posted to `#sqtools-ops`. This repository already owns
that path — `notifyOps` in `lib/notify-owner.js`, which every other operational failure in
the bridge uses. A reminder to run the command has the same failure mode as the cron entry.

**Repo-side half available today:** (c) is buildable here. (a) and (b) are on the box.

**Priority:** P1 | **Effort:** Medium for (a); Low for (b) and (c).
**Risk:** None to the running process — everything here is additive or read-only.
**Status:** open — needs the NAS

---

### 41. The NAS is the single point of failure for every stack and every credential, and its exposure has never been established
**BLOCKED — OWNER ACTION (off-repo).** The repo-side half landed 2026-09-15 (Step 7.9).
Everything remaining is on the appliance: the four exposure questions, then the Step 7
hardening order. Remainder for a branch: none.
**Filed 2026-09-15,** from the NAS hardening pass
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 7,
which carries the full ordered procedure, the commands, and the per-item labels).

**The shape, in one sentence:** one QNAP TS-264 is simultaneously the production host
(SqTools — money and customer PII), the credential store (the `jt-agent` `env_file`'s 9
credential keys per Step 3, plus the repository deploy key and the Claude CLI's live OAuth
credential), and the backup target (#42). A compromise of the appliance is a compromise of
all three at once.

**The undone thing is a check, not a change.** Step 6 of the same document already
recorded that the host level is **owned by no repository**. Nobody has established whether
anything on this box is reachable from the internet — and that answer decides how much of
the rest matters. Four questions, in order, with the commands in Step 7.2: the router's
port-forward table; QTS **UPnP / myQNAPcloud Auto Router Configuration** (which punches
forwards on your behalf — a forward you never made is the one you never audit);
myQNAPcloud Link / DDNS (a relay is an inbound path no router table shows); and an
**off-LAN probe** from a phone on cellular against 8080/443/22/5001. Tailscale needs none
of them — it is outbound-only.

**Write the answers down, dated, in Step 7.** A "no" nobody recorded gets re-asked every
six months and eventually gets guessed at.

**Then the rest of Step 7, in its stated order:** accounts (disable the built-in `admin`
after a named administrator works, 2FA, IP Access Protection) → service surface
(Telnet off, SMB1 off, every unused service off) → Malware Remover and Security Counselor,
whose report against the *actual* firmware is worth more than any convention list → locked
snapshots as the fast-recovery layer. Two things in that pass are compromise checks rather
than hardening and should be done first: **unknown users, shares or scheduled tasks**, and
Malware Remover. Either coming back positive changes the task from hardening to incident
response.

**Also unowned: Supremo.** It is a remote-desktop path into the LAN that does not go
through Tailscale, so "access is via Tailscale" does not cover it. **Unverified:** whether
it starts automatically, whether access is fixed-password or one-time, and who else holds
that credential.

**Every QNAP menu path in Step 7 is an unverified lead** — menus move between QTS
releases. Confirm on the appliance, the same way `docs/EXECUTOR-CONTRACT.md` §2 treats a
supplied file:line.

**Repo-side half, landed 2026-09-15** (Step 7.9): the deployment definition now has an
off-box copy (`docker-compose.example.yml`) and the live file is gitignored so
`git clean -fd` cannot delete it (#26). The container-level narrowing shapes are written
out against the captured compose, commented, in that file — they belong to #27, not here.

**Priority:** P1 | **Effort:** Low to establish exposure; Low-to-Medium per hardening item.
**Risk:** Changing appliance settings is Medium — removing a forward or disabling a
service stops whatever used it, and locking yourself out of a NAS reached only over
Tailscale is a physical-access problem. Establish what uses a thing before removing it,
and verify the replacement administrator logs in before disabling `admin`.
**Status:** open — needs the NAS

---

### 17. Nothing starts `auto-update.js` — merged code does not reach the running process
**Filed 2026-09-14.** *(This item was once duplicated as two `### 17.` headings; reconciled to one on 2026-09-14. The index at the top of this file is regenerated from the headings, so a repeat would show up there.)*

**Status 2026-09-14: documentation corrected, deploy path unchanged.** The false claims
are fixed (see below); the gap itself is open and is the owner's decision.

**Problem (repo-side, verified from this checkout):** no file in this repo starts
`auto-update.js`. Regenerate:
- `node -e "console.log(Object.keys(require('./package.json').scripts))"` → `[ 'test', 'test:smoke', 'validate' ]` — none of them runs it.
- `grep -rn "auto-update" --include=*.js --include=*.json . | grep -v node_modules | grep -v package-lock | grep -v '^./tests/'` → comments, doc prose, and `auto-update.js`'s own body only. Nothing spawns or forks it.
- The repo carries no Procfile, systemd unit or supervisor config. Since 2026-09-15 it
  does carry `docker-compose.example.yml` — the off-box copy of the live file, not a
  second deployment — and its `command:` starts `node bridge-agent.js` only, so it does
  not start the daemon either.

**Problem (off-repo, owner-supplied — NOT verifiable from a checkout):** the live compose
runs `sh -c "npm ci && npm install -g @anthropic-ai/claude-code && node bridge-agent.js"`
(`docker-compose.yml:17` on the NAS). That file stays untracked on the NAS (and, since
2026-09-15, gitignored — #26); `docker-compose.example.yml` reproduces it here. A check
run from inside the container independently recorded "the compose service starts only
`node bridge-agent.js`" (`docs/CONFIG-SURFACE-AND-REBUILD.md`, Step 5). Regenerate **on
the NAS**: `grep -n "command\|entrypoint\|auto-update" /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml`
and `crontab -l` (a host cron is the last unchecked way it could be started).

**Impact, observed not theorised (owner, 2026-09-14):** three branches merged to `main`
and pushed while the container had been up 11 hours; it kept running the code it loaded at
start. A manual `docker compose restart` was what actually deployed them.

**Why this outranks everything else in P1** (carried from the duplicate copy of this
item, reconciled 2026-09-14): every other item in this file is fixed by merging a commit,
and merging a commit is exactly the step that is not connected to the running process.
This is the deploy path itself.

**It would not start cleanly today either (verified here).** `validateConfig()`
(`auto-update.js:803-823`) hard-fails when `LOCAL_REPO_DIR` does not exist, and the
default is the dead Pi path `/home/jtpets/jt-agent` (`auto-update.js:40`). Observed:
`node auto-update.js` with no `LOCAL_REPO_DIR` exits **1**. Under `restart:
unless-stopped` that is a restart loop — so `LOCAL_REPO_DIR` must be set *before*
anything starts this daemon. Whether the live `.env` sets it is unverified from here.

**A green suite for an unstarted daemon.** `tests/auto-update-restart.test.js`,
`tests/auto-update-defer.test.js` and `tests/update-verifier.test.js` pass (62 tests) by
injecting a dependency bag into `checkForUpdates()`. `main()` and `validateConfig()` are
neither exported nor exercised, so the startup path that fails above is untested. This is
the verification-integrity class, not a passing gate.

**Done 2026-09-14 — the documentation no longer claims this works.** Corrected in
`CLAUDE.md` (self-update section retitled "DESIGNED AND TESTED, NOT WIRED" with the
evidence; deploy-command block; task-queue coordination steps marked not-live; task-lock
deferral section), `README.md` (feature bullet, architecture diagram, Auto-Update
section), `docs/WIRING-AND-SEAMS.md` (entry-point table and the task-lock seam),
`docs/AGENTS.md` (**agent-facing** — the "Auto-Deploy … restarts PM2 process" step was
false in both halves), `agents/bridge/memory/context.json` (**agent-facing**),
`COMMANDMENTS.md` (commandment 11 named a non-existent auto-update process), and
`docs/CONFIG-SURFACE-AND-REBUILD.md` (Step 5 "undetermined" → resolved repo-side).
Regenerate the claim list:
```bash
grep -rniE "self-updat|self-deploy|deploys itself|restarts itself|updates itself|auto-update(r| daemon| detects)|deploy_policy|CHECK_INTERVAL_MS|polls its own git" \
     --include=*.md --include=*.json . | grep -v node_modules | grep -v package-lock
```

**Still open — the owner's decision, stated not decided.** The two shapes (start the
daemon / declare manual restart the deploy), a third (push-triggered restart), and their
costs are written up in `CLAUDE.md` → "Two open questions". **This repo cannot implement
any of them**: the compose file is untracked and off-repo, and belongs to no repository
today (`docs/CONFIG-SURFACE-AND-REBUILD.md`, Step 6).

**The independent requirement: nothing can answer "is the running process on `main`?"**
Not the repo, not the container, not Slack. "Merged" and "deployed" are unrelated facts
and nobody is told when they diverge — the 11-hour gap was found by a person noticing.
Whatever reports it must be the *running* process (a boot line to `#sqtools-ops`, an
`ASK: version`, a heartbeat field, a state file); anything computed from the working tree
at query time answers a different question and would have read "current" throughout that
gap. Land this **before** arming any self-restart, so the first real self-update is
observable.
**Effort:** Low for the commit-report; Low–Medium to wire the daemon (off-repo either way).
**Risk:** Wiring it is Medium — it arms a self-restarting daemon whose guards have never
run outside tests, and whose startup config is currently wrong.

---

---

### 25. The preserved scratch clone does not survive a container recreation — silent data loss inside the feature that prevents silent data loss
**Filed 2026-09-14,** from the deployment-topology capture. Full write-up with the
topology it depends on: [`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md)
→ Step 0, consequence 2.

**Repo-side half re-verified 2026-09-16 and it is NOT done.** The alert at
`bridge-agent.js:1127-1133` posts `Location: <path>` and "The clone was NOT deleted so the
work can be recovered and pushed manually" — it still says nothing about the clone being in
container-local storage, nothing about a container recreation destroying it, and nothing
about the `docker exec -it jt-agent sh` needed to reach the path it prints. So fix half 2,
which this item calls Low effort and which a branch can land today, is untouched. This is
why the item is **not** marked owner-blocked: it has real engineering work left.

**What the feature promises.** `detectUndeliveredWork(dir)` (`lib/clone-lifecycle.js:237`,
called from `bridge-agent.js:1123`; filed as `:237-330` and `:964-981`) refuses to delete a scratch clone that holds
uncommitted changes, or local commits `git ls-remote origin` does not show on the remote,
or whose delivery state cannot be read. It keeps the clone and posts its path to
`#sqtools-ops` so the work can be recovered and pushed by hand. It exists because three
tasks' work was destroyed by unconditional cleanup on 2026-09-13. `docs/EXECUTOR-CONTRACT.md`
§7 tells every executor it is there.

**What the deployment does to it.** Clones live under `WORK_DIR`, default
`/tmp/bridge-agent` (`lib/config.js:41`, used at `bridge-agent.js:503-508`). That path is
neither bind mount — the compose mounts only `…/jt-agent → /bridge` and
`…/sqtools/app → /repo:ro` — so it is in the container's own writable layer:

| Operation | Preserved clone survives? |
|---|---|
| `docker compose restart jt-agent` (the documented deploy step) | yes — same container, same layer |
| `docker compose up -d --force-recreate jt-agent` (**required for any `.env` change**) | **no** |
| `down`/`up`, an image change, a container prune, a daemon restart that recreates it | **no** |

Row 2 is the defect: `CLAUDE.md` and `docs/EXECUTOR-CONTRACT.md` both *instruct*
`--force-recreate` for an environment change, so the documented operational procedure
destroys preserved work, with no warning, days after the alert that named it.

**Second mechanism, live today regardless of restarts.** The alert posts a
container-internal path. `/tmp` is not mounted, so `/tmp/bridge-agent/task-…` does not
exist on the NAS host: an owner reading the alert cannot `cd` there. Recovery needs
`docker exec -it jt-agent sh` first, and the alert does not say so.

**Regenerate:**
```bash
# repo side — the default and its consumers
grep -rn "WORK_DIR" lib/config.js bridge-agent.js lib/task-lock.js lib/task-queue.js auto-update.js
grep -n "detectUndeliveredWork" -A 20 bridge-agent.js     # the alert text and the path it posts
# NAS side — the mounts, and whether .env overrides the default
grep -n "volumes" -A 3 /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml
grep -n "^WORK_DIR=" /share/CACHEDEV1_DATA/jt-agent/.env   # names only — never print the file
```

**Unverified:** whether the live `/bridge/.env` sets `WORK_DIR`. If it already points
somewhere under `/bridge`, the durability half of this item is closed and that grep's
output is the evidence. The path-in-the-alert half stands either way.

**Fix — two halves, only one of which this repo can land.**
1. *Off-repo (the real fix, and not ours):* put `WORK_DIR` on a mount. Either add a volume
   for it or set `WORK_DIR` to a path under `/bridge` in the live `.env`. Note the second
   also drops the preserved clone into the live git working tree, so it wants a gitignored
   subdirectory, not the repo root. Deployment change; the compose file belongs to no
   repository today (item #4b, Step 6).
2. *Repo side (available now):* say the true thing in the alert — that the clone lives in
   container-local storage, that it is lost on a container recreation, and the
   `docker exec` needed to reach it. A regression test on the alert text is the close.
   Do **not** "fix" this by making cleanup delete the clone anyway.

**Priority:** P1 — it is the silent-data-loss class, which is the top of this file's
ranking axis, and the loss is of work a human was told had been saved for them.
**Effort:** Low for half 2; Low for half 1 but it is the owner's to make.
**Risk:** Low — half 2 is message text plus a test.

**Status:** open (re-verified 2026-09-14)

---

### 3. The scheduler never checks `planned` status — CONFIRMED FIRING LIVE 2026-09-14
**BLOCKED — OWNER ACTION (off-repo).** Every fix part landed on `main`; the close condition
is this item's own namesake, a claim about what the *running container* registers at startup.
No branch can settle it. Remainder: one `docker compose restart jt-agent` on the NAS, then
compare the startup output against the close condition restated below.
**Filed 2026-09-13** (derived: `git log -S'### 3. ' --reverse -- WORK-TODO.md` -> `20dc049`, the backlog re-derivation).
**Problem:** `startScheduler` iterates `loadAgents()` (all agents) and registers a cron
job for any agent that has *both* a `schedule` and a `channel`
(`lib/agent-scheduler.js:216`, `:227`). It never consults `status: "planned"`.
`getActiveAgents()` (which *does* filter `status !== 'planned'`, `lib/agent-registry.js:79`)
is not used here — but it **is** used by `buildChannelsToPoll()` in `bridge-agent.js`, and
that split is the whole defect.

The CONTEXT said "four agents are planned and their schedules never register." Half right.
Regenerate the registry table:
```
node -e "const a=require('./agents/agents.json');(Array.isArray(a)?a:a.agents).forEach(g=>console.log([g.id,g.status||'active',g.channel||'null',g.schedule||'-'].join(' | ')))"
```
→ 11 agents; four planned (`storefront`, `social-media`, `marketing`, `story-bot`). Their
schedules mostly don't run for incidental reasons, not by design:
- `storefront` — no `schedule`, nothing to register.
- `social-media`, `marketing` — have a `schedule` but `channel: null`, so the
  `!agent.channel` guard skips them.
- **`story-bot` — `status: "planned"`, `schedule: "0 18 * * 5"`, task `draft-weekly-posts`,
  and a real `channel` (`C0AP8CHCV1U`).** Its template exists
  (`lib/agent-scheduler.js:56`). Its job registers and fires.

**Confirmed live 2026-09-14 (owner, against the running container) — and it is worse than
"the channel is unused":**
- Startup reports `Scheduled story-bot:draft-weekly-posts` with cron `0 18 * * 5`.
- Startup also reports `Joined 5/5 agent channels` — five, against eleven agents.
- On task completion: `[bulletin-watcher] Failed to notify story-bot: An API error occurred: not_in_channel`.

**The mechanism, verified in this checkout.** The two paths disagree by construction:

| Path | Source | story-bot? |
|------|--------|-----------|
| `startScheduler` (`lib/agent-scheduler.js:216`) | `loadAgents()` — **all** agents | **scheduled** |
| `buildChannelsToPoll` (`bridge-agent.js`) | `getActiveAgents()` — excludes `planned` | **not joined** |

So the scheduler arms a weekly job to post into a channel the join path deliberately
excluded. Every Friday at 18:00 story-bot runs, produces drafts, and posts them nowhere.
The failure is one log line in a container nobody tails: the job succeeding and the job's
output reaching a human are different events, and only the first is observed.

**The mirror-image instance, same root cause: `jester`.** `status: active`,
`schedule: "0 18 * * 5"`, `channel: null`. The `!agent.channel` guard skips it, so an
*active* agent's weekly schedule silently never arms — no error, no log, no channel. Both
directions of the same missing invariant: **nothing asserts that the scheduled set and the
joined set are the same set.**

**Blocks the channel-consolidation work.** The routing table cannot be written until the
current mapping is enumerated, and the mapping is currently split between
`agents/agents.json` and environment variables with no file describing either — the live
`.env` carries six `*_CHANNEL_ID` keys that no code in this repo reads (see item 4b and
`docs/CONFIG-SURFACE-AND-REBUILD.md`).

**Fix (three parts, all small):**
1. Gate scheduling on active status — call `getActiveAgents()` in `startScheduler`, or add
   `if (agent.status === 'planned') continue;` alongside the existing skips.
2. **Make the disagreement loud, not silent.** At startup, log (and post to
   `#sqtools-ops`) any agent that is scheduled-but-unjoined or has a schedule it cannot
   run for lack of a channel. `jester` would have surfaced years of silence this way.
3. Regression tests in `tests/agent-scheduler.test.js` (it already mocks `node-cron`):
   a planned agent with schedule+channel registers **zero** jobs; an active agent with a
   schedule and `channel: null` is **reported**, not silently skipped. The second test is
   the anti-drift enumerator for this class — it fails when the two sets diverge again.
**Effort:** Low.
**Risk:** Low — part 1 narrows what registers and cannot start anything new; parts 2-3 are
reporting and tests.

**Re-verified 2026-09-14 (this revision), and partly narrowed.** `startScheduler` still
reads `loadAgents()` and still never consults `status`
(`grep -n "status === 'planned'\|getActiveAgents" lib/agent-scheduler.js` -> no hits).
What *did* change: the same pass that wired the deterministic inbox check added a
registration-time refusal for a task name that resolves to neither a handler nor a
template, and an enumerating guard for it
(`tests/agent-scheduler.test.js` -> `resolves every task name scheduled in agents.json`).
That is fix part 3's *shape* applied to a different invariant — it proves the pattern
works here and is the model for the scheduled-set-vs-joined-set assertion this item still
needs. Parts 1 and 2 are untouched.
**ADVANCED 2026-09-15 — all three fix parts landed; left open pending re-verification
against the running container.** `startScheduler` now checks `status` and refuses a
planned agent's job (`grep -n "status === 'planned'" lib/agent-scheduler.js` -> a hit).
Fix part 1 went further than this item proposed: joining, polling and scheduling no
longer have three rules to keep in agreement — they all derive from `activeChannels()`
in `lib/agent-surface.js`, and `buildChannelsToPoll()` in bridge-agent.js delegates to
it rather than restating it, so the two sets *cannot* diverge rather than being checked
for divergence. Fix part 2 landed: a planned agent's schedule and an active agent whose
declared channel has not resolved both go into the scheduler's `refusals`, which posts
to `#sqtools-ops` at startup, and unresolved channels get their own post naming each
agent. `jester` is now reported on every boot. Fix part 3 landed in
`tests/agent-surface.test.js`, including the flip of the test that asserted the defect
("joinableChannels includes a planned agent's existing channel — the story-bot case").

Left **open** deliberately: this item's namesake is a claim about the *running*
container ("CONFIRMED FIRING LIVE"), and a scratch clone cannot verify what registers on
the box. Deploys here are manual, so nothing has reached the NAS.

**CLOSE CONDITION CHANGED 2026-09-15 — read this before checking the box.** It used to
read "close it after a restart whose startup output shows the refusals and **no**
`Scheduled story-bot:draft-weekly-posts`". That is now **inverted for story-bot**, and
following the old wording would report a success as a failure. story-bot has since been
activated on purpose (`default_status: active` in `agents/story-bot/agent.md`), so its
job registering is now CORRECT — what was wrong was registering while the poll loop did
not read its channel, and joining, polling and scheduling now derive from one rule. The
startup output that closes this item is:

- `Scheduled story-bot:draft-weekly-posts` **present**, AND story-bot's channel in the
  joined/polled set — the three consequences arriving together, which is the invariant
  this item is about;
- refusals posted to `#sqtools-ops` for `jester` (active, `#jester-agent` never
  resolved) and for `social-media` / `marketing` (declared schedules, not activated);
- **no** agent that is scheduled but unjoined — the count is 0, and
  `tests/agent-surface.test.js` already fails if it is not.

Regenerate the expected table before comparing: `node scripts/agent-surface.js`.

**Priority:** P1 | **Effort:** Low | **Status:** open — fix landed on a branch, not verified live; close condition restated above

---

### 4. Replace HTTP polling with Slack Socket Mode (event triggers)
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** its ancestor heading
"Replace HTTP polling with Slack Socket Mode" is in the 2026-04-05 seed `4b6ee4a`, so the
idea has been open ~5.5 months and the re-derivation date understates it.
**Source:** tomeraitz/claude-slack-bridge
**Problem:** The bridge still polls: `setInterval(poll, POLL_INTERVAL)` at
`bridge-agent.js:2353` (cited `:2038` when filed; re-checked 2026-09-16), default
`POLL_INTERVAL_MS=30000`. No `@slack/socket-mode`
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

**Priority:** P1 | **Effort:** Medium | **Status:** open — but the premise moved on 2026-09-14.
`@slack/socket-mode` is now a dependency and `lib/slack-socket.js` runs a live Socket Mode
connection, so the "no dependency exists" evidence above is stale (`grep -c socket-mode package.json`
-> 1 now, not 0). What landed is **additive and carries slash commands only**; the poll loop is
untouched and is still the sole message path, deliberately — see #43 and
[`docs/WIRING-AND-SEAMS.md` section 7](docs/WIRING-AND-SEAMS.md). This item is what remains: moving
**message intake** off polling. It is now cheaper (the connection, the token, the reconnect
reporting and the app configuration all exist) and should stay parked until the connection has been
boring for a while, because the poll loop is how the task that would repair it gets dispatched.

**Amended 2026-09-15 — this item is the largest of THREE ways to cut the same latency, and
was the only one written down.** The latency an operator feels between submitting a task
and it starting is `POLL_INTERVAL_MS` (default `30000`, `lib/config.js`), and `/dispatch`
pays it in full because it posts a message and lets `poll()` find it. Recorded together so
the expensive one is not chosen by default:

| Option | Change | Cost |
|---|---|---|
| **Lower the interval** | One env var. `POLL_INTERVAL_MS=10000` → 10s worst case. Needs `docker compose up -d --force-recreate jt-agent`, not `restart`. | Steady Slack API pressure across every polled channel, all day, for a latency win only on the minority of ticks that have a message. Nothing in code changes, so nothing can regress. |
| **Poll immediately after a command posts** | Call `poll()` once, right after `handleViewSubmission`'s `chat.postMessage` resolves. Small and additive. | Preserves every property the poll loop owns — one intake path, dedup by message `ts` in `lib/bridge-state.js`, the allowlist gate, `describeSkipReason` logging — because it triggers the *existing* path rather than adding one. Needs re-entrancy care: `poll()` must not run twice concurrently, and a failed immediate poll must be a no-op, not an error the operator sees. |
| **Move message intake to the socket** | This item. | Changes how *every* message arrives, including the task that would repair it. Largest blast radius of the three. |

The middle row is the one this repository can take today at near-zero risk, and it was
missing from the record: the choice as filed read "30 seconds or rewrite intake". It is not
done here — it touches the live intake path and belongs in its own change with its own
regression test.

---

### 43. A flattened dispatch loses its fields — the connection for the fix exists, the command does not
**BLOCKED — OWNER ACTION (off-repo).** The command exists — `/dispatch` was built
2026-09-15 and its four suites are green. Remainder is entirely Slack app configuration,
which lives in no repository: Socket Mode on, an app-level token with `connections:write`
in `.env` as `SLACK_APP_TOKEN`, the `/dispatch` command registered, Interactivity on, the
app reinstalled, then `docker compose up -d --force-recreate jt-agent`. Remainder for a
branch: none.
**Filed 2026-09-14** (derived: `git log -S'A flattened dispatch loses its fields' --reverse -- WORK-TODO.md` -> `3dacba8`).
Note this is the P1 `### 43.`; the P2 item that briefly shared the number was filed `d5b0c13`
and is closed and purged.
**Source:** three tasks on 2026-09-14 that ran with no repository and the default turn
budget, worked for ten to fifteen minutes each, and failed.
**Problem:** a dispatch is a Slack **message** whose first lines carry `TASK:`/`REPO:`/
`BRANCH:`/`TURNS:`/`INSTRUCTIONS:`. Slack flattens some pasted multi-line input onto one
line; the labels are then no longer at the start of a line, `REPO:` absorbs the rest of the
message, and the task clones nothing. `lib/task-parser.js` is not at fault — `FIELD_LABELS`
are uppercase and line-anchored by design, and refusing a non-canonical label rather than
silently downgrading the task is the correct behaviour. The loss happens in the
**transport**, before the parser sees anything, and no parser change can recover a field
the transport merged away.
**What already exists (2026-09-14):** `lib/slack-socket.js` — an additive Socket Mode
connection carrying slash commands, started after the poll loop is armed and never awaited,
with `SLACK_APP_TOKEN` documented and its absence handled as a normal state. It registers
**no command**; the seam is marked `THE COMMAND SEAM` in that file.
**Fix:** register a `/task` slash command (no Request URL needed in Socket Mode), attach
`onSlashCommand`, and open a modal with **separate** inputs for task / repo / branch /
turns / instructions. Five inputs cannot be flattened into one. On submission, build the
message the way `parseTask` reads it back — that generator→parser round trip is already
pinned in `tests/integration.test.js` and the new generator belongs in that pin — and reuse
`lib/git-identifiers.js`, `isUserAuthorized` and `lib/bridge-state.js` dedup rather than
re-deriving them. Step 6 of `docs/WIRING-AND-SEAMS.md` section 7 names the one open design
decision: post the assembled message to `#claude-bridge` and let `poll()` take it (one
intake path, one dedup owner, up to `POLL_INTERVAL_MS` of latency) versus calling
`processTask` directly (faster, second intake path).
**Blocked on an owner action the repo cannot take:** Socket Mode enabled in the Slack app,
an app-level token with `connections:write`, and `SLACK_APP_TOKEN` in `.env` (which needs
`docker compose up -d --force-recreate jt-agent`, not `restart`). Until then the connection
reports itself unconfigured on every boot and nothing else happens.
**Risk:** Low to the running bridge — the poll loop is not touched either way.

**Amended 2026-09-15 — the command exists; this status was stale.** `/dispatch` was built
on 2026-09-15 as three modules — `lib/dispatch-command.js` (handlers, ack ordering,
authorisation), `lib/dispatch-modal.js` (the five-input modal) and `lib/dispatch-message.js`
(the generator and its `assertRoundTrip`) — and the generator→parser round trip is pinned in
`tests/integration.test.js`. The name is `/dispatch`, not the `/task` proposed above. Step
6's open design decision was **decided**: it posts to `#claude-bridge` and `poll()` takes
it, one intake path and one dedup owner. Routing to the *invoking* channel instead is now
its own item, **#46**, with the two dependencies it turns out to have. What remains here is
only the owner action below.
**Regenerate:** `ls lib/dispatch-*.js && npx jest tests/dispatch-message.test.js tests/dispatch-modal.test.js tests/dispatch-command.test.js tests/dispatch-failure-paths.test.js`

**Priority:** P1 | **Effort:** Medium | **Status:** open ONLY on the owner action — connection landed 2026-09-14, command built 2026-09-15; Socket Mode, the app-level token, the `/dispatch` registration and Interactivity are still owner-side (CLAUDE.md, "ACTION REQUIRED on the Slack app")

---

## P2 — Real gaps, no risk to the running process

### 4b. Config surface is undocumented and cross-stack infra is unowned — INVENTORY FILED 2026-09-14
**Filed 2026-09-14** (derived: `git log -S'### 4b. ' --reverse -- WORK-TODO.md`). The date
was previously only in the heading, where the file's own undated-item check does not see it.
**Source:** Pi→NAS migration; config-surface inventory task.
**Evidence:** [`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) —
full env-var inventory (56 code-read keys + 1 dynamic pattern vs 33 in `.env.example` vs
31 in the live `/bridge/.env`), classification, defaults comparison, a rebuild draft, and
the list of what remains unreachable. Regenerate the figure with the grep in Step 2.
**Findings needing a decision (John):**
- **25 keys the code reads that `.env.example` never documents** (List A), several of
  them credentials. A rebuilder working from the example alone misses them. → update
  `.env.example`.
- **`MAX_TURNS` names two different quantities** — a *default* (50, `config.js:34` /
  `llm-runner.js:172`) and a *ceiling* (100, `task-parser.js:56`). Confirmed. Not a value
  conflict, but a name footgun → rename the parser constant to `TURNS_CEILING`.
  **Superseded 2026-09-14 by item #20:** it is four quantities, not two, and the
  `MAX_TURNS` env var turns out to be unreachable on every non-test path. Act on #20.
- **Live `/bridge/.env` carries 7 keys no bridge code reads** (`PM2_PROCESS_NAME` +
  six `*_CHANNEL_ID`), documented by no repo file. `PM2_PROCESS_NAME` contradicts the
  code's "PM2 is gone" invariant.
- **CLAUDE.md is stale:** the live compose already runs `npm ci` (the doc's "ACTION
  REQUIRED" is done); `auto-update.js` is not started by the `jt-agent` service (self-update
  wiring undetermined); compose `TZ` is `America/New_York`, docs say `America/Toronto`.
  **Escalated 2026-09-14 to P1 #17:** the self-update wiring is no longer "undetermined" —
  nothing starts it, and merged code demonstrably did not reach the running process.
- **Cross-stack infra (3 compose files, host crontab, Tailscale, 3 deploy keys) is owned
  by no app repo.** Proposal: a dedicated infra repo owns the runbook; an encrypted
  off-box secrets store (`sops`/`age` or a hosted manager) holds credentials. **Decisions
  deferred to John — not executed by this task.**
**Effort:** Low for the doc fixes; Medium for standing up the infra repo + secrets store.
**Risk:** None to the running process (documentation + read-only inventory only).
**Priority:** P2 | **Effort:** Low (docs) / Medium (infra repo) | **Status:** open

---

### 30. Three `postToOps`, three `sendDM`, and secret redaction reaches 2 of 48 Slack post sites
**Filed 2026-09-14,** from [`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) §1,
§2 and §10 — read those for the full table. This is the highest-divergence row in that map
and the only one with a security consequence.

| Site | Redacts? | `unfurl_links: false`? | On Slack error |
|------|----------|------------------------|----------------|
| `lib/notify-owner.js:82` `notifyChannel` | no | yes | returns `false` |
| `bridge-agent.js:376` `postToOps` | **yes** | yes | swallows |
| `security-review.js:89` `postToOps` | no | yes | **rethrows** |
| `auto-update.js:80` `postToOps` | no | **no** | swallows |
| `security-review.js:72` / `morning-digest.js:168` / `scripts/watercooler.js:64` `sendDM` | no | yes | rethrow / rethrow / **swallow** |

**Why this is a defect, not duplication.** `lib/redact-secrets.js` exists — per its own
header — because spawned-LLM stderr was surfaced verbatim to `#sqtools-ops`. It is applied
at exactly two of the repository's 48 `chat.postMessage` sites:

```bash
grep -rn "chat\.postMessage" --include='*.js' . | grep -v node_modules | grep -v '/tests/' | wc -l   # 51 (2026-09-16; was 48)
grep -rn "redact(" --include='*.js' . | grep -v node_modules | grep -v '/tests/'                     # 7 call sites, 3 of them post paths
```
**Re-measured 2026-09-16: 51 post sites, 3 of them redacting** — `bridge-agent.js:408`
(`postToOps`), `lib/notify-owner.js:126` and `:129` (`notifyOps`). The other four `redact()`
hits are `bridge-agent.js:852`/`:1068`, `lib/notify-owner.js:222` and the definition itself
at `lib/redact-secrets.js:75`. **The ratio got worse, not better** — three more post sites
landed and none of them redacts, which is precisely what the closing paragraph below
predicts happens without an enumerator.

`security-review.js:89` posts **LLM-generated security findings** to `#sqtools-ops` with no
scrubbing — the exact content class the scrubber was written for, on the one path most
likely to quote a credential back out of a diff. `morning-digest.js:168` DMs the owner
email senders and subjects, also unscrubbed.

The rethrow-vs-swallow split is the second divergence: a Slack hiccup aborts a security
review and a morning digest, but not an auto-update cycle or a bridge task.

**Fix.** Make `lib/notify-owner.js` `notifyChannel` the canonical post — *with* `redact()`
moved into it, so adopting it does not strip protection from `bridge-agent`. Add a
`sendDM(userId, text)` beside it (no such helper exists today). Then delete the six copies.
Settle swallow-vs-rethrow deliberately rather than per-file.

**The durable close is an enumerator, not six edits:** a test that walks every non-test
`.js` file, finds each `chat.postMessage` call, and fails when one is reached by a path
that does not redact — the `tests/no-shell-execution.test.js` pattern applied to
unscrubbed-Slack-output. Without it the seventh copy lands unnoticed.
**Priority:** P2 | **Effort:** Low per site; Medium for the enumerator | **Status:** open

---

### 31. Three definitions of "is this a rate-limit failure?", and the morning digest tells the owner tasks will auto-retry when nothing will
**Filed 2026-09-14,** from [`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) §4.

```bash
grep -n "RATE_LIMIT_PATTERNS = \|BANDWIDTH_EXHAUSTION_PATTERNS = " lib/llm-runner.js   # :29, :41
grep -n "error.includes('rate_limit')" morning-digest.js                               # :209
```

`lib/llm-runner.js` carries two, and they differ **on purpose** with the reason written
down: `RATE_LIMIT_PATTERNS` (`:29`) was tightened on 2026-03-27 to require
`rate limit exceeded|error|reached` so ordinary output stops tripping it;
`BANDWIDTH_EXHAUSTION_PATTERNS` (`:41`) stays permissive (bare `/rate.?limit/i`) but only
applies when the process exited 1 **and** produced under `MIN_REAL_OUTPUT_LENGTH` (50)
characters. Two questions, two answers, both documented.

`morning-digest.js:209-214` re-derives the **permissive** shape — `includes('rate limit')`,
`includes('bandwidth')`, `includes('429')` — in a different module, for a third question
("how should I describe this recorded failure to the owner?"), with **neither** gate. It
then prints:

> *Rate limit / bandwidth: N tasks paused due to rate limits. They will auto-retry.*
> (`morning-digest.js:396`)

Nothing retries a task that `llm-runner` did not classify as rate-limited. A task that
merely *mentions* a rate limit in its error text — including one whose real failure was a
bad clone or a syntax error in the diff — is reported to a human as self-healing. The
owner reads "auto-handling" and does not look.

**Fix.** Export a predicate from `lib/llm-runner.js` and call it from `morning-digest.js`.
`morning-digest.js` reads persisted task records rather than live errors, so it cannot use
the `RateLimitError`/`BandwidthExhaustedError` classes the module exports today — closing
this needs a new export, not a call swap. Failing that, record the classification on the
task row at failure time (where `llm-runner`'s verdict is still in hand) and have the
digest read the recorded verdict instead of re-deriving one.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 22. An interrupted task reaches no human
**Filed 2026-09-14, from the #18 fix** (#18 is closed and purged — `git log -S'### 18.' -- WORK-TODO.md`;
the fix is commit `6454fb0`, guarded by `tests/task-queue-lifecycle.test.js`).
Now that `recoverInterrupted()` can actually
fire, the thing it records goes nowhere a person will see. It writes `interrupted` into
`task-queue.json` and logs one stdout line
(`bridge-agent.js`: `Recovered N interrupted task(s) from queue`); nothing posts to
Slack. Every *other* lifecycle event on this path does post to `#sqtools-ops` — a stale
lock release, a deferred update, a task failure, an undelivered scratch clone. This one
does not, so the observable is "the task just never answered".

It is visible only via `ASK: what's queued` (`formatStatusResponse` → `getRecentCompleted`),
which a human has to think to run, and only inside the 24-hour `COMPLETED_RETENTION_MS`
window before `cleanup()` removes the row.

Regenerate: `grep -n "recoverInterrupted" bridge-agent.js` → one call site at startup,
its result logged and never posted. Compare with the lock's own release path a few lines
below, which builds a verdict string and posts it.

**Fix:** post a `#sqtools-ops` line when `recoverInterrupted()` returns non-zero, naming
the task description and its source message link (both are already on the queue row).
Deliberately *not* done in the #18 change, which was scoped to making the state machine
real; reporting it is a separate decision about noise.
**Priority:** P2 | **Effort:** Low.

**Status:** open (re-verified 2026-09-14)

---

### 23. A task killed mid-run is re-read and re-run on the next poll
**Filed 2026-09-14, from the #18 fix** (closed and purged; see #22 for where its record is).
Both message-dedup guards are written only
*after* a task completes, so neither survives a kill:
- `markTaskProcessed(msg.ts)` (`bridge-agent.js`, poll loop) runs **after**
  `await currentTaskPromise`.
- the `done`/`failed` reaction `alreadyProcessed()` looks for is added by
  `heartbeat.stop()`, which runs in `processTask`'s `finally` — and a `finally` does not
  run when the process is killed. The reactions present *during* a task are
  `eyes`/`hourglass_flowing_sand`/`gear`, none of which `alreadyProcessed()` matches
  (`lib/task-parser.js:435-440`, `lib/heartbeat.js`).

So a task that kills the bridge is re-read from the channel on the next poll and run
again — on the same input, with the same result. `restart: unless-stopped` makes that a
loop. The queue is **not** the loop's source: `recoverInterrupted()` writes a *terminal*
`interrupted` state, never back to `pending`, and `enqueue()` dedups by `msgTs` so no
second row is created.

Regenerate: `grep -n "markTaskProcessed\|alreadyProcessed" bridge-agent.js` and
`grep -n "EMOJI_DONE\|EMOJI_FAILED" lib/task-parser.js lib/heartbeat.js`.

**Partially mitigated by #18's fix, not closed by it:** `_startRunning()` in
`lib/task-queue.js` now bumps `attempts` and preserves `previousStatus`/`previousError`
on a re-attempt, so the interruption verdict survives the re-run and the repetition is at
least *recorded*. Nothing acts on that count.

**Fix:** mark the message processed (or add the reaction) *before* the LLM is invoked
rather than after, or refuse a task whose queue row shows `attempts` over a threshold.
The first is the smaller change and closes the loop; the second is the safety net.
**Priority:** P2 | **Effort:** Low-Medium.

**Status:** open (re-verified 2026-09-14)

---

### 26. `docker-compose.yml` is untracked **and** unignored in the live working tree — `git clean -fd` deletes the deployment definition
**BLOCKED — OWNER ACTION (off-repo).** The repo-side half is verified done at HEAD
(`git check-ignore -v docker-compose.yml` -> `.gitignore:71`, exit 0;
`git check-ignore -v docker-compose.example.yml` -> no match, exit 1). The namesake is the
state of the **live working tree**. Remainder: one `git pull` on the NAS — and #40 first.
**Filed 2026-09-14,** from the deployment-topology capture
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 0,
consequence 1).

**Problem.** `/bridge` is a bind mount of the NAS deploy directory and that directory *is*
the git checkout the bridge runs, so `docker-compose.yml` sits inside a git working tree.
It is not tracked and — unlike `.env`, `.deploy_key*` and the state files — it is not in
`.gitignore` either. Verified from this checkout:
```bash
git ls-files | grep -i compose          # -> nothing (untracked)
git check-ignore -v docker-compose.yml  # -> no match, exit 1 (not ignored)
```
So `git status` in the deploy directory reports it as untracked clutter every time, and
`git clean -fd` — the ordinary command for clearing untracked clutter — deletes the only
copy on the box of the file that defines the deployment. `git reset --hard HEAD`, which
`auto-update.js:170`/`:191` runs, does *not* touch untracked files, and nothing in this
repo runs `git clean` (`grep -rn "git clean" --include=*.js . | grep -v node_modules` →
nothing). The exposure is a human at a prompt, not an automated path.

**Recoverability today, and where it is written down.** The file is reproduced verbatim in
the Appendix of `docs/CONFIG-SURFACE-AND-REBUILD.md`, and its fields are restated as step 3
of that document's Step 5 rebuild path. That copy is in this repository, on GitHub — the
only copy not on the NAS. Losing the file is therefore recoverable, which is why this is
P2 and not P1.

**Fix — repo-side half LANDED 2026-09-15** (NAS hardening pass, Step 7.9). Both halves the
item proposed were taken, authorised by that dispatch rather than unilaterally:
- `docker-compose.yml` is in `.gitignore`. `git clean -fd` skips ignored files without
  `-x`, so it is out of reach, and it stops appearing as untracked noise in `git status`
  on the box. Verify: `git check-ignore -v docker-compose.yml` → matches, exit 0.
- `docker-compose.example.yml` is committed — the stronger version Step 5 item 3 proposed,
  making the rebuild path a file rather than prose in an appendix. It reproduces the
  2026-09-14 capture and carries the proposed container hardening as commented blocks
  (#27). Verify: `git check-ignore -v docker-compose.example.yml` → no match, exit 1.

**Why this stays OPEN.** The item's namesake is the state of the **live working tree**,
and that is not what a repository change fixes. `.gitignore` reaches the deploy tree only
when someone pulls on the NAS, and nothing starts `auto-update.js` (#17) — so merging this
deploys nothing. Until that pull, `docker-compose.yml` is still untracked *and* unignored
there.

**Close it with this, run on the NAS:**
```bash
cd /share/CACHEDEV1_DATA/jt-agent && git pull && git check-ignore -v docker-compose.yml
```
A match (exit 0) closes the item. Note the sequencing against #40: a `git pull` in that
tree is the operation that surfaces any uncommitted local edits — answer #40 first.

**Priority:** P2 | **Effort:** Low (one pull on the box) | **Risk:** None to the running process.

**Status:** open — repo-side fix landed 2026-09-15; remainder is one pull on the NAS

---

### 27. A task has write access to the entire live deployment, including every credential — recorded, undecided
**BLOCKED — OWNER DECISION.** The shapes are written out against the captured compose
(`docs/CONFIG-SURFACE-AND-REBUILD.md` Step 7.7) and the cheap ones are commented into
`docker-compose.example.yml`. **Accepting the risk explicitly is a valid outcome and closes
this item.** Until a shape is chosen there is nothing for a branch to build.
**Filed 2026-09-14,** from the deployment-topology capture
([`docs/CONFIG-SURFACE-AND-REBUILD.md`](docs/CONFIG-SURFACE-AND-REBUILD.md) → Step 0,
consequence 3, which carries the full list).

**Not a new exposure and not a regression** — this has been true since the container was
built. It is filed because it was the blast radius of every task this system runs and it
was written down nowhere, so no one was weighing it when deciding what a task may do.

**The asymmetry.** `/repo` (SqTools — PRODUCTION, money and customer PII) is mounted
read-only. That is a real containment boundary and the reason a bridge-side compromise,
a prompt injection, or a plainly wrong task cannot damage that system. **It must never be
made read-write.** `/bridge` has no equivalent: it is read-write, tasks run through the
Claude Code CLI with `--dangerously-skip-permissions` (a shell) as the mount's owner
(`uid 1000:100`), so a task can write `/bridge/.env` (the Slack token, the Gemini key, the
Google OAuth trio and refresh token, the Square access token, the httpSMS key),
`/bridge/.deploy_key`, `/bridge/docker-compose.yml` (including the `:ro` flag on `/repo`),
`/bridge/agents/agents.json`, `/bridge/CLAUDE.md`, `/bridge/COMMANDMENTS.md`,
`/bridge/.git` and `/bridge/.claude-home/` (the CLI's live OAuth credential).

**What exists today is an authorisation boundary and a convention, not containment:**
`ALLOWED_USER_IDS` on who may submit a task, the approval queue for anything
auto-generated, the turn cap and `TASK_TIMEOUT_MS`, branch protection on `main`, and the
executor-contract rule that work happens in a scratch clone. The first group decides *who*
may start a task; none of it constrains what a started task can reach.

**Stated where both audiences look (done 2026-09-14):** `docs/EXECUTOR-CONTRACT.md` §7
now says plainly that an executor is not sandboxed out of `/bridge`, only asked to stay
out, and lists what is writable; Step 0 consequence 3 carries the reviewer-facing version
and the reason the approval queue is load-bearing rather than procedural.

**Open — the owner's decision, not this file's.** Narrowing it is a deployment change and
the compose file belongs to no repository today (item #4b, Step 6). The shapes, unranked:
run tasks as a second uid that does not own the deploy directory; mount `/bridge`
read-only with a writable sub-path for state and `WORK_DIR` (interacts with item #25);
run tasks in a child container. Each costs something and one of them may be the right
answer; **accepting the risk explicitly is also a valid outcome** and is better than the
current state, which is that it was never considered.

**Regenerate** (on the NAS — not reachable from a checkout):
```bash
grep -n "volumes\|user\|working_dir" -A 3 /share/CACHEDEV1_DATA/jt-agent/docker-compose.yml
docker exec -u 1000:100 jt-agent sh -c 'ls -la /bridge/.env /bridge/.deploy_key; touch /repo/.wtest 2>&1'
```
The second confirms both halves at once: readable/writable on the left, permission denied
on the right.

**The shapes are now written out, 2026-09-15**, so the decision is a review rather than a
design exercise: `docs/CONFIG-SURFACE-AND-REBUILD.md` → Step 7.7 tables each one against
the captured compose with its verification and its honest cost, and
`docker-compose.example.yml` carries the cheap ones as **commented** blocks with a
`docker inspect` check each — log limits, `mem_limit`/`cpus`/`pids_limit`,
`no-new-privileges` + `cap_drop: ALL`. **None has been tested against the live bridge.**
Those three bound the damage; they do not close this item. The two shapes that would —
read-only `/bridge` with a writable sub-path, and a second uid or child container for task
execution — are recorded there as explicitly **not** one-line changes: the start command
runs `npm ci` into `/bridge/node_modules` and installs the CLI into `/bridge/.npm-global`,
so a read-only mount needs those and `WORK_DIR` moved first, which interacts with #25.

**Priority:** P2 | **Effort:** Low to accept and record; Medium to narrow.
**Risk:** Changing it is Medium — every narrowing shape can break task execution or the
push path; none of it should be attempted without a way to verify the bridge still runs.

**Status:** open (re-verified 2026-09-14; narrowing shapes written out 2026-09-15)

---

### 24. Four sibling modules resolve a shared writable path at module scope with no override — the same class as #19
**Filed 2026-09-14, from the #19 fix.** *#19 — `tests/approval-queue.test.js` racing a
hardcoded shared file — is closed and purged; the fix is commit `1bea22d` on
`fix/approval-queue-path-override-19`, and `git log -S'### 19.' -- WORK-TODO.md` finds the
entry. It is referenced throughout this item because it is the one instance of this class
that has actually been closed, and therefore the model for the other four.* The #19 dispatch asked whether the
module-scope-const-writable-path shape is a class rather than one defect. It is.
Regenerate the candidate list:
```
grep -rn "path.join(__dirname, '\.\.'" --include=*.js lib/ memory/ bots/ | grep -iv test
```
Splitting those by whether the path is **writable state** and whether an **override path
exists**:

| Module | Module-scope path | Writable? | Override path? |
|--------|-------------------|-----------|----------------|
| `lib/approval-queue.js` | `approval-queue.json` | yes | **now `init({queueFile})`** (#19) |
| `lib/bridge-state.js` | poll cursors + processed-tasks | yes | `init({stateFile,…})` |
| `lib/task-queue.js` | `task-queue.json` | yes | constructor arg |
| `lib/llm-metrics.js` | `llm-metrics.json` | yes | `LLM_METRICS_FILE` env, read per-call |
| `bots/storefront.js` | `delivery-quotes.json` | yes | `DELIVERY_QUOTES_FILE` env |
| **`lib/bulletin-board.js`** | `bulletin.json` | yes | **none** |
| `lib/slack-client.js` | `channel-map.json` | yes | **`lib/bridge-state.js init({channelMapFile})`** (2026-09-15) |
| **`lib/staff-tasks.js`** | `staff-tasks-state.json` | yes | **none** |
| `lib/watercooler.js` | `watercooler-state.json` | yes | **now `init({stateFile})`** (2026-09-15) |

**LOGIC CHANGE 2026-09-15 — two of the four are closed, and the "latent" judgement below
was wrong about both.** This item said the defect was latent because each file has exactly
one writing suite so nothing races it. That is true and it was not the risk. A full run on
`3c62bb1` left `agents/shared/channel-map.json` containing
`{"test-channel":"C12345","new-channel":"C99999","my-channel":"C12345"}` — three invented
ids written by `tests/slack-client.test.js` into the file the running bridge resolves
agent channels from — and rewrote `agents/shared/watercooler-state.json` on every run.
Not a race: a straightforward corruption of live configuration by a test suite, happening
continuously. See #54 on the deferral judgement itself.

**`lib/slack-client.js` is the instructive one.** By the time it was found it already HAD
the seam this item prescribes — ownership of `channel-map.json` moved to
`lib/bridge-state.js init({ channelMapFile })` on 2026-09-15 — and `tests/slack-client.test.js`
simply never used it. **So the enumerator proposed below, which walks `lib/` for a
module-scope writable path with no override seam, would not have caught it.** A guard on
the cause misses an unused cure.

**The enumerator that now exists is on the EFFECT**, and holds whatever the module shape
is: jest `globalSetup`/`globalTeardown` (`tests/helpers/live-state-setup.js` and
`-teardown.js`) fingerprint every durable state file before a run — `agents/shared/*.json`
enumerated from disk, plus the runtime files that may not exist yet, plus
`.bridge-agent-state.json` — and fail the whole run naming any file created, modified or
deleted. Negative controls: `tests/live-state-guard.test.js`. Cite that pair, not this
paragraph.

**REMAINING: `lib/bulletin-board.js` and `lib/staff-tasks.js`.** Both still resolve their
path as a module-scope `const` with no override; `tests/bulletin-board.test.js:12-19`
unlinks the real `agents/shared/bulletin.json` and `tests/staff-tasks.test.js:305` unlinks
the real `staffTasks.TASKS_STATE_FILE`. They happen to leave no residue, so the new guard
passes on them today and fails the moment either stops cleaning up. Give each the
`init({ file })` override `lib/bridge-state.js` / `lib/approval-queue.js` /
`lib/watercooler.js` model and point its suite at `os.tmpdir()`.
**Priority:** P2 | **Effort:** Low per module (two left); the enumerator is done.
**Risk:** Low — additive overrides; unset option preserves each current path exactly.
**Status:** open — 2 of 4 closed 2026-09-15, enumerator built, 2 remain

---

### 20. `MAX_TURNS` names four different quantities, and the env var is dead config
**Filed 2026-09-14.** Supersedes and extends the `MAX_TURNS` bullet in item 4b, which
recorded two of the four.

**Problem:** the name `MAX_TURNS` / `max_turns` / `maxTurns` is bound to four unrelated
quantities. Regenerate:
`grep -rn "MAX_TURNS\|max_turns\|maxTurns" --include=*.js . | grep -v node_modules | grep -v '^./tests/'`

| Binding | Quantity | Value |
|---------|----------|-------|
| `lib/config.js:34`, `lib/llm-runner.js:172` | env-driven **default** | 50 |
| `lib/task-parser.js:83` | hard **ceiling** on the `TURNS:` header | 100 |
| `lib/task-parser.js:81` `DEFAULT_TURNS` | **default when no header**, a hardcoded literal | 50 |
| `bridge-agent.js:1742` | conversation path's **own** default *and* ceiling | 10 / 20 |

**Citations re-checked 2026-09-16** — every line number in this table had drifted (filed as
`:56`, `:14`, `:1498`); the four bindings themselves are unchanged and the item's claim
holds. The export is at `lib/task-parser.js:488`, not `:463`. **A new consumer appeared
while this was open:** `lib/dispatch-modal.js:23` imports `MIN_TURNS`/`MAX_TURNS` from the
parser, so the rename in fix part 1 now has two consumers to update, not one.

`bridge-agent.js:1498` is the source of the `max-turns=20` the owner observed in
`[llm-runner] Spawning Claude in /tmp/bridge-agent (max-turns=20)` and could not place:
`const maxTurns = Math.min(currentAgent?.max_turns || 10, 20);`. It reads neither the env
var nor either parser constant. `secretary`, `email-monitor` and `story-bot` carry
`max_turns: 20` in `agents.json`; `jester` carries 10; every code agent carries 50 and is
silently clamped to 20 on the `ASK:` path.

**Correction to the dispatch — `MAX_TURNS=200` in the live `.env` raises nothing.** It is
unreachable on every non-test path:
- `lib/llm-runner.js:348` `options.maxTurns || DEFAULT_MAX_TURNS` — but **every** non-test
  callsite passes `maxTurns` explicitly, so the `||` arm never fires. Regenerate:
  `grep -rn "runLLM(\|runWithFallback(" --include=*.js . | grep -v node_modules | grep -v '^./tests/'`
  → `security-review.js:294` (10), `bots/storefront.js:444` (15), `bridge-agent.js:665`
  (`currentTurns`), `bridge-agent.js:1503` (`maxTurns`), `lib/watercooler.js:536` (5),
  `lib/task-decomposer.js:341` (`maxTurns`). Six of six explicit.
- `lib/config.js:34` feeds only `bridge-agent.js:208`
  (`agentConfig?.max_turns || config.MAX_TURNS`), which for the bridge agent resolves to
  its registry value 50, not the env 200 — and that binding is consumed by exactly one
  line, the startup banner at `:1897`.

So `MAX_TURNS` in `.env` changes one thing: nothing. **The standing convention of putting
`TURNS: 100` on every dispatch is correct, but not for the stated reason** — without the
header a task gets 50 from the `task-parser.js:14` literal (not from the env), and with it
up to 100 from the `:56` ceiling. The header is load-bearing; the env var is not.

**Fix (naming and reachability are separate changes — do the rename first, it is safe):**
1. Rename `lib/task-parser.js:56 MAX_TURNS` → `TURNS_CEILING` (it is exported at `:463`,
   so grep consumers). Rename the `bridge-agent.js:1498` literals to named constants
   (`CONVERSATION_TURNS_DEFAULT`, `CONVERSATION_TURNS_CEILING`).
2. Decide what `MAX_TURNS` in `.env` is *for*. Either wire it to something reachable (the
   conversation ceiling is the honest candidate) or delete it from `CLAUDE.md`'s env table
   and `.env.example` and say in the commit body that it was dead. Do not leave a
   documented knob that moves nothing — that is the doc-vs-reality drift class.
3. Add a test asserting the conversation path's effective turns for an agent with
   `max_turns: 50`, so the clamp is stated somewhere other than one un-commented
   `Math.min`.
**Effort:** Low.
**Risk:** Low for (1) and (3). (2) is a behaviour decision, not a refactor — if
`MAX_TURNS=200` is wired to anything it will actually raise turn counts for the first
time, so land it alone.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 33. A UTC day key is used as the store's day, so evening staff tasks are filed against tomorrow
**Filed 2026-09-14,** from [`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) §6.

```bash
grep -rnE "toISOString\(\)\.(slice|split)" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
```

| Site | Key | Correct for its use? |
|------|-----|----------------------|
| `lib/llm-metrics.js:61` `dayKey` | UTC | **yes** — documented at `:53-55` as deliberate: a stable key beats local-midnight alignment for a 7-day ratio |
| `lib/staff-tasks.js:211`, `:318`, `:423` | UTC | **no** |
| `morning-digest.js:477` | UTC | **no** |
| `lib/agent-create.js:82` | UTC | **new 2026-09-15, not in the original table** |

**CORRECTED 2026-09-16 — a sixth site appeared while this item was open.**
`lib/agent-create.js:82` stamps a UTC day into the TODO text of a generated agent
definition. Its consequence is cosmetic (a role string, not a store day), but it is the
same idiom spreading to a new file with nothing failing — which is the argument for the
enumerator below, restated by events rather than by assertion.

`staff-tasks.js` is about the **store's** day. A UTC key rolls over at 20:00 Toronto (EDT)
/ 19:00 (EST), so a task posted at 21:00 is filed under tomorrow's date and
`getDailyTasks()` (`:318`) returns `[]` for it — `state.date !== today` at the next read.
`postDailyTasks()` (`:423`) will then reset the day's state mid-evening. Demonstrated:

```bash
TZ=America/Toronto node -e "const d=new Date('2026-09-15T02:00:00Z');
  console.log(d.toLocaleString('en-US',{timeZone:'America/Toronto'}), '->', d.toISOString().split('T')[0])"
# 9/14/2026, 10:00:00 PM -> 2026-09-15
```

Store hours are 09:00-21:00 (`STORE_HOURS`, `lib/staff-tasks.js:32-34`), so the window between
the UTC rollover and close is narrow in summer and wider in winter — which is why this has
probably been costing a little and never looked like a bug.

The same idiom is right in one module and wrong in four. That is the argument for a named
helper rather than a copied one-liner.

**Fix.** A `dayKey(date, timeZone)` helper; `lib/llm-metrics.js` passes `'UTC'` and keeps
its documented behaviour, `staff-tasks.js` and `morning-digest.js` pass
`'America/Toronto'`. Needs a fixture test at the boundary hour in both DST phases — this
changes what "today" means for staff tasks, so it is not a silent swap.

**The durable close is an enumerator:** a test that fails when a new
`toISOString().split('T')[0]`/`.slice(0,10)` appears outside `lib/llm-metrics.js`. Paired
with #30's; both are named in the map's closing section.
**Priority:** P2 | **Effort:** Low (fix) / Low (enumerator) | **Status:** open

---

### 32. One bulletin timestamp, three renderings — no shared helper
**Filed 2026-09-14,** from [`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) §5.
**Title and table corrected 2026-09-16** — the original heading said "the path every
agent's prompt uses emits none", which was true when filed and false by the time it was
read.

| Site | Function | Renders | Consumer |
|------|----------|---------|----------|
| `lib/bulletin-board.js:283` | `formatBulletinsForSlack` | `Sep 14, 2:05 PM` | human, in Slack |
| `lib/bulletin-board.js:409` | `formatBulletinsForContext` | `Sep 14, 2:05 PM` — **was "nothing"; fixed at `d77cdfa`** | LLM prompt, **every** agent |
| `lib/agent-context.js:177`, `:277` | security / story-bot context | `Sep 14` (no time) | LLM prompt, those two agents |

Regenerate:
```bash
grep -n "b.timestamp" lib/bulletin-board.js lib/agent-context.js
git log --oneline -1 -L 397,420:lib/bulletin-board.js
```

**What was fixed, and by what.** `formatBulletinsForContext` emitted no time at all when
this was filed. Commit `d77cdfa` gave it an America/Toronto date and time. Nothing in this
item was updated at the time, so the backlog carried a false statement about the generic
prompt path for a day — caught while establishing what the `jester` agent can reach
(`docs/JESTER-DESIGN.md` §1.2), where the bulletin stream is the only conversational input
and "does it say when" decides whether it is usable at all.

**What remains, and it is why this stays open.** One field is still rendered by **three
separate inline option sets across two files**. The two special-cased agents in
`lib/agent-context.js` still get a date and **no time**, so they cannot order two bulletins
from the same day. That one path could be fixed while two were left behind, with nothing
failing, is the defect: there is no shared helper to fix.

**Fix.** One `formatTimestamp(date, precision)` helper (none exists anywhere in the repo),
called by all three sites. The behavioural half is done; the duplication half is not.
**Priority:** P2 | **Effort:** Low | **Status:** open — partially fixed at `d77cdfa`; no shared helper exists

---

### 34. `DEPLOY_KEY_PATH` is read but undocumented
**Filed 2026-09-13** (derived: `git log -S'DEPLOY_KEY_PATH` is read but undocumented' --reverse -- WORK-TODO.md`
-> `e2a19e2`, where it was an unnumbered heading; numbered `58b231d` on 2026-09-14).
**Problem:** The scratch-clone push fix reads a new env var,
`process.env.DEPLOY_KEY_PATH || "/bridge/.deploy_key"` (`lib/clone-lifecycle.js:173`), but it
was never added to `CLAUDE.md`'s Environment Variables section or `.env.example`
(`grep -rn DEPLOY_KEY_PATH CLAUDE.md .env.example` → nothing). This violates the repo's
own env-var rule ("When adding a new env var to code you MUST … update the Environment
Variables section in this CLAUDE.md"). The default path is container-specific
(`/bridge/…`), so an operator on a different layout has no signposted way to point it at
their key — the clone silently falls back to READ-ONLY and pushes fail.
**Fix:** document `DEPLOY_KEY_PATH` (description + default `/bridge/.deploy_key`) in the
`CLAUDE.md` Optional env table and in `.env.example`. Doc-only.
**Effort:** Low.

**Re-verified 2026-09-14.** Still true, and the citation moved: the read is now at
`lib/clone-lifecycle.js:173` (seam A extraction), not `bridge-agent.js`.
`grep -rn DEPLOY_KEY_PATH CLAUDE.md .env.example README.md` -> still no hits.
*Given a stable number this revision (it was filed as an unnumbered "New (2026-09-13)"
heading, which cross-references could not point at).*
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 35. Per-agent memory has TTL and decay but no max-entries cap
**Filed 2026-09-13** (derived: `20dc049`, as the unnumbered heading "Reconcile — per-agent
memory: entry caps vs. the tiering that already landed"; numbered `58b231d` on 2026-09-14).
**Substance is older:** ancestor heading "Per-agent memory size limits" in the 2026-04-05
seed `4b6ee4a`.
**Problem:** The old backlog asked for "per-agent memory size limits (max entries,
evict oldest)." Tiered memory with TTL and time-based decay already shipped
(`lib/memory-tiers.js` — `ttl` at `:40`, `decayMs` at `:134`; tests in
`tests/memory-tiers.test.js`). What is *not* there is a hard **max-entries cap** per
tier. Don't re-file the whole item — the only open piece is the count cap.
**Fix:** add an optional max-entries cap per tier in `lib/memory-tiers.js`, evicting
oldest-by-TTL when exceeded. Keep it consistent with the existing decay logic.
**Effort:** Low.

**Re-verified 2026-09-14.** `grep -n "maxEntries\|MAX_ENTRIES" lib/memory-tiers.js` -> no
hits; TTL and decay are there, the count cap is not.
*Given a stable number this revision (it was filed as an unnumbered "Reconcile" heading).*
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 10. Split the god-files that break the repo's own 300-line rule
**Filed 2026-09-13** (derived: `20dc049`).
**Problem:** The repo enforces a 300-line-per-file rule (`lib/validate.js`, `MAX_LINES = 300`)
and **65** `.js` files exceed it. Until 2026-09-15 the gate was **unconditionally red**, so a
new violation could not be told apart from the standing ones without diffing path lists by
hand — that happened twice in the week of 2026-09-08. The exceptions had never been examined.

**The gate is declaration-driven as of 2026-09-15.** `lib/file-size-gate.js` +
`lib/validate-exceptions.json` hold one recorded justification per over-limit file, guarded by
`tests/file-size-gate.test.js`; an undeclared violation fails, and a declared entry whose file
is gone or is back under the limit also fails, so the list cannot rot. This record was
committed before any file was touched, on purpose: it is what that list was built from and what
a later run resumes from instead of re-deriving.

**CORRECTION 2026-09-16 — the regeneration command in this item was a FALSE NEGATIVE, and
every figure below was stale because of it.** `npm run validate 2>&1 | grep -cE '^  - '`
printed **0**, which reads as "no violations". It is not: the declaration-driven gate only
prints a `  - ` list when it FAILS, and since 2026-09-15 it passes, so the command returns 0
whether the true number is 0 or 69. A figure whose command silently returns the wrong answer
is worse than a figure with no command — this file's own rule ("every figure carries the
command that regenerates it") was satisfied in form and broken in fact for a day. Ask the
gate for the measurement instead of parsing its failure output:

```bash
# over-limit files, and the tests/source split — THE working command
node -e "const g=require('./lib/file-size-gate');const m=g.measure().filter(f=>f.lines>300);
  console.log(m.length+' over limit | '+m.filter(f=>f.path.startsWith('tests/')).length+' test suites | '
    +m.filter(f=>!f.path.startsWith('tests/')).length+' source modules');"
# the list itself
node -e "const g=require('./lib/file-size-gate');g.measure().filter(f=>f.lines>300)
  .sort((a,b)=>b.lines-a.lines).forEach(f=>console.log(f.lines, f.path));"
# the gate's own verdict (green = every one of them is declared)
npm run validate 2>&1 | grep 'declared exceptions'
# lines vs. non-comment non-blank code, per over-limit file
node -e "
const fs=require('fs'),path=require('path');
const walk=(d,a=[])=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){
  if(e.name==='node_modules'||e.name.startsWith('.'))continue;const f=path.join(d,e.name);
  e.isDirectory()?walk(f,a):e.name.endsWith('.js')&&a.push(f);}return a;};
for(const f of walk(process.cwd())){const L=fs.readFileSync(f,'utf8').split('\n');
  if(L.length<=300)continue;let c=0,b=0,blk=false;
  for(const l of L){const t=l.trim();if(!t){b++;continue;}
    if(blk){c++;if(t.includes('*/'))blk=false;continue;}
    if(t.startsWith('/*')){c++;if(!t.includes('*/'))blk=true;continue;}
    if(t.startsWith('//'))c++;}
  console.log(path.relative(process.cwd(),f),L.length,'comment='+c,'code='+(L.length-c-b));}"
```
The rule counts `split('\n').length`, which reads one higher than `wc -l` on a
newline-terminated file — that is why these numbers and `wc -l` disagree by one.

**Figures as of 2026-09-16, from the working command above: 69 over the limit — 40 test
suites, 29 source modules — and 69 declared exceptions, so the gate is green.** The tables
below say 65 / 36 / 29 and were correct on 2026-09-15; the four new files are test suites
added by the jester work. The source-module table is unchanged at 29 and every disposition
in it still holds.

**The largest file is `bridge-agent.js` at 2469 lines** (2026-09-16; it was 2227 when the
table below was built, and the table's row still reads 2227), and it is the main agent module —
the premise the seam work rests on. Its seams are declared in
[`docs/WIRING-AND-SEAMS.md`](docs/WIRING-AND-SEAMS.md) §6 (A and B landed; C, D, E open).
It is **excluded from splitting during size-limit work**: cutting the monolith inside a
gate-cleanup produces a diff nobody can review.

**A correction to this item's own history.** Earlier revisions recorded 58 / 59 / 63 files and
`bridge-agent.js` at 2040, then 2210, then 2093. The file count is now 65 and
`bridge-agent.js` is 2227 — it grew again with the `/dispatch` work. The +2 files since
2026-09-14 are guards and modules added by intervening work, which is a knowing trade.

**Third category is empty.** Every over-limit file is either a source module (**29**) or a
test suite (**36**). Nothing in the list falls outside a rule that was never meant to cover it
on grounds of kind — the "was this rule meant to cover tests?" question is real but it is a
question about the rule, filed as **#44**, not a property of any individual file.

**The measurement that reframes 16 of the 29 source modules.** The rule counts raw lines, and
this repository's own contract *requires* per-change prose: `LOGIC CHANGE` comments, module
headers that state why a guard exists, and the evidence behind a decision. Sixteen source
modules are over 300 **lines** while under 300 lines of **code**: `lib/task-queue.js`
(198 comment / 296 code), `lib/code-review-pipeline.js` (133/293), `security-review.js`
(79/287), `lib/integrations/email-sanitizer.js` (130/282), `lib/slack-client.js` (124/273),
`memory/memory-manager.js` (93/255), `lib/integrations/email-categorizer.js` (139/247),
`lib/bulletin-board.js` (99/247), `lib/agent-scheduler.js` (107/240), `lib/email-rate-limiter.js`
(111/231), `lib/integrations/holidays.js` (103/229), `lib/integrations/google-calendar.js`
(99/225), `lib/task-parser.js` (228/224), `lib/owner-tasks.js` (92/221), `lib/notify-owner.js`
(176/192), `lib/clone-lifecycle.js` (170/158). The two extremes are worth naming:
`lib/clone-lifecycle.js` is **49% comment** and was extracted (Seam A) specifically to be one
concern, and `lib/notify-owner.js` carries more comment than code. Splitting either moves
prose between files and changes no responsibility. This is the second axis of **#44**.

---

#### The record — every over-limit file, with category, disposition and reason

Category: **src** = source module, **test** = test suite. Disposition: **SPLIT (done)**,
**split (deferred)** — a real seam or concern boundary exists and is named, work tracked here —
or **justify** — the file should not be split and the reason is stated. `code` is non-comment,
non-blank lines.

**Source modules (29)**

| lines | code | file | disposition | reason |
|------:|-----:|------|-------------|--------|
| 2227 | 1378 | `bridge-agent.js` | split (deferred) | The monolith. Seams C (`lib/ask-commands.js`), D (rate-limit state), E (poll loop) are declared in WIRING-AND-SEAMS §6. Deferred **by this task's own terms**: not cut during a size-limit exercise. |
| 1104 | 623 | `lib/llm-runner.js` | split (deferred) | Boundary: one module per provider adapter (claude / openai / ollama / gemini) behind the existing `runLLM` + `runWithFallback` dispatcher. Deferred because WIRING-AND-SEAMS §4 pins exactly who is on the fallback chain — a move here must not "fix" that. |
| 879 | 505 | `auto-update.js` | split (deferred) | Boundary: git porcelain (`runGit`/`gitFetch`/`gitPull`/`gitResetHard`/`gitResetTo`/`npmInstall`) and the deferral gate (`checkTaskQueue`/`evaluateTaskDeferral`) are two separable concerns. Deferred: nothing starts this daemon (#17), so a refactor buys no safety and risks the 62 tests that inject a dependency bag into `checkForUpdates()`. |
| 726 | 449 | `lib/watercooler.js` | split (deferred) | Boundary: the standup catalogue (`AGENT_DISPLAY`/`STANDUP_TYPES`/`AGENT_STANDUP_PROMPTS`) vs. context gathering vs. `runStandup` orchestration. |
| 722 | 425 | `lib/staff-tasks.js` | split (deferred) | Four concerns in one file: staff/template loading, task state, store-hours + time parsing, Slack rendering + command recognition. The recognisers (`isStaffTaskCommand`, `parseAssignCommand`) belong with Seam C. |
| 598 | 350 | `lib/approval-queue.js` | split (deferred) | Boundary: the queue store vs. presentation (`formatPendingTasks`/`formatTaskDetails`/`getTaskAge`). |
| 598 | 351 | `lib/integrations/gmail.js` | split (deferred) | Boundary: auth/client construction vs. MIME decoding (`stripHtml`/`decodeBase64Url`/`extractBody`/`transformEmail`) vs. the read API. The decoder is pure and testable alone. |
| 579 | 398 | `lib/task-decomposer.js` | justify | **Zero production callers** (WIRING-AND-SEAMS §3) — reachable only from its own test. Splitting dead code multiplies unexecuted surface. The open decision is delete-or-wire, which is the owner's, not a split. |
| 570 | 343 | `lib/memory-tiers.js` | split (deferred) | Boundary: entry lifecycle + file I/O vs. maintenance (`cleanupMemory`/`autoPromote`/`startupCleanup`/`migrateToTiers`). |
| 557 | 296 | `lib/task-queue.js` | justify | One state machine over one file, and **under the limit on code** (296). Its length is the deferral/`markRunning` history recorded in comments, which is what makes the `running`-vs-`pending` defect auditable. |
| 547 | 329 | `lib/security-followup.js` | split (deferred) | Boundary: finding parsing (`parseFindings`/`groupFindingsByFile`) vs. dedup bookkeeping vs. the Slack-side orchestration in `processSecurityBulletin`. |
| 517 | 349 | `bots/storefront.js` | split (deferred) | Boundary: Express routes vs. session store vs. prompt building. It is also the one entry point serving public HTTP, so its routes deserve isolation on security grounds, not only size. |
| 512 | 353 | `morning-digest.js` | split (deferred) | Boundary: `buildDigest` is a 190-line function assembling independent sections (weather, calendar, email, tasks, staff); each section builder is separable. |
| 497 | 224 | `lib/task-parser.js` | split (deferred) | Boundary: task-message parsing vs. the ASK-command recognisers (`isStatusQuery` … `parseShowTaskCommand`), which belong in Seam C's `lib/ask-commands.js` alongside the handlers they gate. **Deferred deliberately** so recogniser and handler move in one change. Also under the limit on code (224). |
| 476 | 293 | `lib/code-review-pipeline.js` | justify | Three phases of one pipeline, and **under the limit on code** (293). The phases share the `context` object; splitting them puts one data structure's producers and consumers in three files. |
| 470 | 282 | `lib/integrations/email-sanitizer.js` | justify | **Under the limit on code** (282). 130 lines are the `INJECTION_PATTERNS` catalogue and the rationale for each pattern — a security-relevant enumeration whose comments are the point. |
| 452 | 305 | `lib/agent-context.js` | split (deferred) | Boundary: one context builder per persona (`buildSecretaryContext`, `buildSecurityContext`, `buildJesterContext`, `buildStoryBotContext`, `buildCodeAgentContext`); they share nothing but the anti-hallucination preamble. |
| 443 | 273 | `lib/slack-client.js` | justify | **Under the limit on code** (273). It is one factory closure (`createSlackClient`) plus channel-map persistence; a cut inside the factory would split a single object's methods across files. |
| 432 | 247 | `lib/integrations/email-categorizer.js` | justify | **Under the limit on code** (247). The file's length is the `DEFAULT_RULES` catalogue and the precedence documentation that makes `rules.json` readable as a specification. |
| 429 | 287 | `security-review.js` | split (deferred) | Boundary: its private `cloneRepo`/`execCommand`/`sendDM`/`postToOps` are **duplicates** of behaviour already canonical elsewhere (`docs/CANONICAL-HELPERS.md` §1, §2; #30). The right cut is de-duplication, not a new module — it belongs to #30, not to a size pass. |
| 421 | 192 | `lib/notify-owner.js` | justify | More comment (176) than code (192). It is the **canonical destination** named by CANONICAL-HELPERS §1/§2 — #30 will move more into it, not less. Splitting it now works against the declared consolidation. |
| 406 | 247 | `lib/bulletin-board.js` | justify | **Under the limit on code** (247). Store plus its two renderers over one JSON file; the renderers exist to keep bulletin formatting from being re-derived per caller, which is the defect CANONICAL-HELPERS §32 records. |
| 400 | 255 | `memory/memory-manager.js` | split (deferred) | Boundary: task/context storage vs. the prompt-context builders (`buildTaskContext`, `buildAgentContext`, ~150 lines) which are rendering, not storage. |
| 397 | 231 | `lib/email-rate-limiter.js` | justify | **Under the limit on code** (231). One sliding-window algorithm applied to three buckets; splitting per bucket triples the surface for a single algorithm. |
| 390 | 240 | `lib/agent-scheduler.js` | **SPLIT (done)** | Catalogue vs. registrar: `TASK_TEMPLATES` + `DETERMINISTIC_TASKS` (what tasks exist) moved to `lib/agent-task-catalogue.js`; the cron registrar (when and how they fire) stays. |
| 387 | 229 | `lib/integrations/holidays.js` | split (deferred) | Boundary: the Nager.Date public-holiday client + cache vs. the hardcoded `PET_AWARENESS_DATES` calendar — two unrelated data domains. **Deferred:** both sides use `parseDate`/`formatDate`, and where a shared date helper lives has to be settled against CANONICAL-HELPERS' date rows (#32, #33) rather than decided by a size pass. |
| 368 | 221 | `lib/owner-tasks.js` | **SPLIT (done)** | Store vs. presentation: the checklist store stays; `formatPendingTasks`, `isOwnerTasksQuery` and `extractActionRequired` (rendering and recognition) moved to `lib/owner-tasks-view.js`. |
| 367 | 225 | `lib/integrations/google-calendar.js` | justify | **Under the limit on code** (225). Its length is six near-identical `get{Today,Yesterday,Tomorrow}Events` / `getAll*` pairs over one `transformEvent`; the real fix is de-duplicating them into one range-parameterised call, which shortens the file rather than splitting it. Filed as the boundary here so a later pass does not "split" it into two copies of the same code. |
| 347 | 158 | `lib/clone-lifecycle.js` | justify | **49% comment, 158 lines of code.** It was extracted 2026-09-14 as Seam A precisely to be one concern, and its comments carry the argv-array and delivery-detection reasoning that three lost tasks paid for. Splitting it would undo the seam to satisfy a line count. |

**Test suites (36)**

All 36 carry the same disposition — **justify, provisional** — for the same reason: a test
suite's length is its **assertion count**, not its responsibility count, and whether the
300-line rule was ever meant to reach `tests/` is filed undecided as **#44**. Each entry's
recorded reason names the subject it covers, so the exception is per-file rather than a
blanket rule. One has a boundary worth naming now:

| lines | file | note |
|------:|------|------|
| 1837 | `tests/llm-runner.test.js` | Largest suite in the repo and the one case where a split is independently justified: one suite per provider adapter plus one for the fallback chain, mirroring the `lib/llm-runner.js` boundary above. Deferred with it, so suite and module move together. |

The remaining 35, each justified as the suite for the subject named:
`tests/task-parser.test.js` (860), `tests/retry-logic.test.js` (685),
`tests/integration.test.js` (639), `tests/approval-queue.test.js` (638),
`tests/security-followup.test.js` (635), `tests/agent-registry.test.js` (631),
`tests/auto-update-restart.test.js` (613), `tests/task-decomposer.test.js` (610),
`tests/email-categorizer.test.js` (603), `tests/notify-owner.test.js` (596),
`tests/email-sanitizer.test.js` (582), `tests/memory-tiers.test.js` (579),
`tests/slack-socket.test.js` (565), `tests/holidays.test.js` (564),
`tests/task-queue.test.js` (559), `tests/slack-client.test.js` (557),
`tests/watercooler.test.js` (531), `tests/config.test.js` (516),
`tests/gmail.test.js` (512), `tests/smoke.test.js` (492),
`tests/storefront.test.js` (479), `tests/owner-tasks.test.js` (451),
`tests/email-rate-limiter.test.js` (445), `tests/bug-fixes.test.js` (436),
`tests/bulletin-board.test.js` (434), `tests/clone-lifecycle.test.js` (429),
`tests/code-review-pipeline.test.js` (400), `tests/agent-context.test.js` (389),
`tests/agent-scheduler.test.js` (376), `tests/staff-tasks.test.js` (367),
`tests/test-gate-honesty.test.js` (365), `tests/auto-update-defer.test.js` (357),
`tests/multi-channel-routing.test.js` (352), `tests/message-detection.test.js` (319),
`tests/undelivered-work.test.js` (302).

**Fix:** work the source-module table top-down, cheapest first, each extraction on the named
boundary and each keeping `node -e "require('./bridge-agent.js')"` green (the CLAUDE.md
refactor rule) and `tests/bridge-agent-scope.test.js` passing. A file that splits loses its
entry in `lib/validate-exceptions.json` in the same commit; the gate fails if it does not.
**Effort:** High, incremental.
**Risk:** Medium per extraction — and this repository cannot prove a pure move is
behaviour-preserving: `node --check` plus the smoke suite catch load failures and export
surface, nothing more. State the smoke coverage of every moved function, and report its
absence as a finding rather than folding it into a green.
**Priority:** P2 | **Effort:** High, incremental | **Status:** open

---

### 44. The 300-line rule is one rule over two different problems — scope it, or say it covers both
**BLOCKED — OWNER DECISION.** The item states it in its own words: *not to be decided by an
executor*. Two independent decisions (scope the rule out of `tests/`; count code lines
rather than raw lines), each small to implement once made. Nothing is blocked on it — the
gate is declaration-driven and green.
**Filed 2026-09-15,** from the size-gate pass that produced #10's record. **Argued here on
both sides and deliberately left undecided — the branch that filed this did not change the
rule.** The gate is now declaration-driven (`lib/file-size-gate.js` +
`lib/validate-exceptions.json`), so nothing is blocked on this; what is at stake is whether
**36 of the 65 recorded exceptions should have to exist at all**.

**What the rule was written to catch.** `lib/validate.js` pairs `MAX_LINES = 300` with a
`bridge-agent.js` load check, under the header "keeps files manageable". `CLAUDE.md` places
the seam rule beside it ("File >300 lines → split on concern separability"), and
`docs/WIRING-AND-SEAMS.md` §5-§6 is the worked example: `bridge-agent.js` reached 2227 lines
with two functions accounting for 46% of it, and behaviour started being **re-derived inline**
because no one could hold the file in one read — which is what `docs/CANONICAL-HELPERS.md`
enumerates the cost of. So the rule is a **proxy for "this module has too many
responsibilities"**, measured in lines because lines are cheap to count.

**Figures, as commands. CORRECTED 2026-09-16 — the command below used to parse
`npm run validate` output and returned 0 for everything; see #10 for why.**
```bash
node -e "const g=require('./lib/file-size-gate');const m=g.measure().filter(f=>f.lines>300);
  console.log(m.length+' over limit | '+m.filter(f=>f.path.startsWith('tests/')).length+' test suites | '
    +m.filter(f=>!f.path.startsWith('tests/')).length+' source modules');"
# -> 69 over limit | 40 test suites | 29 source modules      (2026-09-16)
```
**40 of 69 — 58% of every violation — are test suites**, and the largest after
`bridge-agent.js` is `tests/llm-runner.test.js` at 1837 lines. (It was 36 of 65 when this
was filed; the ratio moved the way the argument below predicts it would, because the four
files added since are all suites.)

**Why a suite is a different problem.** A test file's length is its **assertion count**. The
failure mode the rule exists to prevent — one module quietly acquiring five responsibilities —
has no analogue there: `tests/llm-runner.test.js` has exactly one responsibility, which is
`lib/llm-runner.js`, and it is long because that module has four provider adapters and a
fallback chain with six trigger conditions. Under the rule as written, the cheapest way to
make a suite compliant is **to delete assertions**, and the second cheapest is to scatter one
subject across files so no reader can see what is and is not covered. A rule whose easiest
compliance path is less testing is pointed the wrong way.

### The argument for scoping the rule to source files (suites governed differently, or not at all)

- The rule's stated purpose — responsibility count — does not transfer to a file whose
  responsibility is fixed by what it tests.
- It removes 36 of the 65 exceptions. An exceptions list that is 55% one blanket category is a
  rubber stamp, and the cost of an exception is supposed to be writing down *why*.
- The pressure it creates on a suite is downward on coverage. Nothing else in this repository
  pushes that direction; `tests/test-gate-honesty.test.js` exists precisely to stop a suite
  reporting a pass it did not earn.
- A suite already has a better-fitted guard available: **one suite per module under test**, an
  enumerating rule this repo knows how to write (`tests/architecture-tree.test.js` is the
  pattern) and which catches the real drift — a suite covering three modules, or a module with
  none.

### The argument for keeping one rule over both

- **An unreadable suite is a real defect, not a hypothetical one.** At 1837 lines nobody knows
  what `tests/llm-runner.test.js` asserts without reading it end to end, so the practical
  question "is this behaviour covered?" is answered by grep and hope. That is the same
  can't-hold-it-in-one-read failure the rule was written for, in a different file.
- **A suite that grows without bound hides duplication and dead assertions** the same way a
  module hides re-derived behaviour — `tests/task-parser.test.js` at 860 lines is where a
  redundant case goes unnoticed.
- **Two rules are two things to keep honest.** The single rule is enforced by one check with
  one number; splitting it invites a second threshold that drifts, and a file that is neither
  clearly source nor clearly test (a fixture, a helper under `tests/`) lands in the gap.
  Note #36 already records that three enumerating guards each carry their own tree walker and
  that `tests/` subdirectories are enumerated by none of them — the seam between "source" and
  "test" is not as crisp in this repo as the argument above assumes.
- **The exceptions list makes the cost small.** With a recorded reason per file, a long suite
  is already visible and deliberate. Scoping the rule away removes that visibility entirely.

### A second axis the owner may want separated from the first

The rule counts `split('\n').length` — **every** line, including the prose this repository's
own contract requires (`LOGIC CHANGE` comments, module headers stating why a guard exists,
the evidence behind a decision). **Sixteen of the 29 over-limit source modules are under 300
lines of code**, `lib/clone-lifecycle.js` at 49% comment (170 comment / 158 code) and
`lib/notify-owner.js` at 176 comment / 192 code. Re-checked 2026-09-16: still 29 source
modules, so this half of the argument is unmoved by the four files added since. Regenerate with the `node -e` snippet in
**#10**.

So the rule currently penalises a module for documenting itself, and the cheapest compliance
path for those sixteen is **to delete comments**. That is the same shape as the test argument
above — a rule whose easiest satisfaction is the behaviour you did not want — and it is a
separate decision from the tests question: counting code lines instead of raw lines would
change 16 source files and 0 test suites, while scoping tests out would change 36 test suites
and 0 source files. They can be decided independently and should not be bundled.

**Amended 2026-09-15 — a third consequence of counting raw lines: where a comment is allowed
to live.** This repository requires per-change prose in the file itself — a dated
`LOGIC CHANGE` comment on every logic change (`CLAUDE.md`, "Logic Change Comments"). A rule
that counts raw lines taxes exactly that prose, and the two cheapest ways to comply are both
wrong:

- **Moving a comment that documents a line into a document.** A comment explaining *why this
  line is what it is* — why `--single-branch` forces the ls-remote delivery check, why the
  ollama adapter is on `/api/chat` and not the compat path — belongs **on that line**. Move
  it into `docs/` and the line and its reason drift apart at the next edit, with nothing that
  fails when they do. That trades a measurable problem (a long file) for an unmeasurable one
  (doc drift), and doc-vs-reality drift is the class this repository already treats as
  ranking above its apparent severity.
- **Deleting it.** Already filed above as the suites case: the cheapest compliance path
  should never be less documentation.

**The distinction that does hold:** a comment establishing a *convention* — one that governs
future changes rather than explaining the line under it — belongs in
`docs/EXECUTOR-CONTRACT.md`, with the code pointing at it. "Argv arrays defeat a shell, not
git's option parser" is a convention and is in the contract; "this `--` is here because
`git log` reads it as a pathspec" is a line comment and stays on the line. A convention
stated in eleven files is eleven things to keep in sync; a line's reason stated in a
document is a reason nobody will find.

**Not decided here, and not to be decided by an executor:** changing `MAX_LINES` semantics or
its scope changes what every future change is measured against. It is the owner's call.
Whichever way it goes, the change is small — `lib/file-size-gate.js` owns the enumeration and
the rule in one place, and `tests/file-size-gate.test.js` has the negative controls.
**Priority:** P2 | **Effort:** Low (the decision is the work) | **Status:** open

---

### 11. A helpers/utilities map and an owning-doc rule
**Filed 2026-09-13** (derived: `20dc049`).
**Problem:** There is no index of what the `lib/` helpers do or which doc owns each
behaviour. `docs/` holds per-agent design docs only (no `HELPERS.md`/`UTILITIES.md` —
`ls docs/` confirms). New code re-implements behaviour that already exists in `lib/`
because nothing points to it.
**Fix:** add a `docs/HELPERS.md` mapping each `lib/*.js` to its responsibility (the
`CLAUDE.md` Architecture block is a starting inventory), and a CLAUDE.md rule that a new
file names its owning doc. Doc-and-convention only.
**Effort:** Low.

**Half closed 2026-09-14.** The map exists:
[`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) — twelve concepts, every site
cited `file:line`, each pair marked IDENTICAL / EQUIVALENT / DIVERGENT, a regeneration
command per concept, and a ranked extraction order. Six of its rows are DIVERGENT and are
filed here as **#30**-**#33**. The owning-doc *rule* is added to
`docs/EXECUTOR-CONTRACT.md` section 6 ("check this map before re-deriving shared
behaviour").

**What remains open, and it is the part that matters:** the rule is prose, so it gets
broken silently — the exact failure mode `tests/architecture-tree.test.js` was written to
close for a different rule. Nothing fails when a new site re-derives a mapped helper. The
two guards worth writing are named in the map's closing section and carried with #30
(redaction at every `chat.postMessage` site) and #33 (day keys outside `lib/llm-metrics.js`).
**Priority:** P2 | **Effort:** Low (map done) / Medium (the two enumerators) | **Status:** open — map delivered, rule not yet executable

---

### 5. Mid-task `ask_on_slack` capability
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
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
**Priority:** P2 | **Effort:** High | **Status:** open

---

### 6. Structured task result format
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Problem:** Task results are raw text dumps; no consistent success/failure/files/tests
shape.
**Fix:** define a result schema and render it as a Block Kit card. Note that Phase 3
already extracts test pass/fail counts (`lib/code-review-pipeline.js:348-353`) — build on
that rather than re-parsing.
**Effort:** Medium.
**Priority:** P2 | **Effort:** Medium | **Status:** open

---

### 7. Task timeout escalation tiers
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Problem:** `TASK_TIMEOUT_MS` (default 600000) is a single hard kill with no warning.
No soft-timeout logic exists (`grep -in 'soft\|80%\|will be killed' bridge-agent.js` →
nothing).
**Fix:** at ~80% of the limit, post a "running X min, will be killed in Y" warning to
ops. Don't change the kill itself.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 8. Surface deduplication in status
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading
"Deduplication TTL surfaced in status" in the 2026-04-05 seed `4b6ee4a`.
**Problem:** `processed-tasks.json` dedupes silently; a re-submitted task is skipped with
no feedback to the user. Dedup is real (`CLAUDE.md` "Task Deduplication") but there is no
reply-on-duplicate path.
**Fix:** when a duplicate is detected, post a brief threaded reply: "Already processed
(ID: xxx). Reply `retry` to force." Wire `retry` through the existing dedup check.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 9. `ASK: task history [n]` command
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Problem:** The status command returns the last 5 completed tasks; there is no
`task history N`. `grep -in 'task history' bridge-agent.js lib/task-parser.js` → nothing.
**Fix:** add a built-in `ASK: task history 20` that reads N back from memory with
timestamps and outcomes.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 39. The queue cannot tell a completed task from a landed one — nothing here knows whether a branch merged
**Filed 2026-09-14,** from the autonomous-loop design
([`docs/AUTONOMOUS-LOOP-DESIGN.md`](docs/AUTONOMOUS-LOOP-DESIGN.md) section 4, part five).

**Verified at HEAD.** The queue row is created with exactly these fields and no others:
```bash
grep -n "const queuedTask = {" -A 14 lib/task-queue.js
# -> id, msgTs, channelId, text, description, repo, status, enqueuedAt, startedAt,
#    completedAt, error
grep -rniE "merged|landed|pull_?request|isMerged" --include='*.js' lib/ bridge-agent.js | grep -v node_modules
# -> nothing about merges; the only hits are the word "branch" used for control flow
```
There is no branch field, no commit field and no merge field anywhere in the queue or its
callers. A task reaches `completed` when the executor's process exits successfully, which
says the work was **done**, not that it **landed**.

**Why that matters beyond tidiness.** `formatStatusResponse` answers `ASK: what's queued`
from these rows, so "completed" in Slack means "the agent stopped", and an executor that
committed without pushing, or pushed a branch nobody merged, reports identically to one
whose work is on `main`. `detectUndeliveredWork` (`lib/clone-lifecycle.js`) catches the
*unpushed* case and alerts — but a pushed, unmerged branch is delivered by its definition
and correct by it, and is still not landed.

**It blocks the loop outright.** Decisions D1, D2 and D7 of the loop design all turn on
"has this merged?": the merge gate, the post-merge suite run against `main`, and the
preemption of queued work by a fix task about *merged* code. None can be built on a
completed/landed distinction that does not exist.

**Compounded by, but separate from, #17.** #17 records that nothing can answer which
commit the running process is on. That is "merged vs deployed"; this is "completed vs
merged". Both would have to be answerable for a loop to close, and neither is.

**Fix (shape, not chosen):** record the branch and head SHA on the queue row when the task
pushes, then resolve merge state from the remote. Whatever does the resolving must ask the
remote, not the scratch clone — `detectUndeliveredWork`'s own comment explains why
(`--single-branch` clones have no `origin/feature/*` ref, so a local-only check reads a
pushed branch as unpushed).
**Priority:** P2 | **Effort:** Medium | **Status:** open

---

### 40. Uncommitted edits in the live deployment tree — reported, NOT verifiable from a checkout
**BLOCKED — OWNER ACTION (off-repo).** Nothing here is engineering. Remainder: one
`git status --porcelain` in `/share/CACHEDEV1_DATA/jt-agent`, then a decision per modified
file. This repository cannot see that tree at all.
**Filed 2026-09-14.** **Owner-supplied claim; this repository cannot confirm it.** Filed
with that label rather than as a repo fact, because `/bridge` is off-repo.

**The claim:** the live deployment tree carries uncommitted working-tree edits, which
therefore exist in exactly one place.

**What IS verifiable from here, and makes the claim credible rather than idle:**
- `/bridge` is a bind mount of the NAS deploy directory and **that directory is the git
  checkout the container runs** — there is no copy step between "the repo" and "the
  deployment" (`docs/CONFIG-SURFACE-AND-REBUILD.md` -> Step 0, consequence 1).
- Tasks run through a shell as the directory's owner (`uid 1000:100`) with
  `--dangerously-skip-permissions`, so anything in that tree is writable from a task
  (same document, consequence 3). Nothing prevents an edit landing there.
- `auto-update.js` runs `git reset --hard HEAD` before each pull
  (`grep -n "reset', '--hard" auto-update.js` -> `:170`, `:191`). **That discards exactly
  this class of edit.** It is inert today only because nothing starts that daemon (#17) —
  so answering #17 by starting the daemon would destroy these edits on the first cycle.
- The adjacent, already-filed instance is #26: `docker-compose.yml` is untracked **and**
  unignored in that same tree.

**Regenerate on the NAS** (the only place this is answerable):
```bash
cd /share/CACHEDEV1_DATA/jt-agent && git status --porcelain && git stash list
git diff --stat            # what the edits actually are
git log --oneline -1       # and what commit the tree is on
```
`git status --porcelain` printing nothing but `?? docker-compose.yml` closes this item as
"only #26 applies". Any ` M ` line is the finding, and each such file needs deciding:
commit it, or record why it is deliberately local.

**Sequencing that matters:** this must be answered **before** #17 is resolved by starting
`auto-update.js`, not after.
**Priority:** P2 | **Effort:** Low (one command on the box, then a decision per file) | **Status:** open — blocked on an owner check

---

### 37. `notifyOwner(msg, PRIORITY.HIGH)` goes nowhere and returns success
**BLOCKED — OWNER DECISION.** Build the digest, or collapse HIGH into `notifyOps()`. That
is a choice about how much traffic `#sqtools-ops` should carry, not a bug fix. The code is
small either way; the decision is the gate.
**Filed 2026-09-14,** from the failure-path enumeration
([`docs/AUTONOMOUS-LOOP-DESIGN.md`](docs/AUTONOMOUS-LOOP-DESIGN.md) section 5).

**Verified at HEAD:** `grep -n "PRIORITY.HIGH" -A 4 lib/notify-owner.js` — the HIGH branch
logs `[notify-owner] High priority (for digest):` and `return true`. No digest consumes
it: `grep -rn "digest" lib/notify-owner.js morning-digest.js | grep -i "notify-owner"`
finds no reader.

So a caller asking for a HIGH notification receives a **success return value** and the
owner receives nothing. That is worse than an unimplemented feature — it is a reporting
path that silently does not report while telling its caller it did, which is the same
class as the test gate returning green with no assertions (closed in the part-three
change).

**Not fixed in the part-four change, deliberately:** the fix is either to build the digest
or to collapse HIGH into a `notifyOps()` post, and that is a decision about how much
traffic the owner wants in `#sqtools-ops`, not a bug fix an executor should make alone.
Whichever is chosen, `PRIORITY.HIGH` must stop returning `true` for a message it dropped.
**Priority:** P2 | **Effort:** Low | **Status:** open — owner decides digest vs. ops post

---

### 46. `/dispatch` posts to one fixed channel — routing by the invoking channel needs two things that do not exist
**Filed 2026-09-15,** from the command-router pass.
**Problem:** `handleViewSubmission` in `lib/dispatch-command.js` posts the composed task
message to `config.BRIDGE_CHANNEL` regardless of where `/dispatch` was invoked. Every task
therefore runs as the bridge agent in the bridge channel, whatever channel the operator was
standing in. The modal already records the invoking channel in `private_metadata`
(`lib/dispatch-modal.js` → `buildModalView`), so the value is present and unused.
**The attractive version:** post to the channel the command was invoked in. The existing
channel→agent routing then decides the agent with **no new mechanism** — `poll()` already
walks `channelsToPoll` and carries each channel's `agentConfig` into processing.
**Why it is not done here — two dependencies, both real:**
1. **A task does not execute as the channel's agent.** That is **#38**: `processTask`
   resolves persona and provider from the module-level `agentConfig` (the bridge), not from
   the polled channel's. Posting into the secretary's channel today would produce a task
   that still runs as the bridge — the routing would look wired and change nothing.
2. **A channel the poll loop does not watch swallows the task silently.** `channelsToPoll`
   is built from *active* agents with channels (`bridge-agent.js:1934`, filtered by
   `getActiveAgents()`), so `/dispatch` invoked in `#store-tasks`, a DM, or any planned
   agent's channel would post a message nothing ever reads. The command must **refuse** an
   unwatched channel in the modal — the same reject-never-degrade rule the field validators
   already follow — not fall back to the bridge channel, which would be the silent
   downgrade this whole path exists to remove.
**Fix (after #38):** resolve the invoking channel against `channelsToPoll`; post there on a
match; reject in-form with the reason on a miss. The `private_metadata` round trip and
`tests/dispatch-command.test.js`'s failure-path coverage already exist.
**UNBLOCKED 2026-09-16 — dependency 1 is closed and this status was stale.** #38 ("a task
does not execute as the channel's agent") was closed and purged by `29af5c5` on 2026-09-15,
guarded by `tests/task-agent-identity.test.js`. So the reason this item read "blocked" no
longer holds. Dependency 2 stands and is the actual work: `/dispatch` must **refuse** an
invoking channel that is not in `channelsToPoll`, never fall back to the bridge channel.
Re-verify the remaining claim: `grep -n "BRIDGE_CHANNEL" lib/dispatch-command.js` -> the
post target is still `config.BRIDGE_CHANNEL` regardless of where the command was invoked,
so the namesake is unchanged. Citation drift: `buildChannelsToPoll` is at
`bridge-agent.js:2107`, not `:1934`.
**Priority:** P2 | **Effort:** Low | **Status:** open — **unblocked**, not started

---

### 47. A global provider switch must say what it changed, and must not flatten per-agent settings
**Filed 2026-09-15,** from the provider-resolution pass. **Recorded before the feature is
built, because the failure is in the shape, not the code.**
**Problem:** `LLM_PROVIDER` is the global default, fourth in precedence behind the per-agent
env override and the registry (`resolveLlmProvider`, `lib/config.js:165`; the full
precedence and its provenance are now in `resolveAgentLlm`, `lib/agent-llm-resolver.js`).
Any future command that sets it — "put everything on ollama" — has two ways to be wrong:
1. **It reports nothing.** Eleven agents change behaviour and the operator has no record of
   what each one was on. Reverting needs the previous state, and the previous state was
   never captured.
2. **It flattens per-agent settings.** An agent pinned by `LLM_PROVIDER_<AGENTID>` or by its
   registry `llm_provider` must *keep* that pin: a global default is a default, and an agent
   that was explicitly set is not expressing a preference for "whatever the default is".
   Silently overriding it is the same defect as a clamped turn budget — a downgrade nobody
   was told about.
**Requirement, not a fix:** a global switch returns a per-agent before/after table with the
**source** of each value, and touches only agents whose resolved source is the global
default or the hard fallback. `resolveAgentLlm` already returns `provider_source` per agent
for exactly this; `ASK: agent status` renders it today.
**Priority:** P2 | **Effort:** Low, if built on the resolver | **Status:** open — requirement recorded, nothing built

---

### 49. `NATURAL_CONVERSATION_MODE` is off, and nothing establishes what turning it on does
**Filed 2026-09-15,** from the command-router pass. **This is a question to answer, not a
defect to fix.**
**Problem:** `config.NATURAL_CONVERSATION_MODE` (`lib/config.js`, default `false` —
`process.env.NATURAL_CONVERSATION_MODE === 'true'`) gates a reply path for messages
carrying neither `TASK:` nor `ASK:`. With it off, every such message is skipped, and the
skip is logged by `describeSkipReason`. So the flag's *off* behaviour is well understood
and the *on* behaviour has never been observed: no test exercises a real message through
it, no run has been recorded with it enabled, and the blast radius is not written down
anywhere.
**The questions, in the order they have to be answered:**
- Which channels does it apply to — the bridge channel only, or every polled agent channel?
  Every channel means every incidental human remark in five channels reaches an LLM.
- Does the allowlist still gate it? The poll loop's gate is
  `!isUserAuthorized(msg.user) && !isBotMessage`, and a bot post bypasses it by design
  (`lib/dispatch-command.js` header) — so a bot's own message could trigger a reply, and a
  reply is a message.
- What stops two agents in one channel answering, or an agent answering its own answer?
- What does it cost per day at current message volume, and on which provider?
**Why it matters now:** the command router and the status verb both make it cheaper to add
things that *would* depend on this path. Nothing should, until the four questions above
have answers.
**Priority:** P2 | **Effort:** Low to investigate; unknown to make safe | **Status:** open — question recorded, unanswered

---

### 51. A command that writes a tracked file is destroyed by the next pull, and every configuration-writing command shares it
**BLOCKED — OWNER DECISION.** Three shapes recorded, none chosen, and the item explicitly
forbids the obvious wrong move (*do not fix this by adding a fourth store*). Shape (b) is
already demonstrated by `create`. Picking the shape is the gate.
**Filed 2026-09-15.** **This is a class, filed after its third instance.** A built-in
command that changes configuration has exactly two places to write: a tracked file, which
`auto-update.js`'s `git reset --hard HEAD` discards on the next pull, or a gitignored
file, which no other workspace and no reviewer ever sees. Every such command has to choose,
and none of them has solved it — three have picked a side ad hoc and one of those three
was wrong.

| Command / writer | Writes | Survives a pull? | Visible in review? |
|---|---|---|---|
| `activate` / `deactivate` (`lib/agent-activation.js`) | `agents/shared/agent-activation.json` | **yes** (gitignored) | **no** |
| `ASK: create channel` → `ensureChannel()` | `agents/shared/channel-map.json` | **yes** (gitignored) | **no** |
| the removed `activateAgent()` in `lib/agent-registry.js` | `agents/agents.json` | **NO** | yes |
| a per-agent provider change | nothing — it is `LLM_PROVIDER_<AGENTID>` in `.env`, by hand | yes | **no** |
| `create` (part four, 2026-09-15) | `agents/<id>/agent.md` | **NO** | yes |

**Observed damage, not hypothesised.** `lib/agent-registry.js`'s own removal comment
records the tracked-file variant as having been destroyed twice. `docs/AGENTS.md` records
the same shape destroying a scheduled job's interval. `CLAUDE.md` records that
`docker-compose.yml` was one `git clean -fd` away from being deleted and is now gitignored
for exactly this reason (#26).

**The uncomfortable half:** the two that "survive" survive by being invisible. A workspace
whose agent set differs from its repository's, with the difference recorded nowhere a
reviewer reads, is the same defect as a lost write with the sign flipped — it is how the
running system and the tracked declaration drift without anyone being told.

**Shapes, none chosen:**
- *(a)* A command that writes a tracked file also commits and pushes it. Needs a git
  identity and a push credential in the bridge process, and makes `ASK:` a thing that can
  change `main` — a much larger blast radius than any command has today.
- *(b)* A command that writes a tracked file returns the **diff** and asks a human to
  commit it. Honest, cheap, and the only one that works with the deploy path as it is.
  `create` does this today by saying plainly that the file will be discarded.
- *(c)* Move every runtime-decidable field out of tracked files entirely, so the tracked
  file is a declaration and the local store is the whole state. This is the direction
  2026-09-15 already went (`default_status` + `agent-activation.json`), and (b) is the
  gap-filler for the fields that cannot move — a role, a system prompt, a `target_repo`.

**Do not fix this by adding a fourth store.** The cost of the current mess is three
mechanisms; a fix that adds a fourth is not one.
**Priority:** P2 | **Effort:** Low for (b) per command; High for (a)
**Risk:** (a) is the only one that can push to `main` and should not be attempted before #17
**Status:** open — class recorded with its instances; no shape chosen

---

### 52. The workspace's channels and the repository's agents have never been reconciled in either direction
**Filed 2026-09-15,** from the channel-name correction. **Two sets, never compared.**

**Direction one — agents with no channel.** Regenerate:
```bash
node scripts/channel-map.js --report   # any row printing "unresolved"
```
Today: `jester` (active, scheduled, declares a name nothing created), `marketing` and
`storefront` (planned, declaring names their checklists record as created, so probably
resolvable — never tried).

**Direction two — channels with no agent, which nothing in this repository can even
enumerate.** The repository names channels that no agent record references:
`#sqtools-ops` (`OPS_CHANNEL_ID`), `#store-tasks` (`STORE_TASKS_CHANNEL_ID`),
`#store-inbox` (`STORE_INBOX_CHANNEL_ID`), `#bot-memory` (`MEMORY_CHANNEL_ID`, in a
completed checklist entry and read by nothing). Beyond those, `docs/CONFIG-SURFACE-AND-REBUILD.md`
Step 2 records that the live `.env` carries **six** `*_CHANNEL_ID` keys no code in this
repository reads — so there are channels the deployment knows about that the repository
cannot name at all. And a channel that exists in Slack but appears in neither place is
invisible to every command here.

**Why it is worth reconciling.** The bot joins a channel on every boot and output
accumulates in channels nobody reads; a channel with no agent is where an agent's work
goes to die, and an agent with no channel is work that never starts. Both failures have
already happened (#3, #55). Neither is reported by anything.

**The missing half is one Slack call this repository deliberately does not make.**
`conversations.list` is already used by `findChannelByName()`; a read-only "every channel
the bot is in, against every channel an agent declares" report needs no new scope. It is
not built here because it is a live-workspace enumeration and the repository can only
verify its own half — but it is the only thing that closes this.
**Priority:** P2 | **Effort:** Low (a read-only report; `channels:read` is already held)
**Risk:** Low — read-only, creates nothing
**Status:** open — one direction is computable from the repo today, the other needs the report

---

### 53. `jester` is an active commentary agent with a weekly schedule, no channel, and no defined material
**BLOCKED — OWNER ACTION (off-repo).** Gaps 2 and 3 closed 2026-09-16; gap 1 is a Slack
channel, and nothing in this repository creates one. Remainder: `ASK: create channel
#jester-agent`, then `ASK: activate jester`. Remainder for a branch: none.
**Filed 2026-09-15.** Three separate gaps that look like one:

1. **No channel, and no real name to give it.** Its checklist says "Responds via ASK in
   any channel, no dedicated channel needed", yet its definition declares
   `channel_name: jester-agent`, which nothing ever created. The 2026-09-15 name
   correction fixed seven declarations from tracked evidence and could not fix this one,
   because there is no real name to substitute. It is the only **active** agent that
   cannot be addressed at all.
2. **A schedule that is refused every boot.** `0 18 * * 5` → `weekly-critique`, refused by
   `lib/agent-scheduler.js` for a stated reason since 2026-09-15 (it used to be a silent
   skip — #3). So the refusal is visible; the decision behind it is not made.
3. **Its input is undecided, and that is the real question.** `weekly-critique` is a
   template with no defined material. Pointed at a diff it produces remarks about naming.
   The material worth reading is the **gap between what was claimed and what happened** —
   and a large part of that is already computable with no model at all:

   - items in this file carrying a **Filed** date and still `Status: open` — how long each
     has been open, and which were deferred on scope grounds and then bit (#54);
   - `Closes <ID>` vs `Addresses <ID>` in commit bodies — work claimed complete against
     work claimed partial (`git log --grep='^Addresses #' --oneline`);
   - a definition-of-done list in a commit body against the suites that actually ran.

   A deterministic report over those three is material a model can then be given, rather
   than a model being asked to find material. Note the ordering: decide the input before
   deciding the channel, because a weekly post with nothing to say is worse than silence
   and would be the thing the agent exists to mock.

**Three ways out, none chosen:** create `#jester-agent` (owner action, one channel that
then accumulates a weekly post); drop the schedule and keep jester as an ASK-only
personality, which is what its checklist says it is; or build the deterministic report
first and decide afterwards.

**2026-09-16 — the third way was taken, and gaps 2 and 3 are closed.**
[`docs/JESTER-DESIGN.md`](docs/JESTER-DESIGN.md) is the design of record.

- **Gap 3 (the input) — CLOSED.** `weekly-critique` moved from `TASK_TEMPLATES` to
  `DETERMINISTIC_TASKS`. `lib/critique-digest.js` computes the report this item asked
  for, over exactly the three signals named above plus three more: backlog ages joined
  to how many times `WORK-TODO.md` was revised while an item stayed open; `Closes` vs
  `Addresses` with **items addressed repeatedly and still open**; task outcomes,
  durations and attempts with the queue's 24-hour retention printed beside them; what
  merged and the fact that nothing can say what is *running* (#17); orphaned agent
  output reused from `lib/agent-surface.js`; and bulletins, capped at five, as the only
  conversational input.
- **Gap 2 (the refused schedule) — CLOSED as far as this repository can close it.** The
  job registers the moment the channel resolves: with one supplied,
  `describeSchedule(jester)` returns `{ registered: true, kind: 'deterministic' }`.
- **Gap 1 (the channel) — OPEN, and it is an owner action.** `#jester-agent` has never
  resolved in any evidence this repository holds
  (`node scripts/channel-map.js --from-git` lists it as unrecoverable). **The ASK-only
  alternative is rejected**: the digest is the thing worth reading and it needs
  somewhere to accumulate. `ASK: create channel #jester-agent`, then
  `ASK: activate jester`.

Also landed, because the item asked for the report and a report nobody can trigger is
half a capability: `ASK: critique` runs the same operation on demand, registered in
`lib/command-router.js` and reaching the same `getDeterministicTask` call the cron tick
makes — one route, two triggers. And the thing #53 warned about is enforced rather than
hoped for: a week with nothing in it produces a short honest post and **calls no model
at all** (`tests/weekly-critique.test.js`), because a model handed an empty digest and a
contrarian persona writes a complaint.

**Priority:** P2 | **Effort:** remaining effort is one owner action
**Risk:** Low
**Status:** open — **blocked on `ASK: create channel #jester-agent`, and on nothing
else.** The material, the critique, the on-demand trigger and the no-gating guard are
all landed and green.

---

### 54. Two defects deferred on scope grounds were load-bearing — the deferral judgement, not the filing, is what failed
**Filed 2026-09-15.** **A decision record about how this backlog is used, not a code
defect.** Both instances were filed correctly, with evidence, and then deferred for a
reason that read well at the time and was wrong.

| Filed as | Deferred because | What it actually was |
|---|---|---|
| `getRecentCompleted` sorts by a millisecond timestamp (P2, closed 3d7ad70) | "cosmetic ordering in one status command" | `tests/task-queue.test.js` failed in **25 of 40** isolated runs on the base commit. Every test run in this repository was a coin flip, so *every* gate was unreliable, including the ones judging unrelated work |
| #50 / #24 — a suite writing fixtures into live configuration | "latent; each file has exactly one writing suite, so nothing races it" (#24's own words) | It was not latent. It was writing three invented ids into `agents/shared/channel-map.json` — the file the running bridge resolves agent channels from — on every run, while the same file being absent made 30 tests red in every fresh clone |

**The common shape, and it is the useful part.** Both were ranked by the **visible
symptom's** severity — a mis-ordered list, a tidiness issue in tests — when the thing that
made them load-bearing was that they sat under **verification**. A defect in the thing
that judges other work is not P2 because its symptom is small; its blast radius is every
judgement made while it is open. #50 says this about itself in passing ("Dismissing red is
the habit being trained") and was still filed P2.

**The rule this records:** *before assigning a tier, ask whether the defect is in the
system under test or in the apparatus that tests it.* A defect in the apparatus — a flaky
suite, a gate that cannot start, a gate red for a non-code reason, a suite that mutates
what it measures — is **P1 regardless of its symptom**, because everything downstream of
it is unverified while it is open. The existing P1 definition ("can brick or silently
degrade the running bridge") does not cover this, and both of these fell through that gap.

**Not proposed:** re-ranking the whole file. Two instances is a pattern, not a mandate,
and the next filing is where this is cheapest to apply.
**Why this could not be closed in the 2026-09-16 audit, and what would close it.** Its
Effort is "None — the decision is the artifact", so on a first reading it looks done. It is
not closeable, for a reason that is structural rather than about this item: **this file
purges closed items, so closing a decision record deletes the decision** unless the decision
already lives somewhere else. `grep -rn "apparatus" CLAUDE.md docs/*.md` finds nothing — the
rule exists only here. And it is load-bearing right now: **#56 cites it by number as the
sole justification for its P1 ranking**, so purging this would leave #56's tier unexplained.

Compare #45, closed the same day: its rule was independently written into
`lib/command-router.js:12`, `CLAUDE.md:651` and a test, so purging the item cost nothing.
That is the difference, and it is the close condition here too — **the remainder is one
edit: put the rule in this file's own priority-tier definition.** The tier definition
currently reads "P1 = can brick or silently degrade the running bridge, or unblocks
something that can", and this item exists because that sentence does not cover a defect in
the apparatus. Amend it, then close.

**Priority:** P2 | **Effort:** Low (one edit to the tier definition above, then close)
**Status:** open — the rule is written down here and nowhere else, so closing it would
delete it; #56 depends on it

---

## P3 — Nice to have / uncertain ROI

### 48. A model list is enumerable for a local provider and is a guess for a hosted one — record the asymmetry, build neither yet
**Filed 2026-09-15,** from the provider-resolution pass. **Recorded so that whoever builds
a model picker does not build one list.**
**The asymmetry.** `lib/llm-runner.js`'s ollama adapter already talks to an endpoint that
answers this exactly: `GET /api/tags` returns the models actually pulled on that host, and
`validateOllamaOnStartup()` calls it today. That list is **ground truth** — a name it
returns can be run right now, a name it omits cannot.
No hosted provider offers the equivalent. A published model list is a marketing document:
it changes without notice, it is not scoped to the credential in `.env`, and a model on it
may be unavailable to this account, in this region, or at this tier. Querying one answers
"what exists" when the question is "what can this key run".
**What this means for any model UI:**
- For `ollama`, enumerate from `/api/tags` and treat the result as authoritative. A model
  in `OLLAMA_MODEL` or an agent's `llm_model` that is absent from it is a **precondition
  failure**, which is what the adapter already does rather than guessing.
- For `claude`/`gemini`, do **not** present a list as if it were verified. Either accept a
  free-text model id and let the call fail loudly with the provider's own error, or verify
  one specific id with one real call before recording it. A hardcoded list in this repo
  would go stale silently, which is the doc-drift class.
- The two must not share a code path that implies equal confidence. `resolveAgentLlm`
  (`lib/agent-llm-resolver.js`) already returns `model_source`, so the UI can say where a
  model name came from without claiming it was validated.
**Why this could not be closed in the 2026-09-16 audit.** Same shape as #54: its namesake
is "record the asymmetry, build neither yet", both halves of which are satisfied — and it is
still not closeable, because the record lives only in this file and this file purges what it
closes. Partial traces exist in code (`lib/llm-runner.js:982` explains why the startup probe
uses `/api/tags`; `lib/agent-llm-resolver.js` returns `model_source`), but the *decision* —
never present a hosted provider's model list as if it were verified — is written nowhere
else, and this item exists precisely to reach a future reader who is about to build one.
**The remainder is one edit:** move the two-bullet rule into the document that owns provider
behaviour (`docs/AGENTS.md`, or `CLAUDE.md`'s LLM section beside the ollama contract), then
close this. Until then, closing it destroys the artifact.

**Priority:** P3 | **Effort:** Low (move the rule to an owning doc, then close)
**Status:** open — distinction recorded **only here**, neither list built

---

### 36. Three enumerating guards each carry their own source-tree walker, and `tests/` subdirectories are enumerated by none of them
**Filed 2026-09-14,** from `docs/CANONICAL-HELPERS.md` section 13.

```bash
grep -rn "function stripComments\|function stripCommentsAndStrings\|function listSourceFiles" tests/*.js
```
**CORRECTED 2026-09-16 — it is FOUR copies now, not three.**
`tests/task-agent-identity.test.js` added a fourth while this item was open, which is what
an un-enforced duplication item does: it records a number that the next change invalidates.
The grep above finds all four. Regenerate the count rather than reading it:
`grep -rlE 'function (stripComments|stripCommentsAndStrings|listSourceFiles|collectSourceFiles)' tests/*.js | wc -l` -> 4.

`tests/no-shell-execution.test.js`, `tests/timezone-explicit.test.js`,
`tests/test-gate-honesty.test.js` and `tests/task-agent-identity.test.js` each walk the
source tree from disk and each carries its own copy — roughly 50 lines repeated four times. Marked **EQUIVALENT**, not DIVERGENT: the
two comment scanners differ deliberately (the shell guard blanks string *contents* so prose
naming a banned API does not trip it; the test-gate guard must leave strings intact because
the thing it detects, `'npm test'`, **is** a string literal).

**Why it was not extracted when the third copy landed.** The helper would live under
`tests/helpers/`, and `tests/architecture-tree.test.js` enumerates `tests/*.js`
**non-recursively** (`TRACKED_DIRS` at `:44` includes `tests`, but the walk at `:94` is a
flat `readdirSync`). A file four guards depend on would sit in a directory no guard covers.
**Re-verified 2026-09-16 and still true** — the four files now in `tests/helpers/` are named
in `CLAUDE.md`'s tree but enumerated by no guard, so the tree test cannot fail when one is
added or removed. Extraction therefore means widening that
enumeration first, which is the actual work and is why this is an item rather than a
side effect of the change that noticed it.

**Fix:** widen `tests/architecture-tree.test.js` to walk `tests/` recursively, then extract
`listSourceFiles` and both stripper variants into `tests/helpers/source-scan.js`, keeping
the two stripping modes as an explicit option rather than merging them.

**It has a concrete cost already.** `tests/test-gate-honesty.test.js` is **364 lines** and
is the **one file this branch newly pushed over the repo's 300-line rule** — `npm run validate`
goes 63 -> 64 over-limit files (`npm run validate 2>&1 | grep -cE '^  - '`, compared against
`1533d85`). Roughly 120 of those lines are the walker and the comment scanner, so this
extraction takes the file back under the limit. Trimming prose instead would cost the
reasoning that makes the guard maintainable, and doing the extraction inside the change
that added the third copy would have meant editing two other guards as a side effect —
which is why it is an item.
**Priority:** P3 | **Effort:** Low | **Status:** open

---

### 21. `already_in_channel` warns five times per boot — and the obvious fix is in the wrong place
**Filed 2026-09-14.** Citations re-checked 2026-09-16: `joinAgentChannels` is at
`lib/slack-client.js:367` (filed as `:385`) and the `new WebClient(token)` construction —
the one that actually matters, because it is the missing `logLevel` — is at `:62`, not
`:80`. The claim is unchanged. `joinAgentChannels` (`lib/slack-client.js:367`) calls
`conversations.join` unconditionally for every channel at startup; the bot is already in
all of them, so every boot produces the same five warnings. Harmless, and it trains the
reader to skip WARN lines — which matters because item #3's `not_in_channel` and item #17's
"is the running process on main?" both surface as exactly that kind of line.

**Correction to the dispatch — the warning is not emitted by this repo.**
`lib/slack-client.js:397-402` already treats `already_in_channel` as success: it increments
`joined` and `continue`s **without logging**. So patching that catch block changes nothing.
Slack returns HTTP 200 with a `response_metadata.warnings` field for this case, and the SDK
forwards those straight to `logger.warn`. **Verified**, not inferred:
`node_modules/@slack/web-api/dist/WebClient.js:204-206`
(`result.response_metadata.warnings.forEach(this.logger.warn.bind(this.logger))`) and
`:151`, which defaults the logger to `LogLevel.INFO` when the constructor is given no
`logLevel` — which is exactly how `lib/slack-client.js:80` constructs it
(`new WebClient(token)`). Regenerate:
`grep -n "warnings\|LogLevel.INFO" node_modules/@slack/web-api/dist/WebClient.js`.

**Fix (pick one, both cheap):** pass `logLevel: LogLevel.ERROR` (or a custom `logger`) when
constructing the `WebClient`; or check membership before joining and only call
`conversations.join` for channels the bot is actually missing — which has the side benefit
of making a *real* join (the case channel auto-join exists for) visible instead of buried
among four no-ops. Do not "fix" it in the catch block; that code never runs for this case.
**Effort:** Low. **ROI:** log legibility only.
**Priority:** P3 | **Effort:** Low | **Status:** open

---

### 29. `gmail-unsubscribe` is a declared agent permission that no code implements
**BLOCKED — OWNER DECISION.** Drop the permission and the three rules-file keys as
aspirational, or implement it — which means a write scope, a consent flow and an
irreversible outbound action on a keyword match. The item says so itself: *decision, not
work*. Until it is made there is nothing for a branch to build.
**Filed 2026-09-14,** from the same trace as #28.

The email-monitor agent declares `permissions: ["gmail-read", "gmail-unsubscribe"]` and a
note reading "Can click unsubscribe links in emails marked as ignore/newsletter"
(`agents/agents.json`). Its retired prose task template told the model to "Process any
safe unsubscribe requests" (`lib/agent-scheduler.js`, `check-inbox`, removed 2026-09-14).
`agents/email-monitor/memory/rules.json` carries `auto_unsubscribe`,
`auto_unsubscribe_list` and `unsubscribe_log` keys.

**Nothing implements any of it.** Regenerate:
```bash
grep -rn "unsubscribe" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
# -> only the rules-file keys, keyword lists, and one task-decomposer regex. No action.
grep -rn "gmail\..*\(send\|modify\|trash\|delete\)\|messages\.\(send\|modify\|trash\|delete\)" \
  --include='*.js' lib/ *.js | grep -v node_modules   # -> nothing
```
The only OAuth scope requested anywhere is `gmail.readonly`
(`lib/integrations/gmail.js:83`), so even if a caller existed the token could not do it.

This is a **capability claimed in the registry that the system does not have** — the same
class as CLAUDE.md overselling task decomposition (`docs/WIRING-AND-SEAMS.md` §3). It is
filed rather than fixed because the resolution is a choice: drop the permission and the
three rules-file keys as aspirational, or implement it — which means a write scope, a
consent flow, and an irreversible outbound action taken on the strength of a keyword
match. The second is a much larger decision than it looks.

**Related, and deliberately not merged into this item:** the `denied` list on the same
agent (`gmail-send`, `gmail-delete`, `gmail-archive`) is likewise enforced by nothing —
no code reads `permissions` or `denied` at all
(`grep -rn "\.permissions\|\.denied" --include='*.js' . | grep -v node_modules | grep -v '/tests/'`
-> nothing). That is a broader finding about the
registry's permission model and belongs in its own item if it is ever acted on.
**Priority:** P3 | **Effort:** Low to remove; High to implement | **Status:** open — decision, not work

---

### 13. MCP server wrapper
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Source:** tomeraitz/claude-slack-bridge
**Idea:** expose bridge capabilities (post to Slack, read the queue, query memory) as MCP
tools so Claude Code sessions call them directly.
**Dependency (now explicit):** only meaningful while Claude Code is the executor (see
item 5) and mostly only worth it alongside the mid-task ask capability.
**Effort:** High. **ROI:** unclear.
**Priority:** P3 | **Effort:** High | **Status:** open

---

### 14. Watercooler retro → LinkedIn draft
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading
"Watercooler summary to LinkedIn draft" in the 2026-04-05 seed `4b6ee4a`.
**Idea:** after the Friday retro, aggregate the week's highlights into a LinkedIn draft
for review.
**UNBLOCKED 2026-09-15.** This read "Blocked by: `story-bot` is `status: "planned"`
(see item 3); its `draft-weekly-posts` template exists but the agent is not active.
Activate story-bot first." story-bot is now activated (`default_status: active` in
`agents/story-bot/agent.md`), joined, polled, its Friday job registers, and since #38
closed the task executes as story-bot rather than as the bridge. The template lives at
`lib/agent-task-catalogue.js` now, not `lib/agent-scheduler.js:56` — it moved in the
2026-09-15 catalogue extraction and that citation was stale.
**What remains, which is the actual work of this item:** nothing aggregates the retro's
output into the draft. `lib/watercooler.js` posts a `milestone` bulletin when a standup
completes, story-bot `watches` `milestone`, and `lib/bulletin-watcher.js` would fan out
to it — but a watcher receives a 150-character SUMMARY LINE, not the record, so the
draft would be written from a truncated notification. Either the watcher carries more,
or `draft-weekly-posts` reads the stream itself. Note also that `milestone` reached no
watcher at all while story-bot was the only agent watching it and was not activated;
that is no longer true, so this path is live and untested.
**Priority:** P3 | **Effort:** Low-Medium | **Status:** open — story-bot activated, the aggregation is the remaining work

---

### 15. Task complexity auto-scaling TURNS
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Problem:** `TURNS` is manual (`lib/task-parser.js:13` `DEFAULT_TURNS = 50`, floor 5,
cap 100). `analyzeComplexity()` exists (`lib/task-decomposer.js`) but its score does not
feed TURNS.
**Fix:** when `TURNS` is not explicitly set, derive a baseline from
`analyzeComplexity()` (e.g. 1-2 → 20, 3-5 → 50, 6+ → 80).
**Dependency (now explicit):** turns are a Claude-CLI concept; single-shot adapters
(Gemini/Ollama) ignore `maxTurns` (`lib/llm-runner.js` adapter contracts), so this only
affects Claude-executed tasks.
**Effort:** Low.
**Priority:** P3 | **Effort:** Low | **Status:** open

---

### 16. Channel-per-task archive mode
**Filed 2026-09-13** (derived: `20dc049`). **Substance is older:** ancestor heading in the
2026-04-05 seed `4b6ee4a`.
**Idea:** for long-running/high-value tasks, auto-create a dedicated channel, post all
I/O there, archive on completion.
**Effort:** High. **ROI:** probably only audit/compliance.

**Priority:** P3 | **Effort:** High | **Status:** open

---

## Revision trail

The per-revision "what changed since last time" narrative that used to live here has been
removed. It had grown to ~190 lines that restated items already stated above, recorded
closures whose real record is the commit that closed them, and carried figures (`59 files`,
`bridge-agent.js 2210`) that were stale and in one case never correct. Closed items are
purged; `git log --follow WORK-TODO.md` and each closing commit's `Closes <ID>` body are
the trail.

What survives from it, because it is not recoverable from a commit message:

- **Item numbers 1, 2, 12, 18, 19 and the 2026-04-05 list are retired, not free.** Numbers
  are never reused. `git log -S'### 19.' -- WORK-TODO.md` finds any of them.
- **The list was re-derived on 2026-09-13** from the system as it actually runs; it had been
  seeded from [tomeraitz/claude-slack-bridge](https://github.com/tomeraitz/claude-slack-bridge),
  several of whose assumptions (PM2, a Raspberry Pi host, HTTP-polling-is-fine) were already
  false. Items #4, #5, #6, #13, #15, #16 still carry that origin.
- **Off-repo facts stay labelled.** The compose `command:` line, the live `.env` contents,
  container uptime, the `Joined 5/5 agent channels` and `not_in_channel` startup lines, and
  the ~1-in-6 flake rate once reported for the retired #19 are owner-supplied and not
  checkable from a clone. Each is named at its item with the command that regenerates it on
  the box.

*Updated 2026-09-14: five items filed (#36-#40) from the autonomous-loop design work —
#38 (`TASK:` always runs as the bridge agent), #39 (the queue cannot tell completed from
landed), #40 (uncommitted edits in the live deployment tree — owner-verifiable only),
#37 (`PRIORITY.HIGH` drops the message and returns success) and #36 (three guards, three
copies of the source walker). The claim that nothing can answer which commit the running
process is on was checked against HEAD and is **already filed**, inside #17 — recorded
here as checked, not duplicated as a new item. Index regenerated from the headings, which
also repaired four anchors that had dropped an underscore.*

*Updated 2026-09-15 (command-router pass): five items filed — #45 (commands are verbs,
names are channels), #46 (`/dispatch` posts to a fixed channel; invoking-channel routing
needs #38 and an unwatched-channel refusal), #47 (a global provider switch must report its
before/after and must not flatten per-agent pins), #48 (a model list is ground truth for
ollama and a guess for a hosted provider) and #49 (`NATURAL_CONVERSATION_MODE` is off and
its on-behaviour is unestablished). Three items amended rather than duplicated: **#4** now
records all three ways to cut submit-to-start latency with their costs, not only the
largest; **#43 (P1)** had a stale status — `/dispatch` was built on 2026-09-15 and only the
owner-side Slack app configuration remains; **#44** gains the comment-placement consequence
of counting raw lines. Two candidates were checked and **not** filed because they were
already recorded: the "deleting documentation is the cheapest compliance path" argument
(inside #44) and the per-agent provider override surviving `git reset --hard` (inside
`lib/config.js`'s `resolveLlmProvider` header and CLAUDE.md). The duplicate `### 43.` is
left as it stands — renumbering an address is the owner's call. Index and counts
regenerated from the headings with this file's own commands.*

*Last reconciled 2026-09-14: six closed entries purged (#1, #2, #12, #19, the 2026-09-13
scratch-clone entry, and the retired-#18 references), the two unnumbered items given stable
IDs (#34, #35), eight items filed (#28-#35), item #10's figures corrected against
`npm run validate`, items #3 and #4 re-cited at HEAD, and the revision-trail section
replaced by this note. Index regenerated from the headings.*
