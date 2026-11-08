'use strict';

/**
 * tests/poll-wake.test.js
 *
 * WORK-TODO #4: a Socket Mode `message` event starts one poll soon, and is never intake.
 * lib/poll-wake.js: a polled channel's event schedules ONE poll after the delay however
 * many events arrive; a channel outside the poll set wakes nothing; the handler acks and
 * passes on the channel id only, so a message's text cannot reach anything from here; and
 * bridge-agent.js wires the seam to pollNow through the poll set.
 */

const fs = require('fs');
const path = require('path');
const { createPollWake, messageSignalHandler, DEFAULT_DELAY_MS } = require('../lib/poll-wake');

function fakeTimers() {
    const pending = [];
    return {
        setTimeoutFn: (fn, ms) => { const t = { fn, ms }; pending.push(t); return t; },
        fire: () => { while (pending.length) pending.shift().fn(); },
        pending,
    };
}

describe('createPollWake', () => {
    const watched = () => [{ channelId: 'C_BRIDGE' }, { channelId: 'C_SECRETARY' }];

    test('a burst of events in polled channels produces one poll, after the delay', () => {
        const t = fakeTimers();
        const trigger = jest.fn();
        const w = createPollWake({ trigger, watchedChannels: watched, setTimeoutFn: t.setTimeoutFn });
        expect(w.wake('C_BRIDGE')).toBe(true);
        expect(w.wake('C_SECRETARY')).toBe(false);
        expect(w.wake('C_BRIDGE')).toBe(false);
        expect(t.pending).toHaveLength(1);
        expect(t.pending[0].ms).toBe(DEFAULT_DELAY_MS);
        expect(trigger).not.toHaveBeenCalled();
        t.fire();
        expect(trigger).toHaveBeenCalledTimes(1);
        expect(trigger).toHaveBeenCalledWith('socket message');
        // After it fired, the next event schedules again.
        expect(w.wake('C_BRIDGE')).toBe(true);
    });

    test('a channel outside the poll set, or no channel, wakes nothing', () => {
        const t = fakeTimers();
        const trigger = jest.fn();
        const w = createPollWake({ trigger, watchedChannels: watched, setTimeoutFn: t.setTimeoutFn });
        for (const c of ['C_STRANGER', null, undefined, '', 42]) expect(w.wake(c)).toBe(false);
        expect(t.pending).toHaveLength(0);
    });

    test('the poll set is read per event, so an activation since boot counts', () => {
        const t = fakeTimers();
        let set = [];
        const w = createPollWake({ trigger: jest.fn(), watchedChannels: () => set, setTimeoutFn: t.setTimeoutFn });
        expect(w.wake('C_NEW')).toBe(false);
        set = [{ channelId: 'C_NEW' }];
        expect(w.wake('C_NEW')).toBe(true);
    });

    test('never throws: a throwing poll-set reader or trigger is contained', () => {
        const t = fakeTimers();
        const w = createPollWake({ trigger: () => { throw new Error('boom'); }, watchedChannels: () => { throw new Error('x'); }, setTimeoutFn: t.setTimeoutFn });
        expect(w.wake('C_BRIDGE')).toBe(false);
        const w2 = createPollWake({ trigger: () => { throw new Error('boom'); }, watchedChannels: watched, setTimeoutFn: t.setTimeoutFn });
        expect(w2.wake('C_BRIDGE')).toBe(true);
        expect(() => t.fire()).not.toThrow();
    });
});

describe('messageSignalHandler', () => {
    test('acks, then passes on the channel id and nothing else', async () => {
        const ack = jest.fn().mockResolvedValue();
        const seen = [];
        await messageSignalHandler((...args) => seen.push(args))({
            ack, event: { channel: 'C_BRIDGE', text: 'TASK: secret', user: 'U1', ts: '1.2' },
        });
        expect(ack).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([['C_BRIDGE']]);
    });

    test('a failed ack is logged and the signal still goes out; no seam attached is inert', async () => {
        const logger = { error: jest.fn() };
        const seen = [];
        await messageSignalHandler((c) => seen.push(c), logger)({ ack: () => Promise.reject(new Error('gone')), event: { channel: 'C1' } });
        expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to acknowledge a message event: gone/));
        expect(seen).toEqual(['C1']);
        await expect(messageSignalHandler(null)({ ack: jest.fn(), event: { channel: 'C1' } })).resolves.toBeUndefined();
        await expect(messageSignalHandler((c) => seen.push(c))({})).resolves.toBeUndefined();
        expect(seen).toEqual(['C1', null]);
    });
});

describe('the bridge-agent.js wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    test('the wake is built over pollNow and the poll set, and is the socket seam', () => {
        expect(src).toMatch(/createPollWake\(\{ trigger: pollNow, watchedChannels: \(\) => channelsToPoll \}\)/);
        expect(src).toMatch(/onMessageSignal: \(channel\) => pollWake\.wake\(channel\)/);
    });
});
