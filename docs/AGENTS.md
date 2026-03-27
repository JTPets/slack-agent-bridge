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

## Memory Isolation

Each agent maintains its own memory directory:

```
agents/
├── bridge/
│   └── memory/
│       ├── tasks.json    # Active tasks
│       ├── history.json  # Completed tasks
│       └── context.json  # Agent context
├── secretary/
│   └── memory/
└── security/
    └── memory/
```

Memory files are JSON-based and managed by `memory/memory-manager.js`.

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
