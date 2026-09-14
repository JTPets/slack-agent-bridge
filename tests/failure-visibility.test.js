'use strict';

/**
 * tests/failure-visibility.test.js
 *
 * THE guard for "a failure whose only record is a log line in a container".
 *
 * LOGIC CHANGE 2026-09-14: New file. Part four of the autonomous-loop
 * prerequisites (docs/AUTONOMOUS-LOOP-DESIGN.md sections 4 and 5). The loop's halt
 * state (decision D3) and its escalations (D5, D6) are only real if the message
 * arrives, and several failure paths ended at a `console.error` nobody reads.
 *
 * THE LIVE INSTANCE, observed 2026-09-14 against the running container: story-bot
 * has `status: "planned"` with a real channel and a Friday-18:00 schedule, so the
 * scheduler arms its job while `buildChannelsToPoll` (which filters `planned`)
 * never joins the channel. Every Friday the job runs, produces output, and Slack
 * answers `not_in_channel`. The whole of that failure was one line:
 *   [bulletin-watcher] Failed to notify story-bot: An API error occurred: not_in_channel
 * The job succeeding and the job's output reaching a human are different events and
 * only the first was observed. What this change fixes is the invisibility. The
 * channel membership is the owner's to set, and WORK-TODO #3 is the scheduling half.
 *
 * Two kinds of check here, because neither alone is enough:
 *   1. BEHAVIOURAL — the two lib modules take an injected Slack client, so their
 *      escalation is exercised for real.
 *   2. SOURCE-LEVEL — bridge-agent.js's startup sequence and Phase 3 run inside a
 *      top-level IIFE that cannot be imported without a live Slack token, so those
 *      sites are asserted against the source. Same technique, and same reason, as
 *      tests/task-queue-lifecycle.test.js.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

jest.mock('node-cron', () => {
    const jobs = [];
    return {
        schedule: jest.fn((cronExpr, callback, options) => {
            const job = { cronExpr, callback, options, stop: jest.fn(), start: jest.fn() };
            jobs.push(job);
            return job;
        }),
        validate: jest.fn(() => true),
        _jobs: () => jobs,
        _clear: () => { jobs.length = 0; },
    };
});

const cron = require('node-cron');
const notifyOwner = require('../lib/notify-owner');
const { runScheduledTask } = require('../lib/agent-scheduler');
const { processBulletin } = require('../lib/bulletin-watcher');

/** A Slack client whose postMessage always fails the way the live one did. */
function rejectingSlack(message = 'An API error occurred: not_in_channel') {
    return { chat: { postMessage: jest.fn().mockRejectedValue(new Error(message)) } };
}

describe('notifyOps is a real destination, not a log call', () => {
    afterEach(() => jest.restoreAllMocks());

    test('it posts to the configured ops channel', async () => {
        const slack = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
        notifyOwner.init({ slack, ownerId: 'U1', opsChannelId: 'C-OPS' });

        await expect(notifyOwner.notifyOps('something broke')).resolves.toBe(true);
        expect(slack.chat.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ channel: 'C-OPS', text: expect.stringContaining('something broke') })
        );
    });

    test('it redacts before anything leaves', async () => {
        const slack = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
        notifyOwner.init({ slack, ownerId: 'U1', opsChannelId: 'C-OPS' });

        // Assembled at runtime, never written out as one literal. A token-SHAPED
        // string in a tracked file trips GitHub push protection (it cannot tell a
        // fixture from a live credential, and should not try), and this repository's
        // own rule is that a token never appears anywhere — a fabricated one that
        // matches the pattern is still a pattern match in every scanner that looks.
        const fakeToken = ['xoxb', '1111111111', '2222222222', 'abcdefghijklmnopqrstuvwx'].join('-');

        await notifyOwner.notifyOps(`token ${fakeToken} failed`);
        const sent = slack.chat.postMessage.mock.calls[0][0].text;
        expect(sent).not.toContain(fakeToken);
        // Non-vacuous: the fixture really does match what redact() hunts for, so a
        // redactor that stopped working would fail this rather than trivially pass.
        expect(fakeToken).toMatch(/^xoxb-\d{10}-\d{10}-[a-z]{24}$/);
    });

    test('with no ops channel configured it says so rather than dropping silently', async () => {
        const err = jest.spyOn(console, 'error').mockImplementation(() => {});
        notifyOwner.init({ slack: { chat: { postMessage: jest.fn() } }, ownerId: 'U1', opsChannelId: null });

        await expect(notifyOwner.notifyOps('nowhere to go')).resolves.toBe(false);
        expect(err).toHaveBeenCalledWith(expect.stringContaining('dropped'), expect.stringContaining('nowhere to go'));
    });
});

describe('a scheduled job that cannot post escalates (the live story-bot instance)', () => {
    beforeEach(() => {
        cron._clear();
        jest.restoreAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('runScheduledTask reports the rejection to its caller rather than swallowing it', async () => {
        const slack = rejectingSlack();
        const outcome = await runScheduledTask(slack, { id: 'story-bot', channel: 'C-STORY' }, 'draft-weekly-posts');
        expect(outcome.success).toBe(false);
        expect(outcome.error).toContain('not_in_channel');
    });

    test('the cron callback escalates that failure to #sqtools-ops', async () => {
        const ops = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
        notifyOwner.init({ slack: ops, ownerId: 'U1', opsChannelId: 'C-OPS' });

        // Re-require the scheduler so it registers against this mocked cron.
        const { startScheduler } = require('../lib/agent-scheduler');
        startScheduler(rejectingSlack());

        const job = cron._jobs().find(j => j);
        expect(job).toBeDefined();
        await job.callback();

        const opsPosts = ops.chat.postMessage.mock.calls
            .map(c => c[0])
            .filter(p => p.channel === 'C-OPS');
        expect(opsPosts.length).toBeGreaterThan(0);
        expect(opsPosts.some(p => /Scheduled job failed/.test(p.text))).toBe(true);
        expect(opsPosts.some(p => /not_in_channel/.test(p.text))).toBe(true);
        // And it names the remedy without taking it — channel membership is the
        // owner's to set.
        expect(opsPosts.some(p => /invite it/.test(p.text))).toBe(true);
    });
});

describe('a bulletin notification rejected by Slack escalates', () => {
    beforeEach(() => {
        jest.restoreAllMocks();
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('processBulletin posts to ops when an agent notification is rejected', async () => {
        const ops = { chat: { postMessage: jest.fn().mockResolvedValue({ ok: true }) } };
        notifyOwner.init({ slack: ops, ownerId: 'U1', opsChannelId: 'C-OPS' });

        const slack = rejectingSlack();
        const result = await processBulletin(slack, {
            id: 'b1',
            from: 'bridge',
            type: 'task_completed',
            data: { description: 'a task' },
            timestamp: new Date().toISOString(),
        });

        // Non-vacuous by construction: agents.json has three agents watching
        // `task_completed` with a channel (secretary, security, story-bot), and the
        // injected client rejects every post. Regenerate that set with:
        //   node -e "const a=require('./agents/agents.json');(Array.isArray(a)?a:a.agents)
        //     .forEach(g=>{const w=g.watches&&g.watches.bulletin_types;
        //     if(w&&w.includes('task_completed')&&g.channel)console.log(g.id)})"
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.notified.length).toBe(0);

        const texts = ops.chat.postMessage.mock.calls.map(c => c[0]).filter(p => p.channel === 'C-OPS');
        expect(texts.length).toBe(result.errors.length);
        expect(texts.every(p => /Bulletin notification rejected/.test(p.text))).toBe(true);
        expect(texts.every(p => /not_in_channel/.test(p.text))).toBe(true);
    });
});

describe('bridge-agent startup and Phase 3 report their failures', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'bridge-agent.js'), 'utf8');

    /**
     * The body between `marker` and the end of its catch/if block, roughly. Good
     * enough to assert "a post call appears inside this handler", which is the only
     * claim made here.
     *
     * @param {string} marker
     * @param {number} [span]
     * @returns {string}
     */
    function regionAfter(marker, span = 1400) {
        const i = source.indexOf(marker);
        expect(i).toBeGreaterThan(-1);
        return source.slice(i, i + span);
    }

    test('an interrupted task found at startup is posted, not only logged', () => {
        const region = regionAfter('const interruptedCount = queue.recoverInterrupted();');
        expect(region).toMatch(/postToOps\(/);
        expect(region).toMatch(/interrupted/i);
    });

    test('a task-queue startup failure is posted', () => {
        const region = regionAfter("console.error('[bridge-agent] Task queue startup failed:'");
        expect(region).toMatch(/postToOps\(/);
    });

    test('a Phase 3 gate that throws is posted, not swallowed', () => {
        const region = regionAfter("console.error('[bridge-agent] Phase 3 validation error:'");
        expect(region).toMatch(/postToOps\(/);
        expect(region).toMatch(/did not complete/i);
    });

    test('a watercooler run that succeeded with errors tells the owner', () => {
        const wc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'watercooler.js'), 'utf8');
        const i = wc.indexOf('[watercooler] Warnings:');
        expect(i).toBeGreaterThan(-1);
        // Bounded at the `} else {` that opens the OUTRIGHT-FAILURE branch, not by a
        // character count. A fixed window of 700 reached into that branch and matched
        // its sendDM, so the assertion passed against the pre-change source — a guard
        // that is green before the fix is not a guard.
        const elseAt = wc.indexOf('} else {', i);
        expect(elseAt).toBeGreaterThan(i);
        expect(wc.slice(i, elseAt)).toMatch(/sendDM\(/);
    });
});

describe('the guard itself detects what it claims to', () => {
    test('regionAfter would not find a post call that is absent', () => {
        // Negative control for the source-level half: the same assertion run against
        // a handler that only logs must fail to match.
        const logOnly = "} catch (e) {\n  console.error('[x] nope:', e.message);\n}\n";
        expect(/postToOps\(/.test(logOnly)).toBe(false);
    });

    test('a rejecting Slack client really rejects', async () => {
        await expect(rejectingSlack().chat.postMessage({})).rejects.toThrow(/not_in_channel/);
    });
});
