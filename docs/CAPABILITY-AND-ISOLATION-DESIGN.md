# Capability and isolation — what an agent may reach, what it may publish, and who may edit which

> **Working on this?** Read [`EXECUTOR-CONTRACT.md`](EXECUTOR-CONTRACT.md) first.
>
> **A proposal. Nothing here is built.** No field is enforced, no permission is added or
> removed, no command is registered, and no agent's declaration changes in the branch that
> filed this. §2 is a report of what exists; everything after it is a proposal.
>
> This is the part of the design with a security consequence, so the boundary between
> *reported* and *proposed* is marked on every section rather than left to the banner.

---

## 1. Why there are many agents rather than one

**Isolation with visibility.** An agent holds a credential and a remit. What it *publishes*
to a channel is what every other agent can see; the raw source never leaves the agent
holding the credential.

The worked example is already true today and is worth stating because it is the shape
everything below is trying to preserve: the commentary agent can reason about forty-six
messages **because their subjects and senders were published**, and it cannot read the
mailbox because it holds no credential and no path to one. `formatOkMessage` in
`lib/email-check.js:144-150` emits `[category/priority] subject - from` and nothing else —
no body, ever. That is a declassification decision, taken correctly, in one function.

**The design question this document exists to answer is: what makes that decision a
property of the system rather than a property of that one function?**

---

## 2. What exists today — reported, not proposed

### 2.1 The headline finding: `permissions` and `denied` are read by nothing

```bash
grep -rn "permissions\|denied" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
# -> morning-digest.js:225        the STRING 'permission denied' in an error matcher
# -> lib/agent-create.js:73,74    WRITING the two fields into a new definition
# -> lib/llm-runner.js:357        the flag --dangerously-skip-permissions
# -> lib/weekly-critique.js:31    a comment about that flag
```

**No production code reads either field.** They are parsed into the record by
`lib/agent-markdown.js`'s generic frontmatter codec, carried through `loadAgents()` into
every consumer, and consulted by none of them. Nor is either field *validated*: there is no
closed vocabulary of permission names anywhere, so `denid: github` or `file_system` is
accepted in silence.

So the capability layer today is **documentation that looks like configuration**. That is
worse than no capability layer, because a reviewer reading `denied: file-system` on the
jester reasonably concludes something is stopping it.

### 2.2 The declarations, enumerated

Regenerate:

```bash
node -e "
const {loadDefinitions}=require('./lib/agent-markdown');
for(const d of loadDefinitions())
  console.log(d.id.padEnd(14),'| perms:',(d.permissions||[]).join(',')||'-','| denied:',(d.denied||[]).join(',')||'-');"
```

| Agent | permissions | denied |
|---|---|---|
| `bridge` | github, file-system, claude-code | **(none)** |
| `code-bridge` | github, file-system, claude-code | **(none)** |
| `code-sqtools` | github, file-system, claude-code | **(none)** |
| `secretary` | google-calendar, gmail-read, twilio-inbound, twilio-outbound | github-write, file-system-write |
| `security` | github-read | github-write, file-system-write |
| `storefront` | square-catalog-read, square-orders-write, twilio-sms | github, file-system |
| `jester` | twilio-sms, twilio-voice | github, file-system, square-write |
| `social-media` | meta-graph-api, instagram-api, image-generation, square-catalog-read | github-write, file-system-write, payment-processing |
| `email-monitor` | gmail-read, gmail-unsubscribe | gmail-send, gmail-delete, gmail-archive |
| `marketing` | google-business-profile, google-merchant-center, google-analytics, google-ads-readonly, yelp-readonly | github-write, file-system-write, payment-processing |
| `story-bot` | linkedin-personal, linkedin-company | github-write, file-system-write, payment-processing |

**Correcting the lead:** it is not *one* agent that lists what it is denied — **eight of
eleven do**, and the deny-list is the general pattern rather than an exception. The three
that list none are the three code agents, which under a deny list are unrestricted.

### 2.3 Three things the table shows, beyond the headline

**(a) A new capability is granted to everyone by default.** Nobody denies what has not been
invented. The concrete instance is on the table already: `gmail-unsubscribe` is a
permission on `email-monitor` — *"a declared agent permission that no code implements"*
(WORK-TODO **#29**) — and **no agent denies it**. Implement it and add deny-list
enforcement on the same day, and every one of the eleven can click unsubscribe links in the
owner's mailbox except the one agent the capability was written for, which at least
declares it.

**(b) The vocabulary is not even internally consistent.** `bridge` has `github`;
`secretary` denies `github-write`; `storefront` denies `github`. A deny check of the form
`denied.includes(capability)` gives `secretary` a pass for `github` — the broader
capability, denied nowhere in its row. A deny list only works over a vocabulary with a
defined containment relation, and this one has none and validates nothing.

**(c) The one agent whose denial is load-bearing is the one with a documented workaround.**
`jester` denies `file-system`, and `docs/JESTER-DESIGN.md` §4 records that
`lib/weekly-critique.js` calls `runLLM` rather than `runWithFallback` **because** the chain
can land on `claude`, whose adapter spawns a CLI with `--dangerously-skip-permissions`
(`lib/llm-runner.js:357`). The denial did not stop that; a hand-written call-site decision,
`maxTurns: 1` (`lib/weekly-critique.js:54`) and an empty temp `cwd` did. The security
property is real and it is held by three lines of a module, not by the field that names it.

### 2.4 Remit: can the mail integration scope a fetch by label? **No.**

This is the question that decides whether per-remit agents are structural or aspirational,
so it gets an answer rather than a plan.

```bash
grep -n "q = \|q:\|labelIds" lib/integrations/gmail.js     # :345 'in:inbox', :357 q — no labelIds anywhere
grep -rn "users.labels\|labels.list" --include=*.js .      # -> nothing
grep -n "scopes:" lib/integrations/gmail.js                # :96 gmail.readonly
```

- `fetchRecentEmails` builds **`q = 'in:inbox'`** plus an `after:` clause and passes no
  `labelIds` and no caller-supplied query. There is **no parameter** by which a caller
  could narrow it.
- `users.labels.list` is called nowhere, so the system cannot even **enumerate** the labels
  a binding would offer.
- Labels do arrive on fetched messages (`transformEmail` sets `labels: message.labelIds`),
  so any filtering that happens today happens **client-side, after the whole inbox window
  has already been pulled into the process**.

**So per-remit mail agents are aspirational today**, and the gap is small but real: a
`label` option on `fetchRecentEmails` that appends `label:<name>` to `q`, and a
`listLabels()` for the form.

**And the honest part, which no amount of code fixes:** the credential is **shared**.
There is one Google OAuth refresh token and one `gmail.readonly` scope for the whole
system; Google does not issue a per-label credential. **The boundary is therefore the
module, not the authorisation.** An agent scoped to a label cannot see other mail *because
`lib/integrations/gmail.js` did not fetch it*, not because it lacks permission to. That is
a genuine boundary against mistake and against prompt injection — the LLM never receives
what was never fetched — and **not** a boundary against a compromised or malicious module.
Saying otherwise would be the kind of confident overclaim this repository files as its
worst defect class.

### 2.5 What enforces publication shape today: nothing

`lib/redact-secrets.js` is the only thing between an agent's output and a channel, and it
is **credential-shaped by construction**:

```bash
grep -n "SENSITIVE_NAME\|^const PATTERNS" -A 2 lib/redact-secrets.js | head -20
```

`SENSITIVE_NAME` is `/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|_KEY|CREDENTIAL|PRIVATE|REFRESH|AUTH)/i`
over **env var names**, plus a list of token *formats* (`xoxb-`, `sk-ant-`, `AIza`, PEM
blocks, bearer headers). Nothing in it matches an email address, a phone number, a postal
address, an order total or a customer's name. It was written because spawned-LLM stderr
reached `#sqtools-ops` verbatim, and it does that job.

**It is under-applied on top of being narrow** — `docs/CANONICAL-HELPERS.md` §10,
re-measured 2026-09-16: **51 `chat.postMessage` sites, 3 of them scrubbed**, and the ratio
got worse while the row sat open.

So: **no mechanism constrains what an agent publishes about a customer.** The email path
publishes headers only because `formatOkMessage` was written that way.

---

## 3. The three layers — proposed

Only the third is editable from Slack. That is the whole point of separating them.

| Layer | Answers | Changed by | Exists today? |
|---|---|---|---|
| **Remit** | What can this agent **fetch at all**? | a **deploy** — it is code and credentials | **no** (§2.4) |
| **Capability** | What may this agent **reach and emit**? | a **reviewed commit** to the agent's definition | declared, enforced by nothing (§2.1) |
| **Rules** | Within that, **where does it go and what is included**? | the owner, **from Slack**, via a proposal | partly — `rules.json`, in a tracked file that a pull reverts |

### 3.1 Remit — the module is the boundary

Scope the *fetch*, not the *filter*. A fetch scoped to a mailbox label means the agent
cannot see what is not in the label, because the process never held it.

**Recorded plainly, because it is the thing most likely to be overstated later:** the
credential is shared, so remit is enforced by the module that does the fetching. It
protects against mistake, prompt injection and a model asking for more than it should. It
does not protect against a compromised module, and no arrangement available from this
provider would.

### 3.2 Capability — invert it

**Proposal: an agent declares what it may reach and emit, and anything undeclared is
refused.**

| | Deny list (today) | Allow list (proposed) |
|---|---|---|
| A new capability | granted to everyone silently | **reachable by nobody** until a reviewed commit grants it |
| A typo | silently widens (`file_system` denies nothing) | **refused at load** against a closed vocabulary |
| Reviewing an agent | read the denials and infer the rest | read the grants; that is the list |
| An agent with an empty list | unrestricted | **inert** — which is the correct default for something nobody has reviewed |

The last row is the argument in one line. The three code agents deny nothing today; under
an allow list, an agent nobody has thought about can do nothing, which is the same instinct
`lib/agent-create.js` already applies to a *created* definition — `planned`, no schedule, no
watches — and the same instinct behind `default_status: planned` generally.

**Publishing is where information is declassified, so a capability is about emission, not
only access.** A capability names a **shape**, not just a resource:

| Not this | This |
|---|---|
| `gmail-read` | `mail.read:label=vendors` — *fetch* scope |
| — | `mail.publish:headers` — may emit subject and sender. **Never a body** |
| — | `mail.publish:body` — a separate grant, held by nothing today |
| `square-catalog-read` | `catalog.publish:aggregate` — counts and totals |
| — | `customer.publish:record` — an individual's details. A grant that should require a reason written next to it |

**The vocabulary must be closed and enumerated from disk**, with a guard in the pattern of
`tests/no-shell-execution.test.js` and `tests/bulletin-types.test.js`: a capability named in
a definition that is not in the vocabulary **fails the suite**. That is the piece that makes
this configuration rather than documentation, and it is the piece §2.1 shows is missing —
`customer_interaction` was a watched bulletin type that nothing could post, and nothing
failed, until `tests/bulletin-types.test.js` enumerated both sides from disk.

### 3.3 Rules — destination and inclusion, within what capability already permits

Rules are **merchant-scoped data, not code**. Which mail reaches a staff channel and which
reaches the owner differs per merchant and changes without a deploy. They live in the store
(`docs/STATE-AND-MEMORY-DESIGN.md` §2.3, §2.5) with an origin, a status and a supersession
chain, and they are edited from Slack through a proposal (`docs/COMMAND-SURFACE.md` §4).

---

## 4. A rule can never widen a capability, and here is how that is prevented

**The failure this prevents, stated concretely.** A rule that extends what a post includes —
full bodies instead of headers, customer contact details instead of a count — is a
**capability change wearing a routing rule's clothes**. If both live in one editable store,
a filter tweak typed into Slack becomes a disclosure.

**Four mechanisms, and the first is the one that actually holds.**

**(1) A rule cannot express a shape. Structurally.** A rule's grammar has three slots —
*selector* (which items), *destination* (which channel or person), *inclusion* (which of the
fields **the capability already permits**). The inclusion slot is a **subset selector over a
capability-supplied set**, not a list of field names in its own right. There is no sentence
in the grammar that names a field the capability does not already allow, so "include full
bodies" is not a rule that gets rejected — **it is not a rule that can be written**.

This is the same move `lib/dispatch-message.js` makes with `DISPATCH_DEFAULT_TURNS = MAX_TURNS`:
*"a default above its own ceiling is not expressible"*. Not validated against — not
expressible.

**(2) The emission point reads the capability, not the rule.** One publisher applies the
agent's capability to produce the permitted field set, then applies the rule to select from
it. The rule never reaches the raw item. Order matters and is the mechanism: capability
narrows first, rule narrows second, and narrowing twice cannot widen.

**(3) Two stores, two authorities.** Capabilities are in **tracked definitions**, changed
by a reviewed commit. Rules are in the **store**, changed from Slack. The capability store
is not writable from Slack at all — so the question "could a rule edit widen a capability"
has the same answer as "could a Slack message edit a tracked file", which is *no*, and is
the one durability property this repository has already got right for a related reason.

**(4) A guard test, because the first three are claims about code.** An enumerating guard
in the `tests/no-shell-execution.test.js` pattern: every publication site must route through
the single capability-applying publisher, and a rule evaluator that touches a raw item fails
the suite. The repository has this shape four times already
(`tests/test-gate-honesty.test.js`'s disk walk over test-command sites is the closest
analogue) and it is what turns "we designed it that way" into something that stays true.

### 4.1 The shared record makes this load-bearing rather than theoretical

`docs/STATE-AND-MEMORY-DESIGN.md` §4.3 gives every agent a query over what every other
agent published. **Today an over-broad publication is seen by whoever reads that channel
and falls out of a ten-entry stream within days.** Under the shared record it is durable,
queryable, and visible to every agent — so a single over-broad publication is a disclosure
to the whole system, retained.

That is not an argument against the record. It is the reason the capability model has to
land **with** it rather than after it, and the reason `event.visibility` is a column in
that schema rather than an afterthought.

---

## 5. The exploit, named so the reasoning survives

> **An agent holding mail credentials and production data access can exfiltrate customer
> records to an inbox — and mail is attacker-influenced input.**

Written out, because a named exploit is what stops a future change quietly undoing the
reasoning:

1. Anyone can send mail to the shop. The body reaches `lib/integrations/email-categorizer.js`
   and, through it, an LLM prompt. `lib/integrations/email-sanitizer.js` exists for exactly
   this and strips prompt-injection patterns — a mitigation, not a proof.
2. An agent with both a **mail credential** and a **production data path** is one successful
   injection away from being asked to look something up and send it somewhere.
3. Mail *out* is the exfiltration channel, and it is the same credential.

**What stands between that and the customer record today:**

| Control | Real? |
|---|---|
| `gmail.readonly` is the only OAuth scope requested (`lib/integrations/gmail.js:96`) | **Yes — the strongest control here.** A read-only token cannot send. Note its fragility: it is a property of the token the owner generated, and the scope list in `CLAUDE.md` names `gmail.readonly` only |
| No mailbox write exists in the code (`docs/WIRING-AND-SEAMS.md` §3a: *"no mailbox write of any kind"*) | **Yes**, and `tests/email-check.test.js` asserts the module names no Gmail mutation API |
| `gmail-unsubscribe` is declared but unimplemented (#29) | **This is the one to watch.** Implementing it adds an outbound action to the agent that holds the mail credential. It is the exact step this section exists to make expensive |
| `email-sanitizer` | Partial. A pattern stripper, not a boundary |
| `denied: gmail-send` on `email-monitor` | **No. Read by nothing** (§2.1) |
| No agent holds both mail and production data today | **Yes, and it is an accident of what is unbuilt.** `/repo` is read-only and nothing reads it; there is no SqTools client. The separation is real and is not currently *designed* |

**The design rule that follows, and it is the single most important line in this
document:** **no agent holds both a mail credential and a production data path.** Two
agents, one publishing to the record, the other reading what was published. The record is
what makes that affordable — it is the mechanism by which splitting an agent in two costs
nothing in capability.

---

## 6. The privacy consequence — flagged, not decided

**An agent publishing customer inquiries puts customer information into a third-party
workspace with whatever retention that workspace has.**

This is already happening, at three known sites, and is not a consequence of anything
proposed here:

- `lib/email-check.js:144-150` posts subject and sender per flagged message;
- `bots/storefront.js:267-275` posts a delivery quote to `#store-inbox` carrying
  **business name, contact name, phone, email, pickup address and delivery address** —
  the broadest customer publication in the system, and it is not scrubbed by anything;
- `morning-digest.js` DMs the owner a digest containing email senders and subjects, through
  a `sendDM` that does not scrub (`docs/CANONICAL-HELPERS.md` §2).

**An owner decision, sitting beside the existing compliance work**
(`docs/INTEGRATION-SPEC.md`). The questions, stated and not answered:

1. What is the Slack workspace's message retention, and does it match what the shop tells
   customers about their data?
2. Should customer-identifying fields be **referenced** rather than **published** — an order
   id an agent can resolve, instead of a phone number in a channel?
3. Does the shared record (durable, queryable by every agent) change the answer? §4.1 says
   it should be considered before the record exists, not after.

**Not decided here, deliberately.** This document may name the exposure; it may not choose
the retention policy of a business it does not run.

---

## 7. The mail-label binding, as a command — proposed, not built

**A form listing labels from the mailbox, an agent, and a destination, producing a durable
binding.** It is the `label` verb in group C of `docs/COMMAND-SURFACE.md` §2 — blocked on
durable state, and on §2.4's fetch scoping.

### 7.1 Labels are cached; the fetch is live

**Two different latency budgets, and conflating them is how the form breaks.**

- **The form must open inside Slack's acknowledgement window.** `/dispatch` already meets a
  2.5 s `SUBMIT_POST_TIMEOUT_MS` inside a ~3 s ack, and a Google API round trip is not a
  thing to put on that path. So the label list is **served from the store**, refreshed by a
  background job.
- **The scheduled fetch uses a live connection**, always. A cached label list is a picture
  of the mailbox for a form; it is never the authority for what an agent reads.

### 7.2 Three failure modes, designed for rather than discovered

**(a) A deleted or renamed label leaves a binding returning nothing forever — identical to
an empty label.** The worst of the three, because it is the system's signature failure:
absent rendering as empty. `fetchRecentEmails` already refuses to make this mistake for
credentials and API errors; a binding needs the same treatment. **The binding stores the
label's stable id, not its name**, so a rename is survivable; and a scheduled fetch whose
label id **does not exist** returns `label_missing`, not zero messages — a distinct status
that escalates, exactly as `not_configured` and `fetch_failed` do today.

**(b) A cold start with an expired token must still open the form and say so.** Refusing to
open is wrong: the operator learns nothing and has nowhere to read the reason. The form
opens, renders the cached labels **with their cache age**, and carries a visible banner —
*"the mailbox connection is not currently working: `<reason>`; this list was cached
`<when>`."* A binding may still be made; it simply will not fetch until the credential is
repaired, which is a `#sqtools-ops` matter and not a modal's.

**(c) A fetch finding nothing must be distinguishable from one that failed.** Already
solved and to be reused verbatim: `runInboxCheck` returns `ok` with `fetched: 0` versus
`not_configured` / `fetch_failed` / `categorize_failed`, only `ok` posts, and every other
status escalates **and writes no state** so the window is retried rather than lost. The
binding adds one status (`label_missing`) and changes nothing else.

### 7.3 Binding an agent to a label is a privilege grant

**Stated because the form will not look like one.** A later mailbox filter — created in
Gmail, by a person, with no involvement from this system — can widen what lands in that
label. Bind `vendors` to an agent today and route customer mail into `vendors` next month,
and the agent's remit has grown with nobody touching this system, no commit, and no review.

**So the form shows what the label currently holds:** a count and the newest few subjects
and senders, at the moment of binding. That does not prevent the widening — nothing here
can — but it makes the grant legible at the moment it is made, and it puts a dated record
of what the label contained into the binding.

### 7.4 Rules have two homes, and this is the plain statement of it

**Mail filters live in the mailbox. Routing rules live in the store.**

| | Mailbox filter | Routing rule |
|---|---|---|
| Decides | what lands in a label — i.e. **what an agent can see at all** | where it goes and what is included, **after** it has been fetched |
| Lives in | Gmail, owned by Google | the bridge's store |
| Changed by | a person, in Gmail, with no record here | `feedback` → a proposal the owner accepts, with origin and history |
| Visible to this system | **only as the label's contents** | fully |

**The consequence is real and there is no fixing it, so it is written down instead:** half
the routing story is in a system this one cannot read, cannot version, and is not told
about. A binding that stops delivering may be a broken credential, a deleted label, or a
Gmail filter someone changed — and only the first two are diagnosable from here. §7.3's
dated snapshot of the label's contents exists to make the third at least *noticeable*, by
giving a later reader something to compare against.

---

## 8. What this proposal asks for

**Three decisions, in dependency order:**

1. **Invert the capability model** — an allow list over a closed, enumerated vocabulary,
   with the guard test that makes it configuration rather than prose (§3.2). This is the
   prerequisite for `docs/COMMAND-SURFACE.md` §3's refusal clause, which is why WORK-TODO
   **#59** says the two land together or not at all.
2. **Accept the separation rule** — no agent holds both a mail credential and a production
   data path (§5) — **before** anything is built that would make an agent hold both.
3. **Answer the privacy questions in §6**, or record explicitly that they are deferred and
   by whom.

**And one repository-side change that needs no decision:** §2.1's finding should not sit
only in this document. Either the two fields get a reader or the documentation gets a
banner saying they are declarative — the same choice WORK-TODO **#58** poses for the memory
tiers, for the same reason, and `docs/AGENTS.md` → "Permissions Model" is the paragraph
that currently reads as though enforcement exists.
