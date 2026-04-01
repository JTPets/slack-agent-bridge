# Task Decomposition Skill

Analyze complex tasks and break them into manageable subtasks.

## Instructions

When given a complex task, analyze it to determine if it should be decomposed into smaller subtasks.

### Analysis Steps

1. **Identify discrete work units**: Look for separate pieces of work that could be done independently
2. **Find dependencies**: Determine which subtasks depend on others
3. **Assess complexity**: Each subtask should be completable in one focused session
4. **Route to agents**: Match subtasks to specialized agents based on repo and task type

### Decomposition Criteria

Decompose when the task has:
- Multiple numbered or bulleted items
- Sequential steps with "then", "after", "finally"
- Multiple repositories mentioned
- Mixed concerns (code + docs + tests)
- More than 200 words of instructions

Do NOT decompose when:
- Task is already focused and atomic
- Changes are tightly coupled (e.g., function + its tests)
- Splitting would lose important context

### Subtask Requirements

Each subtask should have:
- **Clear description** (under 50 characters)
- **Complete instructions** (all context needed to execute)
- **Dependencies** (which other subtasks must complete first)
- **Priority** (0-10, higher = more urgent)
- **Task type** (code, security, research, documentation, deploy, etc.)

### Agent Routing

Match subtasks to appropriate agents:

| Task Type | Agent |
|-----------|-------|
| Code (slack-agent-bridge) | code-bridge |
| Code (SquareDashboardTool) | code-sqtools |
| Code (other repos) | bridge |
| Security review | security |
| Email triage | email-monitor or secretary |
| Calendar/scheduling | secretary |
| Social media | social-media |
| Research/analysis | bridge with research skill |

### Output Format

Return JSON with this structure:

```json
{
  "shouldDecompose": true,
  "reasoning": "Brief explanation of why decomposition is needed",
  "subtasks": [
    {
      "description": "Short title",
      "instructions": "Detailed instructions with all context",
      "dependsOn": [],
      "priority": 5,
      "taskType": "code"
    },
    {
      "description": "Second subtask",
      "instructions": "...",
      "dependsOn": [0],
      "priority": 4,
      "taskType": "code"
    }
  ]
}
```

### Example

**Input Task:**
```
TASK: Update error handling and add tests
REPO: jtpets/slack-agent-bridge
INSTRUCTIONS:
1. Refactor the error handling in bridge-agent.js to use a centralized error handler
2. Add unit tests for the new error handler
3. Update CLAUDE.md with the new error handling pattern
4. Run security review on the changes
```

**Output:**
```json
{
  "shouldDecompose": true,
  "reasoning": "Task has 4 distinct work items: code refactor, test writing, documentation, and security review. Security review depends on code changes completing first.",
  "subtasks": [
    {
      "description": "Refactor error handling",
      "instructions": "Refactor the error handling in bridge-agent.js to use a centralized error handler. Create a new lib/error-handler.js module that handles all error types consistently. Update bridge-agent.js to use this centralized handler.",
      "dependsOn": [],
      "priority": 8,
      "taskType": "code"
    },
    {
      "description": "Add error handler tests",
      "instructions": "Add unit tests for the new error handler in tests/error-handler.test.js. Test all error types: network errors, validation errors, rate limits, and unknown errors. Use Jest mocking for external dependencies.",
      "dependsOn": [0],
      "priority": 7,
      "taskType": "code"
    },
    {
      "description": "Update documentation",
      "instructions": "Update CLAUDE.md with the new error handling pattern. Add a section describing the centralized error handler, when to use it, and the error types it handles.",
      "dependsOn": [0],
      "priority": 5,
      "taskType": "documentation"
    },
    {
      "description": "Security review of changes",
      "instructions": "Run security review on the error handling changes. Check for: information leakage in error messages, proper sanitization, no credential exposure, and safe error logging.",
      "dependsOn": [0, 1],
      "priority": 6,
      "taskType": "security"
    }
  ]
}
```

## Notes

- Maximum 5 subtasks per decomposition (group related work if needed)
- Preserve all original context in subtask instructions
- Don't create artificial dependencies - if subtasks can run in parallel, let them
- Consider token efficiency - don't decompose tasks that fit in one session
