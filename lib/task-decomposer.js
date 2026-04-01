'use strict';

/**
 * lib/task-decomposer.js
 *
 * LOGIC CHANGE 2026-04-01: Automated task decomposition system.
 * Analyzes complex tasks, identifies subtasks, routes to appropriate agents,
 * tracks dependencies, and aggregates results.
 *
 * Features:
 * - LLM-powered task analysis to detect multi-step tasks
 * - Automatic agent routing based on repo and task type
 * - Dependency tracking between subtasks
 * - Parallel execution of independent subtasks
 * - Result aggregation and summary generation
 */

const { runLLM } = require('./llm-runner');
const { getAgent, getActiveAgents, isProductionRepo } = require('./agent-registry');
const { parseTask } = require('./task-parser');

// Threshold for considering a task "complex" enough to decompose
const DEFAULT_COMPLEXITY_THRESHOLD = 3;

// Keywords indicating multiple logical tasks
const MULTI_TASK_INDICATORS = [
    /\band\b.*\band\b/i,           // Multiple "and" connectors
    /then\b/i,                     // Sequential tasks
    /also\b/i,                     // Additional tasks
    /first.*then/i,                // Sequential ordering
    /after.*do/i,                  // Dependencies
    /\d+\./,                       // Numbered lists
    /^\s*[-*]/m,                   // Bullet points (multiline)
    /finally\b/i,                  // Final step
    /additionally\b/i,             // More tasks
    /as well as\b/i,               // And also
];

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
 * Subtask status enum
 */
const SUBTASK_STATUS = {
    PENDING: 'pending',
    RUNNING: 'running',
    COMPLETED: 'completed',
    FAILED: 'failed',
    BLOCKED: 'blocked', // Waiting for dependency
    SKIPPED: 'skipped', // Dependency failed
};

/**
 * Analyze task text for complexity indicators
 * @param {string} text - Task text to analyze
 * @returns {object} Analysis result with complexity score and indicators
 */
function analyzeComplexity(text) {
    if (!text || typeof text !== 'string') {
        return { score: 0, indicators: [], isComplex: false };
    }

    const indicators = [];
    let score = 0;

    // Check for multi-task indicators
    for (const pattern of MULTI_TASK_INDICATORS) {
        if (pattern.test(text)) {
            indicators.push(pattern.toString());
            score += 1;
        }
    }

    // Check for numbered list items
    const numberedItems = text.match(/\d+\./g);
    if (numberedItems && numberedItems.length > 1) {
        score += numberedItems.length - 1;
        indicators.push(`${numberedItems.length} numbered items`);
    }

    // Check for bullet points
    const bulletItems = text.match(/^\s*[-*]\s+/gm);
    if (bulletItems && bulletItems.length > 1) {
        score += bulletItems.length - 1;
        indicators.push(`${bulletItems.length} bullet points`);
    }

    // Check for multiple REPO: mentions (rare but possible)
    const repoMentions = text.match(/REPO:/gi);
    if (repoMentions && repoMentions.length > 1) {
        score += repoMentions.length;
        indicators.push(`${repoMentions.length} repo mentions`);
    }

    // Length-based complexity
    const wordCount = text.split(/\s+/).length;
    if (wordCount > 200) {
        score += 2;
        indicators.push('Long task (200+ words)');
    } else if (wordCount > 100) {
        score += 1;
        indicators.push('Moderate task (100+ words)');
    }

    return {
        score,
        indicators,
        isComplex: score >= DEFAULT_COMPLEXITY_THRESHOLD,
        wordCount,
    };
}

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

/**
 * Create a subtask object
 * @param {object} options - Subtask options
 * @returns {object} Subtask object
 */
function createSubtask({
    id,
    parentTaskId,
    description,
    instructions,
    repo = null,
    branch = 'main',
    skill = '',
    agentId = 'bridge',
    dependsOn = [],
    priority = 0,
}) {
    return {
        id: id || `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        parentTaskId,
        description,
        instructions,
        repo,
        branch,
        skill,
        agentId,
        dependsOn, // Array of subtask IDs this depends on
        priority,  // Higher = run first (when no dependencies)
        status: SUBTASK_STATUS.PENDING,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
    };
}

/**
 * Build the LLM prompt for task decomposition
 * @param {object} task - Parsed task object
 * @returns {string} Prompt for LLM
 */
function buildDecompositionPrompt(task) {
    return `Analyze this task and break it down into logical subtasks if it contains multiple independent or sequential pieces of work.

## Task to Analyze

**Description:** ${task.description}
**Repository:** ${task.repo || 'None specified'}
**Instructions:**
${task.instructions}

## Your Analysis

Respond with a JSON object containing:
1. "shouldDecompose": boolean - true if this task should be broken into subtasks
2. "reasoning": string - brief explanation of why/why not to decompose
3. "subtasks": array of objects, each with:
   - "description": short title (under 50 chars)
   - "instructions": detailed instructions for this subtask
   - "dependsOn": array of subtask indices (0-based) this depends on
   - "priority": number 0-10 (higher = more important/urgent)
   - "taskType": one of "code", "security", "research", "documentation", "deploy", "email", "calendar", "social", "general"

## Rules

1. Only decompose if there are genuinely separate pieces of work
2. Keep subtasks focused - each should be completable in one LLM session
3. Preserve all context and requirements in subtask instructions
4. Mark dependencies correctly - e.g., if subtask 2 needs results from subtask 1
5. Don't artificially split atomic tasks - a single function implementation stays together
6. Maximum 5 subtasks - if more needed, group related work
7. If the task is already focused and atomic, set shouldDecompose to false

## Response Format

Return ONLY valid JSON, no markdown code fences:
{
  "shouldDecompose": true/false,
  "reasoning": "...",
  "subtasks": [...]
}`;
}

/**
 * Parse LLM response for decomposition
 * @param {string} response - LLM response text
 * @returns {object|null} Parsed decomposition or null if invalid
 */
function parseDecompositionResponse(response) {
    if (!response) return null;

    try {
        // Try to extract JSON from response
        let jsonStr = response.trim();

        // Remove markdown code fences if present
        if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
        }

        const parsed = JSON.parse(jsonStr);

        // Validate structure
        if (typeof parsed.shouldDecompose !== 'boolean') {
            console.warn('[task-decomposer] Invalid response: missing shouldDecompose');
            return null;
        }

        if (parsed.shouldDecompose && (!Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0)) {
            console.warn('[task-decomposer] Invalid response: shouldDecompose=true but no subtasks');
            return null;
        }

        return parsed;
    } catch (err) {
        console.warn('[task-decomposer] Failed to parse LLM response:', err.message);
        return null;
    }
}

/**
 * Decompose a task into subtasks using LLM analysis
 * @param {object} task - Parsed task object from parseTask()
 * @param {object} options - Options
 * @param {boolean} options.skipLLM - Skip LLM and use heuristics only (for testing)
 * @param {number} options.maxTurns - Max LLM turns (default 5)
 * @returns {Promise<object>} Decomposition result
 */
async function decomposeTask(task, options = {}) {
    const { skipLLM = false, maxTurns = 5 } = options;

    // First, analyze complexity heuristically
    const complexity = analyzeComplexity(task.instructions || task.raw);

    // If not complex enough, skip decomposition
    if (!complexity.isComplex && !skipLLM) {
        return {
            decomposed: false,
            reason: 'Task is not complex enough for decomposition',
            complexity,
            subtasks: [],
        };
    }

    // If skipLLM, return heuristic analysis only
    if (skipLLM) {
        return {
            decomposed: false,
            reason: 'LLM analysis skipped',
            complexity,
            subtasks: [],
        };
    }

    // Use LLM to analyze and decompose
    const prompt = buildDecompositionPrompt(task);

    try {
        const result = await runLLM(prompt, {
            maxTurns,
            provider: 'gemini', // Use Gemini for meta-analysis (faster, cheaper)
        });

        const parsed = parseDecompositionResponse(result.output);

        if (!parsed) {
            return {
                decomposed: false,
                reason: 'Failed to parse LLM decomposition response',
                complexity,
                subtasks: [],
                llmOutput: result.output,
            };
        }

        if (!parsed.shouldDecompose) {
            return {
                decomposed: false,
                reason: parsed.reasoning || 'LLM determined task is atomic',
                complexity,
                subtasks: [],
            };
        }

        // Convert LLM subtasks to our format
        const subtasks = parsed.subtasks.map((st, idx) => {
            const taskType = st.taskType || detectTaskType(st.instructions);
            const agent = findAgentForTask(task.repo, taskType);

            return createSubtask({
                id: `${Date.now()}-${idx}`,
                parentTaskId: task.id,
                description: st.description,
                instructions: st.instructions,
                repo: task.repo,
                branch: task.branch,
                skill: st.skill || task.skill || '',
                agentId: agent ? agent.id : 'bridge',
                dependsOn: (st.dependsOn || []).map(i => `${Date.now()}-${i}`),
                priority: st.priority || 0,
            });
        });

        // Fix dependency IDs after all subtasks created
        const baseId = subtasks[0]?.id.split('-').slice(0, 2).join('-');
        for (const st of subtasks) {
            st.dependsOn = st.dependsOn.map(depId => {
                const depIdx = parseInt(depId.split('-').pop(), 10);
                return `${baseId}-${depIdx}`;
            });
        }

        return {
            decomposed: true,
            reason: parsed.reasoning,
            complexity,
            subtasks,
        };
    } catch (err) {
        console.error('[task-decomposer] LLM decomposition failed:', err.message);
        return {
            decomposed: false,
            reason: `LLM error: ${err.message}`,
            complexity,
            subtasks: [],
            error: err.message,
        };
    }
}

/**
 * Determine which subtasks are ready to run (dependencies satisfied)
 * @param {Array} subtasks - All subtasks
 * @returns {Array} Subtasks ready to run
 */
function getReadySubtasks(subtasks) {
    const completedIds = new Set(
        subtasks
            .filter(st => st.status === SUBTASK_STATUS.COMPLETED)
            .map(st => st.id)
    );

    const failedIds = new Set(
        subtasks
            .filter(st => st.status === SUBTASK_STATUS.FAILED)
            .map(st => st.id)
    );

    return subtasks
        .filter(st => {
            // Skip already processed
            if (st.status !== SUBTASK_STATUS.PENDING) return false;

            // Check dependencies
            for (const depId of st.dependsOn) {
                if (failedIds.has(depId)) {
                    // Dependency failed - mark as skipped
                    st.status = SUBTASK_STATUS.SKIPPED;
                    st.error = `Dependency ${depId} failed`;
                    return false;
                }
                if (!completedIds.has(depId)) {
                    // Dependency not yet complete
                    st.status = SUBTASK_STATUS.BLOCKED;
                    return false;
                }
            }

            // All dependencies satisfied
            return true;
        })
        .sort((a, b) => b.priority - a.priority);
}

/**
 * Check if all subtasks are complete (or skipped/failed)
 * @param {Array} subtasks - All subtasks
 * @returns {boolean} True if all done
 */
function allSubtasksComplete(subtasks) {
    return subtasks.every(st =>
        st.status === SUBTASK_STATUS.COMPLETED ||
        st.status === SUBTASK_STATUS.FAILED ||
        st.status === SUBTASK_STATUS.SKIPPED
    );
}

/**
 * Generate a summary of decomposition results
 * @param {Array} subtasks - Completed subtasks
 * @returns {string} Summary text
 */
function generateSummary(subtasks) {
    const completed = subtasks.filter(st => st.status === SUBTASK_STATUS.COMPLETED);
    const failed = subtasks.filter(st => st.status === SUBTASK_STATUS.FAILED);
    const skipped = subtasks.filter(st => st.status === SUBTASK_STATUS.SKIPPED);

    const lines = [];
    lines.push(`## Task Decomposition Results`);
    lines.push('');
    lines.push(`- **Total subtasks:** ${subtasks.length}`);
    lines.push(`- **Completed:** ${completed.length}`);
    lines.push(`- **Failed:** ${failed.length}`);
    lines.push(`- **Skipped:** ${skipped.length}`);
    lines.push('');

    if (completed.length > 0) {
        lines.push('### Completed:');
        for (const st of completed) {
            lines.push(`- :white_check_mark: ${st.description}`);
        }
        lines.push('');
    }

    if (failed.length > 0) {
        lines.push('### Failed:');
        for (const st of failed) {
            lines.push(`- :x: ${st.description}: ${st.error || 'Unknown error'}`);
        }
        lines.push('');
    }

    if (skipped.length > 0) {
        lines.push('### Skipped (dependency failed):');
        for (const st of skipped) {
            lines.push(`- :fast_forward: ${st.description}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format a subtask as a TASK: message for execution
 * @param {object} subtask - Subtask object
 * @param {object} context - Additional context from previous subtasks
 * @returns {string} Formatted task message
 */
function formatSubtaskAsMessage(subtask, context = {}) {
    const lines = [];
    lines.push(`TASK: ${subtask.description}`);

    if (subtask.repo) {
        lines.push(`REPO: ${subtask.repo}`);
    }

    if (subtask.branch && subtask.branch !== 'main') {
        lines.push(`BRANCH: ${subtask.branch}`);
    }

    if (subtask.skill) {
        lines.push(`SKILL: ${subtask.skill}`);
    }

    // Include context from dependent subtasks
    let instructions = subtask.instructions;
    if (context.previousResults && Object.keys(context.previousResults).length > 0) {
        instructions = `## Context from Previous Subtasks\n\n`;
        for (const [id, result] of Object.entries(context.previousResults)) {
            if (subtask.dependsOn.includes(id)) {
                instructions += `### From subtask ${id}:\n${result}\n\n`;
            }
        }
        instructions += `## Current Subtask Instructions\n\n${subtask.instructions}`;
    }

    lines.push(`INSTRUCTIONS: ${instructions}`);

    return lines.join('\n');
}

module.exports = {
    // Core functions
    analyzeComplexity,
    detectTaskType,
    decomposeTask,
    findAgentForTask,

    // Subtask management
    createSubtask,
    getReadySubtasks,
    allSubtasksComplete,

    // Formatting
    generateSummary,
    formatSubtaskAsMessage,
    buildDecompositionPrompt,
    parseDecompositionResponse,

    // Constants
    SUBTASK_STATUS,
    DEFAULT_COMPLEXITY_THRESHOLD,
    MULTI_TASK_INDICATORS,
    TASK_TYPE_PATTERNS,
};
