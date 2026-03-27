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
    getAgentMemoryDir,
    getProductionAgentForRepo,
    isProductionRepo,
    saveAgents,
    updateAgent,
    activateAgent,
    getAgentsNeedingActivation,
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
            memory_dir: 'agents/bridge/memory',
            workflow: 'direct-to-main',
            merge_policy: 'auto',
            deploy_policy: 'auto-update',
            production: false
        },
        {
            id: 'code-sqtools',
            name: 'SqTools Code Agent',
            role: 'Code modifications for production repo',
            channel: null,
            permissions: ['github', 'file-system'],
            denied: [],
            priority: 1,
            max_turns: 50,
            memory_dir: 'agents/code-sqtools/memory',
            workflow: 'branch-and-pr',
            merge_policy: 'owner-approval-required',
            deploy_policy: 'manual',
            branch_prefix: 'agent/',
            production: true,
            target_repo: 'jtpets/SquareDashboardTool'
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
            expect(agents).toHaveLength(4);
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

            expect(activeAgents).toHaveLength(2);
            expect(activeAgents.map(a => a.id)).toContain('bridge');
            expect(activeAgents.map(a => a.id)).toContain('code-sqtools');
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

            expect(activeAgents).toHaveLength(4);
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

    describe('getProductionAgentForRepo', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return agent for production repo', () => {
            const agent = getProductionAgentForRepo('jtpets/SquareDashboardTool');

            expect(agent).toBeDefined();
            expect(agent.id).toBe('code-sqtools');
            expect(agent.production).toBe(true);
            expect(agent.workflow).toBe('branch-and-pr');
        });

        it('should return null for non-production repo', () => {
            const agent = getProductionAgentForRepo('jtpets/slack-agent-bridge');

            expect(agent).toBeNull();
        });

        it('should return null for unknown repo', () => {
            const agent = getProductionAgentForRepo('unknown/repo');

            expect(agent).toBeNull();
        });

        it('should return null for null repo', () => {
            const agent = getProductionAgentForRepo(null);

            expect(agent).toBeNull();
        });

        it('should return null for undefined repo', () => {
            const agent = getProductionAgentForRepo(undefined);

            expect(agent).toBeNull();
        });

        it('should normalize GitHub URL format', () => {
            const agent = getProductionAgentForRepo('https://github.com/jtpets/SquareDashboardTool');

            expect(agent).toBeDefined();
            expect(agent.id).toBe('code-sqtools');
        });

        it('should normalize .git suffix', () => {
            const agent = getProductionAgentForRepo('jtpets/SquareDashboardTool.git');

            expect(agent).toBeDefined();
            expect(agent.id).toBe('code-sqtools');
        });

        it('should not match agent with production: false', () => {
            // bridge agent has production: false
            const agent = getProductionAgentForRepo('jtpets/slack-agent-bridge');

            expect(agent).toBeNull();
        });
    });

    describe('isProductionRepo', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should return true for production repo', () => {
            expect(isProductionRepo('jtpets/SquareDashboardTool')).toBe(true);
        });

        it('should return false for non-production repo', () => {
            expect(isProductionRepo('jtpets/slack-agent-bridge')).toBe(false);
        });

        it('should return false for unknown repo', () => {
            expect(isProductionRepo('unknown/repo')).toBe(false);
        });

        it('should return false for null', () => {
            expect(isProductionRepo(null)).toBe(false);
        });

        it('should return false for undefined', () => {
            expect(isProductionRepo(undefined)).toBe(false);
        });

        it('should handle GitHub URL format', () => {
            expect(isProductionRepo('https://github.com/jtpets/SquareDashboardTool')).toBe(true);
            expect(isProductionRepo('https://github.com/jtpets/slack-agent-bridge')).toBe(false);
        });
    });

    // LOGIC CHANGE 2026-03-26: Tests for agent activation helper functions
    describe('saveAgents', () => {
        it('should write agents to file', () => {
            const agents = [{ id: 'test', name: 'Test Agent' }];

            saveAgents(agents);

            expect(fs.writeFileSync).toHaveBeenCalled();
            const writeCall = fs.writeFileSync.mock.calls[0];
            const writtenData = JSON.parse(writeCall[1].trim());
            expect(writtenData).toEqual(agents);
        });
    });

    describe('updateAgent', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        it('should update agent fields', () => {
            const updated = updateAgent('bridge', { max_turns: 100 });

            expect(updated).toBeDefined();
            expect(updated.max_turns).toBe(100);
            expect(updated.id).toBe('bridge');
            expect(fs.writeFileSync).toHaveBeenCalled();
        });

        it('should return null for unknown agent', () => {
            const updated = updateAgent('unknown', { max_turns: 100 });

            expect(updated).toBeNull();
        });

        it('should preserve existing fields', () => {
            const updated = updateAgent('bridge', { priority: 5 });

            expect(updated.name).toBe('Bridge Agent');
            expect(updated.priority).toBe(5);
        });
    });

    describe('getAgentsNeedingActivation', () => {
        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
        });

        // LOGIC CHANGE 2026-03-26: Fixed test - secretary has a channel assigned (C123456789),
        // so only security (which has status=planned and channel=null) should be returned.
        it('should return agents with planned status and no channel', () => {
            const agents = getAgentsNeedingActivation();

            expect(agents).toHaveLength(1); // only security has status=planned AND no channel
            expect(agents.some(a => a.id === 'security')).toBe(true);
        });

        it('should not return agents with channels', () => {
            const agents = getAgentsNeedingActivation();

            // secretary has a channel assigned
            const hasSecretary = agents.some(a => a.id === 'secretary');
            expect(hasSecretary).toBe(false);
        });

        it('should return empty array when all agents are active', () => {
            const allActive = mockAgents.map(a => {
                const { status, ...rest } = a;
                return { ...rest, channel: 'C12345' };
            });
            fs.readFileSync.mockReturnValue(JSON.stringify(allActive));

            const agents = getAgentsNeedingActivation();

            expect(agents).toHaveLength(0);
        });
    });

    describe('activateAgent', () => {
        let mockSlackClient;

        beforeEach(() => {
            fs.readFileSync.mockReturnValue(JSON.stringify(mockAgents));
            mockSlackClient = {
                ensureChannel: jest.fn().mockResolvedValue({
                    channelId: 'C99999',
                    name: 'secretary-agent',
                    created: true,
                }),
            };
        });

        it('should throw error for unknown agent', async () => {
            await expect(activateAgent('unknown', mockSlackClient)).rejects.toThrow(
                'Agent not found: unknown'
            );
        });

        it('should throw error for already active agent', async () => {
            // bridge agent has no status field (active)
            await expect(activateAgent('bridge', mockSlackClient)).rejects.toThrow(
                'not in "planned" status'
            );
        });

        it('should activate agent and create channel if none assigned', async () => {
            // security agent has status=planned and no channel
            const result = await activateAgent('security', mockSlackClient);

            expect(result.channelCreated).toBe(true);
            expect(result.channelId).toBe('C99999');
            expect(mockSlackClient.ensureChannel).toHaveBeenCalledWith(
                'security-agent',
                expect.stringContaining('Security Auditor')
            );
        });

        it('should not create channel if already assigned', async () => {
            // secretary has a channel assigned but status=planned
            const result = await activateAgent('secretary', mockSlackClient);

            expect(result.channelCreated).toBe(false);
            expect(mockSlackClient.ensureChannel).not.toHaveBeenCalled();
        });

        it('should continue activation even if channel creation fails', async () => {
            mockSlackClient.ensureChannel.mockRejectedValue(new Error('API error'));

            // security agent has no channel, channel creation will fail
            const result = await activateAgent('security', mockSlackClient);

            // Activation should still complete, just without a channel
            expect(result.channelId).toBe(null);
            expect(result.channelCreated).toBe(false);
        });

        it('should work without slackClient (channel remains null)', async () => {
            const result = await activateAgent('security', null);

            expect(result.channelId).toBe(null);
            expect(result.channelCreated).toBe(false);
        });
    });
});
