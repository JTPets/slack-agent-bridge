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

module.exports = {
    loadAgents,
    getAgent,
    getAgentByChannel,
    getActiveAgents,
    registryExists,
    getAgentMemoryDir,
    getProductionAgentForRepo,
    isProductionRepo
};
