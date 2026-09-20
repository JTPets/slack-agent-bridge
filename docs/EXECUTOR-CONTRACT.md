# Executor contract — slack-agent-bridge

**Read this in full before writing anything.** Every executor dispatched to this
repository is bound by it, so a dispatch can name this file instead of restating it. A
dispatch may add requirements; it cannot waive one here.

Where a rule is already enforced by a test, the test is cited instead of the prose. Run
the test — a rule that fails is worth more than a rule that is read.

---

## 1. The branch gate

- **New branch off `main`.** Confirm the base is current with
  `git fetch origin && git log HEAD..origin/main --oneline` — **empty** means current.
  (`HEAD == origin/main` is the wrong check; it false-flags.) Non-empty means rebase
  before judging anything.
- **Commit and push. Then stop.** Do not merge, do not push to `main`, do not open a
  pull request unless the dispatch asked for one.
- **End by stating the branch name and the commit SHAs.** Review and merge are the
  owner's.

## 2. Before you write code

- **Required reads.** The dispatch names dependency files by full path. Open each in
  full and return **one line per file** saying what it governs. `CLAUDE.md` is read
  automatically; **nothing `CLAUDE.md` references is.** Read what it points at.
- **State findings first, boring interpretation first.** The dull reading — a typo, a
  stale default, a doc never updated — is usually right. Reach for the interesting one
  only after the dull one is ruled out, and say which you ruled out.
- **Everything the dispatch supplied is an unverified lead.** A file:line, a path, a
  host, a container name, a database name, a commit SHA — re-open it at the current
  `HEAD` and report **cited vs. actual**. Line numbers drift; infrastructure names
  predating the Pi→NAS migration drift harder. A lead that no longer resolves is a
  finding to report, not a detail to quietly correct.
- **Check whether the work already exists.** `grep`/`find` before creating any file,
  function or test. If it is already done, say what exists and stop.

## 3. Blast radius

Before changing anything, **enumerate every caller and reader of it**; after changing
it, **confirm each one**. List them explicitly — the list is the deliverable, not a
summary of it.

**A passing suite is not that enumeration.** It tells you the paths that are tested
still behave; it says nothing about the paths that are not. This repo has live proof:
`auto-update.js` has 62 passing tests across `tests/auto-update-restart.test.js`,
`tests/auto-update-defer.test.js` and `tests/update-verifier.test.js`, and the daemon is
never started by anything — the suites inject a dependency bag into `checkForUpdates()`
and never touch `main()` or `validateConfig()`, which is where it fails.

For a defect **class** (not a single site), the definition of done is "the class is
provably closed", which means an **enumerator that fails when a new site appears** —
not a count and not a grep you ran once. The pattern to copy is
`tests/no-shell-execution.test.js`: it enumerates files from disk, strips comments and
string contents, and carries its own meta-tests (`describe('the guard itself detects
what it claims to')`) proving the guard still detects what it claims. Cite the test.

## 4. Proof

**A claim without a commit SHA, a `file:line`, or command output is not done.** Not
"tests pass" — which tests, run where, with what result.

- **A missing runner is a failure, not a pass.** `jest: not found`, a module that will
  not load, `npm ci` never run — that executed zero assertions. If you cannot say which
  assertions ran, none did. Report it as red.
- **Name the suites you ran and where.** Never report a green that includes skipped
  suites without naming the skips.
- **Say "unverified: X"** for anything you could not confirm. Off-box facts (the NAS
  compose file, the host crontab, `.env` contents) are not verifiable from a checkout —
  say so rather than repeating what a dispatch asserted.
- **An artifact you say you produced but that did not reach the reviewer does not
  exist.** The branch is the record.

**Closing a tracked item:** `Closes <ID>` only in a commit whose body **lists the
definition-of-done checks that actually ran** — and only checks you could genuinely run.
If any check could not run, it is `Addresses <ID>` plus an explicit statement of what
remains. A sub-proof is not the item's namesake: "the fix works" is not "the item's
literal claim is met".

## 5. Rules this repo enforces with tests

Run `npm test` (full suite) and `npm run test:smoke` (load/require gate). Both must be
green, and a runner that will not start is **red**, not a hiccup — run `npm ci` first.

`npm run validate` loads `bridge-agent.js` in a subprocess and then runs the
**declaration-driven file-size gate** (`lib/file-size-gate.js`).

**Since 2026-09-15 the size half of it is green, and a red there is yours.** It used to
fail on every over-limit file unconditionally — 65 of them — so it was red on every run
and a new violation could not be told apart from the standing ones without diffing path
lists by hand. Twice in the week of 2026-09-08 nobody did. Every over-limit file now
carries a recorded justification in `lib/validate-exceptions.json`, so the gate fails on:
a file over 300 lines with no entry; an entry whose file is gone or is back under the
limit; an entry with a blank reason; a path declared twice. **If your change puts a file
over the limit, split it or add an entry with a real reason in the same change** — the
cost of an exception is writing down why. The record behind every current entry (path,
length, code-vs-comment, category, disposition, and the seam each deferred split would
cut on) is WORK-TODO **#10**; whether the rule should cover `tests/` at all, and whether
it should count code lines rather than raw lines, are argued and left undecided in **#44**.

Regenerate: `node -e "const g=require('./lib/file-size-gate');const r=g.check();console.log(g.formatReport(r).join('\n'))"`,
or just `npm run validate`. The guard in the suite is `tests/file-size-gate.test.js`.

**The load check is still red without a populated `.env`** — it reports
`Missing required env vars: SLACK_BOT_TOKEN, BRIDGE_CHANNEL_ID, OPS_CHANNEL_ID` and
exits 1. That is a local-environment condition, not a code defect and not your failure;
say so rather than reporting it as a pass or as yours.

| Rule | Guard — cite this, not prose |
|------|------------------------------|
| No shell-string execution anywhere: no `eval`, `exec()`, `execSync()`, `shell: true`, and no importing a shell API from `child_process` at all. Use `spawn()` / `execFileSync()` with an **argv array**. | `tests/no-shell-execution.test.js` |
| Slack-controlled `REPO:`/`BRANCH:` values are **rejected, never sanitised**, and a rejection message is generated from the same character list the pattern uses | `tests/git-identifiers.test.js` (incl. `describe('rejection messages agree with the patterns they enforce')`) |
| Every executable file has `require('dotenv').config()` first; every lib module loads | `tests/smoke.test.js` |
| No unbound identifier in `bridge-agent.js` (catches `X is not defined` that unit tests miss) | `tests/bridge-agent-scope.test.js` |
| The LLM fallback chain is actually wired in, and no circular deps | `tests/integration.test.js` |
| No test invocation can report a pass without assertions having run: an absent runner, a non-zero exit before any assertion, a timeout and a fully skipped suite are each distinguishable from a pass, and every invocation site routes through `lib/test-verdict.js` | `tests/test-gate-honesty.test.js` |
| No `.js` file over 300 lines without a recorded justification in `lib/validate-exceptions.json`; `bridge-agent.js` actually loads | `tests/file-size-gate.test.js`, and `npm run validate` (`lib/validate.js` -> `lib/file-size-gate.js`) |

**On argv arrays and `git`:** an argv array defeats a *shell*, not `git`'s option
parser. A positional value starting with `-` is read as a flag however it arrived.
Validate the value **and** pass `--` before positionals where the subcommand accepts one
(`clone`, `config`, `fetch`, `ls-remote` do; **`git log` does not** — after `git log`,
`--` begins a pathspec, so revisions are shape-asserted instead).

**Other standing rules** (from `CLAUDE.md` — read it, this is a pointer not a
replacement): every caught error is posted to Slack, never a silent failure; temp dirs
are removed in `finally`, not only on the success path; a logic change carries a dated
`LOGIC CHANGE` comment; a bug fix carries a regression test that **fails without the
fix**; no new function ships without a unit test; dependencies go in via
`npm install --save`, never a hand-edited `package.json`.

**A test asserting current-but-wrong behaviour is part of the defect.** Flip it in the
same change as the fix, and say in the commit body that it previously encoded the
defect. Never skip, disable, or delete a test to get green.

## 6. Documentation is part of the change

Any **new file under `lib/`, `bots/`, `scripts/`, `agents/`, or `memory/`**, and any
**new scheduled job, container, env var, or persisted file**, must name the document
that maps it and update that document **in the same change**.

- `CLAUDE.md` — architecture tree, env vars, operational rules. It is the source of
  truth; **if it is wrong, fix it.**
- `docs/WIRING-AND-SEAMS.md` — entry points, what is actually wired, extraction seams.
- `docs/CANONICAL-HELPERS.md` — behaviour implemented in more than one place, with the
  canonical implementation named where one exists. **Before re-deriving shared behaviour
  inline** (a Slack post wrapper, a timestamp format, a day key, a JSON state read,
  a rate-limit test), check this map and call the canonical helper, or say why not.
- `docs/CONFIG-SURFACE-AND-REBUILD.md` — config surface and the rebuild path.
- `README.md` — env var tables and the user-facing summary.
- `WORK-TODO.md` — the backlog. Flat, one `###` heading per item, closed items purged.

**"No document owns this" is a required answer, not permission to skip.** Say it
explicitly so the gap is visible. A trigger that points at a nonexistent document is a
silent no-op.

**Removing a route, module, env var or table** means grepping `docs/` in the same
change. **Any figure written into a document needs the command that regenerates it**, or
it does not go in. An enumerated list of sites is better expressed as a test that fails
when an undeclared site appears.

**A finding is not filed until it is in the repo.** An investigation that produces a
durable map — a write surface, a data flow, who owns a field — updates the owning
document or files a backlog item carrying the evidence. A report that exists only in
Slack is lost. Do not create a new long-lived document unilaterally: propose it and
stop.

## 7. Bridge-specific operational facts

- **Task headers.** `TASK:` and `INSTRUCTIONS:` are required; `REPO:`, `BRANCH:`,
  `TURNS:`, `SKILL:` are optional. A label is recognised **only UPPERCASE at the start
  of a line**; a non-canonical spelling (`repo:`, `Repo:`) **refuses the whole task**
  rather than silently downgrading it (`FIELD_LABELS`, `lib/task-parser.js`).
- **`INSTRUCTIONS:` is required in the enforced sense as of 2026-09-20, not just the
  documented one.** Only `INSTRUCTIONS:` has a multiline capture; every other label
  takes the rest of its own line. A body written under a `TASK:` one-liner with no
  `INSTRUCTIONS:` label used to parse clean and deliver **only that one line** to the
  executor — which is how a 634-byte dispatch reached an agent as 70 bytes on
  2026-09-20, with nothing reported. Unclaimed body text below the header block is now
  recorded in `task.errors` and the task is refused, so the failure is a posted Slack
  message rather than an executor working from a description. Guard:
  `tests/dispatch-body-delivery.test.js`. **If you are composing a dispatch by hand,
  the body goes under `INSTRUCTIONS:`.**
- **`TURNS:` default 50, minimum 5, ceiling 100** (`MIN_TURNS`/`MAX_TURNS`,
  `lib/task-parser.js:81-83` — cited here as `:55-56` until 2026-09-20); out-of-range values are clamped, non-numeric ignored. On
  a max-turns hit the task retries **once** with doubled turns, capped at 100. Dispatch
  bridge work with `TURNS: 100`.
- **You are in a scratch clone, never the live tree.** Each repo task runs in a fresh
  clone under `WORK_DIR` (default `/tmp/bridge-agent`, `lib/config.js:41`). It is not the
  deployed checkout and it is not the NAS. Work that is committed but never pushed is
  preserved and alerted on (`detectUndeliveredWork`, `lib/clone-lifecycle.js`).
  **Whether that preservation survives a container recreation is now contested, and you
  may not rely on either answer.** This repository's copy of the compose file declares
  two mounts and neither covers `/tmp` (`docker-compose.example.yml:75-80`, reproducing
  the live file as captured 2026-09-14), which puts `WORK_DIR` in the container's own
  writable layer — discarded by `docker compose up -d --force-recreate`, which every
  `.env` change requires. An operator `docker inspect jt-agent` on **2026-09-20** reports
  `/tmp/bridge-agent` as a **bind mount** from `/share/CACHEDEV1_DATA/jt-agent/work`,
  which would mean it survives. Both cannot be true of the same file; the off-box one is
  the live deployment and the in-repo one is a stale capture, but neither is verifiable
  from a checkout. See WORK-TODO **#73** and **#25**. So **push**; a preserved clone is a
  last resort whose expiry nobody in this repository can state.
- **You are not sandboxed out of the live tree — you are only asked to stay out of it.**
  The container bind-mounts the NAS deploy directory at `/bridge` **read-write**, and
  that directory *is* the git checkout the bridge runs. Tasks execute through a shell
  running as its owner (`uid 1000:100`), so `/bridge/.env` (every live credential),
  `/bridge/.deploy_key`, `/bridge/docker-compose.yml`, `/bridge/agents/agents.json`,
  `/bridge/CLAUDE.md`, `/bridge/COMMANDMENTS.md` and `/bridge/.git` are all writable
  from a task. Nothing stops you: the rule that you do not touch them is a rule, not a
  wall. **Do not read, write, or `cd` into `/bridge`.**
- **`/repo` is not a sandbox either — `:ro` stops a write and does not stop a read.**
  The *other* mount is the SqTools **production working tree** at `/repo`, mounted
  read-only. That flag is a genuine, kernel-enforced **integrity** boundary and it must
  never be removed. It is **not** a confidentiality boundary: every file under `/repo` is
  readable by anything running in this container, and that tree carries SqTools' own
  `.env` and deploy key (`docs/CONFIG-SURFACE-AND-REBUILD.md` → Step 6 names them as
  out of scope, not as unreachable). **Do not read, write or `cd` into `/repo`.** Never
  propose making it writable, and never describe it as containment without saying which
  half it contains. WORK-TODO **#75**.
  Full write-up, with what is verified and what is owner-supplied:
  `docs/CONFIG-SURFACE-AND-REBUILD.md` → Step 0, consequences 2 and 3, and Step 10.
- **`BRANCH:` is the branch to clone *from*, not one to create.** To create a branch,
  clone `main` and `git checkout -b` in the instructions.
- **Deploys are manual, and merging deploys nothing.** Nothing starts `auto-update.js`.
  A merge to `main` reaches the running bridge only when a human runs
  `docker compose restart jt-agent` on the NAS. **Never report a change as deployed, and
  never verify a fix against the live bridge, on the strength of having pushed it.** See
  "Self-update — DESIGNED AND TESTED, NOT WIRED" in `CLAUDE.md`.
- **That restart kills a running task, and does not even signal the bridge first.**
  `bridge-agent.js` has a `SIGTERM` handler that waits up to 60 s for the running task
  (`gracefulShutdown()`, registered at `:2684`) — **it never runs.** PID 1 is the compose
  `command:`'s `sh`, not `node`, and `sh` does not forward signals to the child it is
  waiting on, so the task is `SIGKILL`ed when Docker's grace period expires. Nothing is
  released, nothing is posted, the scratch clone is never checked for unpushed commits, and
  the message is re-read and re-run on the next poll. **Before asking for a restart, check
  `ASK: what's queued`.** Full evidence and the three candidate fixes: WORK-TODO **#73**.
- **An environment change needs the container recreated, not restarted.**
  `docker compose up -d --force-recreate jt-agent` — a plain `restart` reuses the
  existing container and its baked-in environment, so the new value never lands.
- **`.env` is owner-managed and off-limits.** You cannot read or edit it. Adding an env
  var means: a sensible default in code, a row in `CLAUDE.md` **and** `README.md`, and
  an `ACTION REQUIRED: Add to .env: VAR=value` line in your completion message.
- **`agents/agents.json` is tracked**, so on-box edits are discarded by any pull. A
  per-agent override belongs in `.env` as `LLM_PROVIDER_<AGENTID>`.
- **Never log a token, key or `.env` value.** Name the variable, never the value — in
  logs, in Slack posts, in commit messages, in your report.

## 7.1 The four standing "known blocker" claims — status re-verified at HEAD

Four claims about this repository circulate in dispatch prompts as *"all filed, none fixed"*.
**Three of the four are stale.** They were re-checked on 2026-09-20 at `f13e012`; the table is
the verdict, and each row carries the command that re-establishes it. **Re-run them rather
than trusting this table** — that is the whole point of the table existing. A rule followed
against a condition that no longer holds is not caution, it is a cost with no benefit: the
"no multi-turn bridge work" rule was gating real work on blocker 4, which cannot occur.

| # | The standing claim | Verdict at `f13e012` |
|---|---|---|
| 1 | *No access to the SqTools repo — deliberate* | **TRUE OF `git`, FALSE OF THE FILESYSTEM.** Corrected 2026-09-20; the 2026-09-20 pass checked only the clone path. See below. |
| 2 | *`spawn E2BIG` — the prompt is passed as a command-line argument* | **STALE.** Fixed 2026-09-20. |
| 3 | *`REPO:`/`BRANCH:` are untrusted Slack input reaching a shell string* | **STALE.** Fixed 2026-09-14, and to the class, not to two labels. |
| 4 | *The self-update loop runs every 5 minutes and does not honour the task lock* | **STALE IN BOTH HALVES.** It has honoured the lock since 2026-09-14, and it does not run at all. |

**1 — the claim is one sentence covering three different boundaries, and they have three
different answers.** *"The bridge cannot reach SqTools"* is true of `git`, true of writing,
and **false of reading**. State it as three rows, because a reader who keeps the single
sentence will rely on the wrong one:

| What the bridge can do to SqTools | Verdict | What enforces it |
|---|---|---|
| **Clone** `jtpets/SquareDashboardTool` | **Cannot** | **INCIDENTAL** — no credential exists on the clone path. Not an allowlist. |
| **Write** the SqTools production tree | **Cannot** | **ENFORCED** — the `:ro` mount flag, in the kernel. |
| **Read** the SqTools production tree, *including its `.env` and deploy key* | **CAN** | **Nothing.** `:ro` does not stop a read, and nothing else is in the way. |

**Row 1 — the clone path (unchanged, and still INCIDENTAL).** There is no repository
allowlist on the dispatch path: `isValidRepo` (`lib/git-identifiers.js`) checks the *shape*
`owner/name`, never membership, and the `REPOS` env var is read only by the nightly security
review and by the `/dispatch` form's select (`getConfiguredRepos`, `lib/config.js:198`; the
only consumers are `security-review.js:53` and `lib/dispatch-modal.js:69`). `cloneRepo` clones
over **anonymous HTTPS** (`https://github.com/${repo}.git`, `lib/clone-lifecycle.js:136`) and
configures the deploy key only afterwards, for pushing — so a private repository fails closed
at the clone with no credential to leak, which is what a 2026-09-20 dispatch observed (#57).
**Two consequences worth knowing:** `jtpets/SquareDashboardTool` is in `DEFAULT_REPOS`, so the
`/dispatch` form *offers* it and selecting it produces a 0-second clone failure, not a
refusal; and any *public* repository of valid shape can be cloned today. Regenerate:
`grep -n "DEFAULT_REPOS" lib/config.js` and `grep -rn "getConfiguredRepos" --include=*.js .`

**Rows 2 and 3 — the mount path, which the pass that wrote this section did not check.**
The `jt-agent` container bind-mounts SqTools' **production working tree** at `/repo`,
read-only (`docker-compose.example.yml:80`, reproducing the live file as captured
2026-09-14; `docs/CONFIG-SURFACE-AND-REBUILD.md` Step 0 row "Mount 2" and Step 1 row 3).
`:ro` is an **integrity** boundary and a real one — a mistake or an injected instruction
cannot corrupt SqTools. It is **not a confidentiality boundary**, and nothing else supplies
one: a read of `/repo` is an ordinary read.

**Why that is not merely theoretical for a dispatch.** Dispatched code runs **inside this
container**, in the same mount namespace as `/repo`, with no sandbox of any kind:

- the scratch clone is `path.join(WORK_DIR, 'task-<ts>')` (`bridge-agent.js:646`),
  `WORK_DIR` defaulting to `/tmp/bridge-agent` (`lib/config.js:41`) — a path in the
  container, not a separate machine;
- the agent CLI is an ordinary child process — `spawn(claudeBin, args, { cwd, env })`
  (`lib/llm-runner.js:385`), argv `['-p', …, '--dangerously-skip-permissions']` (`:369-374`),
  reached from `runWithFallback(prompt, { cwd, … })` (`bridge-agent.js:896-897`). `cwd` is a
  working directory, not a root;
- the clone's **own** dependencies are installed *before* the LLM runs —
  `installDependencies(taskDir)` (`bridge-agent.js:660`) → `spawnSync` (`lib/dependency-install.js:161`),
  which for a node repo is `npm ci`. That executes the branch's install scripts in this
  container **before a single test or turn runs**.

So a dispatch against **any** repository of valid shape, not just a bridge dispatch, runs
code that can read `/repo`. Regenerate the execution-location half from a checkout:
`grep -rn "spawn(\|spawnSync(" --include=*.js . | grep -v node_modules | grep -v '^./tests/'`
and `grep -rn "docker\.sock\|dockerode" --include=*.js . | grep -v node_modules` → nothing
(there is no second container and no route to one — `docs/COMMAND-SURFACE.md` §5).

**What is NOT claimed here.** No code in this repository reads `/repo`:
`grep -rnE "['\"\`]/repo(/|['\"\`:])" --include=*.js --include=*.json --include=*.yml . |
grep -v node_modules` returns only test fixtures using `/repo` as a dummy `repoDir` string.
The mount serves no feature this repository can name (`docs/CAPABILITY-AND-ISOLATION-DESIGN.md:306`
and `docs/JESTER-DESIGN.md:174` both already record "nothing reads it"). The exposure is what
a *dispatched executor* — or a dependency's install script — can reach, not something the
bridge does. Filed with the evidence as WORK-TODO **#75**; the remedy is a deployment change
and is the owner's.

**Nothing in the SqTools tree was read to establish this**, and nothing should be: that the
path is readable by the process is the finding; reading a secret to demonstrate it is not.

**2 — the prompt goes over stdin.** `runClaudeAdapter` builds an argv array of flags only
(`lib/llm-runner.js:369-374`) and writes the prompt with `child.stdin.end(promptText)`
(`:408`). **No path passes a prompt in argv:** the claude CLI is spawned from exactly one
place (`grep -rn "claudeBin" --include=*.js . | grep -v node_modules | grep -v tests/` →
`lib/llm-runner.js:351,385`), and the other two adapters are HTTP. The guard is
`tests/llm-runner-prompt-size.test.js`, which spawns for real because a mocked
`child_process` accepts an argv entry of any size.

**3 — and the fix is to the class.** `cloneRepo` (`lib/clone-lifecycle.js:127`) runs
`execFileSync('git', args)` (`:134`) with `--` before the positionals
(`['clone','--depth','1','--branch',branch,'--',url,targetDir]`, `:139`, fallback `:147`),
values rejected — never sanitised — at the boundary and again at the sink. **On the "was it
scoped to two labels?" question: no.** Every `child_process` call site in the repository uses
an argv array; `grep -rnE "spawn\(|spawnSync\(|execFileSync\(|execFile\(" --include=*.js . |
grep -v node_modules | grep -v '^./tests/'` returns 14 sites and none builds a command string.
The other Slack-controlled fields reach no shell either: `SKILL:` is validated as a single
path segment and indexes `skills/<skill>/SKILL.md` (`bridge-agent.js:686`); `TASK:` and
`INSTRUCTIONS:` reach the prompt, which is now stdin; `targetDir` is
`path.join(WORK_DIR, 'task-<msg.ts>')` and is shape-asserted by `assertValidTargetDir`. The
enumerating guard for the class is `tests/no-shell-execution.test.js` — cite it, not a grep.

**4 — stale in both halves, and they are independent.**
*Half one:* `checkForUpdates()` calls `evaluateTaskDeferral()` at `auto-update.js:643`,
**before** the first git mutation (`deps.gitResetHard()` at `:708`); the gate itself
(`:343`) consults `taskLock.releaseIfStale()` (`:346`) and `taskLock.inspect()` (`:356`).
*Half two:* **nothing starts `auto-update.js`** —
`node -e "console.log(Object.keys(require('./package.json').scripts))"` → `[ 'test',
'test:smoke', 'validate' ]`, and
`grep -rn "auto-update" --include=*.js --include=*.json . | grep -v node_modules | grep -v
package-lock | grep -v '^./tests/'` returns only comments, doc prose and the file's own body.
There is no Procfile, systemd unit or supervisor config. So the 5-minute cadence
(`CHECK_INTERVAL_MS`, `auto-update.js:47`, `setInterval` at `:957`) is not running. WORK-TODO
**#17**, which now also records why fixing that alone is not enough (layers 2 and 3).

**What blocker 4 was protecting against is real, and arrives by another route.** A manual
`docker compose restart jt-agent` kills a running task and never signals the bridge — see the
deploy bullets in §7 and WORK-TODO **#73**. Do not read "blocker 4 is stale" as "long
dispatches are now safe"; read it as "the danger has a different name and a different item".

## 8. Forbidden

Suppressing an error or a lint rule instead of root-causing it. A second failure in the
same category without a root cause. Leaving debug code or stray `console.log` in
non-test files. Editing anything on the NAS or inside a running container. Merging your
own work. Claiming a suite you could not run. Pasting a live credential anywhere.

---

## Report template

```
READS: <one line per required-read file — what it governs>
LEADS: <each supplied path/line/host — cited vs. actual at HEAD>
FINDINGS: <boring interpretation first>
BLAST RADIUS: <callers/readers enumerated before; confirmed after>
CHANGES: <file:line per change>
VERIFICATION: <exact commands, where run, actual output; skips named; a missing runner = FAIL>
UNVERIFIED: <anything not confirmed, said plainly>
Closes <ID>  — only with every DoD check listed and actually run
Addresses <ID> — otherwise, plus what remains
BRANCH: <name>   COMMITS: <SHAs>
```
