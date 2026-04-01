# Security Fix Skill

You are fixing a security vulnerability identified by the automated security review.

## Approach

1. **Understand the vulnerability**: Read the finding carefully. Understand WHY it's a vulnerability and how it could be exploited.

2. **Locate the code**: Find the exact file and line mentioned. Read the surrounding context (10-20 lines before and after).

3. **Plan the fix**: Before writing code, think about:
   - What's the minimal change needed?
   - Will this fix break anything?
   - Are there similar patterns elsewhere in the file that need the same fix?

4. **Implement the fix**: Apply the recommended fix or an equivalent secure pattern. Common fixes:
   - SQL injection: Use parameterized queries/prepared statements
   - XSS: Sanitize output, use safe templating
   - Hardcoded secrets: Move to environment variables
   - eval/exec: Remove or replace with safe alternative
   - Missing input validation: Add validation at entry point
   - Insecure dependencies: Update or replace

5. **Add a LOGIC CHANGE comment**: Every security fix MUST have a dated comment:
   ```javascript
   // LOGIC CHANGE YYYY-MM-DD: Fixed [SEVERITY] [vulnerability type] by [what you did]
   ```

6. **Test thoroughly**: Run `npm test` to ensure no regressions. If the vulnerability is in a testable path, add a regression test.

7. **Verify the fix**: Re-check that the vulnerability is actually addressed. Don't just move the problem somewhere else.

## Output

After fixing, provide:
1. A summary of what was changed
2. Confirmation that tests pass
3. Any follow-up items or related patterns that should be reviewed

## Security Fix Checklist

- [ ] Root cause is addressed, not just symptoms
- [ ] LOGIC CHANGE comment added with date
- [ ] No debugging console.log statements left
- [ ] npm test passes
- [ ] If new env var needed, documented in CLAUDE.md
- [ ] Similar patterns in the file checked and fixed if vulnerable
