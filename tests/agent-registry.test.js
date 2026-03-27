'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// We need to mock fs before requiring the module
jest.mock('fs');

const {
    loadAgents,
    getAgent,
    getAgentByChannel,
    getActiveAgents,
    registryExists,
    getAgentMemoryDir
} = require('../lib/agent-registry');

describe('agent-registry', () => {
    const mockAgents = [
        {
            id: 'bridge',
            name: 'Bridge Agent',
            role: 'Code execution',
            channel: 'C0ANZUEJXEJ',
            permissions: ['github', 'file-system'],
            denied: [],
            priority: 1,
            max_turns: 50,
            memory_dir: 'agents/bridge/memory'
        },
        {
            id: 'secretary',
            name: 'Secretary',
            role: 'Calendar management',
            channel: 'C123456789',
            permissions: ['google-calendar'],
            denied: ['github-write'],
            priority: 2,
            max_turns: 20,
            memory_dir: 'agents/secretary/memory',
            status: 'planned'
        },
        {
            id: 'security',
            name: 'Security Auditor',
            role: 'Security review',
            channel: null,
            permissions: ['github-read'],
            denied: ['github-write'],
            priority: 3,
            max_turns: 30,
            memory_dir: 'agents/security/memory',
            status: 'planned'
        }
    ];

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('loadAgents', () => {
        it('should load agents from agents.json', () => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));

            const agents = loadAgents();

            expect(agents).toEqual(mockAgents);
            expect(agents).toHaveLength(3);
        });

        it('should return empty array when file does not exist', () => {
            const error = new Error('File not found');
            error.code = 'ENOENT';
            fs.readFileSync.mockImplementation(() => { throw error; });

            const agents = loadAgents();

            expect(agents).toEqual([]);
        });

        it('should throw on invalid JSON', () => {
            fs.readFileSync.mockReturnValue('invalid json{');

            expect(() => loadAgents()).toThrow();
        });

        it('should throw on other file read errors', () => {
            const error = new Error('Permission denied');
            error.code = 'EACCES';
            fs.readFileSync.mockImplementation(() => { throw error; });

            expect(() => loadAgents()).toThrow('Permission denied');
        });
    });

    describe('getAgent', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return agent by ID', () => {
            const agent = getAgent('bridge');

            expect(agent).toBeDefined();
            expect(agent.id).toBe('bridge');
            expect(agent.name).toBe('Bridge Agent');
            expect(agent.max_turns).toBe(50);
        });

        it('should return null for unknown agent ID', () => {
            const agent = getAgent('unknown-agent');

            expect(agent).toBeNull();
        });

        it('should return null when registry is empty', () => {
            fs.readFileSync.mockReturnValue('[]');

            const agent = getAgent('bridge');

            expect(agent).toBeNull();
        });

        it('should find planned agents', () => {
            const agent = getAgent('secretary');

            expect(agent).toBeDefined();
            expect(agent.status).toBe('planned');
        });
    });

    describe('getAgentByChannel', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return agent by channel ID', () => {
            const agent = getAgentByChannel('C0ANZUEJXEJ');

            expect(agent).toBeDefined();
            expect(agent.id).toBe('bridge');
        });

        it('should return null for unknown channel', () => {
            const agent = getAgentByChannel('CUNKNOWN');

            expect(agent).toBeNull();
        });

        it('should return null for null channel ID', () => {
            const agent = getAgentByChannel(null);

            expect(agent).toBeNull();
        });

        it('should return null for undefined channel ID', () => {
            const agent = getAgentByChannel(undefined);

            expect(agent).toBeNull();
        });

        it('should return null for empty string channel ID', () => {
            const agent = getAgentByChannel('');

            expect(agent).toBeNull();
        });

        it('should not match agents with null channel', () => {
            // security agent has channel: null
            const agent = getAgentByChannel('null');

            expect(agent).toBeNull();
        });
    });

    describe('getActiveAgents', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return only non-planned agents', () => {
            const activeAgents = getActiveAgents();

            expect(activeAgents).toHaveLength(1);
            expect(activeAgents[0].id).toBe('bridge');
        });

        it('should return empty array when all agents are planned', () => {
            const allPlanned = mockAgents.map(a => ({ ...a, status: 'planned' }));
            fs.readFileSync.mockReturnValue(JSON.stringify(allPlanned));

            const activeAgents = getActiveAgents();

            expect(activeAgents).toHaveLength(0);
        });

        it('should return all agents when none are planned', () => {
            const noneStatus = mockAgents.map(a => {
                const { status, ...rest } = a;
                return rest;
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(noneStatus));

            const activeAgents = getActiveAgents();

            expect(activeAgents).toHaveLength(3);
        });
    });

    describe('registryExists', () => {
        it('should return true when agents.json exists', () => {
            fs.existsSync.mockReturnValue(true);

            expect(registryExists()).toBe(true);
        });

        it('should return false when agents.json does not exist', () => {
            fs.existsSync.mockReturnValue(false);

            expect(registryExists()).toBe(false);
        });
    });

    describe('getAgentMemoryDir', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return absolute path to memory directory', () => {
            const memDir = getAgentMemoryDir('bridge');

            expect(memDir).toBeDefined();
            expect(memDir).toContain('agents');
            expect(memDir).toContain('bridge');
            expect(memDir).toContain('memory');
            expect(path.isAbsolute(memDir)).toBe(true);
        });

        it('should return null for unknown agent', () => {
            const memDir = getAgentMemoryDir('unknown');

            expect(memDir).toBeNull();
        });

        it('should return correct paths for different agents', () => {
            const bridgeDir = getAgentMemoryDir('bridge');
            const secretaryDir = getAgentMemoryDir('secretary');

            expect(bridgeDir).toContain('bridge');
            expect(secretaryDir).toContain('secretary');
            expect(bridgeDir).not.toEqual(secretaryDir);
        });
    });

    describe('edge cases', () => {
        it('should handle agent with no memory_dir', () => {
            const agentNoMemory = [{ id: 'test', name: 'Test' }];
            fs.readFileSync.mockReturnValue(JSON.stringify(agentNoMemory));

            const memDir = getAgentMemoryDir('test');

            expect(memDir).toBeNull();
        });

        it('should handle empty agents array', () => {
            fs.readFileSync.mockReturnValue('[]');

            expect(loadAgents()).toEqual([]);
            expect(getAgent('any')).toBeNull();
            expect(getAgentByChannel('any')).toBeNull();
            expect(getActiveAgents()).toEqual([]);
        });
    });
});
