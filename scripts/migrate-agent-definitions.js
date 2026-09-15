#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * scripts/migrate-agent-definitions.js
 *
 * THE migration from `agents/agents.json` to one tracked markdown definition per
 * agent, plus the seeding step that makes it safe.
 *
 * LOGIC CHANGE 2026-09-15: New file. Run once to migrate; kept in the repository
 * because it is also the answer to "where did agents/<id>/agent.md come from" and
 * the command that re-runs the conversion if the legacy file is ever restored.
 *
 * TWO OUTPUTS, AND THE SECOND IS THE ONE THAT PREVENTS AN OUTAGE:
 *
 *   1. `agents/<id>/agent.md` — tracked, portable, carrying the channel NAME.
 *   2. `agents/shared/channel-map.json` — untracked, SEEDED with the channel ids
 *      the legacy file already held, keyed by the name written in (1).
 *
 * The reasoning for (2) was: the bridge would otherwise resolve a name against Slack
 * at boot, the names were a convention rather than a verified fact, and a wrong name
 * does not fail loudly — it resolves to null and the bridge stops polling a channel
 * that worked yesterday. **Every clause of that was correct and it still failed**, for
 * the reason in correction 2 below: the seed cannot travel with the commit. The
 * predicted failure then happened exactly as written.
 *
 * Two things now make the same guarantee, both of which a commit CAN carry: the names
 * are verified rather than conventional (docs/AGENTS.md), and the resolution the boot
 * path performs is REPORTED to #sqtools-ops per agent when it fails, so a wrong name
 * is loud. `nothing in this repository maps C0AP42BT4MR back to a name` is also no
 * longer true — `agents/activation-checklists.json` does, and
 * `lib/channel-map-rebuild.js` reads the binding out of git history.
 *
 * WRITES ONLY. It contacts Slack for nothing and creates no channel.
 *
 *   node scripts/migrate-agent-definitions.js --dry-run   # print, write nothing
 *   node scripts/migrate-agent-definitions.js             # write
 *
 * LOGIC CHANGE 2026-09-15 — TWO CORRECTIONS, BOTH FROM WATCHING THIS FAIL:
 *
 *   1. IT COULD NOT RUN. The commit that added this script also DELETED
 *      `agents/agents.json`, so `migrate()` threw ENOENT from its first line and the
 *      "command that re-runs the conversion" in the header above was not a command.
 *      It now reads the legacy file through `lib/channel-map-rebuild.js`, which takes
 *      the working-tree copy when there is one and otherwise the blob from the commit
 *      that deleted it.
 *   2. THE SEEDING STEP COULD NEVER HAVE REACHED THE DEPLOYMENT, and that is the
 *      defect the header's own reasoning missed. Its only output is
 *      `agents/shared/channel-map.json`, which is GITIGNORED, and a dispatched task
 *      runs in a scratch clone — so the seed was written into a temp directory and
 *      discarded with it. On the box, zero of six mappings were seeded; five active
 *      agents went unresolved and two scheduled agents stopped (WORK-TODO #55).
 *      The seeding half now lives where it can be run deliberately, on the machine
 *      that needs it: `node scripts/channel-map.js --from-git`.
 *   3. `channelNameFor()` IS NO LONGER THE AUTHORITY on a channel name. It was a
 *      convention (`<id>-agent`), seven of its eleven answers were fiction, and the
 *      definitions now carry names verified against `agents/activation-checklists.json`
 *      (docs/AGENTS.md). Where a definition already exists, its declared name wins;
 *      the convention is the fallback for an agent that has none.
 */

const fs = require('fs');
const path = require('path');
const { serializeAgent, loadDefinitions } = require('../lib/agent-markdown');
const bridgeState = require('../lib/bridge-state');
const { readLegacyRegistry } = require('../lib/channel-map-rebuild');

const ROOT = path.join(__dirname, '..');

/**
 * The channel NAME an agent's definition declares.
 *
 * LOGIC CHANGE 2026-09-15: an existing definition's DECLARED name wins. Those names
 * were verified against `agents/activation-checklists.json`; this function's
 * `<id>-agent` convention produced seven fictions out of eleven and is now only the
 * fallback for a legacy record that has no definition yet. `bridge` keeps its explicit
 * `claude-bridge` for that fallback case; the `code-agent` special case is gone,
 * because the definitions already declare `code-review` for both code agents.
 *
 * @param {object} agent - Legacy record.
 * @param {object[]} [definitions] - Current markdown definitions; theirs wins.
 * @returns {string}
 */
function channelNameFor(agent, definitions) {
    const declared = (definitions || []).find(d => d.id === agent.id);
    if (declared && declared.channel_name) return String(declared.channel_name).replace(/^#/, '');
    if (agent.id === 'bridge') return 'claude-bridge';
    return `${agent.id}-agent`;
}

/**
 * Convert one legacy record into the definition record the markdown carries.
 *
 * @param {object} agent
 * @param {number} index - Registry position, preserved as `order`.
 * @returns {object}
 */
function toDefinition(agent, index, definitions) {
    const { channel, status, id, name, ...rest } = agent;
    return {
        id,
        name,
        order: index,
        default_status: status === 'planned' ? 'planned' : 'active',
        channel_name: channelNameFor(agent, definitions),
        ...rest,
    };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {{ written: string[], seeded: object, skipped: string[] }}
 */
function migrate(options = {}) {
    const read = options.legacy || readLegacyRegistry();
    if (!read.ok) throw new Error(`cannot read the legacy registry: ${read.reason}`);
    const legacy = read.agents;
    const definitions = options.definitions || loadDefinitions();

    const written = [];
    const seeded = {};
    const skipped = [];

    legacy.forEach((agent, index) => {
        const definition = toDefinition(agent, index, definitions);
        const dir = path.join(ROOT, 'agents', agent.id);
        const file = path.join(dir, 'agent.md');
        const markdown = serializeAgent(definition);

        if (agent.channel) {
            const name = definition.channel_name;
            if (seeded[name] && seeded[name] !== agent.channel) {
                skipped.push(`${agent.id}: #${name} already seeds ${seeded[name]}, not ${agent.channel}`);
            } else {
                seeded[name] = agent.channel;
            }
        }

        if (!options.dryRun) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(file, markdown, 'utf8');
        }
        written.push(path.relative(ROOT, file));
    });

    if (!options.dryRun) {
        // Merge, never replace: an id already resolved in this workspace wins over a
        // seed, because it was resolved against the live workspace and this was not.
        const map = bridgeState.loadChannelMap();
        for (const [name, id] of Object.entries(seeded)) {
            if (!map[name]) map[name] = id;
        }
        bridgeState.saveChannelMap(map);
    }

    return { written, seeded, skipped };
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const result = migrate({ dryRun });

    console.log(`${dryRun ? '[dry run] would write' : 'wrote'} ${result.written.length} definitions:`);
    for (const f of result.written) console.log(`  ${f}`);
    console.log('');
    console.log(`${dryRun ? 'would seed' : 'seeded'} ${Object.keys(result.seeded).length} channel name -> id mappings into agents/shared/channel-map.json (gitignored — so this reaches the DEPLOYMENT only when run ON it; see \`node scripts/channel-map.js --from-git\`):`);
    for (const [name, id] of Object.entries(result.seeded)) console.log(`  #${name} -> ${id}`);
    if (result.skipped.length) {
        console.log('');
        console.log('CONFLICTS (nothing seeded for these):');
        for (const s of result.skipped) console.log(`  - ${s}`);
    }
    return result.skipped.length ? 1 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { migrate, toDefinition, channelNameFor };
