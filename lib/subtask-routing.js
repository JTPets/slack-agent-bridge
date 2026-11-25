'use strict';

/**
 * lib/subtask-routing.js
 *
 * Which agent a subtask goes to: detectTaskType reads the task type from its text, and
 * findAgentForTask picks an active agent by repository first, then by type.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-decomposer.js, which re-exports every name. The decomposer has no production
 * caller (docs/WIRING-AND-SEAMS.md section 3); whether to wire or delete it is the
 * owner's decision and is not made here.
 */

const { getActiveAgents } = require('./agent-registry');

// Task type patterns for agent routing
const TASK_TYPE_PATTERNS = {
    code: /\b(implement|refactor|fix|bug|code|function|class|module|test|lint)\b/i,
    security: /\b(security|vulnerabilit\w*|audit|scan|cve|owasp|credential|secret|token)\b/i,
    research: /\b(research|investigate|compare|analyze|evaluate|pros.*cons|options)\b/i,
    documentation: /\b(document|readme|docs|update.*claude\.md|jsdoc)\b/i,
    deploy: /\b(deploy|release|publish|build|ci\/cd|pipeline)\b/i,
    email: /\b(email|inbox|unsubscribe|newsletter|gmail)\b/i,
    calendar: /\b(calendar|schedule|meeting|appointment|event)\b/i,
    social: /\b(instagram|facebook|linkedin|social.*media|post|content)\b/i,
};

/**
 * Detect the primary task type for agent routing
 * @param {string} text - Task text
 * @returns {string} Task type identifier
 */
function detectTaskType(text) {
    if (!text) return 'general';

    for (const [type, pattern] of Object.entries(TASK_TYPE_PATTERNS)) {
        if (pattern.test(text)) {
            return type;
        }
    }

    return 'general';
}

/**
 * Find the best agent for a subtask based on repo and type
 * @param {string} repo - Target repository
 * @param {string} taskType - Type of task
 * @returns {object|null} Agent config or null if no match
 */
function findAgentForTask(repo, taskType) {
    const agents = getActiveAgents();

    // First, check for repo-specific agents
    if (repo) {
        const repoAgent = agents.find(a => a.target_repo === repo);
        if (repoAgent) {
            return repoAgent;
        }
    }

    // Then check for task-type specific agents
    switch (taskType) {
        case 'security':
            return agents.find(a => a.id === 'security') || null;
        case 'email':
            return agents.find(a => a.id === 'email-monitor' || a.id === 'secretary') || null;
        case 'calendar':
            return agents.find(a => a.id === 'secretary') || null;
        case 'social':
            return agents.find(a => a.id === 'social-media') || null;
        case 'documentation':
        case 'code':
        case 'deploy':
            // Check for repo-specific code agents
            if (repo && repo.includes('slack-agent-bridge')) {
                return agents.find(a => a.id === 'code-bridge') || null;
            }
            if (repo && repo.includes('SquareDashboardTool')) {
                return agents.find(a => a.id === 'code-sqtools') || null;
            }
            return agents.find(a => a.id === 'bridge') || null;
        default:
            return agents.find(a => a.id === 'bridge') || null;
    }
}

module.exports = {
    detectTaskType,
    findAgentForTask,
    TASK_TYPE_PATTERNS,
};
