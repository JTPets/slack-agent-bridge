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

At the 2026-09-15 size-gate pass those print **40** open items — 7 P1, 26 P2, 7 P3 — and
**one duplicate ID, `### 43.`, which is a defect in this file.** Two items share it: the P1
"A flattened dispatch loses its fields" and the P2 "`getRecentCompleted` sorts by a
millisecond timestamp". They were filed on branches that picked the same next ID
independently — the same collision this paragraph previously recorded being resolved once
already, recurring because "the next ID" is read by eye rather than by command. **Renumbering
one is the owner's call, not an executor's** (an ID is an address and #43 may already be cited
elsewhere), so it is recorded here rather than silently fixed. The preceding count also read
38 while the command printed 39: the figure was stale *and* the duplicate was invisible to
whoever wrote it.

(Was 35 — 4/24/7 — after #28 was closed by the email-rules-file work; the NAS hardening pass
then filed #41 and #42, and the additive Socket Mode connection filed #43, all on 2026-09-15.
The size-gate pass filed #44.)

The index anchors follow GitHub's slugger: lowercase, drop punctuation **except**
hyphen and underscore, spaces to hyphens. Four entries (#5, #20, #21, #34) previously
dropped the underscore too and were therefore broken links; regenerating fixed them.

## Index

*Regenerated from the headings. Do not append to it by hand; re-run the command above.*

**P1 — protects or unblocks the live deployment** (7)

- **#42** — [Every backup this system has lives on the box it backs up, and their liveness is checked by nothing](#42-every-backup-this-system-has-lives-on-the-box-it-backs-up-and-their-liveness-is-checked-by-nothing)
- **#41** — [The NAS is the single point of failure for every stack and every credential, and its exposure has never been established](#41-the-nas-is-the-single-point-of-failure-for-every-stack-and-every-credential-and-its-exposure-has-never-been-established)
- **#17** — [Nothing starts `auto-update.js` — merged code does not reach the running process](#17-nothing-starts-auto-updatejs--merged-code-does-not-reach-the-running-process)
- **#25** — [The preserved scratch clone does not survive a container recreation — silent data loss inside the feature that prevents silent data loss](#25-the-preserved-scratch-clone-does-not-survive-a-container-recreation--silent-data-loss-inside-the-feature-that-prevents-silent-data-loss)
- **#3** — [The scheduler never checks `planned` status — CONFIRMED FIRING LIVE 2026-09-14](#3-the-scheduler-never-checks-planned-status--confirmed-firing-live-2026-09-14)
- **#4** — [Replace HTTP polling with Slack Socket Mode (event triggers)](#4-replace-http-polling-with-slack-socket-mode-event-triggers)
- **#43** — [A flattened dispatch loses its fields — the connection for the fix exists, the command does not](#43-a-flattened-dispatch-loses-its-fields--the-connection-for-the-fix-exists-the-command-does-not)

**P2 — real gaps, no risk to the running process** (26)

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
- **#32** — [One bulletin timestamp, three renderings — and the path every agent's prompt uses emits none](#32-one-bulletin-timestamp-three-renderings--and-the-path-every-agents-prompt-uses-emits-none)
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
- **#38** — [`TASK:` is always executed as the bridge agent, so a scheduled agent's persona and provider never apply to its own task](#38-task-is-always-executed-as-the-bridge-agent-so-a-scheduled-agents-persona-and-provider-never-apply-to-its-own-task)
- **#39** — [The queue cannot tell a completed task from a landed one — nothing here knows whether a branch merged](#39-the-queue-cannot-tell-a-completed-task-from-a-landed-one--nothing-here-knows-whether-a-branch-merged)
- **#40** — [Uncommitted edits in the live deployment tree — reported, NOT verifiable from a checkout](#40-uncommitted-edits-in-the-live-deployment-tree--reported-not-verifiable-from-a-checkout)
- **#37** — [`notifyOwner(msg, PRIORITY.HIGH)` goes nowhere and returns success](#37-notifyownermsg-priorityhigh-goes-nowhere-and-returns-success)
- **#43** — [`getRecentCompleted` sorts by a millisecond timestamp, so same-millisecond tasks come back oldest-first — and it makes the suite flaky](#43-getrecentcompleted-sorts-by-a-millisecond-timestamp-so-same-millisecond-tasks-come-back-oldest-first--and-it-makes-the-suite-flaky)

**P3 — nice to have / uncertain ROI** (7)

- **#36** — [Three enumerating guards each carry their own source-tree walker, and `tests/` subdirectories are enumerated by none of them](#36-three-enumerating-guards-each-carry-their-own-source-tree-walker-and-tests-subdirectories-are-enumerated-by-none-of-them)
- **#21** — [`already_in_channel` warns five times per boot — and the obvious fix is in the wrong place](#21-already_in_channel-warns-five-times-per-boot--and-the-obvious-fix-is-in-the-wrong-place)
- **#29** — [`gmail-unsubscribe` is a declared agent permission that no code implements](#29-gmail-unsubscribe-is-a-declared-agent-permission-that-no-code-implements)
- **#13** — [MCP server wrapper](#13-mcp-server-wrapper)
- **#14** — [Watercooler retro → LinkedIn draft](#14-watercooler-retro--linkedin-draft)
- **#15** — [Task complexity auto-scaling TURNS](#15-task-complexity-auto-scaling-turns)
- **#16** — [Channel-per-task archive mode](#16-channel-per-task-archive-mode)

## P1 — Protects or unblocks the live deployment

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

**What the feature promises.** `detectUndeliveredWork(dir)` (`lib/clone-lifecycle.js:237-330`,
called from `bridge-agent.js:964-981`) refuses to delete a scratch clone that holds
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
**Priority:** P1 | **Effort:** Low | **Status:** open

---

### 4. Replace HTTP polling with Slack Socket Mode (event triggers)
**Source:** tomeraitz/claude-slack-bridge
**Problem:** The bridge still polls: `setInterval(poll, POLL_INTERVAL)` at
`bridge-agent.js:2038`, default `POLL_INTERVAL_MS=30000`. No `@slack/socket-mode`
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

---

### 43. A flattened dispatch loses its fields — the connection for the fix exists, the command does not
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

**Priority:** P1 | **Effort:** Medium | **Status:** open (connection landed 2026-09-14; command not built)

---

## P2 — Real gaps, no risk to the running process

### 4b. Config surface is undocumented and cross-stack infra is unowned — INVENTORY FILED 2026-09-14
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
grep -rn "chat\.postMessage" --include='*.js' . | grep -v node_modules | grep -v '/tests/' | wc -l   # 48
grep -rn "redact(" --include='*.js' . | grep -v node_modules | grep -v '/tests/'                     # 4 call sites, 2 of them post paths
```

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
| **`lib/slack-client.js`** | `channel-map.json` | yes | **none** |
| **`lib/staff-tasks.js`** | `staff-tasks-state.json` | yes | **none** |
| **`lib/watercooler.js`** | `watercooler-state.json` | yes | **none** |

The bottom four are the exact pre-fix shape of #19: a writable file resolved as a
module-scope `const` with no `init`/arg/env override. Their tests confirm it — they
operate on the **real** project file, not a temp copy: `tests/bulletin-board.test.js:12-19`
unlinks the real `agents/shared/bulletin.json`; `tests/slack-client.test.js:532` builds a
`tempDir` the module ignores (its own comment: "The actual CHANNEL_MAP_FILE path is inside
the project"); `tests/staff-tasks.test.js:305` unlinks the real `staffTasks.TASKS_STATE_FILE`.

**Why they do not flake today, and why that is not safety:** each of those four files is
written by exactly **one** test suite, so nothing races it. #19 flaked only because *two*
suites wrote `approval-queue.json` (`approval-queue.test.js` + `security-followup.test.js`).
The defect is latent in the other four — the day a second writing suite appears for any of
them (or two of these suites' production writers run under one test), the identical
scheduling-dependent race returns. Not fixed here to keep the #19 change scoped; filed so
the class is visible.

**Fix:** give each of the four the `init({ file })` override `lib/bridge-state.js` /
`lib/approval-queue.js` already model, and point their suites at `os.tmpdir()`. **The
durable close is an enumerator, not four edits:** a test that walks `lib/` + `bots/`,
flags any module exporting a writer whose target path has no override seam, and fails when
a new one appears — the `tests/no-shell-execution.test.js` pattern applied to
shared-mutable-path. Without it a fifth sibling lands unnoticed.
**Priority:** P2 | **Effort:** Low per module; Medium for the enumerator.
**Risk:** Low — additive overrides; unset option preserves each current path exactly.
**Status:** open (re-verified 2026-09-14)

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
| `lib/task-parser.js:56` | hard **ceiling** on the `TURNS:` header | 100 |
| `lib/task-parser.js:14` `DEFAULT_TURNS` | **default when no header**, a hardcoded literal | 50 |
| `bridge-agent.js:1498` | conversation path's **own** default *and* ceiling | 10 / 20 |

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

### 32. One bulletin timestamp, three renderings — and the path every agent's prompt uses emits none
**Filed 2026-09-14,** from [`docs/CANONICAL-HELPERS.md`](docs/CANONICAL-HELPERS.md) §5.

| Site | Function | Renders | Consumer |
|------|----------|---------|----------|
| `lib/bulletin-board.js:283` | `formatBulletinsForSlack` | `Sep 14, 2:05 PM` | human, in Slack |
| `lib/bulletin-board.js:339-365` | `formatBulletinsForContext` | **nothing** | LLM prompt, **every** agent |
| `lib/agent-context.js:177`, `:277` | security / story-bot context | `Sep 14` | LLM prompt, those two agents |

Regenerate:
```bash
grep -n "b.timestamp" lib/bulletin-board.js lib/agent-context.js
```

`formatBulletinsForContext` is the generic path — every agent's unread-bulletin context
goes through it — and it emits `- [type] agentId: summary` with no time at all. An agent
cannot tell a finding from an hour ago from one from six days ago, cannot order them, and
has no basis for the word "recent" it will nonetheless use. Two agents get a date but no
time because `agent-context.js` builds its own. The human view gets both.

Same field, three answers to "when", one of them "not told". That is information present
in one prompt and absent from another, for the same data — not a formatting preference.

**Fix.** One `formatTimestamp(date, precision)` helper (none exists anywhere in the repo),
called by all three. Emit at least date + time into `formatBulletinsForContext`; a bulletin
list an agent cannot order is worse than no bulletin list.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 34. `DEPLOY_KEY_PATH` is read but undocumented
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

Regenerate every figure in this item:
```bash
# the list itself, and the count
npm run validate 2>&1 | grep -E '^  - '
npm run validate 2>&1 | grep -cE '^  - '
# category split: how many are test suites
npm run validate 2>&1 | grep -E '^  - ' | sed 's/^  - //' | grep -c '^tests/'
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

**The largest file is `bridge-agent.js` at 2227 lines**, and it is the main agent module —
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

**Figures, as commands.**
```bash
npm run validate 2>&1 | grep -cE '^  - '                              # 65 over the limit
npm run validate 2>&1 | grep -E '^  - ' | sed 's/^  - //' | grep -c '^tests/'   # 36 are test suites
```
**36 of 65 — 55% of every violation — are test suites**, and the largest after
`bridge-agent.js` is `tests/llm-runner.test.js` at 1837 lines.

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
`lib/notify-owner.js` at 176 comment / 192 code. Regenerate with the `node -e` snippet in
**#10**.

So the rule currently penalises a module for documenting itself, and the cheapest compliance
path for those sixteen is **to delete comments**. That is the same shape as the test argument
above — a rule whose easiest satisfaction is the behaviour you did not want — and it is a
separate decision from the tests question: counting code lines instead of raw lines would
change 16 source files and 0 test suites, while scoping tests out would change 36 test suites
and 0 source files. They can be decided independently and should not be bundled.

**Not decided here, and not to be decided by an executor:** changing `MAX_LINES` semantics or
its scope changes what every future change is measured against. It is the owner's call.
Whichever way it goes, the change is small — `lib/file-size-gate.js` owns the enumeration and
the rule in one place, and `tests/file-size-gate.test.js` has the negative controls.
**Priority:** P2 | **Effort:** Low (the decision is the work) | **Status:** open

---

### 11. A helpers/utilities map and an owning-doc rule
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
**Problem:** Task results are raw text dumps; no consistent success/failure/files/tests
shape.
**Fix:** define a result schema and render it as a Block Kit card. Note that Phase 3
already extracts test pass/fail counts (`lib/code-review-pipeline.js:348-353`) — build on
that rather than re-parsing.
**Effort:** Medium.
**Priority:** P2 | **Effort:** Medium | **Status:** open

---

### 7. Task timeout escalation tiers
**Problem:** `TASK_TIMEOUT_MS` (default 600000) is a single hard kill with no warning.
No soft-timeout logic exists (`grep -in 'soft\|80%\|will be killed' bridge-agent.js` →
nothing).
**Fix:** at ~80% of the limit, post a "running X min, will be killed in Y" warning to
ops. Don't change the kill itself.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 8. Surface deduplication in status
**Problem:** `processed-tasks.json` dedupes silently; a re-submitted task is skipped with
no feedback to the user. Dedup is real (`CLAUDE.md` "Task Deduplication") but there is no
reply-on-duplicate path.
**Fix:** when a duplicate is detected, post a brief threaded reply: "Already processed
(ID: xxx). Reply `retry` to force." Wire `retry` through the existing dedup check.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 9. `ASK: task history [n]` command
**Problem:** The status command returns the last 5 completed tasks; there is no
`task history N`. `grep -in 'task history' bridge-agent.js lib/task-parser.js` → nothing.
**Fix:** add a built-in `ASK: task history 20` that reads N back from memory with
timestamps and outcomes.
**Effort:** Low.
**Priority:** P2 | **Effort:** Low | **Status:** open

---

### 38. `TASK:` is always executed as the bridge agent, so a scheduled agent's persona and provider never apply to its own task
**Filed 2026-09-14,** from tracing what a scheduled agent job actually runs.

**Verified at HEAD, not inferred.** `agentConfig` is bound **once, at module scope**, to
the bridge agent and never rebound:
```bash
grep -n "agentConfig = getAgent('bridge')" bridge-agent.js          # -> :194
grep -n "processTask(msg, channelId\|processConversation(msg, channelId" bridge-agent.js
```
The second command shows the asymmetry that is the whole item:

| Path | Call | Agent used |
|---|---|---|
| `TASK:` | `processTask(msg, channelId, queuedTask.id)` | **module-scope `agentConfig`** — always `bridge` |
| `ASK:` | `processConversation(msg, channelId, channelAgentConfig)` | the channel's own agent |

So inside `processTask` the `system_prompt`, the `llm_provider`, the `llm_model` and the
`agentId` on the metrics verdict all come from the **bridge** record, whatever channel the
message arrived in and whichever agent the scheduler was firing for.

**Why this is filed rather than fixed.** It is load-bearing in both directions and the
repository already relies on it: `resolveLlmProvider(agentConfig, agentConfig?.id ||
'bridge')` at `bridge-agent.js:498` and `:670` reads the module-scope record deliberately,
and there is a comment saying so. Changing it changes which provider every scheduled task
bills to and which system prompt shapes it — that is a behaviour decision, not a bug fix.

**What it blocks, which is why it is not P3.** Any design in which different agents do
different work. The email-monitor case is the proof and is already fixed *around* this
rather than through it: the scheduler now runs `check-inbox` as deterministic code
(`DETERMINISTIC_TASKS`, `lib/agent-scheduler.js`) precisely because routing it through a
`TASK:` message got the bridge's prompt and no mailbox access. Every future "agent X does
Y on a schedule" hits the same wall, and the deterministic-handler escape hatch does not
scale to work that genuinely needs an LLM with that agent's persona.

**Partly recorded already, nowhere as an item.** A comment at `bridge-agent.js:676-686`
states it, and `docs/WIRING-AND-SEAMS.md` section 3a states it in the specific context of
the email path. Neither is findable by someone designing a new agent.
**Note on the existing citation:** section 3a cites `bridge-agent.js:1704-1711` for the
routing; at HEAD those lines are inside `processConversation`, and the routing is at
`:1768` / `:1792`. Corrected in the same change that files this.

**Fix (not chosen here):** pass the channel's agent into `processTask` as
`processConversation` already does, and decide explicitly whether the prompt, the provider
and the metrics `agentId` each follow the channel or stay on the bridge. They are three
separate decisions and conflating them is how this got missed.
**Priority:** P2 | **Effort:** Medium | **Status:** open

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

### 43. `getRecentCompleted` sorts by a millisecond timestamp, so same-millisecond tasks come back oldest-first — and it makes the suite flaky
**Filed 2026-09-15,** from an unexplained single failure during the /dispatch form work.
Not caused by that change: `git diff origin/main...HEAD --stat` on that branch lists
neither `lib/task-queue.js` nor `tests/task-queue.test.js`.

**Verified at HEAD.** `lib/task-queue.js` `getRecentCompleted` sorts with
`(a, b) => new Date(b.completedAt) - new Date(a.completedAt)`, and `completedAt` is
`new Date().toISOString()` — millisecond resolution. Two tasks completed inside the same
millisecond compare equal, `Array#sort` is stable, so they are returned in INSERTION
order: oldest first, the opposite of the method's documented contract.

**Regenerate the collision rate** (writes only to a temp dir):

```bash
node -e '
const os=require("os"),path=require("path"),fs=require("fs");
const {TaskQueue}=require("./lib/task-queue");
let wrong=0,runs=2000;
for(let i=0;i<runs;i++){
  const f=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"q-")),"q.json");
  const q=new TaskQueue(f);
  q.enqueue({msgTs:"1.1",channelId:"C1",text:"T1",description:"First"});
  q.complete(q.dequeue().id,"Done1");
  q.enqueue({msgTs:"2.2",channelId:"C1",text:"T2",description:"Second"});
  q.complete(q.dequeue().id,"Done2");
  if(q.getRecentCompleted(5)[0].description!=="Second") wrong++;
}
console.log(`oldest-first (wrong) orderings: ${wrong}/${runs}`);
' 2>/dev/null | tail -1
```

Observed **1522/2000** in a tight loop on 2026-09-15 (node v22.22.2, in-container).

**Two consequences, and the second is the reason this is filed rather than shrugged at.**

1. *Live path:* `formatStatusResponse` renders `getRecentCompleted`, so `ASK: what's
   queued` shows the owner the last five tasks in the wrong order whenever two finished
   in the same millisecond. Cosmetic, low.
2. *Verification integrity:* `tests/task-queue.test.js` -> `getRecentCompleted` ->
   "returns completed tasks sorted by completion time (newest first)" fails
   intermittently — observed **once in 25** full `npm test` runs on 2026-09-15. The full
   suite is the gate on every commit in this repo, and a gate that goes red at random
   trains its readers to re-run rather than to read. That is the same class as a green
   suite that skipped: the signal stops meaning what it says.

**The fix is in the source, not the test.** A test asserting the current behaviour would
encode the defect. Either give a completed task a monotonic tiebreaker (an incrementing
sequence, or `process.hrtime.bigint()` alongside `completedAt`) and sort on it, or fall
back to the existing `id` — which already carries `Date.now()` plus a random suffix — when
`completedAt` compares equal. Order within one millisecond must be total, not incidental.
**Priority:** P2 | **Effort:** Low | **Status:** open — not touched by the /dispatch change

---

## P3 — Nice to have / uncertain ROI

### 36. Three enumerating guards each carry their own source-tree walker, and `tests/` subdirectories are enumerated by none of them
**Filed 2026-09-14,** from `docs/CANONICAL-HELPERS.md` section 13.

```bash
grep -rn "function stripComments\|function stripCommentsAndStrings\|function listSourceFiles" tests/*.js
```
`tests/no-shell-execution.test.js`, `tests/timezone-explicit.test.js` and
`tests/test-gate-honesty.test.js` each walk the source tree from disk and each carries its
own copy — roughly 50 lines repeated three times. Marked **EQUIVALENT**, not DIVERGENT: the
two comment scanners differ deliberately (the shell guard blanks string *contents* so prose
naming a banned API does not trip it; the test-gate guard must leave strings intact because
the thing it detects, `'npm test'`, **is** a string literal).

**Why it was not extracted when the third copy landed.** The helper would live under
`tests/helpers/`, and `tests/architecture-tree.test.js` enumerates `tests/*.js`
**non-recursively** (`TRACKED_DIRS` + a flat `readdirSync`). A file three guards depend on
would sit in a directory no guard covers. Extraction therefore means widening that
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
**Filed 2026-09-14.** `joinAgentChannels` (`lib/slack-client.js:385`) calls
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
**Source:** tomeraitz/claude-slack-bridge
**Idea:** expose bridge capabilities (post to Slack, read the queue, query memory) as MCP
tools so Claude Code sessions call them directly.
**Dependency (now explicit):** only meaningful while Claude Code is the executor (see
item 5) and mostly only worth it alongside the mid-task ask capability.
**Effort:** High. **ROI:** unclear.
**Priority:** P3 | **Effort:** High | **Status:** open

---

### 14. Watercooler retro → LinkedIn draft
**Idea:** after the Friday retro, aggregate the week's highlights into a LinkedIn draft
for review.
**Blocked by:** `story-bot` is `status: "planned"` (see item 3); its `draft-weekly-posts`
template exists (`lib/agent-scheduler.js:56`) but the agent is not active. Activate
story-bot first.
**Effort:** Low once story-bot is live.
**Priority:** P3 | **Effort:** Low once story-bot is live | **Status:** open

---

### 15. Task complexity auto-scaling TURNS
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

*Last reconciled 2026-09-14: six closed entries purged (#1, #2, #12, #19, the 2026-09-13
scratch-clone entry, and the retired-#18 references), the two unnumbered items given stable
IDs (#34, #35), eight items filed (#28-#35), item #10's figures corrected against
`npm run validate`, items #3 and #4 re-cited at HEAD, and the revision-trail section
replaced by this note. Index regenerated from the headings.*
