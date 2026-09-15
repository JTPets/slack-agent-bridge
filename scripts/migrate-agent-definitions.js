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
 * Without (2) the bridge would have to resolve a channel name against Slack at
 * boot, and the names are a convention (`<id>-agent`) rather than a fact anyone
 * verified — nothing in this repository maps C0AP42BT4MR back to a name. A wrong
 * name does not fail loudly: it resolves to null and the bridge stops polling a
 * channel that worked yesterday. Seeding means first boot after the migration is a
 * cache hit for every agent that already had an id, so no guess can be wrong for
 * one, and name resolution is exercised only by agents that reach nobody today.
 *
 * WRITES ONLY. It contacts Slack for nothing and creates no channel.
 *
 *   node scripts/migrate-agent-definitions.js --dry-run   # print, write nothing
 *   node scripts/migrate-agent-definitions.js             # write
 */

const fs = require('fs');
const path = require('path');
const { serializeAgent } = require('../lib/agent-markdown');
const bridgeState = require('../lib/bridge-state');

const ROOT = path.join(__dirname, '..');
const LEGACY_FILE = path.join(ROOT, 'agents', 'agents.json');

/**
 * The channel NAME an agent's definition declares.
 *
 * `<id>-agent` is the convention `activateAgent()` has always used. Two exceptions,
 * both facts rather than guesses:
 *   - `bridge` is `#claude-bridge`, named in CLAUDE.md and docs/AGENTS.md.
 *   - `code-bridge` and `code-sqtools` share ONE channel in the legacy file
 *     (C0AP42BT4MR), so they must declare one name, not two that seed the same id.
 *
 * Every other name is UNVERIFIED against the workspace — see the header. The seeded
 * id is what is actually used; the name is what a fresh workspace would resolve.
 *
 * @param {object} agent - Legacy record.
 * @returns {string}
 */
function channelNameFor(agent) {
    if (agent.id === 'bridge') return 'claude-bridge';
    if (agent.id === 'code-bridge' || agent.id === 'code-sqtools') return 'code-agent';
    return `${agent.id}-agent`;
}

/**
 * Convert one legacy record into the definition record the markdown carries.
 *
 * @param {object} agent
 * @param {number} index - Registry position, preserved as `order`.
 * @returns {object}
 */
function toDefinition(agent, index) {
    const { channel, status, id, name, ...rest } = agent;
    return {
        id,
        name,
        order: index,
        default_status: status === 'planned' ? 'planned' : 'active',
        channel_name: channelNameFor(agent),
        ...rest,
    };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {{ written: string[], seeded: object, skipped: string[] }}
 */
function migrate(options = {}) {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8'));
    if (!Array.isArray(legacy)) throw new Error('agents.json is not an array');

    const written = [];
    const seeded = {};
    const skipped = [];

    legacy.forEach((agent, index) => {
        const definition = toDefinition(agent, index);
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
    console.log(`${dryRun ? 'would seed' : 'seeded'} ${Object.keys(result.seeded).length} channel name -> id mappings into agents/shared/channel-map.json (gitignored):`);
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
