# Code Review Skill

Review recent commits for quality and compliance issues.

## Instructions

1. Check the last N commits (default: 3). Use `git log -N --oneline` to identify them
2. For each commit, review the changes with `git show <hash>`
3. Check for these issues:
   - **Security issues**: Hardcoded secrets, eval/exec usage, unsanitized input, token logging
   - **Missing tests**: New functions without corresponding test coverage
   - **CLAUDE.md violations**: Missing LOGIC CHANGE comments, cleanup not in finally blocks, exec() instead of spawn()
   - **Dead code**: Unused imports, unreachable code, commented-out code blocks
   - **Missing error handling**: Async operations without try/catch, errors not posted to Slack

4. Report findings as a numbered list with severity:
   - 🔴 **CRITICAL**: Security issues, data loss risk
   - 🟠 **HIGH**: Missing tests, CLAUDE.md violations
   - 🟡 **MEDIUM**: Dead code, missing error handling
   - 🟢 **LOW**: Style issues, minor improvements

## Example Output

```
Code Review: Last 3 commits

Commits reviewed:
- abc1234: Add user authentication
- def5678: Fix polling interval
- ghi9012: Update README

Findings:

1. 🔴 CRITICAL (abc1234): Potential token exposure in error log at line 45
2. 🟠 HIGH (abc1234): New authenticateUser() function has no test coverage
3. 🟡 MEDIUM (def5678): Missing LOGIC CHANGE comment for interval change
4. 🟢 LOW (ghi9012): No issues found

Summary: 1 critical, 1 high, 1 medium, 1 low
```

If no issues found:
```
Code Review: Last 3 commits
✅ No issues found. All commits follow project guidelines.
```
