# Refactor Skill

Safe refactoring with mandatory pre- and post-checks.

## Pre-Refactor Checklist (MUST DO FIRST)

Before making ANY changes:

1. **Check what exists**
   - Search for existing implementations before creating new ones
   - Run `grep -r "functionName" .` to find usages
   - Check if similar utilities already exist in `lib/`

2. **Read CLAUDE.md**
   - Understand project rules and patterns
   - Note the architecture section for file locations
   - Check for relevant coding standards

3. **Run tests**
   - Run `npm test` and ensure all tests pass
   - Note current test count as baseline

4. **Document starting state**
   - Note which files you plan to modify
   - Note current line counts of those files

## During Refactor

- Every new function MUST have a test
- Add LOGIC CHANGE comments for any behavior changes
- Keep files under 300 lines
- Use spawn(), never exec()
- Clean up temp resources in finally blocks

## Post-Refactor Checklist (MUST DO AFTER)

After making changes:

1. **Run npm test**
   - All tests must pass
   - Test count should increase if you added functions

2. **Run smoke test**
   - `node -e "require('./bridge-agent.js')"`
   - Must load without errors

3. **Update CLAUDE.md**
   - If you added/moved files, update the architecture section
   - If you added env vars, document them

4. **Verify no regressions**
   - Check that refactored functions still work as expected
   - Verify no unused imports or dead code introduced

## Report Format

```
Refactor Summary
================

Pre-checks:
✅ Tests passing (23 tests)
✅ CLAUDE.md reviewed
✅ No existing implementation found

Changes made:
- Extracted validateConfig() from bridge-agent.js to lib/config.js
- Added 3 new tests for validateConfig()

Post-checks:
✅ Tests passing (26 tests, +3)
✅ Smoke test passing
✅ CLAUDE.md architecture updated
✅ All files under 300 lines

Files modified:
- bridge-agent.js: 280 → 245 lines (-35)
- lib/config.js: 45 → 78 lines (+33)
- tests/config.test.js: 30 → 52 lines (+22)
```
