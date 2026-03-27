'use strict';

/**
 * Tests for lib/memory-tiers.js
 *
 * Covers: TTL expiry, auto-promote after 3 occurrences, cleanup removes expired,
 * archive preserves decayed items, getRelevantMemory returns correct tiers
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const memoryTiers = require('../lib/memory-tiers');

describe('memory-tiers', () => {
    let testDir;
    let agentId;

    beforeEach(() => {
        // Create isolated temp directory for each test
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tiers-test-'));
        agentId = 'test-agent';

        // Create agent memory directory structure
        const agentMemoryDir = path.join(testDir, 'agents', agentId, 'memory');
        fs.mkdirSync(agentMemoryDir, { recursive: true });
    });

    afterEach(() => {
        // Cleanup temp directory
        if (testDir && fs.existsSync(testDir)) {
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    describe('createEntry', () => {
        it('creates entry with required metadata', () => {
            const entry = memoryTiers.createEntry('test content', 'test-source', 24);

            expect(entry.id).toBeDefined();
            expect(entry.content).toBe('test content');
            expect(entry.source).toBe('test-source');
            expect(entry.created).toBeDefined();
            expect(entry.lastAccessed).toBeDefined();
            expect(entry.accessCount).toBe(1);
            expect(entry.ttl).toBe(24 * 60 * 60 * 1000); // 24 hours in ms
        });

        it('creates entry with zero TTL when not specified', () => {
            const entry = memoryTiers.createEntry('content', 'source');
            expect(entry.ttl).toBe(0);
        });
    });

    describe('isExpired', () => {
        it('returns false for entries with no TTL', () => {
            const entry = { content: 'test', ttl: 0, created: new Date().toISOString() };
            expect(memoryTiers.isExpired(entry)).toBe(false);
        });

        it('returns false for fresh entries with TTL', () => {
            const entry = {
                content: 'test',
                ttl: 24 * 60 * 60 * 1000, // 24 hours
                created: new Date().toISOString()
            };
            expect(memoryTiers.isExpired(entry)).toBe(false);
        });

        it('returns true for expired entries', () => {
            const pastDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
            const entry = {
                content: 'test',
                ttl: 24 * 60 * 60 * 1000, // 24 hours
                created: pastDate.toISOString()
            };
            expect(memoryTiers.isExpired(entry)).toBe(true);
        });
    });

    describe('shouldDecay', () => {
        it('returns false for recently accessed entries', () => {
            const entry = { lastAccessed: new Date().toISOString() };
            expect(memoryTiers.shouldDecay(entry)).toBe(false);
        });

        it('returns true for entries not accessed in 30 days', () => {
            const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
            const entry = { lastAccessed: oldDate.toISOString() };
            expect(memoryTiers.shouldDecay(entry)).toBe(true);
        });

        it('respects custom decay days', () => {
            const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
            const entry = { lastAccessed: oldDate.toISOString() };
            expect(memoryTiers.shouldDecay(entry, 7)).toBe(true);
            expect(memoryTiers.shouldDecay(entry, 10)).toBe(false);
        });
    });

    describe('addWorkingMemory', () => {
        it('adds entry to working memory', () => {
            const result = memoryTiers.addWorkingMemory(agentId, testDir, {
                content: 'current task state',
                source: 'task'
            });

            expect(result.id).toBeDefined();
            expect(result.content).toBe('current task state');
            expect(result.source).toBe('task');

            // Verify file was created
            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'working.json');
            expect(fs.existsSync(filePath)).toBe(true);

            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data).toHaveLength(1);
            expect(data[0].content).toBe('current task state');
        });

        it('appends multiple entries', () => {
            memoryTiers.addWorkingMemory(agentId, testDir, { content: 'entry1', source: 'test' });
            memoryTiers.addWorkingMemory(agentId, testDir, { content: 'entry2', source: 'test' });

            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'working.json');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data).toHaveLength(2);
        });
    });

    describe('clearWorkingMemory', () => {
        it('clears working memory', () => {
            memoryTiers.addWorkingMemory(agentId, testDir, { content: 'entry1', source: 'test' });
            memoryTiers.clearWorkingMemory(agentId, testDir);

            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'working.json');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data).toHaveLength(0);
        });

        it('handles non-existent file gracefully', () => {
            expect(() => {
                memoryTiers.clearWorkingMemory(agentId, testDir);
            }).not.toThrow();
        });
    });

    describe('addShortTerm', () => {
        it('adds entry with default TTL', () => {
            const result = memoryTiers.addShortTerm(agentId, testDir, {
                content: 'recent event',
                source: 'calendar'
            });

            expect(result.content).toBe('recent event');
            expect(result.ttl).toBe(48 * 60 * 60 * 1000); // 48 hours default
        });

        it('adds entry with custom TTL', () => {
            const result = memoryTiers.addShortTerm(agentId, testDir, {
                content: 'short-lived',
                source: 'reminder'
            }, 12);

            expect(result.ttl).toBe(12 * 60 * 60 * 1000);
        });

        it('increments accessCount for duplicate content', () => {
            memoryTiers.addShortTerm(agentId, testDir, { content: 'repeated', source: 'test' });
            memoryTiers.addShortTerm(agentId, testDir, { content: 'repeated', source: 'test' });
            const result = memoryTiers.addShortTerm(agentId, testDir, { content: 'repeated', source: 'test' });

            expect(result.accessCount).toBe(3);

            // Only one entry should exist
            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data).toHaveLength(1);
        });

        it('handles object content for duplicate detection', () => {
            memoryTiers.addShortTerm(agentId, testDir, { content: { key: 'value' }, source: 'test' });
            const result = memoryTiers.addShortTerm(agentId, testDir, { content: { key: 'value' }, source: 'test' });

            expect(result.accessCount).toBe(2);
        });
    });

    describe('promoteToLongTerm', () => {
        it('moves entry from short-term to long-term', () => {
            const shortTermEntry = memoryTiers.addShortTerm(agentId, testDir, {
                content: 'pattern',
                source: 'test'
            });

            const result = memoryTiers.promoteToLongTerm(agentId, testDir, shortTermEntry.id);

            expect(result).toBeDefined();
            expect(result.content).toBe('pattern');
            expect(result.promotedAt).toBeDefined();
            expect(result.ttl).toBe(0); // Long-term uses decay, not TTL

            // Verify removed from short-term
            const shortTermPath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            const shortTermData = JSON.parse(fs.readFileSync(shortTermPath, 'utf8'));
            expect(shortTermData).toHaveLength(0);

            // Verify added to long-term
            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            const longTermData = JSON.parse(fs.readFileSync(longTermPath, 'utf8'));
            expect(longTermData).toHaveLength(1);
        });

        it('returns null for non-existent entry', () => {
            const result = memoryTiers.promoteToLongTerm(agentId, testDir, 'non-existent-id');
            expect(result).toBeNull();
        });
    });

    describe('addPermanent', () => {
        it('adds permanent context entry', () => {
            const result = memoryTiers.addPermanent(agentId, testDir, 'owner', 'John');

            expect(result.owner).toBe('John');
            expect(result._lastUpdated).toBeDefined();

            // Verify file
            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'context.json');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data.owner).toBe('John');
        });

        it('overwrites existing key', () => {
            memoryTiers.addPermanent(agentId, testDir, 'setting', 'old');
            const result = memoryTiers.addPermanent(agentId, testDir, 'setting', 'new');

            expect(result.setting).toBe('new');
        });
    });

    describe('getRelevantMemory', () => {
        it('returns combined memory from all tiers', () => {
            // Add entries to each tier
            memoryTiers.addPermanent(agentId, testDir, 'owner', 'Test Owner');
            memoryTiers.addWorkingMemory(agentId, testDir, { content: 'working item', source: 'test' });
            memoryTiers.addShortTerm(agentId, testDir, { content: 'short term item', source: 'test' });

            // Add long-term by promoting
            const shortEntry = memoryTiers.addShortTerm(agentId, testDir, { content: 'promoted item', source: 'test' });
            memoryTiers.promoteToLongTerm(agentId, testDir, shortEntry.id);

            const memory = memoryTiers.getRelevantMemory(agentId, testDir);

            expect(memory.context.owner).toBe('Test Owner');
            expect(memory.working).toHaveLength(1);
            expect(memory.shortTerm).toHaveLength(1);
            expect(memory.longTerm).toHaveLength(1);
        });

        it('filters expired short-term entries', () => {
            // Add a fresh entry
            memoryTiers.addShortTerm(agentId, testDir, { content: 'fresh', source: 'test' });

            // Manually add an expired entry
            const shortTermPath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            const data = JSON.parse(fs.readFileSync(shortTermPath, 'utf8'));
            data.push({
                id: 'expired-id',
                content: 'expired',
                created: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(), // 50 hours ago
                ttl: 48 * 60 * 60 * 1000, // 48 hours
                source: 'test'
            });
            fs.writeFileSync(shortTermPath, JSON.stringify(data, null, 2));

            const memory = memoryTiers.getRelevantMemory(agentId, testDir);

            expect(memory.shortTerm).toHaveLength(1);
            expect(memory.shortTerm[0].content).toBe('fresh');
        });

        it('sorts long-term by lastAccessed descending', () => {
            // Add long-term entries with different access times
            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            fs.writeFileSync(longTermPath, JSON.stringify([
                { id: 'old', content: 'old', lastAccessed: '2024-01-01T00:00:00.000Z' },
                { id: 'recent', content: 'recent', lastAccessed: '2024-06-01T00:00:00.000Z' },
                { id: 'middle', content: 'middle', lastAccessed: '2024-03-01T00:00:00.000Z' }
            ], null, 2));

            const memory = memoryTiers.getRelevantMemory(agentId, testDir);

            expect(memory.longTerm[0].content).toBe('recent');
            expect(memory.longTerm[1].content).toBe('middle');
            expect(memory.longTerm[2].content).toBe('old');
        });

        it('returns empty structures for non-existent agent', () => {
            const memory = memoryTiers.getRelevantMemory('non-existent', testDir);

            expect(memory.context).toEqual({});
            expect(memory.working).toEqual([]);
            expect(memory.shortTerm).toEqual([]);
            expect(memory.longTerm).toEqual([]);
        });
    });

    describe('cleanupMemory', () => {
        it('removes expired short-term entries', () => {
            // Add expired entry directly
            const shortTermPath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            fs.writeFileSync(shortTermPath, JSON.stringify([
                {
                    id: 'expired',
                    content: 'old',
                    created: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(),
                    ttl: 48 * 60 * 60 * 1000
                },
                {
                    id: 'fresh',
                    content: 'new',
                    created: new Date().toISOString(),
                    ttl: 48 * 60 * 60 * 1000
                }
            ], null, 2));

            const result = memoryTiers.cleanupMemory(agentId, testDir);

            expect(result.expiredCount).toBe(1);

            const data = JSON.parse(fs.readFileSync(shortTermPath, 'utf8'));
            expect(data).toHaveLength(1);
            expect(data[0].id).toBe('fresh');
        });

        it('archives decayed long-term entries', () => {
            // Add decayed entry directly
            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            fs.writeFileSync(longTermPath, JSON.stringify([
                {
                    id: 'decayed',
                    content: 'old pattern',
                    lastAccessed: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
                },
                {
                    id: 'active',
                    content: 'recent pattern',
                    lastAccessed: new Date().toISOString()
                }
            ], null, 2));

            const result = memoryTiers.cleanupMemory(agentId, testDir);

            expect(result.archivedCount).toBe(1);

            // Verify long-term only has active entry
            const longTermData = JSON.parse(fs.readFileSync(longTermPath, 'utf8'));
            expect(longTermData).toHaveLength(1);
            expect(longTermData[0].id).toBe('active');

            // Verify archive has decayed entry
            const archivePath = path.join(testDir, 'agents', agentId, 'memory', 'archive.json');
            const archiveData = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
            expect(archiveData).toHaveLength(1);
            expect(archiveData[0].id).toBe('decayed');
            expect(archiveData[0].archivedAt).toBeDefined();
        });

        it('handles missing files gracefully', () => {
            const result = memoryTiers.cleanupMemory(agentId, testDir);
            expect(result.expiredCount).toBe(0);
            expect(result.archivedCount).toBe(0);
        });
    });

    describe('autoPromote', () => {
        it('promotes entries with accessCount >= 3', () => {
            // Create entry with accessCount = 3
            const shortTermPath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            fs.writeFileSync(shortTermPath, JSON.stringify([
                { id: 'freq', content: 'frequent', accessCount: 3, source: 'test', created: new Date().toISOString(), ttl: 48 * 60 * 60 * 1000 },
                { id: 'rare', content: 'rare', accessCount: 1, source: 'test', created: new Date().toISOString(), ttl: 48 * 60 * 60 * 1000 }
            ], null, 2));

            const result = memoryTiers.autoPromote(agentId, testDir);

            expect(result).toContain('freq');
            expect(result).not.toContain('rare');

            // Verify promotion
            const shortTermData = JSON.parse(fs.readFileSync(shortTermPath, 'utf8'));
            expect(shortTermData).toHaveLength(1);
            expect(shortTermData[0].id).toBe('rare');

            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            const longTermData = JSON.parse(fs.readFileSync(longTermPath, 'utf8'));
            expect(longTermData).toHaveLength(1);
            expect(longTermData[0].content).toBe('frequent');
        });

        it('handles missing short-term file', () => {
            const result = memoryTiers.autoPromote(agentId, testDir);
            expect(result).toEqual([]);
        });
    });

    describe('startupCleanup', () => {
        it('runs cleanup for all agents', () => {
            // Create another agent
            const agent2MemoryDir = path.join(testDir, 'agents', 'agent2', 'memory');
            fs.mkdirSync(agent2MemoryDir, { recursive: true });

            // Add expired entries for both
            for (const agent of [agentId, 'agent2']) {
                const shortTermPath = path.join(testDir, 'agents', agent, 'memory', 'short-term.json');
                fs.writeFileSync(shortTermPath, JSON.stringify([
                    {
                        id: 'expired',
                        content: 'old',
                        created: new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString(),
                        ttl: 48 * 60 * 60 * 1000
                    }
                ], null, 2));
            }

            const result = memoryTiers.startupCleanup(testDir, [agentId, 'agent2']);

            expect(result[agentId].expiredCount).toBe(1);
            expect(result['agent2'].expiredCount).toBe(1);
        });

        it('handles errors for individual agents', () => {
            // Create invalid JSON file
            const shortTermPath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            fs.writeFileSync(shortTermPath, 'invalid json');

            const result = memoryTiers.startupCleanup(testDir, [agentId]);

            expect(result[agentId].error).toBeDefined();
        });
    });

    describe('migrateToTiers', () => {
        it('migrates tasks.json to working memory', () => {
            // Create legacy files in a separate legacy directory
            const legacyDir = path.join(testDir, 'legacy');
            fs.mkdirSync(legacyDir, { recursive: true });

            fs.writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify([
                { id: 'task1', description: 'Active task', status: 'active', created: '2024-01-01T00:00:00.000Z' }
            ], null, 2));

            const result = memoryTiers.migrateToTiers(agentId, testDir, legacyDir);

            expect(result.migratedTasks).toBe(1);

            // Verify working memory
            const workingPath = path.join(testDir, 'agents', agentId, 'memory', 'working.json');
            const workingData = JSON.parse(fs.readFileSync(workingPath, 'utf8'));
            expect(workingData).toHaveLength(1);
            expect(workingData[0].source).toBe('migrated-task');
        });

        it('migrates history.json to long-term memory', () => {
            const legacyDir = path.join(testDir, 'legacy');
            fs.mkdirSync(legacyDir, { recursive: true });

            fs.writeFileSync(path.join(legacyDir, 'history.json'), JSON.stringify([
                { id: 'hist1', description: 'Completed task', status: 'completed', completedAt: '2024-01-01T00:00:00.000Z' }
            ], null, 2));

            const result = memoryTiers.migrateToTiers(agentId, testDir, legacyDir);

            expect(result.migratedHistory).toBe(1);

            // Verify long-term memory
            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            const longTermData = JSON.parse(fs.readFileSync(longTermPath, 'utf8'));
            expect(longTermData).toHaveLength(1);
            expect(longTermData[0].source).toBe('migrated-history');
        });

        it('migrates context.json', () => {
            const legacyDir = path.join(testDir, 'legacy');
            fs.mkdirSync(legacyDir, { recursive: true });

            fs.writeFileSync(path.join(legacyDir, 'context.json'), JSON.stringify({
                owner: 'John',
                timezone: 'America/Toronto'
            }, null, 2));

            const result = memoryTiers.migrateToTiers(agentId, testDir, legacyDir);

            expect(result.migratedContext).toBe(true);

            // Verify context
            const contextPath = path.join(testDir, 'agents', agentId, 'memory', 'context.json');
            const contextData = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            expect(contextData.owner).toBe('John');
        });

        it('skips if already migrated', () => {
            const legacyDir = path.join(testDir, 'legacy');
            fs.mkdirSync(legacyDir, { recursive: true });

            fs.writeFileSync(path.join(legacyDir, 'tasks.json'), JSON.stringify([
                { id: 'task1' }
            ], null, 2));

            // First migration
            memoryTiers.migrateToTiers(agentId, testDir, legacyDir);

            // Second migration should skip
            const result = memoryTiers.migrateToTiers(agentId, testDir, legacyDir);

            expect(result.alreadyMigrated).toBe(true);
        });
    });

    describe('touchEntry', () => {
        it('updates lastAccessed and accessCount for short-term', () => {
            const entry = memoryTiers.addShortTerm(agentId, testDir, {
                content: 'touchable',
                source: 'test'
            });

            const originalAccessed = entry.lastAccessed;

            // Wait a tiny bit to ensure time changes
            const result = memoryTiers.touchEntry(agentId, testDir, 'shortTerm', entry.id);

            expect(result).toBe(true);

            const filePath = path.join(testDir, 'agents', agentId, 'memory', 'short-term.json');
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            expect(data[0].accessCount).toBe(2);
        });

        it('updates lastAccessed for long-term', () => {
            // Add to long-term directly
            const longTermPath = path.join(testDir, 'agents', agentId, 'memory', 'long-term.json');
            fs.writeFileSync(longTermPath, JSON.stringify([
                { id: 'lt1', content: 'long term', accessCount: 1, lastAccessed: '2024-01-01T00:00:00.000Z' }
            ], null, 2));

            const result = memoryTiers.touchEntry(agentId, testDir, 'longTerm', 'lt1');

            expect(result).toBe(true);

            const data = JSON.parse(fs.readFileSync(longTermPath, 'utf8'));
            expect(data[0].accessCount).toBe(2);
            expect(data[0].lastAccessed).not.toBe('2024-01-01T00:00:00.000Z');
        });

        it('returns false for invalid tier', () => {
            const result = memoryTiers.touchEntry(agentId, testDir, 'invalid', 'id');
            expect(result).toBe(false);
        });

        it('returns false for non-existent entry', () => {
            memoryTiers.addShortTerm(agentId, testDir, { content: 'exists', source: 'test' });
            const result = memoryTiers.touchEntry(agentId, testDir, 'shortTerm', 'non-existent');
            expect(result).toBe(false);
        });
    });
});
