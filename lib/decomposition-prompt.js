'use strict';

/**
 * lib/decomposition-prompt.js
 *
 * The model half of decomposition as text: the prompt that asks for a JSON
 * decomposition, and the parser that accepts or refuses the answer. Pure (it logs why an
 * answer was refused).
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-decomposer.js, which re-exports every name. The decomposer has no production
 * caller (docs/WIRING-AND-SEAMS.md section 3); whether to wire or delete it is the
 * owner's decision and is not made here.
 */

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

module.exports = {
    buildDecompositionPrompt,
    parseDecompositionResponse,
};
