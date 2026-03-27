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
 */

const fs = require('fs');
const path = require('path');

const AGENTS_FILE = path.join(__dirname, '..', 'agents', 'agents.json');

/**
 * Load all agents from agents.json
 * @returns {Array} Array of agent configuration objects
 * @throws {Error} If file exists but contains invalid JSON
 */
function loadAgents() {
    try {
        const data = fs.readFileSync(AGENTS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return [];
        }
        throw err;
    }
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
 * Check if agent registry file exists
 * @returns {boolean} True if agents.json exists
 */
function registryExists() {
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
 * Save agents array back to agents.json.
 * @param {Array} agents - Array of agent configuration objects
 * @throws {Error} If write fails
 */
function saveAgents(agents) {
    const data = JSON.stringify(agents, null, 2) + '\n';
    fs.writeFileSync(AGENTS_FILE, data, 'utf8');
}

/**
 * LOGIC CHANGE 2026-03-26: Update an agent's configuration in the registry.
 * @param {string} id - Agent ID to update
 * @param {Object} updates - Fields to update (merged with existing config)
 * @returns {Object|null} Updated agent config or null if agent not found
 */
function updateAgent(id, updates) {
    const agents = loadAgents();
    const index = agents.findIndex(agent => agent.id === id);
    if (index === -1) return null;

    agents[index] = { ...agents[index], ...updates };
    saveAgents(agents);
    return agents[index];
}

/**
 * LOGIC CHANGE 2026-03-26: Activate an agent by changing status from "planned" to "active".
 * If the agent has no channel assigned, auto-creates one using the slackClient.
 * Channel name is derived from agent ID (e.g., "secretary" -> "secretary-agent").
 *
 * @param {string} id - Agent ID to activate
 * @param {Object} slackClient - SlackClient wrapper from lib/slack-client.js
 * @returns {Promise<{ agent: Object, channelCreated: boolean, channelId: string|null }>}
 * @throws {Error} If agent not found or activation fails
 */
async function activateAgent(id, slackClient) {
    const agent = getAgent(id);
    if (!agent) {
        throw new Error(`Agent not found: ${id}`);
    }

    // Only activate if currently planned
    if (agent.status !== 'planned') {
        throw new Error(`Agent ${id} is not in "planned" status (current: ${agent.status || 'active'})`);
    }

    let channelCreated = false;
    let channelId = agent.channel;

    // Auto-create channel if none assigned
    if (!agent.channel && slackClient) {
        const channelName = `${id}-agent`;
        const topic = `${agent.name} - ${agent.role}`;

        try {
            const result = await slackClient.ensureChannel(channelName, topic);
            channelId = result.channelId;
            channelCreated = result.created;
        } catch (err) {
            // Log error but continue with activation (channel can be assigned later)
            console.error(`[agent-registry] Failed to create channel for ${id}:`, err.message);
        }
    }

    // Update agent in registry
    const updates = {
        status: undefined, // Remove "planned" status to mark as active
    };
    if (channelId && channelId !== agent.channel) {
        updates.channel = channelId;
    }

    // Remove status field entirely (active agents have no status field)
    const agents = loadAgents();
    const index = agents.findIndex(a => a.id === id);
    if (index !== -1) {
        delete agents[index].status;
        if (channelId) {
            agents[index].channel = channelId;
        }
        saveAgents(agents);
    }

    return {
        agent: getAgent(id),
        channelCreated,
        channelId,
    };
}

/**
 * LOGIC CHANGE 2026-03-26: Get agents that need activation (planned status, no channel).
 * @returns {Array} Array of agents with status="planned" and no channel assigned
 */
function getAgentsNeedingActivation() {
    const agents = loadAgents();
    return agents.filter(agent => agent.status === 'planned' && !agent.channel);
}

module.exports = {
    loadAgents,
    getAgent,
    getAgentByChannel,
    getActiveAgents,
    registryExists,
    getAgentMemoryDir,
    getProductionAgentForRepo,
    isProductionRepo,
    saveAgents,
    updateAgent,
    activateAgent,
    getAgentsNeedingActivation,
};
