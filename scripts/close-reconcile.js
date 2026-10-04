#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * scripts/close-reconcile.js — does every `Closes #N` commit leave #N purged?
 *
 *   node scripts/close-reconcile.js            # check HEAD
 *   node scripts/close-reconcile.js --at <sha> # check the backlog as it stood at <sha>
 *   node scripts/close-reconcile.js --repo <dir> # another checkout (the tests use this)
 *
 * Exit 0: every claim is purged (or on a reused id, or unverifiable — both printed).
 * Exit 1: at least one `Closes #N` leaves #N in WORK-TODO.md under the same title.
 * Exit 2: the check could not run (a shallow clone, no git, a bad ref). NEVER 0: a check
 *         that could not look is not a check that found nothing (WORK-TODO #69).
 *
 * Read-only: runs `git log` and `git show`, writes nothing.
 */

const { reconcile, formatReport } = require('../lib/close-reconcile');

const argv = process.argv.slice(2);
const atIdx = argv.indexOf('--at');
const at = atIdx === -1 ? 'HEAD' : argv[atIdx + 1];
const repoIdx = argv.indexOf('--repo');
const opts = { at: at || '' };
if (repoIdx !== -1) opts.repoRoot = argv[repoIdx + 1] || '';

const result = reconcile(opts);
const report = formatReport(result);
const out = result.available && result.still_open.length === 0 ? console.log : console.error;
for (const line of report) out(line);
process.exit(!result.available ? 2 : (result.still_open.length ? 1 : 0));
