/**
 * tests/mail-senders.test.js
 *
 * WORK-TODO #88, phase 1: the sender ledger (lib/mail-senders.js), the two verbs over it
 * (lib/mail-sender-commands.js), their place in the command table, and the inbox
 * check recording into it. Every ledger here is a temp file; addresses are synthetic.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const senders = require('../lib/mail-senders');
const commands = require('../lib/mail-sender-commands');
const router = require('../lib/command-router');
const { decideAgentChannelVerb } = require('../lib/agent-channel-verbs');
const { runInboxCheck } = require('../lib/email-check');

let dir;
let file;
beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-senders-'));
    file = path.join(dir, 'mail-senders.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const T0 = new Date('2026-11-20T15:00:00Z');
const days = (n) => new Date(T0.getTime() + n * 24 * 60 * 60 * 1000);

function email(id, address, { name = 'Shop', url = `https://${address.split('@')[1]}/u`, signals = ['list-unsubscribe'], source = 'header' } = {}) {
    return {
        id,
        bulk: {
            sender: { address, name },
            signals,
            isBulk: signals.length > 0,
            unsubscribe: url ? { url, mailto: null, oneClick: false, source } : null,
        },
    };
}
const idOf = (address) => senders.senderId(address);

describe('recordBulkMail', () => {
    test('one entry per sender, counted, with the newest link and the signals unioned', () => {
        senders.recordBulkMail([email('a', 'news@shop.example'), email('b', 'news@shop.example', { url: 'https://shop.example/u2', signals: ['promotions'] })], { now: T0, file });
        const e = senders.readLedger(file).state.senders['news@shop.example'];
        expect(e).toMatchObject({ count: 2, signals: ['list-unsubscribe', 'promotions'], verdict: null });
        expect(e.unsubscribe.url).toBe('https://shop.example/u2');
    });
    test('the same Gmail id in an overlapping window is counted once', () => {
        senders.recordBulkMail([email('a', 'news@shop.example')], { now: T0, file });
        const r = senders.recordBulkMail([email('a', 'news@shop.example')], { now: days(1), file });
        expect(r.recorded).toBe(0);
        expect(senders.readLedger(file).state.senders['news@shop.example'].count).toBe(1);
    });
    test('mail with no bulk signal (a person writing) is never recorded, and nothing is written', () => {
        const r = senders.recordBulkMail([email('p', 'jane@friend.example', { signals: [], url: null }), { id: 'x' }], { now: T0, file });
        expect(r).toEqual({ recorded: 0, written: false, error: null });
        expect(fs.existsSync(file)).toBe(false);
    });
    test('an unreadable ledger is reported and NOT overwritten (it holds the verdicts)', () => {
        fs.writeFileSync(file, '{ not json');
        const r = senders.recordBulkMail([email('a', 'news@shop.example')], { now: T0, file });
        expect(r.error).toMatch(/sender ledger unreadable/);
        expect(fs.readFileSync(file, 'utf8')).toBe('{ not json');
    });
    test('an undecided sender quiet for 180 days is forgotten; a decided one is kept', () => {
        senders.recordBulkMail([email('a', 'old@one.example'), email('b', 'kept@two.example')], { now: T0, file });
        senders.setVerdict(idOf('kept@two.example'), 'keep', { now: T0, file });
        senders.recordBulkMail([email('c', 'new@three.example')], { now: days(181), file });
        expect(Object.keys(senders.readLedger(file).state.senders).sort()).toEqual(['kept@two.example', 'new@three.example']);
    });
    test('the live ledger is never written from a test', () => {
        expect(senders.writeLedger({ senders: {} })).toEqual({ written: false, error: expect.stringMatching(/refused/) });
    });
});

describe('ASK: unsubscribe', () => {
    test('lists undecided senders, most emails first, with escaped name, id, host and how the link was found', async () => {
        senders.recordBulkMail([
            email('a', 'news@shop.example', { name: 'Shop <b>*News*</b>' }),
            email('b', 'deals@big.example', { name: 'Big', url: 'https://click.mailer.example/u?a=1&b=2|x' }),
            email('c', 'deals@big.example', { name: 'Big', url: 'https://click.mailer.example/u?a=1&b=2|x' }),
        ], { now: T0, file });
        const { ok, text } = await commands.handleUnsubscribe({ file, now: T0 });
        expect(ok).toBe(true);
        expect(text.indexOf('deals@big.example')).toBeLessThan(text.indexOf('news@shop.example'));
        expect(text).toContain(`\`${idOf('deals@big.example')}\``);
        expect(text).toContain('<https://click.mailer.example/u?a=1&amp;b=2%7Cx|unsubscribe> (click.mailer.example, not the sender\'s domain)');
        expect(text).toContain('<https://shop.example/u|unsubscribe> (shop.example) · published in the header');
        expect(text).toContain('Shop &lt;b&gt;*News*&lt;/b&gt;');
        expect(text).not.toMatch(/<b>/);
        expect(text).toMatch(/I never open these links/);
    });
    test('a footer link says to check it; a sender with no link is counted, not listed', async () => {
        senders.recordBulkMail([
            email('a', 'f@foot.example', { source: 'footer', signals: ['footer-link'] }),
            email('b', 'n@nolink.example', { url: null, signals: ['promotions'] }),
        ], { now: T0, file });
        const { text } = await commands.handleUnsubscribe({ file, now: T0 });
        expect(text).toMatch(/found in the footer, check it before you confirm/);
        expect(text).not.toContain('n@nolink.example');
        expect(text).toMatch(/1 other bulk sender published no unsubscribe link/);
    });
    test('an empty ledger says the list fills as mail arrives; an unreadable one is a failure', async () => {
        expect((await commands.handleUnsubscribe({ file })).text).toMatch(/No bulk mail is recorded yet/);
        fs.writeFileSync(file, 'nope');
        expect(await commands.handleUnsubscribe({ file })).toMatchObject({ ok: false, text: expect.stringMatching(/cannot be read/) });
    });
    test('a limit is honoured and a non-number is refused with usage', async () => {
        senders.recordBulkMail(['a', 'b', 'c'].map(x => email(x, `${x}@s${x}.example`)), { now: T0, file });
        expect((await commands.handleUnsubscribe({ file, args: '2', now: T0 })).text.match(/^• /gm)).toHaveLength(2);
        expect((await commands.handleUnsubscribe({ file, args: 'everything' })).text).toMatch(/^Usage/);
    });
});

describe('ASK: sender <id> unsubscribed|keep', () => {
    beforeEach(() => senders.recordBulkMail([email('a', 'news@shop.example'), email('b', 'deals@big.example')], { now: T0, file }));

    test('a verdict takes the sender off the list', async () => {
        const r = await commands.handleSender({ file, args: `${idOf('news@shop.example')} keep`, now: T0, userId: 'U1' });
        expect(r).toMatchObject({ ok: true, text: expect.stringMatching(/kept/) });
        expect((await commands.handleUnsubscribe({ file, now: T0 })).text).not.toContain('news@shop.example');
        expect(senders.readLedger(file).state.senders['news@shop.example']).toMatchObject({ verdict: 'keep', verdictBy: 'U1' });
    });
    test('an unsubscribed sender still writing two weeks later is listed again, separately', async () => {
        await commands.handleSender({ file, args: `${idOf('news@shop.example')} unsubscribed`, now: T0 });
        senders.recordBulkMail([email('c', 'news@shop.example')], { now: days(5), file });
        expect((await commands.handleUnsubscribe({ file, now: days(5) })).text).not.toMatch(/Still sending/);
        senders.recordBulkMail([email('d', 'news@shop.example')], { now: days(15), file });
        const text = (await commands.handleUnsubscribe({ file, now: days(15) })).text;
        expect(text).toMatch(/Still sending two weeks after you unsubscribed:\*\n• `[0-9a-f]{8}` \*Shop\* \(news@shop\.example\)/);
    });
    test('refusals write nothing: unknown id, bad verdict, bad shape, missing args', async () => {
        const before = fs.readFileSync(file, 'utf8');
        for (const args of ['ffffffff keep', `${idOf('news@shop.example')} delete`, 'zz keep', '', `${idOf('news@shop.example')} keep now`]) {
            expect((await commands.handleSender({ file, args })).ok).toBe(false);
        }
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
    });
});

describe('the command table', () => {
    test('`unsubscribe` is read-only, so it runs in an agent channel such as the secretary\'s', () => {
        expect(router.COMMANDS.unsubscribe.kind).toBe('report');
        expect(decideAgentChannelVerb('unsubscribe', [])).toMatchObject({ action: 'run', verb: 'unsubscribe' });
    });
    test('`sender <id> keep` is a command in an agent channel (refused there, never handed to a model)', () => {
        expect(router.COMMANDS.sender.kind).toBe('mutate');
        expect(decideAgentChannelVerb('sender 1a2b3c4d keep', [])).toMatchObject({ action: 'refuse', verb: 'sender' });
        // A sentence starting with the verb is still the agent's to answer.
        expect(decideAgentChannelVerb('sender of the invoice was who?', []).action).toBeNull();
    });
    test('`ack <id> nag` still counts as a bare command after the bareArgs generalisation', () => {
        expect(router.isBareCommand('ack 18c2ab nag')).toBe(true);
        expect(router.isBareCommand('ack the vendor please')).toBe(false);
    });
    test('runCommand reaches both handlers', async () => {
        const r = await router.runCommand('unsubscribe 3', {});
        expect(r).toMatchObject({ handled: true, verb: 'unsubscribe' });
    });
});

describe('the inbox check records into the ledger', () => {
    const quiet = { categorizeEmails: () => ({ total: 0, byCategory: {}, flagged: [] }), getCategoryEmoji: () => '' };
    const notifier = () => {
        const calls = [];
        return { calls, taskFailed: async (...a) => { calls.push(a); return { opsPosted: true } } };
    };

    test('bulk mail from a successful fetch lands in the ledger', async () => {
        const n = notifier();
        const result = await runInboxCheck({
            gmailClient: { fetchRecentEmails: async () => ({ ok: true, emails: [email('a', 'news@shop.example')], reason: null, error: null, listed: 1, failed: 0 }) },
            categorizer: quiet, notifier: n, now: T0,
            stateFile: path.join(dir, 'check.json'), alertStateFile: path.join(dir, 'alerts.json'), senderFile: file,
        });
        expect(result.ok).toBe(true);
        expect(result.senders).toEqual({ recorded: 1, written: true, error: null });
        expect(senders.readLedger(file).state.senders['news@shop.example'].count).toBe(1);
        expect(n.calls).toHaveLength(0);
    });
    test('a ledger that cannot be recorded escalates, and the check still succeeds', async () => {
        fs.writeFileSync(file, 'broken');
        const n = notifier();
        const result = await runInboxCheck({
            gmailClient: { fetchRecentEmails: async () => ({ ok: true, emails: [email('a', 'news@shop.example')], reason: null, error: null, listed: 1, failed: 0 }) },
            categorizer: quiet, notifier: n, now: T0,
            stateFile: path.join(dir, 'check.json'), alertStateFile: path.join(dir, 'alerts.json'), senderFile: file,
        });
        expect(result.ok).toBe(true);
        expect(n.calls.map(c => c[1])).toEqual([expect.stringMatching(/^sender_ledger_failed: sender ledger unreadable/)]);
    });
});
