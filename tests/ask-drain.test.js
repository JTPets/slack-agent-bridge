/**
 * tests/ask-drain.test.js
 *
 * WORK-TODO #71, owner 2026-11-08: "let the code finish its loop but halt new asks from
 * starting." lib/ask-drain.js decides; the poll loop in bridge-agent.js checks it before
 * BOTH conversation paths (ASK: and natural conversation), read from source.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { isBuiltInAsk, shouldRefuseAsk, describeAskRefusal } = require('../lib/ask-drain');

const PENDING = { refuse: true, state: { pending: true, commit: 'c'.repeat(40) } };
const IDLE = { refuse: false, state: { pending: false } };

test('a question for a model is refused only while an update is pending', () => {
    expect(shouldRefuseAsk({ text: 'ASK: draft a post about the sale', drain: PENDING })).toBe(true);
    expect(shouldRefuseAsk({ text: 'ASK: draft a post about the sale', drain: IDLE })).toBe(false);
    expect(shouldRefuseAsk({ text: 'hey secretary, what is on today', drain: PENDING })).toBe(true);
});

test('built-in commands still answer while it waits, so a stuck update can be diagnosed', () => {
    for (const t of ["ASK: what's queued", 'ASK: lock', 'ASK: lock clear', 'ASK: status', 'ASK: history 5']) {
        expect(isBuiltInAsk(t)).toBe(true);
        expect(shouldRefuseAsk({ text: t, drain: PENDING })).toBe(false);
    }
    expect(isBuiltInAsk('ASK: what should we post today')).toBe(false);
    expect(isBuiltInAsk('lock')).toBe(false); // not an ASK at all
});

test('the notice names the commit and says to ask again', () => {
    expect(describeAskRefusal(PENDING.state)).toMatch(/`ccccccc` passed the test gate.*Ask again in a few minutes/s);
});

describe('the poll loop wiring', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
    test('both conversation paths check the drain before processConversation', () => {
        const ask = src.indexOf('if (isConversationMessage(msg) && !alreadyProcessed(msg)');
        const nat = src.indexOf('console.log(`[bridge-agent] Natural conversation in');
        for (const at of [ask, nat]) {
            const region = src.slice(at, src.indexOf('processConversation(msg', at));
            expect(region).toMatch(/if \(await refuseAskForPendingUpdate\(msg, channelId\)\) continue;/);
        }
    });
    test('a refused question is answered in its thread and marked processed', () => {
        const fn = src.slice(src.indexOf('async function refuseAskForPendingUpdate('));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        expect(body).toMatch(/shouldRefuseAsk\(/);
        expect(body).toMatch(/describeAskRefusal\(pending\.state\)/);
        expect(body).toMatch(/markTaskProcessed\(msg\.ts\)/);
        expect(body).toMatch(/postToOps\(/);
    });
});
