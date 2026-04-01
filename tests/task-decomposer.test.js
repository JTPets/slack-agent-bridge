'use strict';

/**
 * tests/task-decomposer.test.js
 *
 * Unit tests for lib/task-decomposer.js
 */

const {
    analyzeComplexity,
    detectTaskType,
    createSubtask,
    getReadySubtasks,
    allSubtasksComplete,
    generateSummary,
    formatSubtaskAsMessage,
    buildDecompositionPrompt,
    parseDecompositionResponse,
    findAgentForTask,
    decomposeTask,
    SUBTASK_STATUS,
    DEFAULT_COMPLEXITY_THRESHOLD,
} = require('../lib/task-decomposer');

// Mock llm-runner
jest.mock('../lib/llm-runner', () => ({
    runLLM: jest.fn(),
}));

// Mock agent-registry
jest.mock('../lib/agent-registry', () => ({
    getAgent: jest.fn(),
    getActiveAgents: jest.fn(() => [
        { id: 'bridge', target_repo: null },
        { id: 'code-bridge', target_repo: 'jtpets/slack-agent-bridge' },
        { id: 'code-sqtools', target_repo: 'jtpets/SquareDashboardTool' },
        { id: 'security', target_repo: null },
        { id: 'secretary', target_repo: null },
    ]),
    isProductionRepo: jest.fn(() => false),
}));

describe('task-decomposer', () => {
    describe('analyzeComplexity', () => {
        test('returns low complexity for simple task', () => {
            const result = analyzeComplexity('Fix the typo in README');
            expect(result.score).toBeLessThan(DEFAULT_COMPLEXITY_THRESHOLD);
            expect(result.isComplex).toBe(false);
        });

        test('detects multiple "and" connectors', () => {
            const result = analyzeComplexity('Update the database and add caching and fix the tests');
            expect(result.indicators.length).toBeGreaterThan(0);
            expect(result.score).toBeGreaterThan(0);
        });

        test('detects numbered lists', () => {
            const result = analyzeComplexity(`
                1. First do this
                2. Then do that
                3. Finally do this
            `);
            expect(result.indicators).toContainEqual(expect.stringContaining('3 numbered items'));
        });

        test('detects bullet points', () => {
            const result = analyzeComplexity(`
                - Item one
                - Item two
                - Item three
            `);
            expect(result.indicators).toContainEqual(expect.stringContaining('3 bullet points'));
        });

        test('detects sequential keywords', () => {
            const result = analyzeComplexity('First implement the feature then add tests');
            expect(result.score).toBeGreaterThan(0);
        });

        test('handles long tasks', () => {
            const longText = 'word '.repeat(250);
            const result = analyzeComplexity(longText);
            expect(result.indicators).toContainEqual(expect.stringContaining('200+ words'));
        });

        test('handles null input', () => {
            const result = analyzeComplexity(null);
            expect(result.score).toBe(0);
            expect(result.isComplex).toBe(false);
        });

        test('handles empty string', () => {
            const result = analyzeComplexity('');
            expect(result.score).toBe(0);
            expect(result.isComplex).toBe(false);
        });
    });

    describe('detectTaskType', () => {
        test('detects code tasks', () => {
            expect(detectTaskType('implement a new function')).toBe('code');
            expect(detectTaskType('fix the bug in module')).toBe('code');
            expect(detectTaskType('refactor the class')).toBe('code');
        });

        test('detects security tasks', () => {
            expect(detectTaskType('run security audit')).toBe('security');
            expect(detectTaskType('check for vulnerabilities')).toBe('security');
            expect(detectTaskType('scan for OWASP issues')).toBe('security');
        });

        test('detects research tasks', () => {
            expect(detectTaskType('research payment options')).toBe('research');
            expect(detectTaskType('compare these libraries')).toBe('research');
            expect(detectTaskType('analyze the pros and cons')).toBe('research');
        });

        test('detects documentation tasks', () => {
            expect(detectTaskType('update the README')).toBe('documentation');
            expect(detectTaskType('add jsdoc comments')).toBe('documentation');
        });

        test('detects email tasks', () => {
            expect(detectTaskType('check the inbox')).toBe('email');
            expect(detectTaskType('unsubscribe from newsletters')).toBe('email');
        });

        test('detects calendar tasks', () => {
            expect(detectTaskType('schedule a meeting')).toBe('calendar');
            expect(detectTaskType('check calendar for conflicts')).toBe('calendar');
        });

        test('detects social media tasks', () => {
            expect(detectTaskType('post to instagram')).toBe('social');
            expect(detectTaskType('create facebook content')).toBe('social');
        });

        test('returns general for unknown', () => {
            expect(detectTaskType('do something random')).toBe('general');
            expect(detectTaskType('')).toBe('general');
            expect(detectTaskType(null)).toBe('general');
        });
    });

    describe('findAgentForTask', () => {
        test('finds repo-specific agent for slack-agent-bridge', () => {
            const agent = findAgentForTask('jtpets/slack-agent-bridge', 'code');
            expect(agent.id).toBe('code-bridge');
        });

        test('finds repo-specific agent for SquareDashboardTool', () => {
            const agent = findAgentForTask('jtpets/SquareDashboardTool', 'code');
            expect(agent.id).toBe('code-sqtools');
        });

        test('finds security agent for security tasks', () => {
            const agent = findAgentForTask(null, 'security');
            expect(agent.id).toBe('security');
        });

        test('finds secretary for calendar tasks', () => {
            const agent = findAgentForTask(null, 'calendar');
            expect(agent.id).toBe('secretary');
        });

        test('returns bridge for general tasks', () => {
            const agent = findAgentForTask(null, 'general');
            expect(agent.id).toBe('bridge');
        });

        test('prioritizes repo-specific over task-type', () => {
            const agent = findAgentForTask('jtpets/slack-agent-bridge', 'security');
            expect(agent.id).toBe('code-bridge');
        });
    });

    describe('createSubtask', () => {
        test('creates subtask with defaults', () => {
            const subtask = createSubtask({
                description: 'Test subtask',
                instructions: 'Do the thing',
            });

            expect(subtask.id).toBeDefined();
            expect(subtask.description).toBe('Test subtask');
            expect(subtask.instructions).toBe('Do the thing');
            expect(subtask.status).toBe(SUBTASK_STATUS.PENDING);
            expect(subtask.dependsOn).toEqual([]);
            expect(subtask.priority).toBe(0);
            expect(subtask.agentId).toBe('bridge');
        });

        test('creates subtask with all options', () => {
            const subtask = createSubtask({
                id: 'custom-id',
                parentTaskId: 'parent-123',
                description: 'Custom subtask',
                instructions: 'Custom instructions',
                repo: 'org/repo',
                branch: 'feature',
                skill: 'research',
                agentId: 'security',
                dependsOn: ['other-1', 'other-2'],
                priority: 10,
            });

            expect(subtask.id).toBe('custom-id');
            expect(subtask.parentTaskId).toBe('parent-123');
            expect(subtask.repo).toBe('org/repo');
            expect(subtask.branch).toBe('feature');
            expect(subtask.skill).toBe('research');
            expect(subtask.agentId).toBe('security');
            expect(subtask.dependsOn).toEqual(['other-1', 'other-2']);
            expect(subtask.priority).toBe(10);
        });
    });

    describe('getReadySubtasks', () => {
        test('returns pending subtasks with no dependencies', () => {
            const subtasks = [
                createSubtask({ id: 'st-1', description: 'First', instructions: '...' }),
                createSubtask({ id: 'st-2', description: 'Second', instructions: '...' }),
            ];

            const ready = getReadySubtasks(subtasks);
            expect(ready).toHaveLength(2);
        });

        test('blocks subtasks with incomplete dependencies', () => {
            const subtasks = [
                createSubtask({ id: 'st-1', description: 'First', instructions: '...' }),
                createSubtask({ id: 'st-2', description: 'Second', instructions: '...', dependsOn: ['st-1'] }),
            ];

            const ready = getReadySubtasks(subtasks);
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe('st-1');
            expect(subtasks[1].status).toBe(SUBTASK_STATUS.BLOCKED);
        });

        test('unblocks subtasks when dependencies complete', () => {
            const subtasks = [
                { ...createSubtask({ id: 'st-1', description: 'First', instructions: '...' }), status: SUBTASK_STATUS.COMPLETED },
                createSubtask({ id: 'st-2', description: 'Second', instructions: '...', dependsOn: ['st-1'] }),
            ];

            const ready = getReadySubtasks(subtasks);
            expect(ready).toHaveLength(1);
            expect(ready[0].id).toBe('st-2');
        });

        test('skips subtasks when dependencies fail', () => {
            const subtasks = [
                { ...createSubtask({ id: 'st-1', description: 'First', instructions: '...' }), status: SUBTASK_STATUS.FAILED },
                createSubtask({ id: 'st-2', description: 'Second', instructions: '...', dependsOn: ['st-1'] }),
            ];

            const ready = getReadySubtasks(subtasks);
            expect(ready).toHaveLength(0);
            expect(subtasks[1].status).toBe(SUBTASK_STATUS.SKIPPED);
        });

        test('sorts by priority', () => {
            const subtasks = [
                createSubtask({ id: 'st-1', description: 'Low', instructions: '...', priority: 1 }),
                createSubtask({ id: 'st-2', description: 'High', instructions: '...', priority: 10 }),
                createSubtask({ id: 'st-3', description: 'Medium', instructions: '...', priority: 5 }),
            ];

            const ready = getReadySubtasks(subtasks);
            expect(ready[0].priority).toBe(10);
            expect(ready[1].priority).toBe(5);
            expect(ready[2].priority).toBe(1);
        });
    });

    describe('allSubtasksComplete', () => {
        test('returns true when all completed', () => {
            const subtasks = [
                { status: SUBTASK_STATUS.COMPLETED },
                { status: SUBTASK_STATUS.COMPLETED },
            ];
            expect(allSubtasksComplete(subtasks)).toBe(true);
        });

        test('returns true when mixed completed/failed/skipped', () => {
            const subtasks = [
                { status: SUBTASK_STATUS.COMPLETED },
                { status: SUBTASK_STATUS.FAILED },
                { status: SUBTASK_STATUS.SKIPPED },
            ];
            expect(allSubtasksComplete(subtasks)).toBe(true);
        });

        test('returns false when any pending', () => {
            const subtasks = [
                { status: SUBTASK_STATUS.COMPLETED },
                { status: SUBTASK_STATUS.PENDING },
            ];
            expect(allSubtasksComplete(subtasks)).toBe(false);
        });

        test('returns false when any running', () => {
            const subtasks = [
                { status: SUBTASK_STATUS.COMPLETED },
                { status: SUBTASK_STATUS.RUNNING },
            ];
            expect(allSubtasksComplete(subtasks)).toBe(false);
        });

        test('returns false when any blocked', () => {
            const subtasks = [
                { status: SUBTASK_STATUS.COMPLETED },
                { status: SUBTASK_STATUS.BLOCKED },
            ];
            expect(allSubtasksComplete(subtasks)).toBe(false);
        });
    });

    describe('generateSummary', () => {
        test('generates summary with completed subtasks', () => {
            const subtasks = [
                { description: 'Task 1', status: SUBTASK_STATUS.COMPLETED },
                { description: 'Task 2', status: SUBTASK_STATUS.COMPLETED },
            ];

            const summary = generateSummary(subtasks);
            expect(summary).toContain('Total subtasks:** 2');
            expect(summary).toContain('Completed:** 2');
            expect(summary).toContain(':white_check_mark: Task 1');
        });

        test('generates summary with failed subtasks', () => {
            const subtasks = [
                { description: 'Task 1', status: SUBTASK_STATUS.COMPLETED },
                { description: 'Task 2', status: SUBTASK_STATUS.FAILED, error: 'Something went wrong' },
            ];

            const summary = generateSummary(subtasks);
            expect(summary).toContain('Failed:** 1');
            expect(summary).toContain(':x: Task 2: Something went wrong');
        });

        test('generates summary with skipped subtasks', () => {
            const subtasks = [
                { description: 'Task 1', status: SUBTASK_STATUS.FAILED },
                { description: 'Task 2', status: SUBTASK_STATUS.SKIPPED },
            ];

            const summary = generateSummary(subtasks);
            expect(summary).toContain('Skipped:** 1');
            expect(summary).toContain(':fast_forward: Task 2');
        });
    });

    describe('formatSubtaskAsMessage', () => {
        test('formats basic subtask', () => {
            const subtask = createSubtask({
                description: 'Fix bug',
                instructions: 'Fix the null pointer exception',
                repo: 'jtpets/slack-agent-bridge',
            });

            const message = formatSubtaskAsMessage(subtask);
            expect(message).toContain('TASK: Fix bug');
            expect(message).toContain('REPO: jtpets/slack-agent-bridge');
            expect(message).toContain('INSTRUCTIONS: Fix the null pointer exception');
        });

        test('includes non-default branch', () => {
            const subtask = createSubtask({
                description: 'Fix bug',
                instructions: '...',
                branch: 'feature/fix',
            });

            const message = formatSubtaskAsMessage(subtask);
            expect(message).toContain('BRANCH: feature/fix');
        });

        test('omits main branch', () => {
            const subtask = createSubtask({
                description: 'Fix bug',
                instructions: '...',
                branch: 'main',
            });

            const message = formatSubtaskAsMessage(subtask);
            expect(message).not.toContain('BRANCH:');
        });

        test('includes skill if specified', () => {
            const subtask = createSubtask({
                description: 'Research options',
                instructions: '...',
                skill: 'research',
            });

            const message = formatSubtaskAsMessage(subtask);
            expect(message).toContain('SKILL: research');
        });

        test('includes context from previous subtasks', () => {
            const subtask = createSubtask({
                id: 'st-2',
                description: 'Follow up',
                instructions: 'Build on previous work',
                dependsOn: ['st-1'],
            });

            const context = {
                previousResults: {
                    'st-1': 'Found 3 issues to address',
                },
            };

            const message = formatSubtaskAsMessage(subtask, context);
            expect(message).toContain('Context from Previous Subtasks');
            expect(message).toContain('Found 3 issues to address');
        });
    });

    describe('buildDecompositionPrompt', () => {
        test('builds prompt with all task fields', () => {
            const task = {
                description: 'Complex task',
                repo: 'jtpets/repo',
                instructions: 'Do many things',
            };

            const prompt = buildDecompositionPrompt(task);
            expect(prompt).toContain('Complex task');
            expect(prompt).toContain('jtpets/repo');
            expect(prompt).toContain('Do many things');
            expect(prompt).toContain('shouldDecompose');
            expect(prompt).toContain('subtasks');
        });

        test('handles missing repo', () => {
            const task = {
                description: 'Simple task',
                instructions: 'Do something',
            };

            const prompt = buildDecompositionPrompt(task);
            expect(prompt).toContain('None specified');
        });
    });

    describe('parseDecompositionResponse', () => {
        test('parses valid JSON response', () => {
            const response = JSON.stringify({
                shouldDecompose: true,
                reasoning: 'Task has multiple steps',
                subtasks: [
                    { description: 'Step 1', instructions: 'Do first thing' },
                ],
            });

            const parsed = parseDecompositionResponse(response);
            expect(parsed.shouldDecompose).toBe(true);
            expect(parsed.reasoning).toBe('Task has multiple steps');
            expect(parsed.subtasks).toHaveLength(1);
        });

        test('parses JSON with code fences', () => {
            const response = '```json\n{"shouldDecompose": false, "reasoning": "Simple task", "subtasks": []}\n```';

            const parsed = parseDecompositionResponse(response);
            expect(parsed.shouldDecompose).toBe(false);
        });

        test('returns null for invalid JSON', () => {
            const response = 'This is not JSON';
            const parsed = parseDecompositionResponse(response);
            expect(parsed).toBeNull();
        });

        test('returns null for missing shouldDecompose', () => {
            const response = JSON.stringify({
                reasoning: 'No decompose field',
                subtasks: [],
            });

            const parsed = parseDecompositionResponse(response);
            expect(parsed).toBeNull();
        });

        test('returns null for shouldDecompose=true with no subtasks', () => {
            const response = JSON.stringify({
                shouldDecompose: true,
                reasoning: 'Should have subtasks',
                subtasks: [],
            });

            const parsed = parseDecompositionResponse(response);
            expect(parsed).toBeNull();
        });

        test('returns null for null input', () => {
            expect(parseDecompositionResponse(null)).toBeNull();
        });
    });

    describe('decomposeTask', () => {
        test('skips decomposition for simple task', async () => {
            const task = {
                description: 'Simple fix',
                instructions: 'Fix the typo',
            };

            const result = await decomposeTask(task);
            expect(result.decomposed).toBe(false);
            expect(result.complexity.isComplex).toBe(false);
        });

        test('returns heuristics only when skipLLM=true', async () => {
            const task = {
                description: 'Complex task',
                instructions: 'Do this and that and also another thing, then finally wrap up',
            };

            const result = await decomposeTask(task, { skipLLM: true });
            expect(result.decomposed).toBe(false);
            expect(result.reason).toBe('LLM analysis skipped');
            expect(result.complexity.score).toBeGreaterThan(0);
        });

        test('uses LLM for complex task', async () => {
            const { runLLM } = require('../lib/llm-runner');
            runLLM.mockResolvedValueOnce({
                output: JSON.stringify({
                    shouldDecompose: true,
                    reasoning: 'Multiple distinct tasks',
                    subtasks: [
                        { description: 'First', instructions: 'Do first', priority: 5, taskType: 'code' },
                        { description: 'Second', instructions: 'Do second', priority: 3, taskType: 'code', dependsOn: [0] },
                    ],
                }),
            });

            const task = {
                description: 'Complex task',
                instructions: 'Do this and that and also another thing, then finally wrap up. ' +
                    '1. First step 2. Second step 3. Third step',
                repo: 'jtpets/slack-agent-bridge',
            };

            const result = await decomposeTask(task);
            expect(result.decomposed).toBe(true);
            expect(result.subtasks).toHaveLength(2);
            expect(result.subtasks[0].description).toBe('First');
            expect(result.subtasks[0].agentId).toBe('code-bridge');
        });

        test('handles LLM saying no decomposition needed', async () => {
            const { runLLM } = require('../lib/llm-runner');
            runLLM.mockResolvedValueOnce({
                output: JSON.stringify({
                    shouldDecompose: false,
                    reasoning: 'Task is actually atomic',
                    subtasks: [],
                }),
            });

            // Must be complex enough to trigger LLM call
            const task = {
                description: 'Looks complex',
                instructions: '1. First step\n2. Second step\n3. Third step\nDo this and that and also another thing',
            };

            const result = await decomposeTask(task);
            expect(result.decomposed).toBe(false);
            expect(result.reason).toContain('atomic');
        });

        test('handles LLM error gracefully', async () => {
            const { runLLM } = require('../lib/llm-runner');
            runLLM.mockRejectedValueOnce(new Error('API rate limit'));

            // Must be complex enough to trigger LLM call
            const task = {
                description: 'Complex task',
                instructions: '1. First step\n2. Second step\n3. Third step\nDo this and that and also another thing, then finally wrap up',
            };

            const result = await decomposeTask(task);
            expect(result.decomposed).toBe(false);
            expect(result.reason).toContain('API rate limit');
        });

        test('handles malformed LLM response', async () => {
            const { runLLM } = require('../lib/llm-runner');
            runLLM.mockResolvedValueOnce({
                output: 'Sorry, I cannot help with that.',
            });

            // Must be complex enough to trigger LLM call
            const task = {
                description: 'Complex task',
                instructions: '1. First step\n2. Second step\n3. Third step\nDo this and that and also another thing, then finally wrap up',
            };

            const result = await decomposeTask(task);
            expect(result.decomposed).toBe(false);
            expect(result.reason).toContain('Failed to parse');
        });
    });
});
