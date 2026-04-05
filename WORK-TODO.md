# Work Backlog

Ideas to borrow, improve, or replace. Sourced from internal review and comparison with [tomeraitz/claude-slack-bridge](https://github.com/tomeraitz/claude-slack-bridge).

Priority tiers: **P1** = high value, low risk | **P2** = medium effort, clear win | **P3** = nice to have / uncertain ROI

---

## P1 — High Value

### Replace HTTP polling with Slack Socket Mode
**Source:** tomeraitz/claude-slack-bridge  
**Problem:** Current `setInterval` poll loop hits the Slack API every 30s regardless of activity. Up to 30s message latency. Accumulates rate limit pressure over time.  
**Fix:** Swap to `@slack/socket-mode` package. One persistent WebSocket connection replaces the poll loop. Near-instant message delivery.  
**Effort:** Medium. `SlackEventMiddlewareFactory` → `SocketModeClient`. Requires `SLACK_APP_TOKEN` (xapp-) env var and Socket Mode enabled in app settings.  
**Risk:** Low. Drop-in replacement for the message detection logic.

---

### Mid-task `ask_on_slack` capability
**Source:** tomeraitz/claude-slack-bridge  
**Problem:** Tasks run fully autonomously. If Claude needs a decision at step 3 of 10, it guesses or aborts. No way to inject human judgment mid-execution.  
**Fix:** Inject a custom tool definition into the task prompt that lets Claude post a question to the originating Slack thread and block on the reply. The bridge listens for a thread reply, then resumes the spawned process via stdin or a follow-up invocation.  
**Effort:** High. Requires: thread-reply listener, tool injection into Claude prompt, session state tracking per in-progress task.  
**Risk:** Medium. Changes the execution model. Must not break the current fire-and-forget path.

---

### Thread-based task conversations
**Source:** tomeraitz/claude-slack-bridge  
**Problem:** All task output posts to the channel top-level. `#claude-bridge` becomes noisy with interleaved messages from concurrent tasks.  
**Fix:** Post the initial task acknowledgment as a top-level message, then post all subsequent output (progress, result, errors) as replies in that thread.  
**Effort:** Low–Medium. Need to capture the `ts` of the first reply and pass it as `thread_ts` on subsequent posts.  
**Risk:** Low. Purely additive.

---

## P2 — Medium Priority

### Structured task result format
**Problem:** Task results are raw text dumps from Claude. No consistent structure for success/failure, files changed, tests run, etc.  
**Fix:** Define a result schema (status, summary, files_changed, test_result, next_steps). Have Claude output JSON at the end of each task. Parse and render as a Slack Block Kit card.  
**Effort:** Medium. Requires prompt engineering + output parser + Block Kit formatting.

---

### Rate limit backoff tuning
**Problem:** `CLAUDE_RATE_LIMIT_PAUSE` defaults to 30 minutes. That's a hard static wait. If the rate limit clears in 5 minutes, the agent sits idle for 25 more.  
**Fix:** Implement exponential backoff with a probe: after the initial pause, try a cheap test call every N minutes and resume when it succeeds.  
**Effort:** Low.

---

### Task timeout escalation tiers
**Problem:** `TASK_TIMEOUT_MS` is a single hard kill. There's no warning before the axe falls.  
**Fix:** Add a soft timeout at 80% of the limit that posts a Slack warning ("task has been running X min, will be killed in Y min"). Gives context without changing the kill behavior.  
**Effort:** Low.

---

### Deduplication TTL surfaced in status
**Problem:** `processed-tasks.json` silently deduplicates. If the agent skips a re-submitted task, the user gets no feedback.  
**Fix:** When a duplicate is detected, post a brief Slack reply: "Already processed this message (ID: xxx). Reply `retry` to force re-run."  
**Effort:** Low.

---

### Per-agent memory size limits
**Problem:** Memory JSON files grow unboundedly. `archive.json` in particular has no eviction policy beyond the TTL logic.  
**Fix:** Add a max-entries cap per tier (e.g. 500 entries for long-term, 1000 for archive). Evict oldest-by-TTL when cap is hit.  
**Effort:** Low.

---

### `ASK: task history [n]` command
**Problem:** The status command shows the last 5 completed tasks. No way to query further back.  
**Fix:** Add `ASK: task history 20` to return the last N tasks from memory with timestamps and outcome.  
**Effort:** Low.

---

### Approval queue expiry
**Problem:** Items in `approval-queue.json` sit forever if not actioned. Stale security findings from weeks ago are noise.  
**Fix:** Auto-expire approval queue entries after N days (configurable, default 7). Post a digest to ops channel when items expire un-actioned.  
**Effort:** Low.

---

### `npm test` failure diff in Slack
**Problem:** When Phase 3 validation fails, the ops message says "tests failed" but doesn't show which tests or the failure output.  
**Fix:** Parse Jest output, extract failed test names and error lines, include in the Slack message (truncated to 2000 chars).  
**Effort:** Low.

---

## P3 — Nice to Have / Uncertain ROI

### Docker/container deployment option
**Source:** tomeraitz/claude-slack-bridge  
**Note:** Their Docker Compose setup is clean. Could be useful if the Pi ever gets replaced or a staging environment is needed. Low priority since PM2 works.

---

### MCP server wrapper
**Source:** tomeraitz/claude-slack-bridge  
**Idea:** Expose bridge capabilities (post to Slack, read task queue, query memory) as MCP tools so Claude Code sessions can call them directly without needing custom prompting.  
**Effort:** High. Requires MCP server scaffolding alongside the existing bridge.  
**ROI:** Unclear. The current prompt injection approach works. Only worth it if adopting the mid-task ask capability above.

---

### Watercooler summary to LinkedIn draft
**Idea:** After Friday retro standup, Story Bot could auto-draft a LinkedIn post from the week's highlights and drop it in `#sqtools-ops` for review.  
**Effort:** Low (Story Bot already flags moments). Just needs a final aggregation step and a post to the channel.

---

### Task complexity auto-scaling TURNS
**Problem:** `TURNS` is manually set per task. Simple tasks waste quota at the default 50; complex tasks hit limits.  
**Fix:** Use `analyzeComplexity()` score to auto-assign a TURNS baseline (e.g. score 1-2 → 20 turns, score 3-5 → 50, score 6+ → 80) unless TURNS is explicitly set.  
**Effort:** Low. One change in `task-parser.js` or task dispatch logic.

---

### Channel-per-task archive mode
**Idea:** For long-running or high-value tasks, auto-create a dedicated Slack channel (e.g. `#task-20260405-fix-auth`) and post all task I/O there. Pin it. Archive when complete.  
**Effort:** High. Requires channel lifecycle management.  
**ROI:** Probably only useful for audit/compliance scenarios.

---

*Last updated: 2026-04-05*
