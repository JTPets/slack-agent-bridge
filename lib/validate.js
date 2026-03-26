#!/usr/bin/env node

/**
 * lib/validate.js
 *
 * Pre-commit validation script that catches common issues:
 * 1. Verifies bridge-agent.js loads without errors (catches missing imports/references)
 * 2. Checks no .js file exceeds 300 lines (keeps files manageable)
 *
 * Usage: npm run validate
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const MAX_LINES = 300;

let hasErrors = false;

// ---- Check 1: Verify bridge-agent.js loads ----

console.log('[validate] Checking bridge-agent.js loads...');

const result = spawnSync('node', ['-e', "require('./bridge-agent.js')"], {
  cwd: ROOT_DIR,
  stdio: 'pipe',
  encoding: 'utf8',
});

if (result.status !== 0) {
  console.error('[validate] ❌ bridge-agent.js failed to load:');
  console.error(result.stderr || result.stdout);
  hasErrors = true;
} else {
  console.log('[validate] ✓ bridge-agent.js loads successfully');
}

// ---- Check 2: No .js file exceeds 300 lines ----

console.log(`[validate] Checking no .js file exceeds ${MAX_LINES} lines...`);

function findJsFiles(dir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Skip node_modules and hidden directories
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      findJsFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const jsFiles = findJsFiles(ROOT_DIR);
const oversizedFiles = [];

for (const file of jsFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lineCount = content.split('\n').length;
  if (lineCount > MAX_LINES) {
    oversizedFiles.push({ file: path.relative(ROOT_DIR, file), lines: lineCount });
  }
}

if (oversizedFiles.length > 0) {
  console.error(`[validate] ❌ Files exceeding ${MAX_LINES} lines:`);
  for (const { file, lines } of oversizedFiles) {
    console.error(`  - ${file}: ${lines} lines`);
  }
  hasErrors = true;
} else {
  console.log(`[validate] ✓ All .js files are under ${MAX_LINES} lines`);
}

// ---- Final result ----

if (hasErrors) {
  console.error('\n[validate] ❌ Validation failed');
  process.exit(1);
} else {
  console.log('\n[validate] ✓ All checks passed');
  process.exit(0);
}
