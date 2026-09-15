'use strict';

/**
 * lib/channel-map-rebuild.js
 *
 * THE answer to "the box died — how does the channel mapping come back?"
 *
 * LOGIC CHANGE 2026-09-15: New file. `agents/shared/channel-map.json` is gitignored
 * and is the only thing that maps a declared `channel_name` to a Slack id, so a fresh
 * clone has none. That is correct — a workspace id is not portable and must not be
 * committed — but until now the only recorded way back was a human reading identifiers
 * out of terminal scrollback, which is what actually happened on 2026-09-15
 * (WORK-TODO #55). This module turns that into two commands.
 *
 * IT EXTENDS WHAT EXISTS RATHER THAN ADDING A THIRD MECHANISM. The store is
 * `lib/bridge-state.js`'s, unchanged. Live resolution is `resolveAgentChannel()` in
 * `lib/agent-activation.js` — the same function the boot path already calls
 * (`bridge-agent.js`, the startup IIFE) and the same one `ASK: activate` calls. What
 * is new is only the *offline* recovery and a read-only report.
 *
 * TWO SOURCES, AND THEY ANSWER DIFFERENT QUESTIONS:
 *
 *   resolveDeclaredChannels()  — asks SLACK what the declared names resolve to in THIS
 *     workspace. Works in any workspace, including a fork's, which is the whole point
 *     of declaring a name instead of an id. Needs a bot token. Creates nothing: a name
 *     that does not exist is REFUSED and reported, never invented.
 *
 *   reconstructFromHistory()   — asks GIT what the ids were, from `agents/agents.json`
 *     as it stood when the 2026-09-15 markdown migration deleted it. Needs no token and
 *     no network, and every clone carries it because it is history, not working tree.
 *     It is exact for THIS workspace and meaningless in any other, so it never writes
 *     anything a tracked file can see.
 *
 * It keys by the CURRENT declared `channel_name`, looked up per agent id — not by the
 * name the old convention would have produced. The legacy file recorded id -> channel
 * id; the definitions record id -> channel name; joining them on the agent id is what
 * makes the reconstruction survive a name correction (docs/AGENTS.md -> "Declared
 * channel name vs. the workspace's real one" corrected seven of eleven).
 *
 * NOTHING HERE CREATES A SLACK CHANNEL, and nothing here writes a tracked file.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const bridgeState = require('./bridge-state');
const { loadAgents } = require('./agent-registry');
const { resolveAgentChannel } = require('./agent-activation');

const REPO_ROOT = path.join(__dirname, '..');
const LEGACY_PATH = 'agents/agents.json';

/** A git object name we are willing to interpolate into a `<rev>^:<path>` argument. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Run git with an ARGV ARRAY — no shell, ever (CLAUDE.md -> Critical Rules).
 *
 * @param {string[]} args
 * @returns {string} stdout, trimmed.
 * @throws {Error} With git's own stderr attached.
 */
function git(args) {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * The legacy registry, from the working tree if it is still there (the documented
 * rollback path) or from the commit that deleted it.
 *
 * `git log` is the one subcommand where `--` does NOT separate options from
 * revisions — after `git log` it begins a PATHSPEC, which is exactly the use here
 * (CLAUDE.md -> "git positional args"). The resulting sha is shape-asserted before it
 * is interpolated into `git show`'s `<rev>^:<path>` argument, because that argument
 * cannot be split into an argv element of its own.
 *
 * @returns {{ ok: boolean, source: string, agents: object[]|null, reason?: string }}
 */
function readLegacyRegistry() {
    const onDisk = path.join(REPO_ROOT, LEGACY_PATH);
    if (fs.existsSync(onDisk)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(onDisk, 'utf8'));
            if (Array.isArray(parsed)) return { ok: true, source: `working tree (${LEGACY_PATH})`, agents: parsed };
            return { ok: false, source: 'working tree', agents: null, reason: `${LEGACY_PATH} is not an array` };
        } catch (err) {
            return { ok: false, source: 'working tree', agents: null, reason: `${LEGACY_PATH} is unreadable: ${err.message}` };
        }
    }

    let sha;
    try {
        sha = git(['log', '--diff-filter=D', '--format=%H', '-1', '--', LEGACY_PATH]);
    } catch (err) {
        return { ok: false, source: 'git', agents: null, reason: `git log failed: ${err.message}` };
    }
    if (!SHA_PATTERN.test(sha)) {
        return {
            ok: false, source: 'git', agents: null,
            reason: `no commit in this clone deletes ${LEGACY_PATH} (git log printed ${JSON.stringify(sha)}). ` +
                'A shallow clone has no such history — fetch the full history, or use --resolve instead.',
        };
    }

    let blob;
    try {
        blob = git(['show', `${sha}^:${LEGACY_PATH}`]);
    } catch (err) {
        return { ok: false, source: 'git', agents: null, reason: `git show ${sha}^:${LEGACY_PATH} failed: ${err.message}` };
    }
    try {
        const parsed = JSON.parse(blob);
        if (!Array.isArray(parsed)) return { ok: false, source: 'git', agents: null, reason: 'the historical file is not an array' };
        return { ok: true, source: `git ${sha.slice(0, 7)}^:${LEGACY_PATH}`, agents: parsed };
    } catch (err) {
        return { ok: false, source: 'git', agents: null, reason: `the historical file does not parse: ${err.message}` };
    }
}

/**
 * Merge new mappings into the local map WITHOUT overwriting anything already there.
 *
 * An id already in the map was resolved against the live workspace; a reconstructed
 * one was not. The live answer wins, always. Same rule the 2026-09-15 migration used.
 *
 * @param {Object<string,string>} additions - name -> id.
 * @param {boolean} dryRun
 * @returns {{ added: object, kept: object }}
 */
function mergeIntoMap(additions, dryRun) {
    const map = bridgeState.loadChannelMap();
    const added = {};
    const kept = {};
    for (const [name, id] of Object.entries(additions)) {
        if (map[name]) {
            if (map[name] !== id) kept[name] = { keeping: map[name], ignored: id };
            continue;
        }
        map[name] = id;
        added[name] = id;
    }
    if (!dryRun && Object.keys(added).length) bridgeState.saveChannelMap(map);
    return { added, kept };
}

/**
 * Rebuild the mapping from the deleted legacy registry in git history.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun] - Compute and report; write nothing.
 * @param {object[]} [options.agents] - Registry records; defaults to loadAgents().
 * @param {object} [options.legacy]   - Injected legacy read, for tests.
 * @returns {{ ok: boolean, source: string, recovered: object, added: object, kept: object, unrecovered: object[], conflicts: string[], reason?: string }}
 */
function reconstructFromHistory(options = {}) {
    const legacy = options.legacy || readLegacyRegistry();
    if (!legacy.ok) {
        return { ok: false, source: legacy.source, recovered: {}, added: {}, kept: {}, unrecovered: [], conflicts: [], reason: legacy.reason };
    }

    const agents = options.agents || loadAgents();
    const byId = new Map(agents.map(a => [a.id, a]));
    const recovered = {};
    const conflicts = [];

    for (const record of legacy.agents) {
        if (!record || !record.id || !record.channel) continue;
        const current = byId.get(record.id);
        if (!current || !current.channel_name) {
            conflicts.push(`${record.id}: held ${record.channel} but no current definition declares a channel_name for it`);
            continue;
        }
        const name = String(current.channel_name).replace(/^#/, '');
        if (recovered[name] && recovered[name] !== record.channel) {
            conflicts.push(`#${name}: ${recovered[name]} and ${record.channel} both claim it — nothing recovered for this name`);
            delete recovered[name];
            continue;
        }
        recovered[name] = record.channel;
    }

    const { added, kept } = mergeIntoMap(recovered, Boolean(options.dryRun));

    const unrecovered = agents
        .filter(a => a.channel_name && !recovered[String(a.channel_name).replace(/^#/, '')])
        .filter(a => !bridgeState.getChannelId(String(a.channel_name).replace(/^#/, '')))
        .map(a => ({ id: a.id, channel_name: a.channel_name, status: a.status || 'active' }));

    return { ok: true, source: legacy.source, recovered, added, kept, unrecovered, conflicts };
}

/**
 * Resolve every declared channel name that has no id yet against Slack, caching each
 * answer. This is the SAME call the boot path makes; running it here only moves it
 * earlier, so a restart is not needed to find out whether a name is real.
 *
 * @param {object} options
 * @param {object} options.slackClient - lib/slack-client.js wrapper.
 * @param {object[]} [options.agents]
 * @param {boolean} [options.includePlanned] - Also resolve agents this workspace has not activated.
 * @returns {Promise<{ resolved: object[], unresolved: object[] }>}
 */
async function resolveDeclaredChannels(options = {}) {
    const agents = options.agents || loadAgents();
    const resolved = [];
    const unresolved = [];

    for (const agent of agents) {
        if (!agent.channel_name) continue;
        if (!options.includePlanned && agent.status === 'planned') continue;
        const outcome = await resolveAgentChannel(agent, options.slackClient);
        if (outcome.resolved) {
            resolved.push({ id: agent.id, channel_name: agent.channel_name, channelId: outcome.channelId, source: outcome.source });
        } else {
            unresolved.push({ id: agent.id, channel_name: agent.channel_name, reason: outcome.reason });
        }
    }
    return { resolved, unresolved };
}

/**
 * The read-only picture: what every declared name resolves to right now. No Slack
 * call, no token, no write — safe from any checkout.
 *
 * @param {object[]} [agents]
 * @returns {Array<{ id: string, status: string, channel_name: string|null, channel: string|null, resolved: boolean }>}
 */
function report(agents) {
    return (agents || loadAgents()).map(a => ({
        id: a.id,
        status: a.status || 'active',
        channel_name: a.channel_name || null,
        channel: a.channel || null,
        resolved: Boolean(a.channel),
    }));
}

/**
 * Render a report as fixed-width lines.
 *
 * @param {object[]} rows - From report().
 * @returns {string[]}
 */
function formatReport(rows) {
    const head = ['AGENT', 'STATUS', 'DECLARED CHANNEL', 'RESOLVED ID'];
    const body = rows.map(r => [r.id, r.status, r.channel_name ? `#${r.channel_name}` : '—', r.channel || 'UNRESOLVED']);
    const widths = head.map((h, i) => Math.max(h.length, ...body.map(row => String(row[i]).length)));
    const line = cells => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
    return [line(head), line(widths.map(w => '-'.repeat(w))), ...body.map(line)];
}

module.exports = {
    readLegacyRegistry,
    reconstructFromHistory,
    resolveDeclaredChannels,
    mergeIntoMap,
    report,
    formatReport,
    LEGACY_PATH,
};
