/**
 * lib/security-followup.js
 *
 * Security finding → auto-task pipeline.
 * Parses security review bulletins and generates TASK messages to fix findings.
 *
 * LOGIC CHANGE 2026-04-01: Initial implementation of security followup pipeline.
 * When security-review.js posts a security_finding bulletin, this module:
 * 1. Parses the review output for CRITICAL/HIGH/MEDIUM/LOW findings
 * 2. Groups findings by file to create focused remediation tasks
 * 3. Posts TASK messages to the appropriate code agent channel
 * 4. Tracks which findings have been addressed via bulletin board
 *
 * LOGIC CHANGE 2026-04-01: Added approval queue integration.
 * Auto-generated tasks are now queued for owner approval instead of posting
 * directly. This prevents potential prompt injection attacks via malicious
 * security findings or manipulated review output.
 */

'use strict';

const { getAgent, loadAgents } = require('./agent-registry');
const approvalQueue = require('./approval-queue');

// Severity levels in priority order
const SEVERITY_LEVELS = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

// Severity emoji mapping for Slack messages
const SEVERITY_EMOJI = {
    CRITICAL: ':rotating_light:',
    HIGH: ':warning:',
    MEDIUM: ':large_yellow_circle:',
    LOW: ':information_source:',
};

// Rate limiting: track recently created tasks to avoid duplicates
const recentTasks = new Map();
const TASK_DEDUP_MS = 24 * 60 * 60 * 1000; // 24 hours

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
 * Generate a unique key for deduplication.
 *
 * @param {string} repo - Repository name
 * @param {string} file - File path
 * @param {string} severity - Severity level
 * @returns {string} Dedup key
 */
function generateDedupKey(repo, file, severity) {
    return `${repo}:${file}:${severity}`;
}

/**
 * Check if a task was recently created (within dedup window).
 *
 * @param {string} key - Deduplication key
 * @returns {boolean} True if recently created
 */
function wasRecentlyCreated(key) {
    const created = recentTasks.get(key);
    if (!created) return false;
    return (Date.now() - created) < TASK_DEDUP_MS;
}

/**
 * Record that a task was created.
 *
 * @param {string} key - Deduplication key
 */
function recordTaskCreated(key) {
    recentTasks.set(key, Date.now());
}

/**
 * Clean up old entries from the dedup map.
 */
function cleanupDedupMap() {
    const now = Date.now();
    for (const [key, created] of recentTasks) {
        if ((now - created) > TASK_DEDUP_MS) {
            recentTasks.delete(key);
        }
    }
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
 * Process a security_finding bulletin and generate TASK messages.
 *
 * LOGIC CHANGE 2026-04-01: Tasks are now queued for approval instead of posting
 * directly. Use skipApproval=true to bypass the queue (for testing or when
 * the approval queue feature is disabled).
 *
 * @param {object} slack - Slack WebClient instance
 * @param {object} bulletin - The security_finding bulletin
 * @param {object} options - Configuration options
 * @param {boolean} options.includeMedium - Include MEDIUM severity in auto-tasks
 * @param {boolean} options.dryRun - If true, don't actually post messages
 * @param {boolean} options.skipApproval - If true, post directly without queuing for approval
 * @returns {Promise<{tasks: Array, queued: Array, skipped: Array, errors: Array}>}
 */
async function processSecurityBulletin(slack, bulletin, options = {}) {
    const { includeMedium = false, dryRun = false, skipApproval = false } = options;

    const result = {
        tasks: [],
        queued: [],
        skipped: [],
        errors: [],
    };

    // Validate bulletin
    if (!bulletin || !bulletin.data) {
        result.errors.push({ error: 'Invalid bulletin: missing data' });
        return result;
    }

    const { repo, summary, fullReview } = bulletin.data;
    if (!repo) {
        result.errors.push({ error: 'Invalid bulletin: missing repo' });
        return result;
    }

    // LOGIC CHANGE 2026-04-01: Prefer fullReview over summary for parsing.
    // fullReview contains the complete security review output with all findings.
    // Falls back to summary (500 chars) if fullReview not available.
    const reviewText = fullReview || summary || '';

    // Parse findings from the review
    const allFindings = parseFindings(reviewText);

    if (allFindings.length === 0) {
        console.log(`[security-followup] No parseable findings in bulletin for ${repo}`);
        // Check if this is an "all clear" message
        if (reviewText.includes('All clear') || reviewText.includes('No security issues')) {
            result.skipped.push({ reason: 'No issues found', repo });
        } else {
            result.skipped.push({ reason: 'No parseable findings', repo });
        }
        return result;
    }

    console.log(`[security-followup] Found ${allFindings.length} finding(s) in ${repo}`);

    // Filter to actionable findings
    const actionableFindings = filterActionableFindings(allFindings, { includeMedium });

    if (actionableFindings.length === 0) {
        console.log(`[security-followup] No actionable findings (CRITICAL/HIGH) in ${repo}`);
        result.skipped.push({
            reason: 'No CRITICAL/HIGH findings',
            repo,
            lowMediumCount: allFindings.length,
        });
        return result;
    }

    // Group by file
    const fileGroups = groupFindingsByFile(actionableFindings);

    // Find the code agent for this repo
    const { agentId, channelId } = findCodeAgent(repo);

    if (!channelId) {
        result.errors.push({
            error: `No channel found for agent ${agentId}`,
            repo,
        });
        return result;
    }

    // Clean up old dedup entries
    cleanupDedupMap();

    // Create a task for each file with findings
    for (const [file, findings] of fileGroups) {
        const highestSeverity = getHighestSeverity(findings);
        const dedupKey = generateDedupKey(repo, file, highestSeverity);

        // Check deduplication
        if (wasRecentlyCreated(dedupKey)) {
            console.log(`[security-followup] Skipping duplicate task for ${file} in ${repo}`);
            result.skipped.push({
                reason: 'Duplicate within 24h',
                file,
                repo,
            });
            continue;
        }

        // Build the task message
        const taskMessage = buildTaskMessage(repo, file, findings);

        if (dryRun) {
            console.log(`[security-followup] DRY RUN - Would queue for approval: ${file}`);
            result.tasks.push({
                file,
                repo,
                agentId,
                channelId,
                findingCount: findings.length,
                highestSeverity,
                dryRun: true,
            });
            continue;
        }

        // LOGIC CHANGE 2026-04-01: Queue tasks for approval instead of posting directly.
        // This prevents prompt injection attacks via malicious security findings.
        // Tasks remain in the approval queue until the owner explicitly approves them.
        if (!skipApproval) {
            const queueResult = approvalQueue.queueTask({
                source: 'security-followup',
                targetChannel: channelId,
                targetAgent: agentId,
                taskMessage,
                metadata: {
                    repo,
                    file,
                    findingCount: findings.length,
                    highestSeverity,
                    findings: findings.map(f => ({
                        severity: f.severity,
                        issue: f.issue,
                        line: f.line,
                    })),
                },
            });

            if (queueResult.queued) {
                // Record for deduplication
                recordTaskCreated(dedupKey);

                console.log(`[security-followup] Queued task ${queueResult.id} for ${file} (awaiting approval)`);
                result.queued.push({
                    id: queueResult.id,
                    file,
                    repo,
                    agentId,
                    channelId,
                    findingCount: findings.length,
                    highestSeverity,
                });
            } else {
                result.errors.push({
                    error: queueResult.reason || 'Failed to queue task',
                    file,
                    repo,
                });
            }
            continue;
        }

        // Skip approval mode: post directly (legacy behavior)
        try {
            await slack.chat.postMessage({
                channel: channelId,
                text: taskMessage,
                unfurl_links: false,
            });

            // Record for deduplication
            recordTaskCreated(dedupKey);

            console.log(`[security-followup] Posted task for ${file} to ${agentId} (${channelId})`);
            result.tasks.push({
                file,
                repo,
                agentId,
                channelId,
                findingCount: findings.length,
                highestSeverity,
            });
        } catch (err) {
            console.error(`[security-followup] Failed to post task for ${file}:`, err.message);
            result.errors.push({
                error: err.message,
                file,
                repo,
            });
        }
    }

    return result;
}

/**
 * Create a bulletin watcher handler for security_finding bulletins.
 * This integrates with the existing bulletin-watcher.js system.
 *
 * @param {object} slack - Slack WebClient instance
 * @param {object} options - Configuration options
 * @returns {Function} Handler function for security_finding bulletins
 */
function createSecurityFollowupHandler(slack, options = {}) {
    return async function handleSecurityFinding(bulletin) {
        // Only process security_finding bulletins
        if (bulletin.type !== 'security_finding') {
            return { skipped: true, reason: 'Not a security_finding bulletin' };
        }

        const result = await processSecurityBulletin(slack, bulletin, options);

        // Log summary
        // LOGIC CHANGE 2026-04-01: Added logging for queued tasks.
        if (result.queued && result.queued.length > 0) {
            console.log(`[security-followup] Queued ${result.queued.length} task(s) for approval`);
        }
        if (result.tasks.length > 0) {
            console.log(`[security-followup] Created ${result.tasks.length} task(s) from security findings`);
        }
        if (result.errors.length > 0) {
            console.error(`[security-followup] ${result.errors.length} error(s) during task creation`);
        }

        return result;
    };
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

/**
 * Clear dedup map (for testing).
 */
function clearDedupMap() {
    recentTasks.clear();
}

module.exports = {
    parseFindings,
    groupFindingsByFile,
    getHighestSeverity,
    findCodeAgent,
    buildTaskMessage,
    filterActionableFindings,
    processSecurityBulletin,
    createSecurityFollowupHandler,
    formatFollowupSummary,
    wasRecentlyCreated,
    recordTaskCreated,
    cleanupDedupMap,
    clearDedupMap,
    SEVERITY_LEVELS,
    SEVERITY_EMOJI,
};
