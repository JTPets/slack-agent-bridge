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

`npm run validate` (loads `bridge-agent.js` in a subprocess; fails any `.js` file over
**300 lines**) is **currently red on `main` for two known reasons**: it needs a populated
`.env` to load the bridge, and **63** files already exceed 300 lines (WORK-TODO **#10**;
regenerate that figure with `npm run validate 2>&1 | grep -cE '^  - '`).
Run it anyway and **compare against the base commit** — new failures are yours, the
standing ones are not. Never report its red as a pass, and never report it as your
failure without that comparison.

| Rule | Guard — cite this, not prose |
|------|------------------------------|
| No shell-string execution anywhere: no `eval`, `exec()`, `execSync()`, `shell: true`, and no importing a shell API from `child_process` at all. Use `spawn()` / `execFileSync()` with an **argv array**. | `tests/no-shell-execution.test.js` |
| Slack-controlled `REPO:`/`BRANCH:` values are **rejected, never sanitised**, and a rejection message is generated from the same character list the pattern uses | `tests/git-identifiers.test.js` (incl. `describe('rejection messages agree with the patterns they enforce')`) |
| Every executable file has `require('dotenv').config()` first; every lib module loads | `tests/smoke.test.js` |
| No unbound identifier in `bridge-agent.js` (catches `X is not defined` that unit tests miss) | `tests/bridge-agent-scope.test.js` |
| The LLM fallback chain is actually wired in, and no circular deps | `tests/integration.test.js` |
| No `.js` file over 300 lines; `bridge-agent.js` actually loads | `npm run validate` (`lib/validate.js`) |

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
- **`TURNS:` default 50, minimum 5, ceiling 100** (`MIN_TURNS`/`MAX_TURNS`,
  `lib/task-parser.js:55-56`); out-of-range values are clamped, non-numeric ignored. On
  a max-turns hit the task retries **once** with doubled turns, capped at 100. Dispatch
  bridge work with `TURNS: 100`.
- **You are in a scratch clone, never the live tree.** Each repo task runs in a fresh
  clone under `WORK_DIR` (default `/tmp/bridge-agent`). It is not the deployed checkout
  and it is not the NAS. Work that is committed but never pushed is preserved and
  alerted on (`detectUndeliveredWork`, `lib/clone-lifecycle.js`) — but preserved in a
  temp directory **in the container's own writable layer**, which a container
  *recreation* (`docker compose up -d --force-recreate`, required for any `.env` change)
  discards. The preservation feature does not survive that. So **push**; a preserved
  clone is a last resort with an expiry you do not control.
- **You are not sandboxed out of the live tree — you are only asked to stay out of it.**
  The container bind-mounts the NAS deploy directory at `/bridge` **read-write**, and
  that directory *is* the git checkout the bridge runs. Tasks execute through a shell
  running as its owner (`uid 1000:100`), so `/bridge/.env` (every live credential),
  `/bridge/.deploy_key`, `/bridge/docker-compose.yml`, `/bridge/agents/agents.json`,
  `/bridge/CLAUDE.md`, `/bridge/COMMANDMENTS.md` and `/bridge/.git` are all writable
  from a task. Nothing stops you: the rule that you do not touch them is a rule, not a
  wall. **Do not read, write, or `cd` into `/bridge`.** The one real boundary in this
  deployment is the *other* mount — SqTools at `/repo`, mounted **read-only**, which is
  why a bridge-side mistake cannot damage production. Never propose making it writable.
  Full write-up, with what is verified and what is owner-supplied:
  `docs/CONFIG-SURFACE-AND-REBUILD.md` → Step 0, consequences 2 and 3.
- **`BRANCH:` is the branch to clone *from*, not one to create.** To create a branch,
  clone `main` and `git checkout -b` in the instructions.
- **Deploys are manual, and merging deploys nothing.** Nothing starts `auto-update.js`.
  A merge to `main` reaches the running bridge only when a human runs
  `docker compose restart jt-agent` on the NAS. **Never report a change as deployed, and
  never verify a fix against the live bridge, on the strength of having pushed it.** See
  "Self-update — DESIGNED AND TESTED, NOT WIRED" in `CLAUDE.md`.
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
