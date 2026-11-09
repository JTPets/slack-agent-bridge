'use strict';

/**
 * tests/agent-channel-verbs.test.js
 *
 * WORK-TODO #64 (the safe half) and #49 (the bot path), 2026-10-04.
 *
 * #64: a bridge verb typed on its own in an agent's channel never reaches the agent's
 * model. Since 2026-11-09 (owner's answer 2026-11-08) a READ-ONLY verb runs there with
 * the channel's agent; a verb that changes something or starts work is refused.
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

describe('#64: which verbs run in an agent channel is decided by the table kind', () => {
  const { decideAgentChannelVerb, describeVerbRefusal, readOnlyVerbs } = require('../lib/agent-channel-verbs');
  const { COMMANDS } = require('../lib/command-router');

  test.each([
    ['status', 'run'], ['agents', 'run'], ['history 20', 'run'], ['channels', 'run'], ['status secretary', 'run'],
    ['activate secretary', 'refuse'], ['lock', 'refuse'], ['provider', 'refuse'], ['check-inbox', 'refuse'], ['critique', 'refuse'],
    ['create a post about the sale', null], ['status of the order?', null],
  ])('%j -> %s', (text, action) => {
    expect(decideAgentChannelVerb(text, IDS).action).toBe(action);
  });

  test('every report verb runs and every other kind is refused, enumerated from the table', () => {
    for (const [verb, entry] of Object.entries(COMMANDS)) {
      expect(decideAgentChannelVerb(verb, IDS).action).toBe(entry.kind === 'report' ? 'run' : 'refuse');
    }
  });

  test('the refusal lists exactly the read-only verbs, generated from the table', () => {
    const text = describeVerbRefusal('lock', 'C0BRIDGE');
    expect(text).toMatch(/runs only in <#C0BRIDGE>/);
    expect(text).toMatch(/Nothing was run/);
    expect(readOnlyVerbs()).toEqual(Object.keys(COMMANDS).filter(v => COMMANDS[v].kind === 'report').sort());
    for (const v of readOnlyVerbs()) expect(text).toContain(v);
    expect(text).not.toMatch(/\bactivate\b/);
  });
});

describe('processConversation wiring for a bare verb in an agent channel', () => {
  const start = SRC.indexOf('async function processConversation(');
  const fn = SRC.slice(start, SRC.indexOf('\n}\n', start));
  const branch = fn.slice(fn.indexOf('} else if (agentChannelVerb.action) {'), fn.indexOf('return;', fn.indexOf('} else if (agentChannelVerb.action) {')));

  test('the agent-channel branch is the else of the bridge-channel router gate', () => {
    expect(fn).toMatch(/const agentChannelVerb = sourceChannel === BRIDGE_CHANNEL \? \{ action: null \}\s*: decideAgentChannelVerb\(questionText, knownAgentIds\(\)\);/);
    expect(fn).toMatch(/if \(sourceChannel === BRIDGE_CHANNEL\) \{\s*const routed = await commandRouter\.runCommand/);
    expect(branch.length).toBeGreaterThan(0);
  });

  test('a read-only verb runs with the CHANNEL agent; anything else gets the refusal', () => {
    expect(branch).toMatch(/if \(agentChannelVerb\.action === 'run'\) \{\s*const routed = await commandRouter\.runCommand\(questionText, \{\s*slack, agent: currentAgent,/);
    expect(branch).toMatch(/replyText = describeVerbRefusal\(verb, BRIDGE_CHANNEL\)/);
    expect(branch).not.toMatch(/onActivationChanged|slackClient/);
  });

  test('it posts and returns before any LLM call', () => {
    expect(branch).not.toMatch(/runWithFallback|runLLM/);
    expect(fn.search(/runWithFallback\(/)).toBeGreaterThan(fn.indexOf('} else if (agentChannelVerb.action) {'));
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

describe('#49: natural conversation only where the agent can write nothing', () => {
  const { naturalConversationVerdict } = require('../lib/natural-conversation');
  const { loadAgents } = require('../lib/agent-registry');

  test.each([
    [{ id: 'chat', permissions: [] }, true],
    [{ id: 'mail', permissions: ['gmail-read', 'twilio-outbound'] }, true],
    [{ id: 'reader', permissions: ['github-read'] }, true],
    [{ id: 'coder', permissions: ['claude-code'] }, false],
    [{ id: 'editor', permissions: ['file-system'] }, false],
    [null, false],
  ])('%j -> allowed %s', (agent, allowed) => {
    expect(naturalConversationVerdict(agent).allowed).toBe(allowed);
  });

  test('a tool that is not a read tool disqualifies, even one this file has never heard of', () => {
    const tools = require('../lib/agent-tools');
    const saved = tools.GRANTS;
    jest.spyOn(tools, 'resolveClaudeTools').mockReturnValue({ full: false, tools: ['Read', 'SendMail'] });
    try {
      const v = naturalConversationVerdict({ id: 'future-secretary' });
      expect(v.allowed).toBe(false);
      expect(v.reason).toMatch(/SendMail/);
    } finally {
      jest.restoreAllMocks();
    }
    expect(tools.GRANTS).toBe(saved);
  });

  test('the live definitions: the code agents need a prefix, the tool-less agents do not', () => {
    const verdicts = Object.fromEntries(loadAgents().map(a => [a.id, naturalConversationVerdict(a).allowed]));
    for (const id of ['bridge', 'code-bridge', 'code-sqtools']) expect(verdicts[id]).toBe(false);
    for (const id of ['secretary', 'jester', 'email-monitor', 'story-bot', 'security']) expect(verdicts[id]).toBe(true);
  });

  test('the poll loop consults the verdict before processConversation, and skips with the reason', () => {
    const start = SRC.indexOf('if (config.NATURAL_CONVERSATION_MODE &&');
    const branch = SRC.slice(start, SRC.indexOf('continue;', SRC.indexOf('processConversation(', start)));
    const verdictAt = branch.indexOf('naturalConversationVerdict(channelAgentConfig)');
    expect(verdictAt).toBeGreaterThan(0);
    expect(verdictAt).toBeLessThan(branch.indexOf('processConversation('));
    expect(branch).toMatch(/if \(!natural\.allowed\) \{\s*console\.log\(`[^`]*\$\{natural\.reason\}`\);\s*continue;/);
  });
});
