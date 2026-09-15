#!/usr/bin/env node

/**
 * lib/validate.js
 *
 * Pre-commit validation script that catches common issues:
 * 1. Verifies bridge-agent.js loads without errors (catches missing imports/references)
 * 2. Checks no .js file exceeds 300 lines without a recorded justification in
 *    lib/validate-exceptions.json (see lib/file-size-gate.js)
 *
 * Usage: npm run validate
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

let hasErrors = false;

// ---- Check 1: Verify bridge-agent.js loads ----

console.log('[validate] Checking bridge-agent.js loads...');

// LOGIC CHANGE 2026-09-13: This check used to hang forever, so the repo's own
// pre-commit gate could never complete. Two things were wrong:
//
//   1. `require('./bridge-agent.js')` RETURNS fine - the module body registers a
//      scheduler, a setInterval(poll) and signal handlers, then returns. What
//      never happened was process exit, because those handles keep the event loop
//      alive. So the probe sat there running a live bridge agent (joining Slack
//      channels, probing providers) until someone noticed and killed it.
//      `process.exit(0)` right after the require ends it the moment the module
//      has loaded, which is the only thing this check is asking about.
//
//   2. spawnSync had no timeout, so there was no backstop at all. There is one
//      now. With the explicit exit above, hitting it means module load itself
//      blocked (a synchronous network or exec call at module scope) - a real
//      defect, so the timeout is reported as a failure rather than a pass.
//
// 30s is deliberately generous: on a cold cache this resolves several hundred
// files under node_modules (googleapis alone is large) off slow NAS storage. The
// normal path exits in well under a second, so the gate does not pay this cost.
const LOAD_TIMEOUT_MS = 30000;

const result = spawnSync('node', ['-e', "require('./bridge-agent.js'); process.exit(0);"], {
  cwd: ROOT_DIR,
  stdio: 'pipe',
  encoding: 'utf8',
  timeout: LOAD_TIMEOUT_MS,
});

if (result.error && result.error.code === 'ETIMEDOUT') {
  console.error(`[validate] ❌ bridge-agent.js did not finish loading within ${LOAD_TIMEOUT_MS}ms:`);
  console.error('[validate]    module load is blocking - look for synchronous work at module scope.');
  console.error(result.stderr || result.stdout || '(no output)');
  hasErrors = true;
} else if (result.error) {
  console.error('[validate] ❌ could not run the bridge-agent.js load check:');
  console.error(result.error.message);
  hasErrors = true;
} else if (result.status !== 0) {
  console.error('[validate] ❌ bridge-agent.js failed to load:');
  console.error(result.stderr || result.stdout);
  hasErrors = true;
} else {
  console.log('[validate] ✓ bridge-agent.js loads successfully');
}

// ---- Check 2: no .js file over the limit without a recorded justification ----

// LOGIC CHANGE 2026-09-15: This check used to fail on every over-limit file
// unconditionally — 65 of them — so it was red on every run and a NEW violation could
// not be distinguished from the standing ones without diffing path lists by hand. Two
// went unnoticed that way in the week of 2026-09-08. The rule and the enumeration now
// live in lib/file-size-gate.js, with lib/validate-exceptions.json as the declared list
// of what may exceed the limit and why. Both directions fail: an undeclared violation,
// and an entry that no longer describes reality. See WORK-TODO #10 for the record and
// #44 for the open question of what the rule should cover.
const fileSizeGate = require('./file-size-gate');

console.log(`[validate] Checking no .js file exceeds ${fileSizeGate.MAX_LINES} lines without a recorded justification...`);

try {
  const result = fileSizeGate.check();
  const report = fileSizeGate.formatReport(result);
  for (const line of report) {
    (result.ok ? console.log : console.error)(line);
  }
  if (!result.ok) {
    hasErrors = true;
  }
} catch (err) {
  // A missing or unparseable declaration file is a failure, never a pass: a gate that
  // fails open on a typo is the thing this check was rewritten to stop being.
  console.error('[validate] ❌ could not run the file-size gate:');
  console.error(`[validate]    ${err.message}`);
  hasErrors = true;
}

// ---- Final result ----

if (hasErrors) {
  console.error('\n[validate] ❌ Validation failed');
  process.exit(1);
} else {
  console.log('\n[validate] ✓ All checks passed');
  process.exit(0);
}
