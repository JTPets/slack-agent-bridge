# Agent Registry Documentation

This document describes the multi-agent architecture for the Slack Agent Bridge system.

## Overview

The agent registry (`agents/agents.json`) defines multiple specialized agents that can be deployed within the system. Each agent has a specific role, permissions, and configuration.

## How Agents Work

1. **Registry Loading**: On startup, `bridge-agent.js` loads agent configurations from `agents/agents.json`
2. **Fallback Behavior**: If the registry doesn't exist, the system falls back to environment variables
3. **Channel Routing**: Each agent can be assigned to a specific Slack channel
4. **Memory Isolation**: Each agent has its own memory directory for task history

## Agent Configuration Schema

```json
{
  "id": "string",           // Unique identifier (e.g., "bridge", "secretary")
  "name": "string",         // Human-readable name
  "role": "string",         // Description of what this agent does
  "channel": "string|null", // Slack channel ID this agent monitors (null = no channel)
  "permissions": ["array"], // List of allowed capabilities
  "denied": ["array"],      // Explicitly denied capabilities
  "priority": "number",     // Execution priority (1 = highest)
  "max_turns": "number",    // Max LLM turns per task
  "memory_dir": "string",   // Relative path to memory directory
  "status": "string"        // Optional: "planned" means not yet active
}
```

## Current Agents

### Bridge Agent (Active)
- **ID**: `bridge`
- **Channel**: `#claude-bridge` (C0ANZUEJXEJ)
- **Role**: Code execution, GitHub operations, task automation
- **Max Turns**: 50
- **Permissions**: github, file-system, claude-code

### Secretary (Planned)
- **ID**: `secretary`
- **Role**: Calendar accountability, email monitoring, daily briefings, reminders, phone reception, delivery notifications
- **Max Turns**: 20
- **Permissions**: google-calendar, gmail-read, twilio-inbound, twilio-outbound
- **Denied**: github-write, file-system-write

#### Phone Capabilities

The Secretary agent acts as the receptionist for JT Pets with full phone and SMS capabilities. See [SECRETARY-PHONE-DESIGN.md](./SECRETARY-PHONE-DESIGN.md) for complete specification.

**Inbound Calls:**
- IVR menu: store hours, place orders, check delivery, speak with staff
- After-hours routing: voicemail, urgent callback option
- All calls logged to #store-inbox with caller ID, duration, outcome

**Outbound Calls/SMS:**
- Delivery confirmations: "Your order is out for delivery! ETA ~30 min"
- Appointment reminders: 24h and 2h before scheduled appointments
- Vendor follow-ups: Alerts owner when vendor orders are missed
- Customer callbacks: Returns calls for voicemail requests

**Cross-Agent Coordination:**
- Reads delivery tasks from store-ops via bulletin board
- Posts customer confirmations back to bulletin board
- Coordinates delivery timing between store-ops and drivers

### Security Auditor (Planned)
- **ID**: `security`
- **Role**: Daily code review, vulnerability scanning, dependency monitoring
- **Max Turns**: 30
- **Permissions**: github-read
- **Denied**: github-write, file-system-write

### Storefront Agent (Planned)
- **ID**: `storefront`
- **Role**: Customer-facing AI for product inquiries, nutrition consults, order creation
- **Max Turns**: 15
- **Permissions**: square-catalog-read, square-orders-write
- **Denied**: github, file-system

### Social Media Manager (Planned)
- **ID**: `social-media`
- **Role**: Creates, schedules, and manages social media content for JT Pets across Instagram, Facebook, and Meta Business Suite
- **Max Turns**: 30
- **Permissions**: meta-graph-api, instagram-api, image-generation, square-catalog-read
- **Denied**: github-write, file-system-write, payment-processing
- **Integrations**: meta-business-suite, instagram-graph-api, facebook-pages-api, canva-api

#### Content Generation
The Social Media Manager generates various content types:
- **Product Spotlights**: Auto-generate "Product of the Day" from Square catalog
- **Nutrition Tips**: Leverage owner's expertise with 200+ pet food brands
- **Delivery Promotions**: "Free local delivery in Hamilton!" messaging
- **Seasonal Content**: Flea/tick season, winter coat care, holiday pet safety
- **Community Engagement**: Polls, Q&A sessions, customer pet features

#### Platform Strategy
- **Instagram**: Visual product shots, Reels for nutrition tips, Stories for daily specials
- **Facebook**: Community engagement, longer nutrition articles, event promotion
- **Meta Business Suite**: Unified scheduling and cross-platform analytics

#### Approval Workflow
All posts require owner approval before scheduling. The agent posts drafts to #social-media Slack channel. Owner reacts to approve, edit, or reject. Approved posts are scheduled via Meta Graph API.

See [SOCIAL-MEDIA-DESIGN.md](./SOCIAL-MEDIA-DESIGN.md) for complete specification.

### The Jester (Planned)
- **ID**: `jester`
- **Role**: Comedic relief, witty commentary, playful business roasts via SMS/voice
- **Max Turns**: 10
- **Permissions**: twilio-sms, twilio-voice
- **Denied**: github, file-system, square-write

### Email Monitor (Planned)
- **ID**: `email-monitor`
- **Role**: Monitors Gmail for important emails, categorizes by urgency, summarizes for daily digest, handles unsubscribe requests
- **Max Turns**: 20
- **Permissions**: gmail-read, gmail-unsubscribe
- **Denied**: gmail-send, gmail-delete, gmail-archive

#### Email Categories
The Email Monitor categorizes incoming emails:
- **Urgent**: Time-sensitive emails requiring immediate Slack notification
- **Important**: Emails summarized in the daily digest
- **Newsletter**: Marketing emails that can be auto-unsubscribed
- **Spam**: Unwanted emails (ignored)

#### Unsubscribe Capability
The Email Monitor can automatically unsubscribe from newsletters on behalf of the owner:

1. **Manual request**: Owner says "unsubscribe from X" → sender added to `auto_unsubscribe_list`
2. **Category-wide**: Owner says "auto-unsubscribe all newsletters" → enables `newsletter.auto_unsubscribe`
3. **On next email**: Monitor checks `List-Unsubscribe` header or scans body for unsubscribe link
4. **Logging**: Every unsubscribe action is logged to bulletin board for Secretary to report

**Safety Controls:**
- Explicit opt-in only (no bulk unsubscribe without approval)
- Every action logged with timestamp, sender, and method
- Cannot send, delete, or archive emails

See [EMAIL-MONITOR-DESIGN.md](./EMAIL-MONITOR-DESIGN.md) for complete specification.

---

## How agent state is actually held — established from code, 2026-09-15

Written because the summary everyone repeats ("agents are declared in `agents.json`,
some are planned") is true and useless: it does not say *when* a definition is read,
*which* fields the tracked file actually decides, or what a change to one requires
before it takes effect. Those three have different answers, and the difference is
what makes a format migration safe or not.

Every claim below carries the `file:line` it was read from at `69a3922`.

### What loads a definition, and when

`lib/agent-registry.js:31 loadAgents()` is the **only** reader of
`agents/agents.json`. It `fs.readFileSync`s the file on **every call** — there is no
cache, no memoisation, no watcher. Regenerate the caller list:

```bash
grep -rn "require.*agent-registry" --include=*.js . | grep -v node_modules | grep -v '^./tests/'
```

Nothing outside `lib/agent-registry.js` opens the file by path, in `lib/`, in the
entry points, or in `scripts/`. That chokepoint is the single most important fact
here and everything in the migration section rests on it.

So the file is re-readable at runtime — but **what the process does with it is not
re-derived.** Three pieces of startup-only state are computed once and then outlive
any edit:

| Derived at startup, never again | Where | What a registry edit cannot change until restart |
|---|---|---|
| `agentConfig` — the bridge's own record | `bridge-agent.js:215-221` (`getAgent('bridge')`) | `MAX_TURNS` (`:241`), the bridge `system_prompt` (`:581`, `:661`), its provider (`:527`, `:700`) |
| `channelsToPoll` | `bridge-agent.js:2030` calling `buildChannelsToPoll()` (`:1979`, which calls `getActiveAgents()` at `:1991`) | which channels are polled at all |
| `activeJobs` — the cron registrations | `lib/agent-scheduler.js:32`, filled by `startScheduler()` (`:107 loadAgents()`), called at `bridge-agent.js:2126` | every schedule, its cron expression and its refusals |

Everything else reads the registry **per event**, so an edit lands immediately:
`getAgentByChannel()` on every polled message, `lib/bulletin-watcher.js:64` on every
bulletin, `lib/command-router.js:48`, `lib/task-decomposer.js:19`,
`lib/notify-owner.js:14`, `lib/security-followup.js:22`, `lib/watercooler.js:20`,
`lib/agent-surface.js:22`.

**So: "what does a change to a definition require before it takes effect?" has two
answers, not one.** A change to a personality, a system prompt, a watch list, a
permission or a `target_repo` is live on the next event. A change to a channel, a
schedule, `status`, or any bridge-agent field is inert until
`docker compose restart jt-agent` — and merging it reaches the box only when a human
runs that (`CLAUDE.md` → "Self-update — DESIGNED AND TESTED, NOT WIRED"). Nothing
reports the difference, so an edit that appears to do nothing and an edit that is
waiting for a restart look identical.

### Which fields come from the tracked file, and which from the environment

**From `agents/agents.json` (tracked):** `id`, `name`, `role`, `channel`,
`permissions`, `denied`, `priority`, `max_turns`, `memory_dir`, `status`,
`workflow`, `merge_policy`, `deploy_policy`, `branch_prefix`, `production`,
`target_repo`, `llm_provider`, `llm_model`, `schedule`, `watches`, `personality`,
`system_prompt`, `activation_prefix`, `integrations`, `note`, `phone_capabilities`,
`watercooler`.

**From `.env` (untracked, owner-managed, not verifiable from a checkout):**
`LLM_PROVIDER_<AGENTID>` — which **wins over** the registry's `llm_provider`
(`lib/config.js:165`, provenance in `lib/agent-llm-resolver.js`); the global
`LLM_PROVIDER`; and the channel ids `BRIDGE_CHANNEL_ID`, `OPS_CHANNEL_ID`,
`STORE_TASKS_CHANNEL_ID`.

**The finding in that split:** the bridge agent's polled channel does **not** come
from its registry record. `buildChannelsToPoll()` pushes `BRIDGE_CHANNEL`
(`bridge-agent.js:1982-1986`), which is `config.BRIDGE_CHANNEL` = the
`BRIDGE_CHANNEL_ID` env var (`lib/config.js:20`). The bridge record's
`"channel": "C0ANZUEJXEJ"` is read only by `getAgentByChannel()` and by
`joinableChannels()`. If the two ever disagree the bridge **joins both and polls
one**, and nothing compares them. Whether they agree on the NAS is
**unverified — `.env` is off-limits from a checkout.**

### Where a running agent's state lives other than in the file it was declared in

Six durable places and four in-process ones. This is the list a format migration has
to leave undisturbed.

| Store | Owner | Keyed by | Tracked? |
|---|---|---|---|
| `agents/shared/channel-map.json` | `lib/slack-client.js:36/58` | channel **name** → id | gitignored |
| `.bridge-agent-state.json` | `lib/bridge-state.js` | channel **id** → poll cursor | gitignored |
| `agents/shared/processed-tasks.json` | `lib/bridge-state.js` | message `ts` | gitignored |
| `agents/<id>/memory/*.json` | `memory/memory-manager.js`, `lib/memory-tiers.js` | agent **id** | gitignored except seeds |
| `agents/shared/bulletin.json` | `lib/bulletin-board.js` | agent **id** (`agentId`, `read_by`) | gitignored |
| `.env` | owner | var name | untracked |

In-process only, lost on restart: `agentConfig` (`bridge-agent.js:215`),
`channelsToPoll` (`:291`), `activeJobs` (`lib/agent-scheduler.js:32`),
`lastTriggerTimes` (`lib/bulletin-watcher.js:24`).

**`channel-map.json` is the one that matters and the one that is not doing its
job.** It is a channel-name → id cache, and it is written **only** by
`ensureChannel()` (`lib/slack-client.js:333/352/363`), which is reached only from
`activateAgent()` and the `ASK: create channel` command. The startup join path does
not consult it: `joinAgentChannels()` (`:388`) takes ids straight from the registry
records. So the durable resolution cache exists, is gitignored, is the right shape —
and the boot path has never used it.

### If definitions move to a new format, do the running agents migrate, run in parallel, or break?

**They migrate, in place, with no parallel period** — because `loadAgents()` is a
real chokepoint. Ten non-test modules consume agent definitions and every one of
them goes through it. Change what `loadAgents()` reads, keep the record shape it
returns, and no other module has to know.

One thing genuinely would break a running agent, and it is the reason this section
was written before any code was moved:

> **The channel IDs cannot be re-derived from a checkout.** Nothing in this
> repository maps `C0AP42BT4MR` to a channel name — that needs a Slack API call. A
> migration that replaced `channel: <id>` with `channel_name: <name>` and resolved
> the name at startup would depend on names guessed from agent ids. A wrong guess
> does not fail loudly: `findChannelByName` returns null, the agent's channel
> resolves to nothing, and the bridge **stops polling a channel that worked
> yesterday**.

The avoidance is to never resolve what is already known. At migration time the six
live ids are **seeded into the local state store**, keyed by the channel name the
new definition declares. First boot after the migration is a cache hit for every
existing agent; no Slack lookup runs for an agent that already worked, so no guess
can be wrong for one. Name resolution is exercised only by an agent that has no id
today — which is exactly the four that are already reaching nobody.

**Reversibility: yes, by `git revert` alone, with no manual step and no data loss.**
The channel ids are in git history whatever happens to the working tree, so
reverting the migration commit restores `agents/agents.json` with its ids intact and
`loadAgents()` reads it again. The local state file the migration writes is
gitignored and additive — code from before the migration never looks at it, so a
revert leaves it sitting harmlessly on disk. A channel id is not a credential; it is
already public in this repository's history, so recording one in a commit body costs
nothing.

**Verdict: safe to proceed.** The condition is the seeding step, not the format.

---

## The bulletin stream — what every agent can see, established 2026-09-15

The bulletin board is the substrate for agents reacting to each other's output
rather than only to the owner. This section is the report of what it actually
carries; `lib/bulletin-board.js` is the code and `tests/bulletin-types.test.js` is
the guard.

### What is published today

Five call sites. Regenerate the list rather than trusting this table:

```bash
grep -rn "postBulletin(" --include=*.js . | grep -v node_modules | grep -v '^./tests/' | grep -v '^./lib/bulletin-board.js'
```

| Posted by | Type | When |
|---|---|---|
| `bridge-agent.js` | `task_completed` | every task that finishes |
| `security-review.js` | `security_finding` | the nightly audit finds something |
| `morning-digest.js` (as `secretary`) | `milestone` | the digest runs |
| `lib/watercooler.js` (as `watercooler`) | `milestone` | a standup completes |
| `lib/integrations/email-categorizer.js` | **the category name** | a category whose action is `push_to_secretary` matches |

The last row is the one to watch. It types the bulletin by the *category name*, and
category names come from `agents/email-monitor/memory/rules.json`, which is
operator-editable, while valid types come from `BULLETIN_TYPES`. Today only
`vendor_deal` carries `push_to_secretary` and it happens to be a valid type, so
nothing is being dropped. Give `urgent` that action — which is exactly what the file
is for — and every one of its bulletins is rejected, because `postBulletin` returns
`{ success: false }` rather than throwing and the call site ignored the result. The
call site now logs the rejection, and the guard test covers the literal call sites.

### Who watches, and what a watcher actually receives

`watches.bulletin_types` in an agent's definition. `lib/bulletin-watcher.js` fans out
to matching agents — skipping the poster, skipping agents with no channel, and
rate-limited to one trigger per agent per five minutes.

**A watcher receives a notification, not the record.** It is an `ASK:` message
carrying `[type] from agentId: <summary truncated to 150 characters>`, posted into
the watcher's channel. The bulletin's payload beyond that one summary line, its id,
and its timestamp are all absent from the notification. To see the record the agent
has to read the stream.

**`customer_interaction` was a dead watch** — secretary and marketing both declared
it and it is not in `BULLETIN_TYPES`, so `postBulletin` would reject it and those
watches could never have fired. Corrected to `customer_insight`, and
`tests/bulletin-types.test.js` now fails on any watch for a type nothing can post.

**`milestone` currently reaches no watcher.** Only story-bot watches it, and
story-bot is not activated, so `processBulletin` skips it for want of a channel.
This is not a regression from the 2026-09-15 activation change: before it, the
notification was posted into a channel the poll loop did not read, so it was never
executed either. The difference is that it is now quiet rather than accumulating.

### The stream itself, which every active agent sees

Distinct from watching, and **not opt-in**. `processConversation` injects
`formatBulletinsForContext(agentId, 10)` into the prompt of whichever agent owns the
channel, on every `ASK:`. Since every active agent's channel is polled (see the one
declaration rule above), every active agent sees the stream. `ASK: bulletins` renders
it for a human in any polled channel, through the same module.

**What it carries:** the bulletin type, which agent posted it, when (America/Toronto,
named explicitly), and **every scalar field of the payload**, each value capped at
200 characters so one long field cannot crowd out the rest.

Before 2026-09-15 it carried one line of `description || title || message ||
JSON.stringify(data).slice(0,150)`. Every bulletin `pushToSecretary` posts has none
of those three keys — its payload is `from`, `subject`, `isTrustedVendor` — so a
supplier email reached other agents as a truncated JSON fragment. An agent cannot
notice a supplier shortage in a string cut at 150 characters.

**What it does not carry:**

- anything beyond the newest 10, and nothing at all past the 7-day retention
  (`cleanupOldBulletins`). It is a recent-events feed, not a log;
- the bulletin **id**, so an agent cannot refer to one or mark it read;
- any **link back** to the work that produced it — no Slack permalink, no thread, no
  task id. An agent can see that a task completed; it cannot open it;
- **no reaction logic.** Nothing here makes an agent act on what it reads. That is
  deliberate and out of scope: the stream existing and being worth reading is the
  deliverable.

`unreadBy` is applied, but **nothing in production calls `markRead`** —

```bash
grep -rn "markRead" --include=*.js . | grep -v node_modules | grep -v tests
```

— so in practice every agent sees the newest ten on every `ASK`, including ones it
has seen. That is deliberate for now: an agent has no memory of a bulletin between
conversations, so filtering seen ones would make the stream emptier, not cleaner.


## Adding a New Agent

1. **Define the agent** in `agents/agents.json`:
   ```json
   {
     "id": "new-agent",
     "name": "New Agent Name",
     "role": "What this agent does",
     "channel": null,
     "permissions": ["required-permissions"],
     "denied": ["forbidden-actions"],
     "priority": 2,
     "max_turns": 25,
     "memory_dir": "agents/new-agent/memory",
     "status": "planned"
   }
   ```

2. **Create the memory directory**:
   ```bash
   mkdir -p agents/new-agent/memory
   ```

3. **Implement agent-specific logic** (if needed):
   - Add handler in the appropriate entry point
   - Configure channel routing if the agent monitors a Slack channel

4. **Remove `status: "planned"`** when the agent is ready for production

## Permissions Model

Permissions are declarative and enforced at the agent level:

### Permission Types
- `github` - Full GitHub access (read/write)
- `github-read` - Read-only GitHub access
- `github-write` - Write access to GitHub
- `file-system` - Full file system access
- `file-system-write` - Write access to file system
- `claude-code` - Can execute Claude Code CLI
- `google-calendar` - Google Calendar API access
- `gmail-read` - Read-only Gmail access
- `gmail-send` - Send emails via Gmail
- `gmail-delete` - Delete emails from Gmail
- `gmail-archive` - Archive emails in Gmail
- `gmail-unsubscribe` - Click unsubscribe links in emails
- `square-catalog-read` - Read Square catalog data
- `square-orders-write` - Create Square orders
- `meta-graph-api` - Meta Graph API for Facebook/Instagram posting
- `instagram-api` - Instagram Graph API access
- `image-generation` - Generate images via AI (Claude, DALL-E, etc.)
- `payment-processing` - Process payments (highly restricted)

### Denied Permissions
The `denied` array explicitly blocks permissions. This is useful for:
- Preventing escalation (e.g., secretary can't modify code)
- Creating read-only agents
- Limiting blast radius of automated agents

## Memory Tiers

Each agent maintains a tiered memory system with different retention policies:

```
agents/
├── bridge/
│   └── memory/
│       ├── context.json      # Permanent: owner info, preferences
│       ├── working.json      # Session: current task state (cleared after each task)
│       ├── short-term.json   # 24-72 hour TTL: today's events, reminders, recent conversations
│       ├── long-term.json    # Weeks/months: learned patterns, recurring events, discovered preferences
│       └── archive.json      # Decayed long-term items (kept for reference, not injected into prompts)
├── secretary/
│   └── memory/
└── security/
    └── memory/
```

### Memory Entry Structure

Each memory entry contains:

```json
{
  "id": "unique-identifier",
  "content": "string or object",
  "created": "2026-03-26T12:00:00.000Z",
  "lastAccessed": "2026-03-26T12:00:00.000Z",
  "ttl": 172800000,
  "accessCount": 1,
  "source": "task|calendar|user|system"
}
```

### Tier Descriptions

| Tier | File | TTL | Description |
|------|------|-----|-------------|
| Permanent | context.json | Never expires | Owner info, timezone, user preferences |
| Working | working.json | Cleared after task | Current task state, intermediate results |
| Short-term | short-term.json | 24-72 hours (default 48h) | Today's events, active reminders, recent conversations |
| Long-term | long-term.json | 30-day decay | Learned patterns, recurring events, discovered preferences |
| Archive | archive.json | Never deleted | Decayed long-term items preserved for reference |

### Automatic Behaviors

#### TTL Expiry
Short-term entries expire based on their TTL. Expired entries are purged during cleanup.

#### Auto-Promotion
When a short-term entry is re-added 3 or more times, it's automatically promoted to long-term memory. This captures patterns like recurring tasks or frequently accessed information.

#### Decay and Archival
Long-term entries that haven't been accessed in 30 days are moved to the archive. Archived items are preserved for reference but not injected into prompts.

#### Startup Cleanup
On bridge-agent startup:
1. Run cleanup for all agents (purge expired, archive decayed)
2. Run auto-promotion (promote frequently accessed items)
3. Log cleanup summary

### Memory API

Functions in `memory/memory-manager.js`:

| Function | Description |
|----------|-------------|
| `buildAgentContext(agentId)` | Returns combined context string for prompts |
| `addAgentWorkingMemory(agentId, entry)` | Add to working memory |
| `clearAgentWorkingMemory(agentId)` | Clear working memory after task |
| `addAgentShortTerm(agentId, entry, ttlHours)` | Add to short-term with TTL |
| `promoteAgentMemory(agentId, entryId)` | Promote from short-term to long-term |
| `setAgentPermanent(agentId, key, value)` | Set permanent context |
| `cleanupAgentMemory(agentId)` | Run cleanup for agent |
| `autoPromoteAgentMemory(agentId)` | Run auto-promotion for agent |
| `startupMemoryCleanup(agentIds)` | Run cleanup for all agents |
| `migrateAgentMemory(agentId)` | Migrate legacy memory files |

### Legacy Compatibility

The tiered memory system maintains backward compatibility:
- Legacy `memory/tasks.json`, `history.json`, `context.json` continue to work
- On first run, legacy files are migrated to the new structure
- Legacy functions (`addTask`, `completeTask`, etc.) remain available
- Migration only runs once per agent (tracked by `.migrated` marker)

## Channel Routing

When a message arrives in a Slack channel, the system:
1. Looks up which agent handles that channel via `getAgentByChannel()`
2. Applies that agent's configuration (max_turns, permissions)
3. Routes to the agent's memory directory

If no agent is configured for a channel, the message is ignored.

### Which channels exist, which are joined, which are polled — as a command

Do not read a count from this file; it goes stale and nothing fails when it does.

```bash
node scripts/agent-surface.js           # the table
node scripts/agent-surface.js --json    # the same rows, machine-readable
```

The guard is `tests/agent-surface.test.js`: it fails when an agent's output stops
reaching anything. **LOGIC CHANGE 2026-09-15: these are now three consequences of ONE declaration, not
three facts maintained separately.** They used to have three different fixes, which
is how they drifted: every declared channel was joined, only active agents' channels
were polled, and the scheduler checked neither. story-bot — `planned`, with a real
channel and a weekly job — was therefore joined to a channel the poll loop never
read, and its `draft-weekly-posts` job posted a `TASK:` message every Friday that
nothing executed.

The rule is `activeChannels()` in `lib/agent-surface.js`, and there is exactly one
statement of it: `buildChannelsToPoll()` in `bridge-agent.js` delegates to it, the
startup join path calls it, and `lib/agent-scheduler.js` refuses any schedule it
excludes. `tests/agent-surface.test.js` asserts the delegation and that the join set
and the poll set are the same set.

- **Resolved** — the agent's declared `channel_name` has an id in the local channel
  map (`agents/shared/channel-map.json`). Resolution happens once, at startup, for
  an active agent whose name has never resolved, and is cached durably — so an
  already-known channel costs no API call. **Nothing creates a channel.**
- **Joined** — the bridge calls `conversations.join` on it at startup.
- **Polled** — `poll()` reads it, so a `TASK:`/`ASK:` message there is executed.
- **Scheduled** — the agent's cron job is registered.

An agent that is not activated in this workspace, or whose declared channel has not
resolved, gets **none** of them — and the reason is posted to `#sqtools-ops` at
startup rather than skipped in silence. Three or none is the whole rule; one of them
arriving alone is what produced work nobody collected.

### On the repeated `already_in_channel` warnings

**There are none, and there never were** — cited versus actual at `69a3922`.
`joinAgentChannels()` (`lib/slack-client.js`) treats `already_in_channel` as a
*success*: it increments `joined` and `continue`s, logging nothing. Grep it:

```bash
grep -rn "already_in_channel" --include=*.js . | grep -v node_modules
```

Every hit is a success branch or a test of one. So the change above removes no
warning, because none exists to remove. What *does* repeat on every start is the
single info line `[bridge-agent] Joined N/N agent channels`, and re-joining on every
start is deliberate: a channel can be recreated while the bot is offline, and
`conversations.join` on a channel it is already in is a no-op. What the change does
reduce is the *size* of that set — planned agents' channels are no longer joined —
and the number of `conversations.list` lookups, which is now zero for any channel
already in the local map. If a warning really is appearing on the box it has a
different cause and is not this code path; it would need the actual log line to
diagnose, which is not readable from a checkout.

### Channels that would need to be created — PROPOSED, not created

**Nothing in this repository creates a Slack channel, and no dispatch should.** The
four agents below carry a schedule or a role and have `"channel": null`, so the
scheduler skips them silently — unlike an unknown task name, a missing channel is not
even reported at startup. Creating a channel is an owner action
(`ASK: create channel #name`, which needs `channels:manage`); this is the proposal.

| Agent | Status | Declared schedule | Proposed channel | What creating it would change |
|---|---|---|---|---|
| `jester` | **active** | `0 18 * * 5` weekly-critique | `#jester-agent` | The only **active** agent that cannot be addressed at all — its declared `channel_name` has never resolved, so no channel, no registered job, no route. Its `weekly-critique` template exists and nothing can reach it. Since 2026-09-15 this is reported to `#sqtools-ops` at every startup instead of being a silent skip. Creating the channel resolves it on the next restart and registers the job. |
| `social-media` | planned | `0 9 * * 1,3,5` content-calendar | `#social-media-agent` | Registers the job. It would still need `status: "planned"` removed for the channel to be **polled**, or the posted `TASK:` message reaches no executor — see #3. |
| `marketing` | planned | `0 6 * * 1` weekly-analytics | `#marketing-agent` | Same as above. |
| `storefront` | planned | none | `#storefront-agent` | Nothing scheduled; the agent is served by `bots/storefront.js` over HTTP, not by a channel. Lowest value of the four — listed for completeness, not recommended. |

**Do not create all four to make the table tidy.** Each new channel is a channel the
bot joins on every boot and a place output can accumulate unread. `jester` is the one
with a concrete defect behind it; the other three are gated on the `planned` decision
in WORK-TODO #3 and should follow it, not precede it.

**`story-bot` is NOT in this table** — its channel already exists and its id is in
the local channel map. What it lacks is an *activation*: as of 2026-09-15 a
`planned` agent is not joined, not polled and not scheduled, so story-bot produces
nothing rather than producing work nobody collected. Activating it is
`lib/agent-activation.js`, not a channel to create.

## API Reference

The `lib/agent-registry.js` module exports:

| Function | Description |
|----------|-------------|
| `loadAgents()` | Load all agents from agents.json |
| `getAgent(id)` | Get agent config by ID |
| `getAgentByChannel(channelId)` | Get agent for a Slack channel |
| `getActiveAgents()` | Get all non-planned agents |
| `registryExists()` | Check if agents.json exists |
| `getAgentMemoryDir(id)` | Get absolute path to agent's memory dir |

## Backward Compatibility

The registry system maintains backward compatibility:
- If `agents/agents.json` doesn't exist, env vars are used
- The bridge agent config overlays (not replaces) env var settings
- All existing task message formats continue to work

## Production Safety

Agents can be configured with different workflow modes based on their production status.

### Workflow Configuration Fields

| Field | Values | Description |
|-------|--------|-------------|
| `workflow` | `direct-to-main`, `branch-and-pr` | How changes are committed |
| `merge_policy` | `auto`, `owner-approval-required` | Who can merge PRs |
| `deploy_policy` | `auto-update`, `manual` | How deploys happen. **Both values mean manual today** — see the warning under "Non-Production Repo Rules". No code reads this field (`grep -rn "deploy_policy" --include=*.js .` returns only test fixtures); it is declarative. |
| `branch_prefix` | `agent/` | Prefix for feature branches |
| `production` | `true`, `false` | Whether repo is production |
| `target_repo` | `org/repo` | Target repo for agent |

### Production Repo Rules

Agents with `production: true` MUST use feature branches and never push to main:

1. **Branch Creation**: Agent creates a feature branch using `branch_prefix` (e.g., `agent/fix-reorder-bug`)
2. **Commit and Push**: Agent commits changes and pushes the feature branch
3. **PR Creation**: Agent creates a pull request using `gh pr create`
4. **Notification**: Agent posts PR link to #sqtools-ops and DMs owner
5. **Review**: Owner reviews the PR manually
6. **Merge**: Owner merges after approval
7. **Deploy**: Owner deploys manually. **The command below is stale and unverified** —
   it names the Raspberry Pi, which is dead; SqTools now runs on the QNAP NAS. It is
   left rather than guessed at because SqTools' deploy path is owned by
   `jtpets/SquareDashboardTool`, not by this repo, and cannot be verified from here.
   Confirm against that repo before following it.
   ```bash
   # STALE — Pi-era. Verify before use.
   git pull origin main && npm test && pm2 restart server
   ```

### Non-Production Repo Rules

Agents with `production: false` can push directly to main:

1. **Direct Commit**: Agent commits changes to main
2. **Push**: Agent pushes to main
3. **Deploy**: **manual.** The owner runs `docker compose restart jt-agent` on the NAS.

> ⚠️ **Agents: do not assume your pushed code is running.** This step used to read
> "Auto-Deploy: Auto-updater detects changes and restarts PM2 process". Both halves were
> false: there is no PM2 on this host, and `auto-update.js` is never started, so nothing
> detects your push. A merge to `main` reaches the running bridge only when a human
> restarts the container. Never report a change as deployed, and never verify a fix
> against the live bridge's behaviour, on the strength of having pushed it.
> Verified 2026-09-14; tracked as WORK-TODO item #17.

### Prompt Override for Production Repos

When a task targets a repo matching an agent with `production: true`, the bridge-agent automatically prepends the following instruction to the prompt:

> This is a PRODUCTION repo. You MUST create a feature branch, commit there, push the branch, and create a pull request using `gh pr create`. Do NOT push to main. Do NOT merge.

This ensures Claude Code follows the safe workflow even if the task instructions don't explicitly mention it

## Activation Checklists

The `agents/activation-checklists.json` file tracks owner action items required to activate each agent. This provides visibility into what setup tasks remain before an agent can be deployed.

### Checklist Structure

```json
{
  "bridge": {
    "name": "Bridge Agent",
    "status": "active",
    "tasks": [
      { "description": "Create Slack app and bot token", "completed": true },
      { "description": "Add ALLOWED_USER_IDS to .env", "completed": false, "priority": "high" }
    ]
  }
}
```

### Task Properties

| Property | Type | Description |
|----------|------|-------------|
| `description` | string | What needs to be done |
| `completed` | boolean | Whether the task is done |
| `priority` | string | `high`, `medium`, or `low` (default: `medium`) |
| `completedAt` | string | ISO timestamp when completed |
| `addedAt` | string | ISO timestamp when added (for auto-added items) |
| `source` | string | `action_required` if auto-added from task output |

### Querying Owner Tasks

Use the ASK: command to check your pending tasks:

```
ASK: what do I need to do
ASK: my tasks
ASK: pending tasks
ASK: action items
```

The response shows tasks grouped by priority and includes agent readiness percentages.

### Auto-Adding Tasks

When a task completes with "ACTION REQUIRED:" in its output, the action item is automatically added to the bridge agent's checklist with high priority. This ensures owner follow-up items are tracked.

Example output that triggers auto-add:
```
Task completed successfully.
ACTION REQUIRED: Add NEW_API_KEY to .env
```

### Owner Tasks API

The `lib/owner-tasks.js` module exports:

| Function | Description |
|----------|-------------|
| `getPendingTasks()` | Get all uncompleted tasks sorted by priority |
| `completeTask(agentId, taskIndex)` | Mark a task as completed |
| `getAgentReadiness(agentId)` | Get completion percentage for an agent |
| `getAllAgentReadiness()` | Get readiness summary for all agents |
| `addTask(agentId, description, priority)` | Add a new task to an agent's checklist |
| `extractActionRequired(text)` | Extract ACTION REQUIRED item from text |
| `formatPendingTasks()` | Format tasks for Slack display |
| `isOwnerTasksQuery(text)` | Check if text is an owner tasks query |
