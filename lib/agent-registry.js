'use strict';

/**
 * lib/agent-registry.js
 *
 * Agent registry loader for multi-agent architecture.
 * Provides functions to load and query agent configurations from agents/agents.json.
 *
 * LOGIC CHANGE 2026-03-26: Initial implementation of agent registry system.
 * Supports loading agents from JSON, querying by ID or channel, and filtering
 * active agents (those without status="planned").
 *
 * LOGIC CHANGE 2026-03-26: Added agent activation helper for auto-channel creation.
 * When an agent's status changes from "planned" to "active", auto-creates a Slack
 * channel and updates the registry.
 *
 * LOGIC CHANGE 2026-09-15: THE MERGE POINT. An agent record now has two halves that
 * live in two places, and this module is where they meet:
 *
 *   TRACKED, PORTABLE   `agents/<id>/agent.md` — identity, role, personality,
 *                       provider, schedule, watches, and the channel NAME. Readable,
 *                       reviewable, deletable by anyone who takes this repository.
 *   LOCAL, PER-WORKSPACE `lib/bridge-state.js` — the Slack id that channel name
 *                       resolves to, and whether THIS workspace activated the agent.
 *                       Gitignored, so it survives auto-update's `git reset --hard`.
 *
 * The record `loadAgents()` returns is byte-identical in shape to the one
 * `agents/agents.json` used to return, which is what made this a one-file change:
 * ten non-test modules consume agent definitions and every one goes through here.
 *
 * `agents/agents.json` remains supported as a FALLBACK — used when no markdown
 * definition exists at all. That is the rollback path (`git revert` restores the
 * file with its ids) and it is what keeps the fs-mocked suites in
 * tests/agent-registry.test.js exercising a real code path.
 */

const fs = require('fs');
const path = require('path');
const { loadDefinitions } = require('./agent-markdown');
const bridgeState = require('./bridge-state');

const AGENTS_FILE = path.join(__dirname, '..', 'agents', 'agents.json');

/**
 * Load agents from the legacy `agents/agents.json` blob.
 *
 * Kept as the rollback path for the 2026-09-15 move to markdown definitions: it is
 * consulted only when no `agents/<id>/agent.md` exists. Reverting that commit
 * restores this file with its channel ids and the bridge reads it again, with no
 * manual step.
 *
 * @returns {Array} Array of agent configuration objects
 */
// LOGIC CHANGE 2026-03-28: Added corruption resilience to loadAgents().
// JSON.parse errors now log a warning and return [] instead of crashing the bot.
function loadLegacyAgents() {
    try {
        const data = fs.readFileSync(AGENTS_FILE, 'utf8');
        if (!data || !data.trim()) {
            console.warn('[agent-registry] agents.json is empty, returning []');
            return [];
        }
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
            console.warn('[agent-registry] agents.json is not an array, returning []');
            return [];
        }
        return parsed;
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        console.warn(`[agent-registry] Corrupted agents.json: ${err.message}. Returning [].`);
        return [];
    }
}

/**
 * Resolve one markdown definition into a full registry record by merging the
 * workspace-local half onto it.
 *
 * Two fields are computed here and nowhere else:
 *
 *   `channel` — the Slack id `channel_name` resolves to in THIS workspace, read
 *     from the local channel map. `null` when the name has never been resolved,
 *     which is the honest answer and the one the scheduler already knows how to
 *     refuse on. Nothing here contacts Slack; resolution is a lookup.
 *
 *   `status` — `'planned'` or absent, the shape every existing consumer already
 *     switches on (`getActiveAgents()` filters `status !== 'planned'`). It comes
 *     from the local activation decision when one exists, and falls back to the
 *     definition's declared `default_status` when none does. That fallback is what
 *     makes a fresh clone with no local state behave exactly as the tracked file
 *     says it should.
 *
 * @param {object} definition - Record from lib/agent-markdown.js.
 * @param {object} local - { channels, activations } read once by the caller.
 * @returns {object} Registry record.
 */
function applyWorkspaceState(definition, local) {
    const record = { ...definition };

    const name = definition.channel_name ? String(definition.channel_name).replace(/^#/, '') : null;
    record.channel = (name && local.channels[name]) || null;

    const decided = local.activations[definition.id];
    const activated = (decided && typeof decided.activated === 'boolean')
        ? decided.activated
        : definition.default_status !== 'planned';

    if (activated) delete record.status;
    else record.status = 'planned';

    return record;
}

/**
 * Load all agents: tracked markdown definitions merged with workspace-local state,
 * falling back to the legacy `agents/agents.json` when no definition exists.
 *
 * Reads from disk on every call — there is no cache, deliberately. A definition
 * edit is therefore live for every per-event consumer; the startup-derived state
 * (`channelsToPoll`, the scheduler's jobs, the bridge's own `agentConfig`) is not,
 * and that split is documented in docs/AGENTS.md.
 *
 * @returns {Array} Array of agent configuration objects
 */
function loadAgents() {
    const definitions = loadDefinitions();
    if (!definitions.length) return loadLegacyAgents();

    let local = { channels: {}, activations: {} };
    try {
        local = { channels: bridgeState.loadChannelMap(), activations: bridgeState.loadActivations() };
    } catch (err) {
        // Local state is a cache and an override; losing it must degrade to "nothing
        // is resolved and every default applies", never take the registry down.
        console.warn(`[agent-registry] Could not read workspace state: ${err.message}. Using declared defaults.`);
    }
    if (!local.channels || typeof local.channels !== 'object') local.channels = {};
    if (!local.activations || typeof local.activations !== 'object') local.activations = {};

    return definitions.map(def => applyWorkspaceState(def, local));
}

/**
 * Get a specific agent by ID
 * @param {string} id - The agent ID (e.g., "bridge", "secretary")
 * @returns {Object|null} Agent configuration or null if not found
 */
function getAgent(id) {
    const agents = loadAgents();
    return agents.find(agent => agent.id === id) || null;
}

/**
 * Get agent configuration by Slack channel ID
 * @param {string} channelId - The Slack channel ID
 * @returns {Object|null} Agent configuration or null if no agent handles this channel
 */
function getAgentByChannel(channelId) {
    if (!channelId) return null;
    const agents = loadAgents();
    return agents.find(agent => agent.channel === channelId) || null;
}

/**
 * Get all active agents (those without status="planned")
 * @returns {Array} Array of active agent configurations
 */
function getActiveAgents() {
    const agents = loadAgents();
    return agents.filter(agent => agent.status !== 'planned');
}

/**
 * Is there an agent registry at all?
 *
 * LOGIC CHANGE 2026-09-15: "at least one definition exists", not "agents.json
 * exists". bridge-agent.js gates its whole registry-vs-env-vars branch on this
 * (`bridge-agent.js:216`), so answering from the old file alone would have made
 * every markdown definition invisible to the bridge's own config.
 *
 * @returns {boolean}
 */
function registryExists() {
    if (loadDefinitions().length > 0) return true;
    return fs.existsSync(AGENTS_FILE);
}

/**
 * Get agent's memory directory path (absolute)
 * @param {string} id - The agent ID
 * @returns {string|null} Absolute path to memory directory or null if agent not found
 */
function getAgentMemoryDir(id) {
    const agent = getAgent(id);
    if (!agent || !agent.memory_dir) return null;
    return path.join(__dirname, '..', agent.memory_dir);
}

/**
 * LOGIC CHANGE 2026-03-26: Check if a repo is production (requires branch-and-pr workflow).
 * Looks for an agent with production: true that either has target_repo matching the repo,
 * or handles this specific repo via other configuration.
 * @param {string} repo - The repo in org/name format (e.g., "jtpets/SquareDashboardTool")
 * @returns {Object|null} Agent configuration if repo is production, null otherwise
 */
function getProductionAgentForRepo(repo) {
    if (!repo) return null;
    const agents = loadAgents();
    // Normalize repo to org/name format
    const normalizedRepo = repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
    return agents.find(agent =>
        agent.production === true &&
        agent.target_repo === normalizedRepo
    ) || null;
}

/**
 * LOGIC CHANGE 2026-03-26: Check if a repo requires production workflow.
 * Returns true if any agent with production: true targets this repo.
 * @param {string} repo - The repo in org/name format
 * @returns {boolean} True if repo requires production workflow
 */
function isProductionRepo(repo) {
    return getProductionAgentForRepo(repo) !== null;
}

/**
 * LOGIC CHANGE 2026-09-15: `saveAgents`, `updateAgent`, `activateAgent` and
 * `getAgentsNeedingActivation` were removed from this module.
 *
 * The first three wrote `agents/agents.json` back to disk. With definitions in
 * tracked markdown that file no longer governs, so they would have edited a
 * fallback nothing reads — and writing a TRACKED file at runtime is the defect
 * auto-update's `git reset --hard HEAD` has already destroyed twice.
 *
 * Activation moved to `lib/agent-activation.js`, which writes workspace-local
 * state instead and never creates a Slack channel. `activateAgent` and
 * `getAgentsNeedingActivation` are re-exported below so existing callers and the
 * smoke suite's export check are unchanged; `saveAgents` and `updateAgent` have no
 * replacement, because "change a definition" is now "edit the markdown file and
 * commit it", which is the whole point of the move.
 */

module.exports = {
    loadAgents,
    loadLegacyAgents,
    applyWorkspaceState,
    getAgent,
    getAgentByChannel,
    getActiveAgents,
    registryExists,
    getAgentMemoryDir,
    getProductionAgentForRepo,
    isProductionRepo,
    // Re-exported from lib/agent-activation.js. Required lazily to keep the cycle
    // out of module scope: agent-activation depends on this module's loadAgents.
    get activateAgent() { return require('./agent-activation').activateAgent; },
    get getAgentsNeedingActivation() { return require('./agent-activation').getAgentsNeedingActivation; },
};
