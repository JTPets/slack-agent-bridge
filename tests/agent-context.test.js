/**
 * tests/agent-context.test.js
 *
 * Tests for lib/agent-context.js - Agent context builder for preventing hallucinations.
 */

'use strict';

// Mock dependencies before requiring the module
jest.mock('../lib/integrations/google-calendar', () => ({
    getAllTodayEvents: jest.fn(),
    getAllTomorrowEvents: jest.fn(),
}));

jest.mock('../lib/owner-tasks', () => ({
    getPendingTasks: jest.fn(),
}));

jest.mock('../lib/bulletin-board', () => ({
    getBulletins: jest.fn(),
}));

const agentContext = require('../lib/agent-context');
const googleCalendar = require('../lib/integrations/google-calendar');
const ownerTasks = require('../lib/owner-tasks');
const bulletinBoard = require('../lib/bulletin-board');

describe('agent-context', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('ANTI_HALLUCINATION_RULE', () => {
        it('should export the anti-hallucination rule', () => {
            expect(agentContext.ANTI_HALLUCINATION_RULE).toBeDefined();
            expect(agentContext.ANTI_HALLUCINATION_RULE).toContain('NEVER invent');
            expect(agentContext.ANTI_HALLUCINATION_RULE).toContain("I don't have access");
        });
    });

    describe('formatEventsForPrompt', () => {
        it('should return "No events scheduled." for empty array', () => {
            expect(agentContext.formatEventsForPrompt([])).toBe('No events scheduled.');
        });

        it('should return "No events scheduled." for null', () => {
            expect(agentContext.formatEventsForPrompt(null)).toBe('No events scheduled.');
        });

        it('should format events with times', () => {
            const events = [
                { title: 'Team Meeting', start: '2026-03-28T10:00:00-04:00' },
                { title: 'Lunch', start: '2026-03-28T12:00:00-04:00' },
            ];
            const result = agentContext.formatEventsForPrompt(events);
            expect(result).toContain('Team Meeting');
            expect(result).toContain('Lunch');
            expect(result).toMatch(/\d+:\d+ (AM|PM)/);
        });

        it('should handle all-day events', () => {
            const events = [
                { title: 'Vacation', start: '2026-03-28' },
            ];
            const result = agentContext.formatEventsForPrompt(events);
            expect(result).toContain('All day');
            expect(result).toContain('Vacation');
        });
    });

    describe('buildSecretaryContext', () => {
        it('should include calendar data and owner tasks', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([
                { title: 'Morning Standup', start: '2026-03-28T09:00:00-04:00' },
            ]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([
                { title: 'Client Call', start: '2026-03-29T14:00:00-04:00' },
            ]);
            ownerTasks.getPendingTasks.mockReturnValue([
                { description: 'Set up email forwarding', priority: 'high' },
            ]);

            const context = await agentContext.buildSecretaryContext();

            expect(context).toContain("TODAY'S CALENDAR");
            expect(context).toContain('Morning Standup');
            expect(context).toContain("TOMORROW'S CALENDAR");
            expect(context).toContain('Client Call');
            expect(context).toContain('PENDING OWNER TASKS');
            expect(context).toContain('Set up email forwarding');
            expect(context).toContain('[HIGH]');
        });

        it('should handle empty calendar gracefully', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);

            const context = await agentContext.buildSecretaryContext();

            expect(context).toContain("TODAY'S CALENDAR");
            expect(context).toContain('No events scheduled.');
            expect(context).toContain('PENDING OWNER TASKS: None');
        });

        it('should handle calendar API errors gracefully', async () => {
            googleCalendar.getAllTodayEvents.mockRejectedValue(new Error('API error'));
            googleCalendar.getAllTomorrowEvents.mockRejectedValue(new Error('API error'));
            ownerTasks.getPendingTasks.mockReturnValue([]);

            const context = await agentContext.buildSecretaryContext();

            // Should not throw, should include empty calendar data
            expect(context).toContain("TODAY'S CALENDAR");
            expect(context).toContain('No events scheduled.');
        });
    });

    describe('buildSecurityContext', () => {
        it('should include security findings and recent tasks', () => {
            bulletinBoard.getBulletins.mockImplementation(({ type }) => {
                if (type === 'security_finding') {
                    return [
                        {
                            data: { description: 'SQL injection vulnerability found' },
                            timestamp: '2026-03-28T10:00:00Z',
                        },
                    ];
                }
                if (type === 'task_completed') {
                    return [
                        {
                            data: { description: 'Updated auth module', repo: 'jtpets/slack-agent-bridge' },
                        },
                    ];
                }
                return [];
            });

            const context = agentContext.buildSecurityContext();

            expect(context).toContain('RECENT SECURITY FINDINGS');
            expect(context).toContain('SQL injection');
            expect(context).toContain('RECENT CODE CHANGES TO REVIEW');
            expect(context).toContain('Updated auth module');
        });

        it('should handle no security findings', () => {
            bulletinBoard.getBulletins.mockReturnValue([]);

            const context = agentContext.buildSecurityContext();

            expect(context).toContain('None in the past 7 days');
        });
    });

    describe('buildJesterContext', () => {
        it('should include milestones and completed tasks', () => {
            bulletinBoard.getBulletins.mockImplementation(({ type }) => {
                if (type === 'milestone') {
                    return [
                        { agentId: 'bridge', data: { description: 'Reached 1000 tasks' } },
                    ];
                }
                if (type === 'task_completed') {
                    return [
                        { data: { description: 'Fixed critical bug' } },
                    ];
                }
                return [];
            });

            const context = agentContext.buildJesterContext();

            expect(context).toContain('RECENT MILESTONES');
            expect(context).toContain('Reached 1000 tasks');
            expect(context).toContain('RECENT COMPLETED TASKS');
            expect(context).toContain('Fixed critical bug');
        });
    });

    describe('buildStoryBotContext', () => {
        it('should include milestones and technical accomplishments', () => {
            bulletinBoard.getBulletins.mockImplementation(({ type }) => {
                if (type === 'milestone') {
                    return [
                        {
                            data: { description: 'Launched new feature' },
                            timestamp: '2026-03-28T10:00:00Z',
                        },
                    ];
                }
                if (type === 'task_completed') {
                    return [
                        { data: { description: 'Implemented multi-agent system', repo: 'jtpets/slack-agent-bridge' } },
                    ];
                }
                return [];
            });

            const context = agentContext.buildStoryBotContext();

            expect(context).toContain('RECENT MILESTONES');
            expect(context).toContain('Launched new feature');
            expect(context).toContain('RECENT TECHNICAL ACCOMPLISHMENTS');
            expect(context).toContain('multi-agent system');
        });
    });

    describe('buildCodeAgentContext', () => {
        it('should include agent-specific and team code tasks', () => {
            bulletinBoard.getBulletins.mockImplementation(({ agentId, type }) => {
                if (agentId === 'bridge' && type === 'task_completed') {
                    return [
                        { data: { description: 'Fixed rate limiting' } },
                    ];
                }
                if (type === 'task_completed') {
                    return [
                        { agentId: 'bridge', data: { description: 'Fixed rate limiting', repo: 'slack-agent-bridge' } },
                        { agentId: 'code-sqtools', data: { description: 'Updated API', repo: 'SquareDashboardTool' } },
                    ];
                }
                return [];
            });

            const context = agentContext.buildCodeAgentContext('bridge');

            expect(context).toContain('YOUR RECENT COMPLETED TASKS');
            expect(context).toContain('Fixed rate limiting');
            expect(context).toContain('RECENT TEAM CODE CHANGES');
        });
    });

    describe('buildEnrichedPrompt', () => {
        it('should include system prompt for any agent', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);
            bulletinBoard.getBulletins.mockReturnValue([]);

            const agent = {
                id: 'secretary',
                system_prompt: 'You are the Secretary for JT Pets.',
            };

            const prompt = await agentContext.buildEnrichedPrompt(agent, 'What is on my calendar?');

            expect(prompt).toContain('You are the Secretary for JT Pets.');
        });

        it('should include anti-hallucination rule for all agents', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);
            bulletinBoard.getBulletins.mockReturnValue([]);

            const agent = { id: 'secretary', system_prompt: 'Test prompt' };
            const prompt = await agentContext.buildEnrichedPrompt(agent, 'Test question');

            expect(prompt).toContain('NEVER invent');
            expect(prompt).toContain("I don't have access");
        });

        it('should inject real calendar data for secretary', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([
                { title: 'Board Meeting', start: '2026-03-28T10:00:00-04:00' },
            ]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);

            const agent = { id: 'secretary', system_prompt: 'You are the secretary.' };
            const prompt = await agentContext.buildEnrichedPrompt(agent, 'What meetings do I have?');

            expect(prompt).toContain('Board Meeting');
            expect(prompt).toContain("TODAY'S CALENDAR");
        });

        it('should include the user question at the end', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);

            const agent = { id: 'secretary', system_prompt: 'Test' };
            const prompt = await agentContext.buildEnrichedPrompt(agent, 'What is my schedule?');

            expect(prompt).toContain('User question: What is my schedule?');
            // Question should be at the end
            expect(prompt.indexOf('User question:')).toBeGreaterThan(prompt.indexOf('NEVER invent'));
        });

        it('should include additional context when provided', async () => {
            googleCalendar.getAllTodayEvents.mockResolvedValue([]);
            googleCalendar.getAllTomorrowEvents.mockResolvedValue([]);
            ownerTasks.getPendingTasks.mockReturnValue([]);

            const agent = { id: 'secretary', system_prompt: 'Test' };
            const additionalContext = {
                memoryContext: 'Recent task: Fixed bug',
                bulletinContext: 'Bulletin: New milestone',
            };

            const prompt = await agentContext.buildEnrichedPrompt(agent, 'Test', additionalContext);

            expect(prompt).toContain('Recent task: Fixed bug');
            expect(prompt).toContain('Bulletin: New milestone');
        });

        it('should handle missing agent gracefully', async () => {
            const prompt = await agentContext.buildEnrichedPrompt(null, 'Test question');

            expect(prompt).toContain('You are a helpful assistant');
            expect(prompt).toContain('NEVER invent');
            expect(prompt).toContain('User question: Test question');
        });

        it('should call appropriate context builder based on agent id', async () => {
            // Security agent should get security context
            bulletinBoard.getBulletins.mockImplementation(({ type }) => {
                if (type === 'security_finding') {
                    return [];
                }
                return [];
            });

            const securityAgent = { id: 'security', system_prompt: 'Security auditor' };
            const securityPrompt = await agentContext.buildEnrichedPrompt(securityAgent, 'Test');
            // Security context always includes the heading, even if no findings
            expect(securityPrompt).toContain('SECURITY FINDINGS');

            // Jester with milestones should include MILESTONES heading
            bulletinBoard.getBulletins.mockImplementation(({ type }) => {
                if (type === 'milestone') {
                    return [
                        { agentId: 'bridge', data: { description: 'Test milestone' } },
                    ];
                }
                return [];
            });

            const jesterAgent = { id: 'jester', system_prompt: 'The Jester' };
            const jesterPrompt = await agentContext.buildEnrichedPrompt(jesterAgent, 'Test');
            expect(jesterPrompt).toContain('MILESTONES');
            expect(jesterPrompt).toContain('Test milestone');
        });
    });
});
