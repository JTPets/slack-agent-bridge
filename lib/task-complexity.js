'use strict';

/**
 * lib/task-complexity.js
 *
 * The heuristic half of task decomposition: how complex a task's text looks (numbered
 * items, bullets, sequencing words, length) and whether that crosses the threshold for
 * asking a model to decompose it. Pure.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/task-decomposer.js, which re-exports every name. The decomposer has no production
 * caller (docs/WIRING-AND-SEAMS.md section 3); whether to wire or delete it is the
 * owner's decision and is not made here.
 */

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

module.exports = {
    analyzeComplexity,
    DEFAULT_COMPLEXITY_THRESHOLD,
    MULTI_TASK_INDICATORS,
};
