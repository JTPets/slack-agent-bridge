'use strict';

/**
 * Tests for bots/storefront.js
 *
 * LOGIC CHANGE 2026-03-27: Initial test suite for storefront chat bot.
 */

// Mock dependencies before requiring the module
jest.mock('@slack/web-api', () => ({
    WebClient: jest.fn().mockImplementation(() => ({
        chat: {
            postMessage: jest.fn().mockResolvedValue({ ok: true }),
        },
    })),
}));

jest.mock('../lib/llm-runner', () => ({
    runLLM: jest.fn().mockResolvedValue({ output: 'Test response', hitMaxTurns: false }),
}));

// Set required env vars before requiring module
process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

const request = require('supertest');
const {
    app,
    getOrCreateSession,
    buildPrompt,
    sanitizeInput,
    cleanExpiredSessions,
    sessions,
    STOREFRONT_AGENT_CONFIG,
} = require('../bots/storefront');
const { runLLM } = require('../lib/llm-runner');

describe('storefront', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        sessions.clear();
    });

    describe('sanitizeInput', () => {
        it('should return empty string for invalid input', () => {
            expect(sanitizeInput(null)).toBe('');
            expect(sanitizeInput(undefined)).toBe('');
            expect(sanitizeInput('')).toBe('');
            expect(sanitizeInput(123)).toBe('');
        });

        it('should trim whitespace', () => {
            expect(sanitizeInput('  hello  ')).toBe('hello');
            expect(sanitizeInput('\n\thello\n')).toBe('hello');
        });

        it('should remove control characters', () => {
            expect(sanitizeInput('hello\x00world')).toBe('helloworld');
            expect(sanitizeInput('test\x1fdata')).toBe('testdata');
        });

        it('should truncate to 2000 characters', () => {
            const longInput = 'a'.repeat(3000);
            expect(sanitizeInput(longInput).length).toBe(2000);
        });

        it('should preserve valid text', () => {
            expect(sanitizeInput('Hello, how are you?')).toBe('Hello, how are you?');
            expect(sanitizeInput('What food is best for dogs?')).toBe('What food is best for dogs?');
        });
    });

    describe('getOrCreateSession', () => {
        it('should create new session for unknown ID', () => {
            const session = getOrCreateSession('test-session-1');

            expect(session.id).toBe('test-session-1');
            expect(session.history).toEqual([]);
            expect(session.lastActivity).toBeDefined();
            expect(session.createdAt).toBeDefined();
        });

        it('should return existing session for known ID', () => {
            const session1 = getOrCreateSession('test-session-2');
            session1.history.push({ role: 'user', content: 'hello' });

            const session2 = getOrCreateSession('test-session-2');

            expect(session2.history).toHaveLength(1);
            expect(session2.history[0].content).toBe('hello');
        });

        it('should update lastActivity on access', () => {
            const session = getOrCreateSession('test-session-3');
            const initialActivity = session.lastActivity;

            // Wait a tiny bit
            const later = Date.now() + 1;
            session.lastActivity = later - 100; // Manually set to earlier time

            getOrCreateSession('test-session-3');

            expect(session.lastActivity).toBeGreaterThanOrEqual(later - 100);
        });
    });

    describe('buildPrompt', () => {
        it('should include system prompt', () => {
            const prompt = buildPrompt([], 'Hello');

            expect(prompt).toContain(STOREFRONT_AGENT_CONFIG.systemPrompt);
            expect(prompt).toContain('Customer: Hello');
            expect(prompt).toContain('Agent:');
        });

        it('should include conversation history', () => {
            const history = [
                { role: 'user', content: 'What food is best for puppies?' },
                { role: 'assistant', content: 'For puppies, I recommend...' },
            ];

            const prompt = buildPrompt(history, 'Thanks!');

            expect(prompt).toContain('Previous conversation:');
            expect(prompt).toContain('Customer: What food is best for puppies?');
            expect(prompt).toContain('Agent: For puppies, I recommend...');
            expect(prompt).toContain('Customer: Thanks!');
        });

        it('should limit history to last 10 messages', () => {
            const history = [];
            for (let i = 0; i < 15; i++) {
                history.push({ role: 'user', content: `Message ${i}` });
            }

            const prompt = buildPrompt(history, 'Latest');

            // Should only include messages 5-14 (last 10)
            expect(prompt).not.toContain('Message 0');
            expect(prompt).not.toContain('Message 4');
            expect(prompt).toContain('Message 5');
            expect(prompt).toContain('Message 14');
        });
    });

    describe('cleanExpiredSessions', () => {
        it('should remove expired sessions', () => {
            // Create two sessions
            const session1 = getOrCreateSession('session-1');
            const session2 = getOrCreateSession('session-2');

            // Make session1 expired (set lastActivity to 2 hours ago)
            session1.lastActivity = Date.now() - 2 * 60 * 60 * 1000;

            cleanExpiredSessions();

            expect(sessions.has('session-1')).toBe(false);
            expect(sessions.has('session-2')).toBe(true);
        });

        it('should keep non-expired sessions', () => {
            getOrCreateSession('active-session');

            cleanExpiredSessions();

            expect(sessions.has('active-session')).toBe(true);
        });
    });

    describe('HTTP endpoints', () => {
        describe('GET /health', () => {
            it('should return health status', async () => {
                const response = await request(app).get('/health');

                expect(response.status).toBe(200);
                expect(response.body).toEqual({
                    status: 'ok',
                    agent: 'storefront',
                });
            });
        });

        describe('POST /api/chat', () => {
            it('should return chat response', async () => {
                runLLM.mockResolvedValue({ output: 'Hello! How can I help you?', hitMaxTurns: false });

                const response = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Hello' });

                expect(response.status).toBe(200);
                expect(response.body.response).toBe('Hello! How can I help you?');
                expect(response.body.sessionId).toBeDefined();
            });

            it('should use provided sessionId', async () => {
                runLLM.mockResolvedValue({ output: 'Test response', hitMaxTurns: false });

                const response = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Hello', sessionId: 'my-session-id' });

                expect(response.status).toBe(200);
                expect(response.body.sessionId).toBe('my-session-id');
            });

            it('should return error for empty message', async () => {
                const response = await request(app)
                    .post('/api/chat')
                    .send({ message: '' });

                expect(response.status).toBe(400);
                expect(response.body.code).toBe('INVALID_MESSAGE');
            });

            it('should return error for missing message', async () => {
                const response = await request(app)
                    .post('/api/chat')
                    .send({});

                expect(response.status).toBe(400);
                expect(response.body.code).toBe('INVALID_MESSAGE');
            });

            it('should handle rate limit errors', async () => {
                const rateLimitError = new Error('Rate limited');
                rateLimitError.isRateLimit = true;
                runLLM.mockRejectedValue(rateLimitError);

                const response = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Hello' });

                expect(response.status).toBe(429);
                expect(response.body.code).toBe('RATE_LIMITED');
            });

            it('should handle internal errors', async () => {
                runLLM.mockRejectedValue(new Error('Something broke'));

                const response = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Hello' });

                expect(response.status).toBe(500);
                expect(response.body.code).toBe('INTERNAL_ERROR');
            });

            it('should maintain conversation history across requests', async () => {
                runLLM.mockResolvedValue({ output: 'Response 1', hitMaxTurns: false });

                // First message
                const response1 = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Hello', sessionId: 'persistent-session' });

                expect(response1.status).toBe(200);

                runLLM.mockResolvedValue({ output: 'Response 2', hitMaxTurns: false });

                // Second message with same session
                const response2 = await request(app)
                    .post('/api/chat')
                    .send({ message: 'Follow up', sessionId: 'persistent-session' });

                expect(response2.status).toBe(200);

                // Verify the session has history
                const session = sessions.get('persistent-session');
                expect(session.history).toHaveLength(4); // 2 user + 2 assistant messages
            });

            it('should call runLLM with correct parameters', async () => {
                runLLM.mockResolvedValue({ output: 'Test', hitMaxTurns: false });

                await request(app)
                    .post('/api/chat')
                    .send({ message: 'What food is best?' });

                expect(runLLM).toHaveBeenCalledWith(
                    expect.stringContaining('What food is best?'),
                    expect.objectContaining({
                        maxTurns: 15,
                        timeout: 60000,
                    })
                );
            });
        });

        describe('GET /widget', () => {
            it('should return HTML content', async () => {
                const response = await request(app).get('/widget');

                expect(response.status).toBe(200);
                expect(response.headers['content-type']).toContain('text/html');
            });
        });
    });

    describe('STOREFRONT_AGENT_CONFIG', () => {
        it('should have required fields', () => {
            expect(STOREFRONT_AGENT_CONFIG.name).toBe('Storefront Agent');
            expect(STOREFRONT_AGENT_CONFIG.maxTurns).toBe(15);
            expect(STOREFRONT_AGENT_CONFIG.systemPrompt).toContain('JT Pets');
        });

        it('should include store information in system prompt', () => {
            expect(STOREFRONT_AGENT_CONFIG.systemPrompt).toContain('Toronto');
            expect(STOREFRONT_AGENT_CONFIG.systemPrompt).toContain('pet nutrition');
        });
    });
});
