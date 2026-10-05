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
 *
 * LOGIC CHANGE 2026-10-05 (WORK-TODO #10): finding parsing moved to
 * lib/security-findings.js and dedup bookkeeping to lib/security-followup-dedup.js. This
 * file keeps the orchestration (processSecurityBulletin and its handler) and re-exports
 * every name it exported before.
 */

'use strict';

const approvalQueue = require('./approval-queue');
const {
    SEVERITY_LEVELS, SEVERITY_EMOJI, parseFindings, groupFindingsByFile, getHighestSeverity,
    findCodeAgent, buildTaskMessage, filterActionableFindings, formatFollowupSummary,
} = require('./security-findings');
const {
    generateDedupKey, wasRecentlyCreated, recordTaskCreated, cleanupDedupMap, clearDedupMap,
} = require('./security-followup-dedup');

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
