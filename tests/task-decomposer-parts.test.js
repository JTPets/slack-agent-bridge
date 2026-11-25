'use strict';

/**
 * tests/task-decomposer-parts.test.js
 *
 * WORK-TODO #10, B37 (2026-11-25): each part lib/task-decomposer.js was split into,
 * tested on its own (the facade's behaviour is tests/task-decomposer.test.js). Routing
 * reads the agent registry, so that one part is given a mocked registry.
 */

jest.mock('../lib/agent-registry', () => ({
    getActiveAgents: jest.fn(() => [
        { id: 'bridge' }, { id: 'security' }, { id: 'code-bridge' }, { id: 'app-agent', target_repo: 'jtpets/app' },
    ]),
}));

const complexity = require('../lib/task-complexity');
const routing = require('../lib/subtask-routing');
const graph = require('../lib/subtask-graph');
const format = require('../lib/subtask-format');
const prompt = require('../lib/decomposition-prompt');
const { parseTask } = require('../lib/task-parser');

describe('lib/task-complexity.js', () => {
    test('a short task is simple; a numbered multi-step one crosses the threshold', () => {
        expect(complexity.analyzeComplexity('fix the typo').isComplex).toBe(false);
        expect(complexity.analyzeComplexity('1. a\n2. b\n3. c then also d').isComplex).toBe(true);
        expect(complexity.analyzeComplexity(null)).toEqual({ score: 0, indicators: [], isComplex: false });
    });
});

describe('lib/subtask-routing.js', () => {
    test('a repo-specific agent wins; otherwise the task type decides', () => {
        expect(routing.findAgentForTask('jtpets/app', 'code').id).toBe('app-agent');
        expect(routing.detectTaskType('audit the secrets')).toBe('security');
        expect(routing.findAgentForTask(null, 'security').id).toBe('security');
        expect(routing.findAgentForTask('jtpets/slack-agent-bridge', 'code').id).toBe('code-bridge');
    });
});

describe('lib/subtask-graph.js', () => {
    test('a subtask waits for its dependency and is skipped when it fails', () => {
        const a = graph.createSubtask({ id: 'a', description: 'A', instructions: '.' });
        const b = graph.createSubtask({ id: 'b', description: 'B', instructions: '.', dependsOn: ['a'] });
        expect(graph.getReadySubtasks([a, b]).map((s) => s.id)).toEqual(['a']);
        a.status = graph.SUBTASK_STATUS.FAILED;
        b.status = graph.SUBTASK_STATUS.PENDING;
        expect(graph.getReadySubtasks([a, b])).toEqual([]);
        expect(b.status).toBe(graph.SUBTASK_STATUS.SKIPPED);
        expect(graph.allSubtasksComplete([a, b])).toBe(true);
    });
});

describe('lib/subtask-format.js', () => {
    test('a subtask message parses back with no rejected fields', () => {
        const st = graph.createSubtask({ id: 'x', description: 'Do it', instructions: 'line one\nline two', repo: 'jtpets/app', branch: 'dev' });
        const parsed = parseTask(format.formatSubtaskAsMessage(st));
        expect(parsed.errors).toEqual([]);
        expect(parsed).toMatchObject({ description: 'Do it', repo: 'jtpets/app', branch: 'dev', instructions: 'line one\nline two' });
        expect(format.generateSummary([st])).toContain('**Total subtasks:** 1');
    });
});

describe('lib/decomposition-prompt.js', () => {
    beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
    afterEach(() => jest.restoreAllMocks());

    test('accepts fenced JSON, refuses a decomposition with no subtasks', () => {
        expect(prompt.parseDecompositionResponse('```json\n{"shouldDecompose": false}\n```')).toEqual({ shouldDecompose: false });
        expect(prompt.parseDecompositionResponse('{"shouldDecompose": true, "subtasks": []}')).toBeNull();
        expect(prompt.buildDecompositionPrompt({ description: 'd', instructions: 'i' })).toContain('**Description:** d');
    });
});
