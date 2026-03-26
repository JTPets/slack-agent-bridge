# Deploy Check Skill

Verify deployment health with a series of automated checks.

## Instructions

Run these checks and report pass/fail for each:

### 1. Git Status Check
- Run `git log -1 --oneline` to show the last commit
- Verify working directory is clean (`git status --porcelain`)
- **Pass**: Clean working directory with recent commit
- **Fail**: Uncommitted changes or detached HEAD

### 2. Test Suite Check
- Run `npm test`
- **Pass**: All tests pass (exit code 0)
- **Fail**: Any test failures

### 3. Smoke Test Check
- Run `node -e "require('./bridge-agent.js')"`
- **Pass**: Process loads without error
- **Fail**: Any require/syntax errors

### 4. File Size Check
- Check all .js files for lines over 300
- Use `wc -l` on each file
- **Pass**: No files exceed 300 lines
- **Fail**: List files that exceed limit

## Report Format

```
Deploy Health Check
==================

1. Git Status: ✅ PASS
   Last commit: abc1234 Add new feature
   Working directory: clean

2. Test Suite: ✅ PASS
   4 suites, 23 tests, all passing

3. Smoke Test: ✅ PASS
   bridge-agent.js loads successfully

4. File Size: ✅ PASS
   All files under 300 lines

------------------
Overall: ✅ READY TO DEPLOY
```

Or with failures:

```
Deploy Health Check
==================

1. Git Status: ✅ PASS
   Last commit: abc1234 Add new feature

2. Test Suite: ❌ FAIL
   2 tests failing (see npm test output)

3. Smoke Test: ✅ PASS

4. File Size: ❌ FAIL
   - bridge-agent.js: 342 lines (limit: 300)

------------------
Overall: ❌ NOT READY - Fix 2 issues before deploy
```
