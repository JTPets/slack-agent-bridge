'use strict';

/**
 * lib/review-prompt.js
 *
 * Phase 2 of the code-review pipeline: buildPrompt assembles the prompt the executor
 * receives, in a fixed section order, from the Phase-1 context and the caller's parts.
 * Pure: builds a string.
 *
 * LOGIC CHANGE 2026-11-25 (WORK-TODO #10, B37): moved unchanged out of
 * lib/code-review-pipeline.js, which re-exports it.
 */

/**
 * Phase 2: Build the full enriched prompt for Claude.
 * Assembles in order: COMMANDMENTS → agent system prompt → production warning →
 * CLAUDE.md → memory/bulletin context → repo structure → relevant files →
 * skill content → execution plan → task instructions → quality checklist.
 *
 * @param {Object} task - Parsed task object
 * @param {Object} context - Context from reviewTask()
 * @param {Object} plan - Plan from createExecutionPlan()
 * @param {Object} [options] - Additional prompt components
 * @param {string} [options.commandmentsContent] - COMMANDMENTS.md content (from host repo)
 * @param {string} [options.agentSystemPrompt] - Agent personality/system prompt
 * @param {string} [options.productionWarning] - Production repo warning
 * @param {string} [options.skillContent] - SKILL.md content if applicable
 * @param {string} [options.memoryContext] - Task history context
 * @param {string} [options.bulletinContext] - Recent inter-agent bulletins
 * @param {string} [options.repoRef] - "repo (branch)" reference string
 * @returns {string} Complete assembled prompt
 */
function buildPrompt(task, context, plan, options = {}) {
    const {
        commandmentsContent = '',
        agentSystemPrompt = '',
        productionWarning = '',
        skillContent = '',
        memoryContext = '',
        bulletinContext = '',
        repoRef = '',
    } = options;

    const sections = [];

    // 1. COMMANDMENTS.md (host repo takes precedence; fallback to repo copy)
    const commandments = commandmentsContent || context.commandmentsContent || '';
    if (commandments) {
        sections.push('# COMMANDMENTS (Non-Negotiable Rules)\n' + commandments);
    }

    // 2. Agent system prompt (personality and expertise)
    if (agentSystemPrompt) {
        sections.push('# AGENT CONTEXT\n' + agentSystemPrompt);
    }

    // 3. Production warning (must appear prominently)
    if (productionWarning) {
        sections.push('# ⚠️ PRODUCTION REPO WARNING\n' + productionWarning);
    }

    // 4. CLAUDE.md rules from cloned repo
    if (context.claudeMdRules) {
        sections.push('# PROJECT RULES (CLAUDE.md)\n' + context.claudeMdRules);
    }

    // 5. Memory and bulletin context
    if (memoryContext) {
        sections.push(memoryContext);
    }
    if (bulletinContext) {
        sections.push(bulletinContext);
    }

    // 6. Codebase structure (so Claude knows what files exist)
    if (context.repoStructure) {
        sections.push('# CODEBASE STRUCTURE (JS files)\n' + context.repoStructure);
    }

    // 7. Recent git history (so Claude knows what was recently changed)
    if (context.gitLog) {
        sections.push('# RECENT GIT HISTORY\n' + context.gitLog);
    }

    // 8. Relevant existing files surfaced by keyword search
    const relevantEntries = Object.entries(context.relevantFiles);
    if (relevantEntries.length > 0) {
        const snippets = relevantEntries
            .map(([file, content]) => `## ${file}\n\`\`\`js\n${content}\n\`\`\``)
            .join('\n\n');
        sections.push('# RELEVANT EXISTING CODE\n' + snippets);
    }

    // 9. Skill template content
    if (skillContent) {
        sections.push('# SKILL TEMPLATE\n' + skillContent);
    }

    // 10. Repo reference
    if (repoRef) {
        sections.push(`You are working in a cloned repo: ${repoRef}.\nYour working directory is the repo root.`);
    }

    // 11. Commit/push instruction (skip for production repos which handle this differently)
    if (!productionWarning && repoRef) {
        sections.push('When done, commit and push your changes if you made any code changes.');
    }

    // 12. Original task instructions
    const taskText = task.instructions || task.description;
    if (taskText) {
        sections.push('# TASK\n' + taskText);
    }

    // 13. Quality checklist
    sections.push(`# QUALITY CHECKLIST (required before committing)
- Add a LOGIC CHANGE comment with today's date for every logic change: // LOGIC CHANGE YYYY-MM-DD: ...
- Run npm test before committing — ALL tests must pass
- Add a unit test for every new exported function (no new function ships without a test)
- Add a regression test for every bug fix
- No debugging console.log statements left in production code
- If new env vars added, document them in CLAUDE.md and .env.example
- No hardcoded secrets — all credentials via environment variables
- Temp directories cleaned up in finally blocks, not just success paths`);

    return sections.filter(Boolean).join('\n\n');
}

module.exports = { buildPrompt };
