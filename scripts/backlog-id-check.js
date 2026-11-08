#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * scripts/backlog-id-check.js — before you push: has `main` already used a WORK-TODO id
 * this branch files? (WORK-TODO #67)
 *
 *   node scripts/backlog-id-check.js                 # fetch origin main, check HEAD against it
 *   node scripts/backlog-id-check.js --no-fetch      # check HEAD against the local origin/main
 *   node scripts/backlog-id-check.js --base <ref>    # check against another ref (no fetch)
 *   node scripts/backlog-id-check.js --repo <dir>    # another checkout (the tests use this)
 *
 * Exit 0: every id new on this branch is free on main.
 * Exit 1: at least one is already taken on main, or was used there before and purged.
 * Exit 2: the check could not run (shallow clone, failed fetch, bad ref, no merge base).
 *         NEVER 0: a check that could not look is not a check that found nothing.
 *
 * Writes nothing. The default fetch updates FETCH_HEAD, nothing else.
 */

const { runGit, REPO_ROOT } = require('../lib/repo-history');
const { checkBacklogIds, formatReport } = require('../lib/backlog-id-check');

const argv = process.argv.slice(2);
const valueOf = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : (argv[i + 1] || ''); };
const repoRoot = valueOf('--repo') ?? REPO_ROOT;
let base = valueOf('--base');

if (base === null && !argv.includes('--no-fetch')) {
    const fetched = runGit(['fetch', '--quiet', '--', 'origin', 'main'], repoRoot);
    if (!fetched.ok) {
        console.error(`[backlog-ids] UNAVAILABLE — nothing was checked: git fetch origin main failed: ${fetched.error}`);
        process.exit(2);
    }
    base = 'FETCH_HEAD';
}

const result = checkBacklogIds({ base: base || 'origin/main', repoRoot });
const bad = result.collisions.length + result.reused.length;
const out = result.available && bad === 0 ? console.log : console.error;
for (const line of formatReport(result)) out(line);
process.exit(!result.available ? 2 : (bad ? 1 : 0));
