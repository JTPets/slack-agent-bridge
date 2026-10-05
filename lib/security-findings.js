/**
 * lib/security-findings.js
 *
 * Turning a security review's text into remediation work: the severity scale, parsing
 * findings, grouping them by file, picking the code agent for a repo, the TASK message
 * for one file, which findings are actionable, and the summary line. Pure apart from
 * reading the agent registry.
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): moved out of lib/security-followup.js
 * unchanged, on the boundary #10 names (finding parsing vs. dedup bookkeeping vs. the
 * Slack-side orchestration). lib/security-followup.js re-exports every name.
 */

'use strict';

const { getAgent, loadAgents } = require('./agent-registry');

// Severity levels in priority order
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// Severity emoji mapping for Slack messages
const SEVERITY_EMOJI = {
    CRITICAL: ':rotating_light:',
    HIGH: ':warning:',
    MEDIUM: ':large_yellow_circle:',
    LOW: ':information_source:',
};

/**
 * Parse a security review output to extract individual findings.
 * Expects format: "SEVERITY: [issue] - [file:line] - [fix recommendation]"
 *
 * @param {string} reviewText - The raw security review output
 * @returns {Array<{severity: string, issue: string, file: string, line: number|null, fix: string}>}
 */
function parseFindings(reviewText) {
    if (!reviewText || typeof reviewText !== 'string') {
        return [];
    }

    const findings = [];
    const lines = reviewText.split('\n');

    // Match patterns like:
    // CRITICAL: SQL injection in login handler - src/auth.js:42 - Use parameterized queries
    // HIGH: Hardcoded API key - config.js:15 - Move to environment variable
    const findingPattern = /^(CRITICAL|HIGH|MEDIUM|LOW):\s*(.+?)\s*-\s*([^:]+):?(\d+)?\s*-\s*(.+)$/i;

    for (const line of lines) {
        const trimmed = line.trim();
        const match = trimmed.match(findingPattern);

        if (match) {
            const [, severity, issue, file, lineNum, fix] = match;
            findings.push({
                severity: severity.toUpperCase(),
                issue: issue.trim(),
                file: file.trim(),
                line: lineNum ? parseInt(lineNum, 10) : null,
                fix: fix.trim(),
            });
        }
    }

    return findings;
}

/**
 * Group findings by file for efficient task creation.
 *
 * @param {Array} findings - Array of finding objects
 * @returns {Map<string, Array>} Map of file path to findings in that file
 */
function groupFindingsByFile(findings) {
    const groups = new Map();

    for (const finding of findings) {
        const file = finding.file;
        if (!groups.has(file)) {
            groups.set(file, []);
        }
        groups.get(file).push(finding);
    }

    return groups;
}

/**
 * Get the highest severity in a list of findings.
 *
 * @param {Array} findings - Array of finding objects
 * @returns {string} The highest severity level
 */
function getHighestSeverity(findings) {
    for (const severity of SEVERITY_LEVELS) {
        if (findings.some(f => f.severity === severity)) {
            return severity;
        }
    }
    return 'LOW';
}

/**
 * Determine which code agent should handle a repo's security fixes.
 *
 * @param {string} repo - The repository name (e.g., "jtpets/slack-agent-bridge")
 * @returns {{ agentId: string, channelId: string|null }}
 */
function findCodeAgent(repo) {
    const agents = loadAgents();

    // Find an agent with matching target_repo
    const targetAgent = agents.find(a =>
        a.target_repo === repo &&
        !a.status &&
        a.channel
    );

    if (targetAgent) {
        return { agentId: targetAgent.id, channelId: targetAgent.channel };
    }

    // Default to bridge agent for unmatched repos
    const bridge = getAgent('bridge');
    return {
        agentId: 'bridge',
        channelId: bridge ? bridge.channel : null,
    };
}

/**
 * Build a TASK message for a group of findings in a file.
 *
 * @param {string} repo - Repository name
 * @param {string} file - File path
 * @param {Array} findings - Findings in this file
 * @returns {string} TASK message text
 */
function buildTaskMessage(repo, file, findings) {
    const highestSeverity = getHighestSeverity(findings);
    const emoji = SEVERITY_EMOJI[highestSeverity];

    // Build instructions listing each finding
    const instructions = findings.map((f, i) => {
        const lineRef = f.line ? `:${f.line}` : '';
        return `${i + 1}. [${f.severity}] ${f.issue}\n   Location: ${f.file}${lineRef}\n   Fix: ${f.fix}`;
    }).join('\n\n');

    return `${emoji} *Security Remediation Required*

TASK: Fix ${highestSeverity} security finding${findings.length > 1 ? 's' : ''} in ${file}
REPO: ${repo}
SKILL: security-fix
INSTRUCTIONS:
Security audit found ${findings.length} issue${findings.length > 1 ? 's' : ''} in \`${file}\`:

${instructions}

After fixing:
1. Run \`npm test\` to ensure no regressions
2. Add a LOGIC CHANGE comment explaining the security fix
3. Commit with message: "fix(security): address ${highestSeverity} finding in ${file}"`;
}

/**
 * Determine if findings warrant automatic task creation.
 * Only CRITICAL and HIGH severity findings trigger auto-tasks.
 *
 * @param {Array} findings - All findings from the review
 * @param {object} options - Configuration options
 * @param {boolean} options.includemedium - Also create tasks for MEDIUM findings
 * @returns {Array} Findings that should trigger task creation
 */
function filterActionableFindings(findings, options = {}) {
    const { includeMedium = false } = options;

    const actionableSeverities = ['CRITICAL', 'HIGH'];
    if (includeMedium) {
        actionableSeverities.push('MEDIUM');
    }

    return findings.filter(f => actionableSeverities.includes(f.severity));
}

/**
 * Format a summary of the followup results for Slack.
 *
 * @param {object} result - Result from processSecurityBulletin
 * @returns {string} Formatted summary message
 */
function formatFollowupSummary(result) {
    const lines = [];

    // LOGIC CHANGE 2026-04-01: Added queued tasks to summary output.
    // Queued tasks await owner approval before execution.
    if (result.queued && result.queued.length > 0) {
        lines.push(`:hourglass: Queued ${result.queued.length} task(s) for approval:`);
        for (const task of result.queued) {
            const emoji = SEVERITY_EMOJI[task.highestSeverity];
            lines.push(`  ${emoji} \`${task.id}\` - ${task.file} (${task.findingCount} finding${task.findingCount > 1 ? 's' : ''})`);
        }
        lines.push('\nUse `ASK: pending approvals` to review and approve tasks.');
    }

    if (result.tasks.length > 0) {
        lines.push(`:white_check_mark: Created ${result.tasks.length} remediation task(s):`);
        for (const task of result.tasks) {
            const emoji = SEVERITY_EMOJI[task.highestSeverity];
            lines.push(`  ${emoji} ${task.file} (${task.findingCount} finding${task.findingCount > 1 ? 's' : ''})`);
        }
    }

    if (result.skipped.length > 0) {
        lines.push(`\n:fast_forward: Skipped ${result.skipped.length} item(s):`);
        for (const skip of result.skipped) {
            lines.push(`  - ${skip.reason}${skip.file ? `: ${skip.file}` : ''}`);
        }
    }

    if (result.errors.length > 0) {
        lines.push(`\n:x: ${result.errors.length} error(s):`);
        for (const err of result.errors) {
            lines.push(`  - ${err.error}${err.file ? ` (${err.file})` : ''}`);
        }
    }

    if (lines.length === 0) {
        return 'No security followup actions taken.';
    }

    return lines.join('\n');
}

module.exports = {
    SEVERITY_LEVELS, SEVERITY_EMOJI, parseFindings, groupFindingsByFile, getHighestSeverity,
    findCodeAgent, buildTaskMessage, filterActionableFindings, formatFollowupSummary,
};
