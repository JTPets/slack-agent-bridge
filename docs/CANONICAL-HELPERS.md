# Canonical helpers — the shared-behaviour map

**Created 2026-09-14.** This repository had no document mapping behaviour that is
implemented in more than one place; WORK-TODO **#11** asked for one and an earlier
dispatch declined to create it unilaterally. It is now authorised.

**This is a map, not a refactor.** Nothing was extracted or moved in the change that
created it. The extraction order is proposed at the end and stops there — a refactor
built on an unreviewed map is how a small task becomes a large diff.

**How to read a row.** Every concept lists each implementation with `file:line`, then
one of three verdicts:

| Verdict | Meaning | Status |
|---------|---------|--------|
| **IDENTICAL** | Same code, modulo a log prefix or a variable name. | Cleanup opportunity. |
| **EQUIVALENT** | Different code, same observable result for every input the callers produce. | Cleanup opportunity. |
| **DIVERGENT** | Different observable result for some real input. | **A defect.** Filed in `WORK-TODO.md`. |

A DIVERGENT row is not tidiness. It means two places in this repository disagree about
what the system does, and at least one of them is wrong.

**Scope of the enumeration.** Every `.js` file in the repo except `node_modules/`,
`.git/`, `tests/` and `coverage/`. Regenerate the file set with:

```bash
find . -name '*.js' -not -path './node_modules/*' -not -path './.git/*' \
       -not -path './tests/*' -not -path './coverage/*' | sort
```

Every per-concept enumeration below carries its own regeneration command. Line numbers
are leads that drift — re-run the command, do not trust the number.

---

## 1. Slack channel posting — **DIVERGENT** (defect: WORK-TODO #30)

```bash
grep -rnE "async function (post|notify|send)[A-Za-z]*\(" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
# The post-site count used below (48 at the time of writing):
grep -rn "chat\.postMessage" --include='*.js' . | grep -v node_modules | grep -v '/tests/' | wc -l
```

| Site | Redacts? | `unfurl_links: false`? | On Slack error |
|------|----------|------------------------|----------------|
| `lib/notify-owner.js:82` `notifyChannel` | **no** | yes | returns `false` |
| `bridge-agent.js:376` `postToOps` | **yes** (`redact(text)`) | yes | logs, swallows |
| `security-review.js:89` `postToOps` | **no** | yes | logs, **rethrows** |
| `auto-update.js:80` `postToOps` | **no** | **no** | logs, swallows |
| `lib/email-check.js:199` (inline) | no | yes | logs, returns `false` |

Three functions named `postToOps`, in three files, with three different behaviours.

**Why this is a defect and not duplication.** `CLAUDE.md` describes
`lib/redact-secrets.js` as the scrubber for "any string bound for Slack or the logs",
and it exists — per its own header — *because spawned-LLM stderr was surfaced verbatim
to `#sqtools-ops`*. It is applied at exactly **two** of the 48 `chat.postMessage` call
sites in the repository (`bridge-agent.js:382`, and `lib/notify-owner.js:196` which
scrubs the error string before `taskFailed` formats it). `security-review.js:89` posts
LLM-generated security findings to `#sqtools-ops` with no scrubbing at all — the exact
content class the scrubber was written for. The rethrow-vs-swallow split is the second
divergence: a Slack outage aborts a security review but not an auto-update cycle.

**Canonical implementation:** `lib/notify-owner.js` `notifyChannel` — but it does not
redact, so adopting it as-is would *remove* protection from `bridge-agent`. The
canonical version has to be `notifyChannel` **with** redaction moved into it.

**Added 2026-09-14 — `lib/slack-socket.js` adds no row here, deliberately.** It reports
every Socket Mode condition (unconfigured, bad token shape, missing dependency, failed
handshake, an outage that has not recovered, a recovery) through
`lib/notify-owner.js` `notifyOps`, which already redacts before delegating to
`notifyChannel`. It defines no `postToOps` of its own and calls `chat.postMessage`
nowhere, so the count above is unchanged — confirm with the second command in this
section. A fourth divergent `postToOps` was the obvious way to write that module and
would have made #30 worse.

## 2. Slack DM — **DIVERGENT** (same defect, WORK-TODO #30)

```bash
grep -rnE "conversations\.open" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
```

| Site | On Slack error | Redacts? |
|------|----------------|----------|
| `security-review.js:72` `sendDM` | **rethrows** | no |
| `morning-digest.js:168` `sendDM` | **rethrows** | no |
| `scripts/watercooler.js:64` `sendDM` | swallows | no |

Three copies of `conversations.open` → `chat.postMessage`, two of which abort their
caller on a Slack hiccup and one of which does not. `morning-digest.js` DMs the owner a
digest containing email senders and subjects; none of the three scrubs.

**Canonical implementation:** none. `lib/notify-owner.js` `notifyOwner(msg, CRITICAL)`
DMs `ownerId` directly (`lib/notify-owner.js:157`) and never opens a conversation, so
it covers the owner case only. A `sendDM(userId, text)` helper does not exist.

## 3. Emoji reactions — **IDENTICAL**

```bash
grep -rnE "reactions\.(add|remove)" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
```

| Site | Notes |
|------|-------|
| `bridge-agent.js:358` `react` / `:368` `unreact` | swallows `already_reacted`; ignores remove errors |
| `lib/heartbeat.js:26` `react` / `:36` `unreact` | byte-identical apart from the `[heartbeat]` log prefix |

**Canonical implementation:** none declared. `lib/heartbeat.js`'s pair is the closer of
the two to a library (it is already in `lib/`), but both are closures over their own
`slack`. Lowest-risk row on this page: identical code, two sites, no behavioural
question to settle.

## 4. "Is this a rate-limit failure?" — **DIVERGENT** (defect: WORK-TODO #31)

```bash
grep -rniE "rate.?limit|\b429\b|quota|bandwidth" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/' | grep -E "test\(|includes\(|status ==="
```

| Site | Shape | Matches "rate limit" bare? |
|------|-------|----------------------------|
| `lib/llm-runner.js:29` `RATE_LIMIT_PATTERNS` | `/rate.?limit.?(exceeded\|error\|reached)/i`, `/too many requests/i`, `/quota exceeded/i`, `/usage limit reached/i`, `/\b429\b/` | **no** — deliberately tightened 2026-03-27 to stop false positives |
| `lib/llm-runner.js:41` `BANDWIDTH_EXHAUSTION_PATTERNS` | `/rate.?limit/i`, `/usage.?limit/i`, `/bandwidth/i`, `/quota/i`, `/\b429\b/`, `/too many/i`, `/try again later/i` | yes — deliberately permissive, and gated on exit 1 **and** output shorter than `MIN_REAL_OUTPUT_LENGTH` (50) |
| `morning-digest.js:209-214` `categorizeFailures` | `includes('rate_limit')`, `includes('rate limit')`, `includes('bandwidth')`, `includes('429')`, `includes('too many requests')` | yes — with **no** exit-code or output-length gate |

The first two disagree on purpose, in one module, with the reason written down. The
third re-derives the *permissive* shape in a different module, for a different job, with
none of the gating — and then tells the owner, in the morning digest, *"Rate limit /
bandwidth: N tasks paused due to rate limits. They will auto-retry."*
(`morning-digest.js:400-405`). Nothing retries a task that `llm-runner` did not classify
as rate-limited. A task whose error text merely contains the words is reported to a
human as self-healing when it is not.

**Canonical implementation:** `lib/llm-runner.js` — but it exports neither predicate
(`isRateLimitError` is module-private; the module exports the `RateLimitError` /
`BandwidthExhaustedError` **classes** instead). `morning-digest.js` reads persisted task
records, not live errors, so it cannot use the classes. Closing this needs an exported
predicate, not just a call swap.

## 5. Date and time formatting for Slack — **DIVERGENT on one pair, EQUIVALENT elsewhere**

```bash
grep -rnE "toLocale(Date|Time)?String|Intl\.DateTimeFormat" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

Every site names `timeZone: 'America/Toronto'` explicitly — that class is closed and
guarded by `tests/timezone-explicit.test.js`. What is *not* guarded is the option set.

**Time-of-day** — `{ hour: 'numeric', minute: '2-digit', hour12: true, timeZone }`,
**IDENTICAL** across six sites: `bridge-agent.js:292`, `:316`, `:1073`, `:1092`,
`lib/agent-context.js:61`, `morning-digest.js:132`.

**Date + time** — **EQUIVALENT**: `lib/bulletin-board.js:283` sets `hour12: true`;
`lib/email-check.js:130` omits it. `en-US` defaults to 12-hour, so the rendered string
is the same; the omission is an inconsistency in a file added the same day as this map,
not a behaviour difference.

**Bulletin timestamps — DIVERGENT** (defect: WORK-TODO #32). One field,
`bulletin.timestamp`, is rendered **three** ways depending on which formatter reads it:

| Site | Function | Renders | Consumer |
|------|----------|---------|----------|
| `lib/bulletin-board.js:283` | `formatBulletinsForSlack` | month, day, hour, minute (`Sep 14, 2:05 PM`) | human, in Slack |
| `lib/bulletin-board.js:339-365` | `formatBulletinsForContext` | **nothing — no timestamp is emitted at all** | LLM prompt, **every** agent |
| `lib/agent-context.js:177` / `:277` | security / story-bot context | month, day only (`Sep 14`) | LLM prompt, those two agents |

The generic path — the one every agent's bulletin context goes through — drops the
timestamp entirely, so an agent reading unread bulletins cannot tell a finding from an
hour ago from one from six days ago, cannot order them, and cannot say "recent" with any
basis. The two special-cased agents get a date but no time. The human view gets both.

Same data, three answers to "when", one of which is "not told". That is not a formatting
preference — it is information present in one prompt and absent from another.

**Canonical implementation:** none. There is no `formatTimestamp` anywhere.

## 6. Day-bucket keys — **DIVERGENT** (defect: WORK-TODO #33)

```bash
grep -rnE "toISOString\(\)\.(slice|split)" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
```

| Site | Key | Correct for its use? |
|------|-----|----------------------|
| `lib/llm-metrics.js:61` `dayKey` | UTC (`toISOString().slice(0,10)`) | **yes** — documented at `lib/llm-metrics.js:53-55` as a deliberate choice: a stable key beats local-midnight alignment for a 7-day ratio |
| `lib/staff-tasks.js:211` | UTC (`toISOString().split('T')[0]`) | **no** |
| `lib/staff-tasks.js:318` | UTC | **no** |
| `lib/staff-tasks.js:423` | UTC | **no** |
| `morning-digest.js:477` | UTC | **no** |

`staff-tasks.js` is about the **store's** day. A UTC key rolls over at 20:00 Toronto
(EDT) / 19:00 (EST), so the evening's staff tasks are filed against tomorrow and
`getDailyTasks()` returns `[]` for them. Demonstrated:

```bash
TZ=America/Toronto node -e "const d=new Date('2026-09-15T02:00:00Z');
  console.log(d.toLocaleString('en-US',{timeZone:'America/Toronto'}), '->', d.toISOString().split('T')[0])"
# 9/14/2026, 10:00:00 PM -> 2026-09-15
```

The same UTC key is right in one module and wrong in four, which is exactly why it needs
a named helper with the zone as an argument rather than a copied idiom.

**Canonical implementation:** `lib/llm-metrics.js` `dayKey` — but it is UTC-only and not
exported for this purpose. A canonical version takes a timezone.

**Not a defect, checked and cleared:** `lib/staff-tasks.js:297` `getCurrentTimeMinutes()`
round-trips through `new Date(now.toLocaleString('en-US', { timeZone: 'America/Toronto' }))`,
which *looks* like the classic process-timezone-dependent idiom. It is not: the parse and
the subsequent `getHours()` both use the process zone, so the two cancel. Verified under
two process zones:

```bash
for z in Europe/Berlin America/New_York; do TZ=$z node -e "
  const n=new Date('2026-09-14T18:00:00Z');
  const t=new Date(n.toLocaleString('en-US',{timeZone:'America/Toronto'}));
  console.log(process.env.TZ, t.getHours()+':'+String(t.getMinutes()).padStart(2,'0'))"; done
# both print 14:00, the correct Toronto wall clock
```
Fragile (it depends on `Date` parsing the `en-US` rendering, and is ambiguous in the DST
fall-back hour) but correct. Recorded so the next reader does not re-open it.

## 7. JSON state file read / write — **EQUIVALENT ×17, one DIVERGENT property**

```bash
grep -rnE "JSON\.parse\(fs\.readFileSync|writeFileSync\(" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

Seventeen modules implement the same load-with-default / write-JSON pair:
`lib/agent-registry.js:32,136` · `lib/approval-queue.js:67,116` ·
`lib/bridge-state.js:76,92,127,147` · `lib/bulletin-board.js:50,93` ·
`lib/email-check.js:74,95` · `lib/llm-metrics.js:73,106` · `lib/memory-tiers.js:77,110` ·
`lib/owner-tasks.js:25,55` · `lib/slack-client.js:38,64` · `lib/staff-tasks.js:119,143` ·
`lib/task-lock.js:178,108` · `lib/task-queue.js:89,115` · `lib/watercooler.js:106,127` ·
`memory/memory-manager.js:35,66` · `auto-update.js:425,458` ·
`lib/integrations/email-categorizer.js:89` (read only) ·
`bridge-agent.js:1818,1836` (inline).

They are **EQUIVALENT** on the happy path and on the corrupt-file path (all return a
default rather than throwing — `tests/bug-fixes.test.js` covers that class).

The **DIVERGENT** property is durability: **not one of the eighteen writes is atomic.**
Every one is a bare `writeFileSync` over the live path, so a crash mid-write leaves a
truncated file, which the next read discards as corrupt — silently losing the queue, the
poll cursors, the processed-task set, or the approval queue. The write-temp-then-`rename`
pattern appears nowhere in the repository:

```bash
grep -rn "renameSync\|fs.rename" --include='*.js' . | grep -v node_modules   # no hits
```

Not filed as a new defect: this is the same surface as WORK-TODO **#24** (four modules
resolving a shared writable path at module scope with no override), and it belongs in
the same extraction. Noted here so the extraction is scoped to include it.

**Canonical implementation:** none. `lib/bridge-state.js` is the closest — it is the
only module whose stated job *is* state persistence — but it owns two specific files,
not the pattern.

## 8. Path resolution to the repo root — **IDENTICAL ×15, plus WORK-TODO #24's group**

```bash
grep -rnE "^const [A-Z_]+(FILE|PATH|DIR)[A-Z_]* = " --include='*.js' . | grep -v node_modules
```

Fifteen modules compute `path.join(__dirname, '..', ...)` at module scope. Four resolve a
**writable** path that way with no injectable override — `lib/approval-queue.js:31`,
`lib/task-queue.js:33`, `lib/task-lock.js:57`, `lib/bridge-state.js:35-36` — which is
WORK-TODO **#24**, already filed (and partly fixed for `approval-queue` by
`fix/approval-queue-path-override-19`). The read-only ones are harmless duplication.

`WORK_DIR`'s default string `/tmp/bridge-agent` is written out at three sites:
`auto-update.js:53`, `lib/task-lock.js:57`, `lib/task-queue.js:33` (plus `lib/config.js`).

**Canonical implementation:** none. No `lib/paths.js` exists.

## 9. Output truncation for Slack — **DIVERGENT** (cosmetic; not filed)

```bash
grep -rnE "function truncate|\.slice\(0, *[0-9]{3,4}\)" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

| Site | Limit | Strategy |
|------|-------|----------|
| `bridge-agent.js:399` `truncate` | 3500 default | head only |
| `lib/notify-owner.js:208` | 3500 | **head 1750 + tail 1750** with a marker |
| `lib/notify-owner.js:257` | 3500 | head + tail |
| `lib/notify-owner.js:203` | 200 | head + `...` |
| `lib/llm-runner.js:118,400` | 2000 | head |
| `lib/llm-runner.js:419,569,574,594,664,667,695` | 500 | head |
| `bots/storefront.js:222` | 2000 | head |
| `security-review.js:385` | 500 | head |

Head-only and head+tail are genuinely different — an error whose signal is in the last
line survives one and not the other — but every caller is a display path and no
downstream code parses the result. Recorded, not filed.

## 10. Secret redaction — canonical exists, **under-applied** (folded into #30)

```bash
grep -rn "redact(" --include='*.js' . | grep -v node_modules | grep -v '/tests/'
```

**Canonical implementation: `lib/redact-secrets.js` `redact()`.** Applied at four sites:
`bridge-agent.js:382` (the ops choke point), `:756` (LLM stderr to the console),
`:921` (failure message), `lib/notify-owner.js:196` (`taskFailed`'s error string).

No site re-implements it — there is no second scrubber — so this is not duplication. It
is **under-application**: 48 `chat.postMessage` sites, 2 scrubbed. Counted under #1/#2.

## 11. Git identifier validation — **canonical, no divergence** ✅

```bash
grep -rnE "isValid[A-Za-z]*\(|assertValid[A-Za-z]*\(" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

**Canonical implementation: `lib/git-identifiers.js`.** Every consumer calls it and none
re-derives a pattern: `lib/task-parser.js:139,161` (boundary),
`lib/clone-lifecycle.js:128-130,241` (sink), `security-review.js:156,252`. Rejection
messages are generated from the same character lists the patterns use, guarded by
`tests/git-identifiers.test.js`.

This row is the template the other ten should look like. It is here as the positive
control: the enumeration is not simply reporting duplication everywhere.

## 12. Git subprocess invocation — **DIVERGENT on safety posture** (not filed; see #17)

```bash
grep -rnE "execFileSync\('git'|spawnSync\('git'|spawn\('git'" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

| Site | API | `--` before positionals | Timeout |
|------|-----|-------------------------|---------|
| `lib/clone-lifecycle.js:134` `git()` | `execFileSync`, argv array | yes, at each call site | 60 s / 15 s |
| `auto-update.js:98` `runGit()` | `spawnSync`, argv array | **no** | 60 s |

Both use argv arrays, so `tests/no-shell-execution.test.js` is satisfied by both and the
command-injection class stays closed. They differ on the *option-parser* half of the rule
(`CLAUDE.md`: "argv arrays defeat a shell, not git's option parser"). `auto-update.js`
takes no Slack-controlled input — its refs are `main` and literal SHAs — so the omission
is not currently exploitable. Not filed as a defect on its own because `auto-update.js`
is dead code (WORK-TODO **#17**, nothing starts it); it becomes one the day #17 lands.

---

## 13. Source scanning in the enumerating guards — **EQUIVALENT** (not filed)

Added 2026-09-14 with `tests/test-gate-honesty.test.js`.

```bash
grep -rn "function stripComments\|function stripCommentsAndStrings\|function listSourceFiles" tests/*.js
```

| Site | What it blanks | Why |
|------|----------------|-----|
| `tests/no-shell-execution.test.js` `stripCommentsAndStrings` | comments, and optionally string CONTENTS | a call-site ban must not trip on prose or on a message naming the banned API |
| `tests/test-gate-honesty.test.js` `stripComments` | comments only; strings left intact | the thing being detected (`'npm test'`) **is** a string literal, so blanking strings would make the scan match nothing |

Three guards now walk the source tree from disk (`tests/no-shell-execution.test.js`,
`tests/timezone-explicit.test.js`, `tests/test-gate-honesty.test.js`) and each carries
its own `listSourceFiles`.

**EQUIVALENT, not DIVERGENT:** the two strippers produce different output by design and
neither is wrong. The duplication is the walk plus the comment-scanner, roughly 50 lines
repeated across three test files.

**Deliberately not extracted here.** A shared helper would live under `tests/helpers/`,
and `tests/architecture-tree.test.js` enumerates `tests/*.js` non-recursively — so the
helper would sit in a directory no guard covers, which is a worse property for a file
that three guards depend on. Extracting it means widening that enumeration first. Filed
as WORK-TODO #36 rather than done as a side effect of a different change.

---

## 14. Agent LLM provider resolution — **DIVERGENT** (defect: WORK-TODO #47 records the consequence)

```bash
grep -rnE "llm_provider|resolveLlmProvider|resolveAgentLlm" --include='*.js' . \
  | grep -v node_modules | grep -v '/tests/'
```

**Canonical implementation: `resolveLlmProvider` in `lib/config.js`** for the provider,
and since 2026-09-15 **`resolveAgentLlm` in `lib/agent-llm-resolver.js`** for the full
answer — provider, model, adapter inputs, and the *source* of each. The resolver calls
`resolveLlmProvider` rather than restating its precedence, so there is one owner of the
value and one owner of the label.

| Site | Reads | Verdict |
|---|---|---|
| `lib/config.js:165` `resolveLlmProvider` | the four-level precedence | **canonical** |
| `lib/agent-llm-resolver.js` `resolveAgentLlm` | calls the above, adds model + adapter inputs + provenance | **canonical (superset)** |
| `bridge-agent.js:552,730,1726` | `resolveLlmProvider(currentAgent, currentAgentId)` | ✅ calls the canonical one — and since 2026-09-15 passes the RESOLVED executing agent at all three sites, not the module-scope bridge record (WORK-TODO #38). Was cited `:516,689,1606`; line numbers are leads |
| `bridge-agent.js:772,1727` | `currentAgent?.llm_model` — inline, no helper | **DIVERGENT, unchanged in kind** — still read inline rather than through `resolveAgentLlm`. What changed 2026-09-15 (WORK-TODO #38) is *which record* is read: both sites now read the RESOLVED executing agent rather than the module-scope bridge record, so the task path no longer reads the wrong agent's model. Centralising the read is still open |
| `lib/watercooler.js:522` | `agent.llm_provider \|\| 'gemini'` | **DIVERGENT, and on the default too.** It bypasses the per-agent `LLM_PROVIDER_<AGENTID>` override entirely — the one mechanism that survives auto-update's `git reset --hard` — and where the canonical chain falls back to `claude`, this falls back to `gemini`. An agent pinned to ollama in `.env` still runs the standup on gemini, and nothing reports the discrepancy |
| `lib/llm-runner.js:998,1001-1003` | `a.llm_provider` for the ollama startup probe | **EQUIVALENT-BY-INTENT, DIVERGENT in fact.** It asks "does any agent use ollama?" to decide whether to probe. An agent switched to ollama purely by `LLM_PROVIDER_<AGENTID>` is invisible to it, so the probe is skipped and the provider is marked unavailable on a boot where an agent is in fact using it. The flag is reporting-only, so the cost is a wrong report, not wrong routing |

**Why this row matters more than its severity suggests.** The per-agent env override
exists *because* live registry edits have been destroyed twice by `git reset --hard`. A
site that reads `agent.llm_provider` directly is not a style inconsistency — it is a site
where the only override mechanism that survives a pull silently does not apply.

**Extraction:** point `lib/watercooler.js:522` and `bridge-agent.js`'s three
`llm_model` reads at `resolveAgentLlm`, and give `validateOllamaOnStartup` the resolved
provider rather than the raw field. Not done in the change that filed this row — it
touches the live standup and the live task path, and belongs in its own change with its
own regression test.

## Proposed extraction order

Ranked by **how much divergence each concept currently carries**, not by how easy the
extraction is. Each is a separate branch. **None of this is done in the branch that
created this map.**

| # | Concept | Sites | Why it is first/last |
|---|---------|-------|----------------------|
| 1 | **Slack posting + DM + redaction** (§1, §2, §10) | 6 wrappers, ~48 post sites | The only row where the divergence has a security consequence: unscrubbed LLM output reaching `#sqtools-ops` is the exact failure `redact-secrets.js` was written for, and it is live in `security-review.js`. Also the largest behavioural spread (rethrow vs swallow, unfurl vs not). |
| 2 | **Rate-limit predicate** (§4) | 3 | Three definitions of one question, and the third actively misinforms the owner in the morning digest. Small, self-contained: export a predicate from `llm-runner`, delete the copy. |
| 3 | **Day-bucket key** (§6) | 5 | One correct use and four wrong ones sharing an idiom. Fixing it changes what "today" means for staff tasks, so it needs its own review and its own regression test. |
| 4 | **Timestamp formatting** (§5) | 9 | Mostly identical; the one divergence (bulletin timestamps) silently changes what an agent can see in its prompt. Cheap once §1 gives `lib/` a natural home for a `formatTimestamp`. |
| 5 | **JSON state read/write + atomic writes** (§7) | 18 | Largest mechanical surface and the most valuable durability fix, but it touches every persisted file in the system at once. Must land **after** WORK-TODO #24 settles path injection, or it fights it. |
| 6 | **Reactions** (§3) | 2 pairs | Byte-identical, zero behavioural question. Deliberately last: it is the one everybody wants to do first because it is easy, and it buys the least. |

**Not proposed for extraction:** §8 (path resolution — belongs to WORK-TODO #24), §9
(truncation — cosmetic), §11 (already canonical), §12 (blocked on WORK-TODO #17).

---

## Keeping this map honest

This document is prose, and prose drifts. The rows most worth making executable, in
order: §10 (a test that fails when a `chat.postMessage` call site is added without
redaction) and §6 (a test that fails when a new `toISOString().split('T')[0]` appears
outside `lib/llm-metrics.js`). The pattern to copy is
`tests/no-shell-execution.test.js` — enumerate from disk, strip comments and strings,
carry meta-tests proving the guard still detects what it claims. Filed as part of
WORK-TODO #30 and #33 respectively.
