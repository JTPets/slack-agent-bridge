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
- **Role**: Calendar accountability, email monitoring, daily briefings, reminders
- **Max Turns**: 20
- **Permissions**: google-calendar, gmail-read
- **Denied**: github-write, file-system-write

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
- `square-catalog-read` - Read Square catalog data
- `square-orders-write` - Create Square orders

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
| `deploy_policy` | `auto-update`, `manual` | How deploys happen |
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
7. **Deploy**: Owner runs deploy on Pi:
   ```bash
   git pull origin main && npm test && pm2 restart server
   ```

### Non-Production Repo Rules

Agents with `production: false` can push directly to main:

1. **Direct Commit**: Agent commits changes to main
2. **Push**: Agent pushes to main
3. **Auto-Deploy**: Auto-updater detects changes and restarts PM2 process

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
