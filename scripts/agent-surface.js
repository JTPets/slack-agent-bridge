#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * scripts/agent-surface.js
 *
 * THE regenerating command for the declared-agent surface. Prints one row per agent
 * in `agents/agents.json`: channel, whether the bridge joins it, whether it polls
 * it, whether a scheduled job is registered, which provider it resolves to and from
 * where, and whether anything the agent produces has a reader.
 *
 * LOGIC CHANGE 2026-09-15: New file. It exists so no document has to carry the
 * figures — "eleven agents, five channels, four jobs" was a count someone made once
 * and nothing failed when it went stale.
 *
 * READ-ONLY. It loads the registry and the environment and prints. It contacts
 * Slack for nothing, joins nothing, creates nothing, and needs no token: with
 * BRIDGE_CHANNEL_ID unset the JOIN/POLL columns simply report the registry-only
 * view, which is the honest answer from a checkout.
 *
 *   node scripts/agent-surface.js          # the table
 *   node scripts/agent-surface.js --json   # the same rows, machine-readable
 */

const { buildSurface, formatSurface, findOrphans } = require('../lib/agent-surface');

function main() {
    const rows = buildSurface();
    const json = process.argv.includes('--json');

    if (json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
    }

    console.log(formatSurface(rows).join('\n'));
    console.log('');
    // Counted as DISTINCT channel ids, not as agents: code-bridge and code-sqtools
    // name the same channel, so counting agents would report one channel twice.
    const distinct = key => new Set(rows.filter(r => r[key]).map(r => r.channel)).size;
    console.log(`${rows.length} declared agents | ` +
        `${distinct('channel')} distinct channels declared | ` +
        `${distinct('joined')} joined | ` +
        `${distinct('polled')} polled | ` +
        `${rows.filter(r => r.scheduled).length} scheduled jobs registered`);

    if (!process.env.BRIDGE_CHANNEL_ID) {
        console.log('');
        console.log('NOTE: BRIDGE_CHANNEL_ID is unset, so the bridge channel is absent from the');
        console.log('      JOIN/POLL columns. Every other column is unaffected.');
    }

    const orphans = findOrphans(rows);
    if (orphans.length) {
        console.log('');
        console.log(`OUTPUT THAT REACHES NOBODY (${orphans.length}):`);
        for (const o of orphans) console.log(`  - ${o.id}: ${o.problem}`);
    }
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { main };
