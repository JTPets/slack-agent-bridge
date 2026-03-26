# Run Tests Skill

Run the full test suite and report results.

## Instructions

1. Run `npm test` in the project root
2. Parse the Jest output to extract:
   - Total test suites
   - Total tests
   - Passing tests
   - Failing tests
3. Report results in this format:
   ```
   Test Results:
   - Suites: X total
   - Tests: X passed, X failed, X total
   - Status: ✅ All passing / ❌ X failing
   ```
4. If any tests fail, list the failing test names
5. Do NOT fix anything - this is a read-only check

## Example Output

```
Test Results:
- Suites: 4 total
- Tests: 23 passed, 0 failed, 23 total
- Status: ✅ All passing
```

Or with failures:

```
Test Results:
- Suites: 4 total
- Tests: 21 passed, 2 failed, 23 total
- Status: ❌ 2 failing

Failing tests:
1. task-parser.test.js > parseTaskMessage > should handle missing REPO field
2. config.test.js > loadConfig > should validate required env vars
```
