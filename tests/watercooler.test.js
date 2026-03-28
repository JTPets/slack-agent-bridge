/**
 * tests/watercooler.test.js
 *
 * Tests for lib/watercooler.js
 * Tests the multi-agent standup conversation orchestrator.
 */

'use strict';

const path = require('path');
const fs = require('fs');

// Mock dotenv before any requires
jest.mock('dotenv', () => ({
    config: jest.fn(),
}));

// Mock llm-runner to avoid actual API calls
jest.mock('../lib/llm-runner', () => ({
    runLLM: jest.fn().mockResolvedValue({
        output: 'This is a mock standup message from the agent.',
        hitMaxTurns: false,
    }),
}));

// Mock bulletin-board
jest.mock('../lib/bulletin-board', () => ({
    getBulletins: jest.fn().mockReturnValue([
        {
            id: 'test-1',
            agentId: 'bridge',
            type: 'task_completed',
            data: { description: 'Test task completed' },
            timestamp: new Date().toISOString(),
            read_by: [],
        },
    ]),
    postBulletin: jest.fn().mockReturnValue({ success: true }),
}));

// Mock agent-registry
jest.mock('../lib/agent-registry', () => ({
    loadAgents: jest.fn().mockReturnValue([
        {
            id: 'secretary',
            name: 'Secretary',
            role: 'Calendar accountability',
            personality: 'Warm and professional',
            system_prompt: 'You are the Secretary.',
            llm_provider: 'gemini',
        },
        {
            id: 'security',
            name: 'Security Auditor',
            role: 'Security reviews',
            personality: 'Paranoid with dry humor',
            system_prompt: 'You are the Security Auditor.',
            llm_provider: 'gemini',
        },
        {
            id: 'jester',
            name: 'The Jester',
            role: 'Comedic relief',
            personality: 'Sharp-tongued contrarian',
            system_prompt: 'You are The Jester.',
            llm_provider: 'gemini',
        },
        {
            id: 'code-bridge',
            name: 'Code Bridge Agent',
            role: 'Code modifications',
            personality: 'Meticulous',
            system_prompt: 'You are the Code Bridge Agent.',
            llm_provider: 'claude',
        },
        {
            id: 'storefront',
            name: 'Storefront Agent',
            role: 'Customer-facing AI',
            status: 'planned', // Planned agents should be excluded
            llm_provider: 'gemini',
        },
    ]),
    getActiveAgents: jest.fn().mockReturnValue([]),
}));

const watercooler = require('../lib/watercooler');

describe('watercooler', () => {
    // Store original env
    const originalEnv = process.env;

    beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();

        // Set up test environment
        process.env = {
            ...originalEnv,
            GEMINI_API_KEY: 'test-gemini-key',
            OPS_CHANNEL_ID: 'C_TEST_OPS',
        };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    describe('isStandupCommand', () => {
        it('should detect "team standup" command', () => {
            expect(watercooler.isStandupCommand('team standup')).toBe(true);
            expect(watercooler.isStandupCommand('TEAM STANDUP')).toBe(true);
            expect(watercooler.isStandupCommand('Team Standup')).toBe(true);
        });

        it('should detect "standup" command', () => {
            expect(watercooler.isStandupCommand('standup')).toBe(true);
            expect(watercooler.isStandupCommand('STANDUP')).toBe(true);
        });

        it('should detect "watercooler" command', () => {
            expect(watercooler.isStandupCommand('watercooler')).toBe(true);
            expect(watercooler.isStandupCommand('WATERCOOLER')).toBe(true);
        });

        it('should detect "weekly standup" command', () => {
            expect(watercooler.isStandupCommand('weekly standup')).toBe(true);
        });

        it('should not match partial phrases', () => {
            expect(watercooler.isStandupCommand('what is a standup')).toBe(false);
            expect(watercooler.isStandupCommand('standup meeting tomorrow')).toBe(false);
            expect(watercooler.isStandupCommand('team standup notes')).toBe(false);
        });

        it('should handle empty/null input', () => {
            expect(watercooler.isStandupCommand('')).toBe(false);
            expect(watercooler.isStandupCommand(null)).toBe(false);
            expect(watercooler.isStandupCommand(undefined)).toBe(false);
        });
    });

    describe('isGeminiConfigured', () => {
        it('should return true when GEMINI_API_KEY is set', () => {
            process.env.GEMINI_API_KEY = 'test-key';
            expect(watercooler.isGeminiConfigured()).toBe(true);
        });

        it('should return false when GEMINI_API_KEY is not set', () => {
            delete process.env.GEMINI_API_KEY;
            expect(watercooler.isGeminiConfigured()).toBe(false);
        });
    });

    describe('getAgentDisplay', () => {
        it('should return correct display info for known agents', () => {
            expect(watercooler.getAgentDisplay('secretary', 'Secretary')).toEqual({
                emoji: ':calendar:',
                order: 1,
            });
            expect(watercooler.getAgentDisplay('security', 'Security Auditor')).toEqual({
                emoji: ':shield:',
                order: 2,
            });
            expect(watercooler.getAgentDisplay('jester', 'The Jester')).toEqual({
                emoji: ':performing_arts:',
                order: 3,
            });
        });

        it('should return default display for unknown agents', () => {
            expect(watercooler.getAgentDisplay('unknown-agent', 'Unknown')).toEqual({
                emoji: ':robot_face:',
                order: 99,
            });
        });
    });

    describe('sortAgentsForStandup', () => {
        it('should sort agents by order with jester last', () => {
            const agents = [
                { id: 'jester', name: 'The Jester' },
                { id: 'secretary', name: 'Secretary' },
                { id: 'code-bridge', name: 'Code Bridge Agent' },
                { id: 'security', name: 'Security Auditor' },
            ];

            const sorted = watercooler.sortAgentsForStandup(agents);

            expect(sorted[0].id).toBe('secretary');
            expect(sorted[1].id).toBe('security');
            expect(sorted[sorted.length - 1].id).toBe('jester'); // Jester always last
        });

        it('should not modify original array', () => {
            const agents = [
                { id: 'jester', name: 'The Jester' },
                { id: 'secretary', name: 'Secretary' },
            ];
            const originalOrder = agents.map(a => a.id);

            watercooler.sortAgentsForStandup(agents);

            expect(agents.map(a => a.id)).toEqual(originalOrder);
        });
    });

    describe('filterStandupParticipants', () => {
        it('should include active agents in the standup list', () => {
            const agents = [
                { id: 'secretary', name: 'Secretary' },
                { id: 'security', name: 'Security Auditor' },
                { id: 'jester', name: 'The Jester' },
            ];

            const participants = watercooler.filterStandupParticipants(agents);

            expect(participants).toHaveLength(3);
            expect(participants.map(p => p.id)).toContain('secretary');
            expect(participants.map(p => p.id)).toContain('security');
            expect(participants.map(p => p.id)).toContain('jester');
        });

        it('should exclude planned agents', () => {
            const agents = [
                { id: 'secretary', name: 'Secretary' },
                { id: 'storefront', name: 'Storefront Agent', status: 'planned' },
            ];

            const participants = watercooler.filterStandupParticipants(agents);

            expect(participants).toHaveLength(1);
            expect(participants[0].id).toBe('secretary');
        });

        it('should only include whitelisted agent IDs', () => {
            const agents = [
                { id: 'secretary', name: 'Secretary' },
                { id: 'unknown-agent', name: 'Unknown' }, // Not in whitelist
            ];

            const participants = watercooler.filterStandupParticipants(agents);

            expect(participants).toHaveLength(1);
            expect(participants[0].id).toBe('secretary');
        });
    });

    describe('formatBulletinsSummary', () => {
        it('should format bulletins list', () => {
            const bulletins = [
                {
                    agentId: 'bridge',
                    type: 'task_completed',
                    data: { description: 'Fixed the bug' },
                },
                {
                    agentId: 'security',
                    type: 'security_finding',
                    data: { description: 'Found a vulnerability' },
                },
            ];

            const summary = watercooler.formatBulletinsSummary(bulletins);

            expect(summary).toContain('2 bulletins since last standup');
            expect(summary).toContain('[bridge]');
            expect(summary).toContain('[security]');
            expect(summary).toContain('Fixed the bug');
            expect(summary).toContain('Found a vulnerability');
        });

        it('should handle empty bulletins', () => {
            const summary = watercooler.formatBulletinsSummary([]);
            expect(summary).toBe('No new bulletins since last standup.');
        });

        it('should truncate long bulletin lists', () => {
            const bulletins = Array(15).fill(null).map((_, i) => ({
                agentId: 'bridge',
                type: 'task_completed',
                data: { description: `Task ${i}` },
            }));

            const summary = watercooler.formatBulletinsSummary(bulletins);

            expect(summary).toContain('... and 5 more');
        });
    });

    describe('formatCompletionsSummary', () => {
        it('should format completions list', () => {
            const completions = [
                { description: 'Task 1', repo: 'jtpets/repo1' },
                { description: 'Task 2' },
            ];

            const summary = watercooler.formatCompletionsSummary(completions);

            expect(summary).toContain('2 tasks completed this week');
            expect(summary).toContain('Task 1 (jtpets/repo1)');
            expect(summary).toContain('Task 2');
        });

        it('should handle empty completions', () => {
            const summary = watercooler.formatCompletionsSummary([]);
            expect(summary).toBe('No task completions this week.');
        });
    });

    describe('formatBacklogSummary', () => {
        it('should format backlog summary', () => {
            const backlog = [
                { title: 'High priority item', status: 'pending', priority: 'high' },
                { title: 'Medium priority item', status: 'pending', priority: 'medium' },
                { title: 'In progress item', status: 'in_progress', priority: 'low' },
            ];

            const summary = watercooler.formatBacklogSummary(backlog);

            expect(summary).toContain('Backlog: 2 pending, 1 in progress');
            expect(summary).toContain('High priority items');
            expect(summary).toContain('High priority item');
        });

        it('should handle empty backlog', () => {
            const summary = watercooler.formatBacklogSummary([]);
            expect(summary).toBe('No items in backlog.');
        });
    });

    describe('formatPreviousMessages', () => {
        it('should format previous messages', () => {
            const messages = [
                { agentName: 'Secretary', message: 'Hello team!' },
                { agentName: 'Security', message: 'Watch out for bugs.' },
            ];

            const formatted = watercooler.formatPreviousMessages(messages);

            expect(formatted).toContain('What other agents said');
            expect(formatted).toContain('Secretary: "Hello team!"');
            expect(formatted).toContain('Security: "Watch out for bugs."');
        });

        it('should handle first speaker', () => {
            const formatted = watercooler.formatPreviousMessages([]);
            expect(formatted).toBe('You are the first to speak.');
        });
    });

    describe('buildStandupPrompt', () => {
        it('should build a complete prompt for an agent', () => {
            const agent = {
                id: 'secretary',
                name: 'Secretary',
                role: 'Calendar accountability',
                personality: 'Warm and professional',
                system_prompt: 'You are the Secretary.',
            };

            const context = {
                bulletins: [{ agentId: 'bridge', type: 'task_completed', data: { description: 'Test' } }],
                completions: [{ description: 'Completed task' }],
                backlog: [{ title: 'Pending item', status: 'pending', priority: 'high' }],
                previousMessages: [],
                isJesterFinalWord: false,
            };

            const prompt = watercooler.buildStandupPrompt(agent, context);

            expect(prompt).toContain('You are Secretary');
            expect(prompt).toContain('Your personality: Warm and professional');
            expect(prompt).toContain('STANDUP CONTEXT');
            expect(prompt).toContain('YOUR TASK');
            expect(prompt).toContain('Share your standup update');
        });

        it('should include jester final word instructions', () => {
            const agent = {
                id: 'jester',
                name: 'The Jester',
                role: 'Comedic relief',
                personality: 'Sharp-tongued',
            };

            const context = {
                bulletins: [],
                completions: [],
                backlog: [],
                previousMessages: [{ agentName: 'Secretary', message: 'All is well!' }],
                isJesterFinalWord: true,
            };

            const prompt = watercooler.buildStandupPrompt(agent, context);

            expect(prompt).toContain('You get the final word');
            // LOGIC CHANGE 2026-03-28: Updated test to reflect retro standup jester prompt
            expect(prompt).toContain('Grade the week A-F');
            expect(prompt).toContain('Roast the weakest performer');
        });

        it('should include previous messages in context', () => {
            const agent = {
                id: 'security',
                name: 'Security Auditor',
                role: 'Security reviews',
                personality: 'Paranoid',
            };

            const context = {
                bulletins: [],
                completions: [],
                backlog: [],
                previousMessages: [
                    { agentName: 'Secretary', message: 'Great week everyone!' },
                ],
                isJesterFinalWord: false,
            };

            const prompt = watercooler.buildStandupPrompt(agent, context);

            expect(prompt).toContain('What other agents said');
            expect(prompt).toContain('Secretary: "Great week everyone!"');
        });
    });

    describe('runStandup', () => {
        it('should return no agents error when none available', async () => {
            // Override loadAgents mock to return empty
            const { loadAgents } = require('../lib/agent-registry');
            loadAgents.mockReturnValueOnce([]);

            const mockSlack = {
                chat: {
                    postMessage: jest.fn().mockResolvedValue({}),
                },
            };

            const result = await watercooler.runStandup(mockSlack, 'C_TEST');

            expect(result.success).toBe(false);
            expect(result.errors).toContain('No agents available for standup');
        });

        it('should post standup header and footer', async () => {
            const mockSlack = {
                chat: {
                    postMessage: jest.fn().mockResolvedValue({}),
                },
            };

            await watercooler.runStandup(mockSlack, 'C_TEST');

            const calls = mockSlack.chat.postMessage.mock.calls;

            // LOGIC CHANGE 2026-03-28: Updated test to reflect standup type names
            // First call should be header (default type is retro)
            expect(calls[0][0].text).toContain('Retro Standup');

            // Last call should be footer
            expect(calls[calls.length - 1][0].text).toContain('complete');
        });

        it('should include agent names and emojis in messages', async () => {
            const mockSlack = {
                chat: {
                    postMessage: jest.fn().mockResolvedValue({}),
                },
            };

            await watercooler.runStandup(mockSlack, 'C_TEST');

            const calls = mockSlack.chat.postMessage.mock.calls;
            const agentMessages = calls.filter(call =>
                call[0].text.includes('*Secretary:*') ||
                call[0].text.includes('*Security Auditor:*') ||
                call[0].text.includes('*The Jester:*')
            );

            // Should have at least some agent messages (depending on mocked agents)
            expect(agentMessages.length).toBeGreaterThan(0);
        });

        it('should track conversation history for later agents', async () => {
            const { runLLM } = require('../lib/llm-runner');
            runLLM.mockImplementation((prompt) => {
                // Verify that later agents see previous messages
                if (prompt.includes('Security Auditor')) {
                    expect(prompt).toContain('What other agents said');
                }
                return Promise.resolve({ output: 'Mock response', hitMaxTurns: false });
            });

            const mockSlack = {
                chat: {
                    postMessage: jest.fn().mockResolvedValue({}),
                },
            };

            await watercooler.runStandup(mockSlack, 'C_TEST');

            // runLLM should have been called for each participating agent
            expect(runLLM).toHaveBeenCalled();
        });
    });

    describe('AGENT_DISPLAY constant', () => {
        it('should have entries for all expected agents', () => {
            const expectedAgents = [
                'secretary',
                'security',
                'jester',
                'story-bot',
                'social-media',
                'marketing',
                'code-bridge',
                'code-sqtools',
                'storefront',
                'bridge',
            ];

            for (const agentId of expectedAgents) {
                expect(watercooler.AGENT_DISPLAY[agentId]).toBeDefined();
                expect(watercooler.AGENT_DISPLAY[agentId].emoji).toBeTruthy();
                expect(typeof watercooler.AGENT_DISPLAY[agentId].order).toBe('number');
            }
        });
    });
});
