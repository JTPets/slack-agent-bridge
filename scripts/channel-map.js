#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * scripts/channel-map.js
 *
 * THE command that answers "which channel does each agent actually run in?", and THE
 * command that rebuilds the answer when the box is gone.
 *
 * LOGIC CHANGE 2026-09-15: New file, for WORK-TODO #55. The mapping lives in
 * `agents/shared/channel-map.json`, which is gitignored — correctly, a workspace id is
 * not portable — and until now the only recorded way back from losing it was a human
 * reading identifiers out of terminal scrollback. That is what happened on 2026-09-15:
 * five active agents unresolved, two scheduled agents stopped.
 *
 *   node scripts/channel-map.js                  # report. Read-only, no token, no network
 *   node scripts/channel-map.js --from-git       # rebuild from git history (this workspace)
 *   node scripts/channel-map.js --from-git --dry-run
 *   node scripts/channel-map.js --resolve        # rebuild from Slack by name (any workspace)
 *   node scripts/channel-map.js --resolve --include-planned
 *
 * WHICH ONE TO USE:
 *   Same workspace, map lost      -> --from-git. Exact, offline, one command.
 *   New or forked workspace       -> --resolve. The names are declared; this finds
 *                                    whatever they mean HERE.
 *   Both unavailable              -> the mapping is gone. That gap is #55's remainder.
 *
 * It CREATES NO SLACK CHANNEL and writes no tracked file. A declared name that does
 * not exist is reported, never invented.
 */

const rebuild = require('../lib/channel-map-rebuild');

/**
 * @param {string[]} argv
 * @returns {Promise<number>} Process exit code.
 */
async function main(argv) {
    const flags = new Set(argv);
    const dryRun = flags.has('--dry-run');

    if (flags.has('--from-git')) {
        const result = rebuild.reconstructFromHistory({ dryRun });
        if (!result.ok) {
            console.error(`Could not read the legacy registry: ${result.reason}`);
            console.error('Try `--resolve` instead, which needs a bot token but no history.');
            return 1;
        }
        console.log(`source: ${result.source}`);
        const added = Object.entries(result.added);
        console.log(`${dryRun ? 'would add' : 'added'} ${added.length} mapping(s) to agents/shared/channel-map.json:`);
        for (const [name, id] of added) console.log(`  #${name} -> ${id}`);
        for (const [name, k] of Object.entries(result.kept)) {
            console.log(`  #${name}: KEPT the live value ${k.keeping}; ignored ${k.ignored} from history ` +
                '(a value resolved against the workspace always wins over a reconstructed one)');
        }
        for (const c of result.conflicts) console.log(`  CONFLICT: ${c}`);
        if (result.unrecovered.length) {
            console.log('');
            console.log('Not recoverable from history — these had no id in the legacy registry:');
            for (const u of result.unrecovered) console.log(`  ${u.id} (${u.status}) declares #${u.channel_name}`);
            console.log('Run with --resolve to look these up by name, or accept that they have never resolved.');
        }
        return result.conflicts.length ? 1 : 0;
    }

    if (flags.has('--resolve')) {
        const config = require('../lib/config');
        if (!config.SLACK_BOT_TOKEN) {
            console.error('--resolve needs SLACK_BOT_TOKEN. Nothing was changed.');
            return 1;
        }
        const { createSlackClient } = require('../lib/slack-client');
        const outcome = await rebuild.resolveDeclaredChannels({
            slackClient: createSlackClient(config.SLACK_BOT_TOKEN),
            includePlanned: flags.has('--include-planned'),
        });
        for (const r of outcome.resolved) console.log(`  ${r.id}: #${r.channel_name} -> ${r.channelId} (${r.source})`);
        for (const u of outcome.unresolved) console.log(`  ${u.id}: #${u.channel_name} UNRESOLVED — ${u.reason}`);
        console.log(`${outcome.resolved.length} resolved, ${outcome.unresolved.length} unresolved. Nothing was created.`);
        return outcome.unresolved.length ? 1 : 0;
    }

    console.log(rebuild.formatReport(rebuild.report()).join('\n'));
    console.log('');
    console.log('Rebuild: `--from-git` (this workspace, offline) or `--resolve` (any workspace, needs a token).');
    return 0;
}

if (require.main === module) {
    main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}

module.exports = { main };
