'use strict';

/**
 * tests/agent-channel-verbs.test.js
 *
 * WORK-TODO #64 (the safe half) and #49 (the bot path), 2026-10-04.
 *
 * #64: a bridge verb typed on its own in an agent's channel is REFUSED with a pointer
 * to #claude-bridge, instead of falling through to the agent's model, which answered a
 * question about the system as conversation. The channel gate is NOT lifted.
 *
 * #49: with NATURAL_CONVERSATION_MODE on, a message posted by a bot (the bridge's own
 * reports included) must never reach a model as natural conversation.
 */

const fs = require('fs');
const path = require('path');
const { isBareCommand } = require('../lib/command-router');
const { isNaturalConversationMessage } = require('../lib/task-parser');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'bridge-agent.js'), 'utf8');
const IDS = ['secretary', 'bridge'];

describe('isBareCommand: narrow on purpose', () => {
  test.each([
    ['status', true], ['agents', true], ['history 20', true], ['status secretary', true],
    ['create a post about the sale', false], ['help me', false], ['status of the order?', false],
    ['what is the status', false], ['history of the store', false], ['', false],
  ])('%j -> %s', (text, expected) => {
    expect(isBareCommand(text, IDS)).toBe(expected);
  });
});

describe('processConversation refuses a bare verb in an agent channel', () => {
  const start = SRC.indexOf('async function processConversation(');
  const fn = SRC.slice(start, SRC.indexOf('\n}\n', start));

  test('the refusal is the else of the bridge-channel router gate (the gate is not lifted)', () => {
    expect(fn).toMatch(/if \(sourceChannel === BRIDGE_CHANNEL\) \{\s*const routed = await commandRouter\.runCommand/);
    expect(fn).toMatch(/\} else if \(commandRouter\.isBareCommand\(questionText, knownAgentIds\(\)\)\) \{/);
  });

  test('it posts, runs nothing, and returns before any LLM call', () => {
    const refusal = fn.indexOf('commandRouter.isBareCommand(');
    const block = fn.slice(refusal, fn.indexOf('return;', refusal));
    expect(block).toMatch(/is a bridge command/);
    expect(block).toMatch(/Nothing was run/);
    expect(block).not.toMatch(/runCommand|runWithFallback|runLLM/);
    const firstLlm = fn.search(/runWithFallback\(/);
    expect(firstLlm).toBeGreaterThan(refusal);
  });
});

describe('#49: a bot message is never natural conversation', () => {
  test('a bot-token post (bot_id, no subtype) is excluded', () => {
    expect(isNaturalConversationMessage({ text: 'Inbox check: 3 flagged', user: 'U_BOT', bot_id: 'B123' })).toBe(false);
  });

  test('negative control: the same text from a person is natural conversation', () => {
    expect(isNaturalConversationMessage({ text: 'Inbox check: 3 flagged', user: 'U_OWNER' })).toBe(true);
  });

  test('the natural path in poll has no bot exemption', () => {
    const start = SRC.indexOf('if (config.NATURAL_CONVERSATION_MODE &&');
    const branch = SRC.slice(start, SRC.indexOf('continue;', SRC.indexOf('processConversation(', start)));
    expect(start).toBeGreaterThan(0);
    expect(branch).toMatch(/if \(!isUserAuthorized\(msg\.user\)\) \{/);
    expect(branch).not.toMatch(/isBotMessage/);
  });
});
