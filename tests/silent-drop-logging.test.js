/**
 * tests/silent-drop-logging.test.js
 *
 * Regression tests for the 2026-09-12 "silent noop" defect and its neighbours.
 *
 * What broke: a Slack message with no TASK:/ASK: prefix, arriving while
 * NATURAL_CONVERSATION_MODE was unset, fell through all three branches of the
 * poll loop and logged nothing at all. From outside, a message that is quietly
 * discarded and a bot that is down look identical - which is what turned a
 * one-line cause into an afternoon of diagnosis.
 *
 * These tests pin two things:
 *   1. describeSkipReason names a reason for every fall-through shape.
 *   2. The poll loop actually calls it - a helper nobody invokes is the same
 *      silent-discard defect wearing a function name.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BRIDGE_AGENT_PATH = path.join(__dirname, '..', 'bridge-agent.js');
const source = fs.readFileSync(BRIDGE_AGENT_PATH, 'utf8');

/**
 * describeSkipReason is defined inside bridge-agent.js, which exports nothing and
 * starts a poll loop on require. Lift the function out by source text and evaluate
 * it against injected collaborators so the real branching logic is exercised.
 *
 * @param {Object} stubs - { config, isTaskMessage, isConversationMessage, alreadyProcessed, isTaskProcessed }
 * @returns {Function} describeSkipReason bound to those stubs
 */
function loadDescribeSkipReason(stubs) {
    const start = source.indexOf('function describeSkipReason(msg) {');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('\n}\n', start) + 3;
    const body = source.slice(start, end);

    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'config', 'isTaskMessage', 'isConversationMessage', 'alreadyProcessed', 'isTaskProcessed',
        `${body}\nreturn describeSkipReason;`
    );
    return factory(
        stubs.config,
        stubs.isTaskMessage,
        stubs.isConversationMessage,
        stubs.alreadyProcessed,
        stubs.isTaskProcessed
    );
}

const defaultStubs = {
    config: { NATURAL_CONVERSATION_MODE: false },
    isTaskMessage: () => false,
    isConversationMessage: () => false,
    alreadyProcessed: () => false,
    isTaskProcessed: () => false,
};

describe('describeSkipReason', () => {
    test('names NATURAL_CONVERSATION_MODE for an unprefixed message when the mode is off', () => {
        // This is the exact case that produced zero log output before the fix.
        const describeSkipReason = loadDescribeSkipReason(defaultStubs);
        expect(describeSkipReason({ ts: '1.1', text: 'hey can you check the inbox' }))
            .toBe('no TASK:/ASK: prefix and NATURAL_CONVERSATION_MODE is off');
    });

    test('names the rejecting predicate when natural mode is on', () => {
        const describeSkipReason = loadDescribeSkipReason({
            ...defaultStubs,
            config: { NATURAL_CONVERSATION_MODE: true },
        });
        expect(describeSkipReason({ ts: '1.1', text: 'hello' }))
            .toBe('unprefixed message rejected by isNaturalConversationMessage');
    });

    test('names the reaction-based dedup for an already-handled TASK: message', () => {
        const describeSkipReason = loadDescribeSkipReason({
            ...defaultStubs,
            isTaskMessage: () => true,
            alreadyProcessed: () => true,
        });
        expect(describeSkipReason({ ts: '1.1', text: 'TASK: do a thing' }))
            .toBe('TASK: message already carries a done/failed reaction');
    });

    test('names the processed-tasks dedup for an already-answered ASK: message', () => {
        const describeSkipReason = loadDescribeSkipReason({
            ...defaultStubs,
            isConversationMessage: () => true,
            isTaskProcessed: () => true,
        });
        expect(describeSkipReason({ ts: '1.1', text: 'ASK: bulletins' }))
            .toBe('ASK: message already recorded in processed-tasks.json');
    });

    test('names the subtype for a system message', () => {
        const describeSkipReason = loadDescribeSkipReason(defaultStubs);
        expect(describeSkipReason({ ts: '1.1', subtype: 'channel_join' }))
            .toBe('message subtype "channel_join" is not actionable');
    });

    test('names empty text', () => {
        const describeSkipReason = loadDescribeSkipReason(defaultStubs);
        expect(describeSkipReason({ ts: '1.1', text: '   ' })).toBe('message has no text');
    });

    test('never echoes the message body into the log line', () => {
        // Log lines go to container stdout. Message bodies can carry customer detail
        // and, in the email pipeline, untrusted external content.
        const describeSkipReason = loadDescribeSkipReason(defaultStubs);
        const secret = 'xoxb-not-a-real-token-9999';
        expect(describeSkipReason({ ts: '1.1', text: secret })).not.toContain(secret);
    });
});

describe('poll loop wiring', () => {
    test('the poll loop logs the skip reason on the fall-through path', () => {
        expect(source).toMatch(
            /console\.log\(\s*`\[bridge-agent\] Skipped message in \$\{agentId\} channel \(\$\{channelId\}\) ts=\$\{msg\.ts\}: \$\{describeSkipReason\(msg\)\}`\s*\);/
        );
    });

    test('the natural-conversation branch continues so the skip log is not reached on a handled message', () => {
        const naturalBranch = source.slice(
            source.indexOf('Natural conversation in ${agentId} channel'),
            source.indexOf('Skipped message in ${agentId} channel')
        );
        expect(naturalBranch).toContain('continue;');
    });
});
