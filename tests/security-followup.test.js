/**
 * tests/security-followup.test.js
 *
 * Unit tests for lib/security-followup.js
 * Tests security finding parsing, task generation, and the followup pipeline.
 *
 * LOGIC CHANGE 2026-04-01: Added tests for security followup pipeline.
 */

'use strict';

// Set required env vars before loading modules
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
process.env.BRIDGE_CHANNEL_ID = 'C_BRIDGE_TEST';
process.env.OPS_CHANNEL_ID = 'C_OPS_TEST';

const securityFollowup = require('../lib/security-followup');
const approvalQueue = require('../lib/approval-queue');

describe('security-followup', () => {
    beforeEach(() => {
        // Clear dedup map and approval queue before each test
        securityFollowup.clearDedupMap();
        approvalQueue.clearQueue();
    });

    describe('parseFindings', () => {
        test('parses CRITICAL finding with file and line', () => {
            const review = 'CRITICAL: SQL injection in login handler - src/auth.js:42 - Use parameterized queries';
            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(1);
            expect(findings[0]).toEqual({
                severity: 'CRITICAL',
                issue: 'SQL injection in login handler',
                file: 'src/auth.js',
                line: 42,
                fix: 'Use parameterized queries',
            });
        });

        test('parses HIGH finding without line number', () => {
            const review = 'HIGH: Hardcoded API key - config.js - Move to environment variable';
            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(1);
            expect(findings[0]).toEqual({
                severity: 'HIGH',
                issue: 'Hardcoded API key',
                file: 'config.js',
                line: null,
                fix: 'Move to environment variable',
            });
        });

        test('parses multiple findings', () => {
            const review = `CRITICAL: eval usage - src/exec.js:15 - Remove eval, use JSON.parse
HIGH: Missing auth check - api/users.js:30 - Add authentication middleware
MEDIUM: Debug logging - lib/helper.js:100 - Remove console.log in production
LOW: Missing input validation - utils.js:5 - Add type checking`;

            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(4);
            expect(findings[0].severity).toBe('CRITICAL');
            expect(findings[1].severity).toBe('HIGH');
            expect(findings[2].severity).toBe('MEDIUM');
            expect(findings[3].severity).toBe('LOW');
        });

        test('handles mixed content with findings and other text', () => {
            const review = `Security Review for jtpets/test-repo

Reviewed 5 commits from the last 24 hours.

CRITICAL: SQL injection - db.js:10 - Use prepared statements
Some other analysis text here...
HIGH: XSS vulnerability - views/user.js:25 - Escape HTML output

Summary: Found 2 issues.`;

            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(2);
            expect(findings[0].issue).toBe('SQL injection');
            expect(findings[1].issue).toBe('XSS vulnerability');
        });

        test('returns empty array for "all clear" review', () => {
            const review = 'All clear. No security issues detected in yesterday\'s commits.';
            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(0);
        });

        test('returns empty array for null/undefined input', () => {
            expect(securityFollowup.parseFindings(null)).toEqual([]);
            expect(securityFollowup.parseFindings(undefined)).toEqual([]);
            expect(securityFollowup.parseFindings('')).toEqual([]);
        });

        test('handles case-insensitive severity levels', () => {
            const review = `critical: Issue A - file.js:1 - Fix A
High: Issue B - file.js:2 - Fix B
MEDIUM: Issue C - file.js:3 - Fix C
low: Issue D - file.js:4 - Fix D`;

            const findings = securityFollowup.parseFindings(review);

            expect(findings).toHaveLength(4);
            expect(findings[0].severity).toBe('CRITICAL');
            expect(findings[1].severity).toBe('HIGH');
            expect(findings[2].severity).toBe('MEDIUM');
            expect(findings[3].severity).toBe('LOW');
        });
    });

    describe('groupFindingsByFile', () => {
        test('groups findings by file path', () => {
            const findings = [
                { severity: 'CRITICAL', issue: 'Issue 1', file: 'src/auth.js', line: 10 },
                { severity: 'HIGH', issue: 'Issue 2', file: 'src/auth.js', line: 20 },
                { severity: 'MEDIUM', issue: 'Issue 3', file: 'lib/db.js', line: 5 },
            ];

            const groups = securityFollowup.groupFindingsByFile(findings);

            expect(groups.size).toBe(2);
            expect(groups.get('src/auth.js')).toHaveLength(2);
            expect(groups.get('lib/db.js')).toHaveLength(1);
        });

        test('handles empty findings array', () => {
            const groups = securityFollowup.groupFindingsByFile([]);
            expect(groups.size).toBe(0);
        });
    });

    describe('getHighestSeverity', () => {
        test('returns CRITICAL when present', () => {
            const findings = [
                { severity: 'LOW' },
                { severity: 'CRITICAL' },
                { severity: 'HIGH' },
            ];
            expect(securityFollowup.getHighestSeverity(findings)).toBe('CRITICAL');
        });

        test('returns HIGH when CRITICAL not present', () => {
            const findings = [
                { severity: 'LOW' },
                { severity: 'HIGH' },
                { severity: 'MEDIUM' },
            ];
            expect(securityFollowup.getHighestSeverity(findings)).toBe('HIGH');
        });

        test('returns LOW for only LOW findings', () => {
            const findings = [{ severity: 'LOW' }];
            expect(securityFollowup.getHighestSeverity(findings)).toBe('LOW');
        });

        test('returns LOW for empty array', () => {
            expect(securityFollowup.getHighestSeverity([])).toBe('LOW');
        });
    });

    describe('findCodeAgent', () => {
        test('finds matching target_repo agent', () => {
            const result = securityFollowup.findCodeAgent('jtpets/slack-agent-bridge');

            // Should find code-bridge agent
            expect(result.agentId).toBe('code-bridge');
            expect(result.channelId).toBeDefined();
        });

        test('falls back to bridge for unknown repo', () => {
            const result = securityFollowup.findCodeAgent('unknown/repo');

            expect(result.agentId).toBe('bridge');
            expect(result.channelId).toBeDefined();
        });
    });

    describe('filterActionableFindings', () => {
        const findings = [
            { severity: 'CRITICAL', issue: 'Issue 1' },
            { severity: 'HIGH', issue: 'Issue 2' },
            { severity: 'MEDIUM', issue: 'Issue 3' },
            { severity: 'LOW', issue: 'Issue 4' },
        ];

        test('filters to CRITICAL and HIGH by default', () => {
            const actionable = securityFollowup.filterActionableFindings(findings);

            expect(actionable).toHaveLength(2);
            expect(actionable.map(f => f.severity)).toEqual(['CRITICAL', 'HIGH']);
        });

        test('includes MEDIUM when option set', () => {
            const actionable = securityFollowup.filterActionableFindings(findings, { includeMedium: true });

            expect(actionable).toHaveLength(3);
            expect(actionable.map(f => f.severity)).toEqual(['CRITICAL', 'HIGH', 'MEDIUM']);
        });

        test('returns empty for only LOW findings', () => {
            const lowFindings = [{ severity: 'LOW', issue: 'Issue' }];
            const actionable = securityFollowup.filterActionableFindings(lowFindings);

            expect(actionable).toHaveLength(0);
        });
    });

    describe('buildTaskMessage', () => {
        test('builds task message with correct format', () => {
            const findings = [
                { severity: 'CRITICAL', issue: 'SQL injection', file: 'db.js', line: 10, fix: 'Use parameterized queries' },
            ];

            const message = securityFollowup.buildTaskMessage('jtpets/test-repo', 'db.js', findings);

            expect(message).toContain('TASK: Fix CRITICAL security finding');
            expect(message).toContain('REPO: jtpets/test-repo');
            expect(message).toContain('SKILL: security-fix');
            expect(message).toContain('SQL injection');
            expect(message).toContain('db.js:10');
            expect(message).toContain('Use parameterized queries');
        });

        test('handles multiple findings in same file', () => {
            const findings = [
                { severity: 'HIGH', issue: 'Issue 1', file: 'file.js', line: 1, fix: 'Fix 1' },
                { severity: 'HIGH', issue: 'Issue 2', file: 'file.js', line: 2, fix: 'Fix 2' },
            ];

            const message = securityFollowup.buildTaskMessage('jtpets/test-repo', 'file.js', findings);

            expect(message).toContain('findings');
            expect(message).toContain('2 issue');
            expect(message).toContain('Issue 1');
            expect(message).toContain('Issue 2');
        });

        test('includes appropriate emoji for severity', () => {
            const criticalFindings = [{ severity: 'CRITICAL', issue: 'Test', file: 'a.js', line: 1, fix: 'Fix' }];
            const highFindings = [{ severity: 'HIGH', issue: 'Test', file: 'b.js', line: 1, fix: 'Fix' }];

            const criticalMsg = securityFollowup.buildTaskMessage('repo', 'a.js', criticalFindings);
            const highMsg = securityFollowup.buildTaskMessage('repo', 'b.js', highFindings);

            expect(criticalMsg).toContain(':rotating_light:');
            expect(highMsg).toContain(':warning:');
        });
    });

    describe('deduplication', () => {
        test('wasRecentlyCreated returns false for new key', () => {
            expect(securityFollowup.wasRecentlyCreated('new:key:CRITICAL')).toBe(false);
        });

        test('wasRecentlyCreated returns true after recording', () => {
            const key = 'test:file.js:CRITICAL';
            securityFollowup.recordTaskCreated(key);

            expect(securityFollowup.wasRecentlyCreated(key)).toBe(true);
        });

        test('clearDedupMap clears all entries', () => {
            securityFollowup.recordTaskCreated('key1');
            securityFollowup.recordTaskCreated('key2');

            securityFollowup.clearDedupMap();

            expect(securityFollowup.wasRecentlyCreated('key1')).toBe(false);
            expect(securityFollowup.wasRecentlyCreated('key2')).toBe(false);
        });
    });

    describe('processSecurityBulletin', () => {
        const mockSlack = {
            chat: {
                postMessage: jest.fn().mockResolvedValue({ ok: true }),
            },
        };

        beforeEach(() => {
            mockSlack.chat.postMessage.mockClear();
            securityFollowup.clearDedupMap();
        });

        test('returns error for invalid bulletin', async () => {
            const result = await securityFollowup.processSecurityBulletin(mockSlack, null);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain('Invalid bulletin');
        });

        test('returns error for missing repo', async () => {
            const bulletin = { data: { summary: 'test' } };
            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            expect(result.errors).toHaveLength(1);
            expect(result.errors[0].error).toContain('missing repo');
        });

        test('skips when no parseable findings', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    summary: 'All clear. No security issues detected.',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            expect(result.tasks).toHaveLength(0);
            expect(result.skipped.length).toBeGreaterThan(0);
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });

        test('skips when only LOW findings', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    summary: 'LOW: Minor style issue - style.js:1 - Consider refactoring',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            expect(result.tasks).toHaveLength(0);
            expect(result.skipped.some(s => s.reason.includes('No CRITICAL/HIGH'))).toBe(true);
        });

        // LOGIC CHANGE 2026-04-01: Default behavior now queues tasks for approval.
        // Use skipApproval: true for legacy behavior (direct posting).
        test('queues task for CRITICAL finding (default behavior)', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/slack-agent-bridge',
                    fullReview: 'CRITICAL: SQL injection - db.js:10 - Use prepared statements',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            expect(result.queued).toHaveLength(1);
            expect(result.queued[0].highestSeverity).toBe('CRITICAL');
            expect(result.queued[0].file).toBe('db.js');
            expect(result.queued[0].id).toBeDefined();
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });

        test('creates task for CRITICAL finding with skipApproval', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/slack-agent-bridge',
                    fullReview: 'CRITICAL: SQL injection - db.js:10 - Use prepared statements',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin, { skipApproval: true });

            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0].highestSeverity).toBe('CRITICAL');
            expect(result.tasks[0].file).toBe('db.js');
            expect(mockSlack.chat.postMessage).toHaveBeenCalledTimes(1);
        });

        test('queues multiple tasks for findings in different files', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/slack-agent-bridge',
                    fullReview: `CRITICAL: Issue A - file1.js:10 - Fix A
HIGH: Issue B - file2.js:20 - Fix B`,
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            expect(result.queued).toHaveLength(2);
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });

        test('creates multiple tasks with skipApproval', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/slack-agent-bridge',
                    fullReview: `CRITICAL: Issue A - file1.js:10 - Fix A
HIGH: Issue B - file2.js:20 - Fix B`,
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin, { skipApproval: true });

            expect(result.tasks).toHaveLength(2);
            expect(mockSlack.chat.postMessage).toHaveBeenCalledTimes(2);
        });

        test('respects dryRun option', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    fullReview: 'CRITICAL: Test issue - test.js:1 - Fix it',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin, { dryRun: true });

            expect(result.tasks).toHaveLength(1);
            expect(result.tasks[0].dryRun).toBe(true);
            expect(mockSlack.chat.postMessage).not.toHaveBeenCalled();
        });

        test('deduplicates within 24h window', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    fullReview: 'HIGH: Same issue - same.js:1 - Same fix',
                },
            };

            // First call should queue task
            const result1 = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);
            expect(result1.queued).toHaveLength(1);

            // Second call should skip (duplicate)
            const result2 = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);
            expect(result2.queued).toHaveLength(0);
            expect(result2.skipped.some(s => s.reason.includes('Duplicate'))).toBe(true);
        });

        test('prefers fullReview over summary', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    summary: 'MEDIUM: Summary only issue - summary.js:1 - Fix summary',
                    fullReview: 'CRITICAL: Full review issue - full.js:1 - Fix full',
                },
            };

            const result = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);

            // Should parse from fullReview, which has CRITICAL (now queued instead of tasks)
            expect(result.queued).toHaveLength(1);
            expect(result.queued[0].highestSeverity).toBe('CRITICAL');
            expect(result.queued[0].file).toBe('full.js');
        });

        test('includes MEDIUM findings when option set', async () => {
            const bulletin = {
                data: {
                    repo: 'jtpets/test-repo',
                    fullReview: 'MEDIUM: Medium severity issue - medium.js:1 - Fix medium',
                },
            };

            // Without includeMedium - should skip
            const result1 = await securityFollowup.processSecurityBulletin(mockSlack, bulletin);
            expect(result1.queued).toHaveLength(0);

            securityFollowup.clearDedupMap();

            // With includeMedium - should queue task
            const result2 = await securityFollowup.processSecurityBulletin(mockSlack, bulletin, { includeMedium: true });
            expect(result2.queued).toHaveLength(1);
        });
    });

    describe('formatFollowupSummary', () => {
        test('formats queued tasks correctly', () => {
            const result = {
                tasks: [],
                queued: [
                    { id: 'sec-123', file: 'file1.js', findingCount: 2, highestSeverity: 'CRITICAL' },
                    { id: 'sec-456', file: 'file2.js', findingCount: 1, highestSeverity: 'HIGH' },
                ],
                skipped: [],
                errors: [],
            };

            const summary = securityFollowup.formatFollowupSummary(result);

            expect(summary).toContain('Queued 2 task(s) for approval');
            expect(summary).toContain('file1.js');
            expect(summary).toContain('file2.js');
            expect(summary).toContain(':rotating_light:');
            expect(summary).toContain(':warning:');
            expect(summary).toContain('pending approvals');
        });

        test('formats direct tasks correctly (skipApproval mode)', () => {
            const result = {
                tasks: [
                    { file: 'file1.js', findingCount: 2, highestSeverity: 'CRITICAL' },
                    { file: 'file2.js', findingCount: 1, highestSeverity: 'HIGH' },
                ],
                queued: [],
                skipped: [],
                errors: [],
            };

            const summary = securityFollowup.formatFollowupSummary(result);

            expect(summary).toContain('Created 2 remediation task(s)');
            expect(summary).toContain('file1.js');
            expect(summary).toContain('file2.js');
            expect(summary).toContain(':rotating_light:');
            expect(summary).toContain(':warning:');
        });

        test('formats skipped items', () => {
            const result = {
                tasks: [],
                skipped: [
                    { reason: 'Duplicate within 24h', file: 'dup.js' },
                    { reason: 'No CRITICAL/HIGH findings' },
                ],
                errors: [],
            };

            const summary = securityFollowup.formatFollowupSummary(result);

            expect(summary).toContain('Skipped 2 item(s)');
            expect(summary).toContain('Duplicate');
            expect(summary).toContain('dup.js');
        });

        test('formats errors', () => {
            const result = {
                tasks: [],
                skipped: [],
                errors: [
                    { error: 'Channel not found', file: 'error.js' },
                ],
            };

            const summary = securityFollowup.formatFollowupSummary(result);

            expect(summary).toContain('1 error(s)');
            expect(summary).toContain('Channel not found');
        });

        test('returns default message for empty result', () => {
            const result = { tasks: [], skipped: [], errors: [] };

            const summary = securityFollowup.formatFollowupSummary(result);

            expect(summary).toContain('No security followup actions taken');
        });
    });

    describe('createSecurityFollowupHandler', () => {
        const mockSlack = {
            chat: {
                postMessage: jest.fn().mockResolvedValue({ ok: true }),
            },
        };

        beforeEach(() => {
            mockSlack.chat.postMessage.mockClear();
            securityFollowup.clearDedupMap();
        });

        test('returns handler function', () => {
            const handler = securityFollowup.createSecurityFollowupHandler(mockSlack);
            expect(typeof handler).toBe('function');
        });

        test('handler skips non-security_finding bulletins', async () => {
            const handler = securityFollowup.createSecurityFollowupHandler(mockSlack);
            const result = await handler({ type: 'task_completed', data: {} });

            expect(result.skipped).toBe(true);
            expect(result.reason).toContain('Not a security_finding');
        });

        test('handler processes security_finding bulletins and queues tasks', async () => {
            const handler = securityFollowup.createSecurityFollowupHandler(mockSlack);
            const result = await handler({
                type: 'security_finding',
                data: {
                    repo: 'jtpets/test-repo',
                    fullReview: 'HIGH: Test issue - test.js:1 - Fix it',
                },
            });

            // Default behavior queues tasks for approval
            expect(result.queued.length).toBeGreaterThan(0);
        });

        test('handler with skipApproval posts tasks directly', async () => {
            const handler = securityFollowup.createSecurityFollowupHandler(mockSlack, { skipApproval: true });
            const result = await handler({
                type: 'security_finding',
                data: {
                    repo: 'jtpets/test-repo',
                    fullReview: 'HIGH: Test issue - test.js:1 - Fix it',
                },
            });

            expect(result.tasks.length).toBeGreaterThan(0);
            expect(mockSlack.chat.postMessage).toHaveBeenCalled();
        });
    });

    describe('SEVERITY_LEVELS and SEVERITY_EMOJI exports', () => {
        test('SEVERITY_LEVELS is in priority order', () => {
            expect(securityFollowup.SEVERITY_LEVELS).toEqual(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
        });

        test('SEVERITY_EMOJI has all levels', () => {
            for (const level of securityFollowup.SEVERITY_LEVELS) {
                expect(securityFollowup.SEVERITY_EMOJI[level]).toBeDefined();
            }
        });
    });
});
