/**
 * tests/email-check.test.js
 *
 * Tests for lib/email-check.js - the deterministic scheduled inbox check.
 *
 * The load-bearing assertion in this file is that an empty inbox and a broken
 * inbox check produce DIFFERENT outcomes. Before lib/email-check.js existed the
 * scheduled check went through an LLM with no mailbox access at all, and before
 * gmail.fetchRecentEmails() existed every failure mode collapsed into the same
 * empty array that an empty inbox produces.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const emailCheck = require('../lib/email-check');
const gmail = require('../lib/integrations/gmail');

function makeDeps(overrides = {}) {
    const posted = [];
    const escalations = [];

    return {
        posted,
        escalations,
        deps: {
            slack: {
                chat: {
                    postMessage: async (args) => {
                        posted.push(args);
                        return { ok: true };
                    },
                },
            },
            channelId: 'C_EMAIL',
            notifier: {
                taskFailed: async (task, error) => {
                    escalations.push({ task, error: String(error) });
                    return { opsPosted: true, ownerNotified: true };
                },
            },
            categorizer: {
                categorizeEmails: (emails) => ({
                    byCategory: {},
                    flagged: [],
                    total: emails.length,
                    rateLimited: 0,
                }),
                formatSummary: (s) => `Email: ${s.total} new`,
            },
            now: new Date('2026-09-14T12:00:00Z'),
            ...overrides,
        },
    };
}

describe('lib/email-check', () => {
    let tmpDir;
    let stateFile;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-check-'));
        stateFile = path.join(tmpDir, 'check-state.json');
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('empty is not the same as failed', () => {
        it('reports an empty inbox as ok, posts a summary, escalates nothing', async () => {
            const { deps, posted, escalations } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                gmailClient: {
                    fetchRecentEmails: async () => ({ ok: true, emails: [], reason: null, error: null, listed: 0, failed: 0 }),
                },
            });

            expect(verdict.status).toBe(emailCheck.STATUS.OK);
            expect(verdict.ok).toBe(true);
            expect(verdict.fetched).toBe(0);
            expect(escalations).toEqual([]);
            expect(posted).toHaveLength(1);
            expect(posted[0].text).toContain('0 new messages');
            expect(posted[0].text).not.toMatch(/fail/i);
        });

        // THE regression this change exists for. With the pre-change gmail module
        // an unauthenticated fetch returned [] - byte-identical to an empty inbox -
        // so this assertion could not have been written, let alone passed.
        it('reports missing credentials as a FAILURE, not an empty inbox', async () => {
            const { deps, posted, escalations } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                gmailClient: {
                    fetchRecentEmails: async () => ({
                        ok: false,
                        emails: [],
                        reason: 'no_credentials',
                        error: 'No Gmail authentication configured.',
                        listed: 0,
                        failed: 0,
                    }),
                },
            });

            expect(verdict.status).toBe(emailCheck.STATUS.NOT_CONFIGURED);
            expect(verdict.ok).toBe(false);
            // A human is told.
            expect(verdict.escalated).toBe(true);
            expect(escalations).toHaveLength(1);
            expect(escalations[0].error).toContain('not_configured');
            // And no "all clear" summary is posted.
            expect(posted).toEqual([]);
        });

        it('reports an API error as a failure and escalates', async () => {
            const { deps, escalations } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                gmailClient: {
                    fetchRecentEmails: async () => ({
                        ok: false, emails: [], reason: 'list_failed', error: 'invalid_grant', listed: 0, failed: 0,
                    }),
                },
            });

            expect(verdict.status).toBe(emailCheck.STATUS.FETCH_FAILED);
            expect(verdict.escalated).toBe(true);
            expect(escalations[0].error).toContain('invalid_grant');
        });

        it('escalates when the fetch throws outright', async () => {
            const { deps, escalations } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                gmailClient: {
                    fetchRecentEmails: async () => { throw new Error('socket hang up'); },
                },
            });

            expect(verdict.ok).toBe(false);
            expect(verdict.status).toBe(emailCheck.STATUS.FETCH_FAILED);
            expect(escalations).toHaveLength(1);
        });

        it('does not write state on a failed check, so the window is not lost', async () => {
            const { deps } = makeDeps();
            await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                gmailClient: {
                    fetchRecentEmails: async () => ({ ok: false, emails: [], reason: 'list_failed', error: 'boom', listed: 0, failed: 0 }),
                },
            });

            expect(fs.existsSync(stateFile)).toBe(false);
        });
    });

    describe('filtering comes from the rules file, not a model', () => {
        it('passes fetched emails through the categorizer and reports its summary', async () => {
            const seen = [];
            const { deps, posted } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                categorizer: {
                    categorizeEmails: (emails) => {
                        seen.push(...emails);
                        return {
                            byCategory: { vendor_deal: 1 },
                            flagged: [{ email: emails[0], category: 'vendor_deal', priority: 'high' }],
                            total: emails.length,
                            rateLimited: 0,
                        };
                    },
                    formatSummary: () => 'Email: 1 new (1 vendor)',
                },
                gmailClient: {
                    fetchRecentEmails: async () => ({
                        ok: true,
                        emails: [{ id: 'm1', from: 'sales@vendor.example', subject: '40% off bulk', body: 'sale', snippet: 'sale' }],
                        reason: null, error: null, listed: 1, failed: 0,
                    }),
                },
            });

            expect(seen).toHaveLength(1);
            expect(verdict.summary.byCategory).toEqual({ vendor_deal: 1 });
            expect(posted[0].text).toContain('40% off bulk');
            expect(posted[0].text).toContain('rules.json');
        });

        it('escalates when categorization throws', async () => {
            const { deps, escalations } = makeDeps();
            const verdict = await emailCheck.runInboxCheck({
                ...deps,
                stateFile,
                categorizer: { categorizeEmails: () => { throw new Error('bad rules'); } },
                gmailClient: {
                    fetchRecentEmails: async () => ({ ok: true, emails: [{ id: 'm1' }], reason: null, error: null, listed: 1, failed: 0 }),
                },
            });

            expect(verdict.status).toBe(emailCheck.STATUS.CATEGORIZE_FAILED);
            expect(escalations).toHaveLength(1);
        });
    });

    describe('window state', () => {
        it('records the check time and uses it as the next window', async () => {
            const { deps } = makeDeps();
            const gmailClient = {
                calls: [],
                fetchRecentEmails: async function (since) {
                    this.calls.push(since);
                    return { ok: true, emails: [], reason: null, error: null, listed: 0, failed: 0 };
                },
            };

            await emailCheck.runInboxCheck({ ...deps, stateFile, gmailClient });
            expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSuccessfulCheckAt)
                .toBe('2026-09-14T12:00:00.000Z');

            await emailCheck.runInboxCheck({
                ...deps, stateFile, gmailClient, now: new Date('2026-09-14T12:30:00Z'),
            });
            expect(gmailClient.calls[1].toISOString()).toBe('2026-09-14T12:00:00.000Z');
        });

        it('falls back to the lookback ceiling with no state', () => {
            const now = new Date('2026-09-14T12:00:00Z');
            const { since, sinceSource } = emailCheck.resolveWindow(now, null);
            expect(sinceSource).toBe('lookback_ceiling');
            expect(now.getTime() - since.getTime()).toBe(emailCheck.MAX_LOOKBACK_MS);
        });

        it('caps a very old state stamp at the lookback ceiling', () => {
            const now = new Date('2026-09-14T12:00:00Z');
            const { sinceSource } = emailCheck.resolveWindow(now, '2020-01-01T00:00:00Z');
            expect(sinceSource).toBe('lookback_ceiling_capped');
        });

        it('treats an unparseable state file as first run without throwing', () => {
            fs.writeFileSync(stateFile, 'not json{');
            const state = emailCheck.readState(stateFile);
            expect(state.lastSuccessfulCheckAt).toBeNull();
            expect(state.error).toBeTruthy();
        });
    });

    describe('gmail.fetchRecentEmails verdict shape', () => {
        // Guards the contract lib/email-check.js depends on. getRecentEmails must
        // keep its []-on-failure shape for morning-digest.js:368.
        it('exports both the verdict-carrying fetch and the legacy array fetch', () => {
            expect(typeof gmail.fetchRecentEmails).toBe('function');
            expect(typeof gmail.getRecentEmails).toBe('function');
        });

        it('returns a no_credentials verdict when nothing is configured', async () => {
            const saved = { ...process.env };
            delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
            delete process.env.GOOGLE_REFRESH_TOKEN;
            delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
            delete process.env.GOOGLE_CLIENT_ID;
            delete process.env.GOOGLE_CLIENT_SECRET;

            try {
                const result = await gmail.fetchRecentEmails();
                expect(result.ok).toBe(false);
                expect(result.reason).toBe('no_credentials');
                expect(result.emails).toEqual([]);
                // The legacy shape still flattens to [] for its existing caller.
                await expect(gmail.getRecentEmails()).resolves.toEqual([]);
            } finally {
                process.env = saved;
            }
        });
    });

    describe('read-only', () => {
        // Scope gate: this module must never grow a mailbox write.
        it('names no Gmail mutation API', () => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'email-check.js'), 'utf8');
            for (const forbidden of ['messages.send', 'messages.trash', 'messages.delete', 'messages.modify', 'messages.batchModify', 'labels.create']) {
                expect(src).not.toContain(forbidden);
            }
        });
    });
});
