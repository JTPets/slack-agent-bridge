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

module.exports = {
    loadAgents,
    getAgent,
    getAgentByChannel,
    getActiveAgents,
    registryExists,
    getAgentMemoryDir
};
