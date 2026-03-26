/**
 * tests/message-detection.test.js
 *
 * Unit tests for isTaskMessage, isConversationMessage, and alreadyProcessed
 * from lib/task-parser.js
 */

const {
  isTaskMessage,
  isConversationMessage,
  alreadyProcessed,
  EMOJI_DONE,
  EMOJI_FAILED,
} = require('../lib/task-parser');

describe('isTaskMessage', () => {
  test('returns true for messages containing TASK:', () => {
    const msg = { text: 'TASK: Do something\nINSTRUCTIONS: Details' };
    expect(isTaskMessage(msg)).toBe(true);
  });

  test('returns true for messages with TASK: anywhere in text', () => {
    const msg = { text: 'Hey team,\nTASK: Build feature' };
    expect(isTaskMessage(msg)).toBe(true);
  });

  test('returns false for channel_join subtypes', () => {
    const msg = { subtype: 'channel_join', text: 'TASK: Something' };
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for channel_leave subtypes', () => {
    const msg = { subtype: 'channel_leave', text: 'TASK: Something' };
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for empty text', () => {
    const msg = { text: '' };
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for undefined text', () => {
    const msg = {};
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for null text', () => {
    const msg = { text: null };
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for messages without TASK:', () => {
    const msg = { text: 'Just a regular message' };
    expect(isTaskMessage(msg)).toBe(false);
  });

  test('returns false for task (lowercase)', () => {
    const msg = { text: 'task: lowercase task' };
    expect(isTaskMessage(msg)).toBe(false);
  });
});

describe('isConversationMessage', () => {
  test('returns true for ASK: prefix', () => {
    const msg = { text: 'ASK: What is the status?' };
    expect(isConversationMessage(msg)).toBe(true);
  });

  test('is case insensitive (lowercase ask:)', () => {
    const msg = { text: 'ask: lowercase question' };
    expect(isConversationMessage(msg)).toBe(true);
  });

  test('is case insensitive (mixed case Ask:)', () => {
    const msg = { text: 'Ask: Mixed case question' };
    expect(isConversationMessage(msg)).toBe(true);
  });

  test('handles leading whitespace', () => {
    const msg = { text: '  ASK: Question with leading space' };
    expect(isConversationMessage(msg)).toBe(true);
  });

  test('returns false for channel_join subtypes', () => {
    const msg = { subtype: 'channel_join', text: 'ASK: Something' };
    expect(isConversationMessage(msg)).toBe(false);
  });

  test('returns false for channel_leave subtypes', () => {
    const msg = { subtype: 'channel_leave', text: 'ASK: Something' };
    expect(isConversationMessage(msg)).toBe(false);
  });

  test('returns false for empty text', () => {
    const msg = { text: '' };
    expect(isConversationMessage(msg)).toBe(false);
  });

  test('returns false for undefined text', () => {
    const msg = {};
    expect(isConversationMessage(msg)).toBe(false);
  });

  test('returns false for messages without ASK: prefix', () => {
    const msg = { text: 'What is the status?' };
    expect(isConversationMessage(msg)).toBe(false);
  });

  test('returns false when ASK: is not at the start', () => {
    const msg = { text: 'Please ASK: the team' };
    expect(isConversationMessage(msg)).toBe(false);
  });
});

describe('alreadyProcessed', () => {
  test('returns false when no reactions', () => {
    const msg = {};
    expect(alreadyProcessed(msg)).toBe(false);
  });

  test('returns false when reactions is empty array', () => {
    const msg = { reactions: [] };
    expect(alreadyProcessed(msg)).toBe(false);
  });

  test('returns true when has done emoji (robot_face)', () => {
    const msg = { reactions: [{ name: EMOJI_DONE }] };
    expect(alreadyProcessed(msg)).toBe(true);
  });

  test('returns true when has failed emoji (x)', () => {
    const msg = { reactions: [{ name: EMOJI_FAILED }] };
    expect(alreadyProcessed(msg)).toBe(true);
  });

  test('returns true when has both done and failed emoji', () => {
    const msg = { reactions: [{ name: EMOJI_DONE }, { name: EMOJI_FAILED }] };
    expect(alreadyProcessed(msg)).toBe(true);
  });

  test('returns false when has unrelated reactions only', () => {
    const msg = { reactions: [{ name: 'thumbsup' }, { name: 'heart' }] };
    expect(alreadyProcessed(msg)).toBe(false);
  });

  test('returns true when done emoji among other reactions', () => {
    const msg = { reactions: [{ name: 'thumbsup' }, { name: EMOJI_DONE }, { name: 'heart' }] };
    expect(alreadyProcessed(msg)).toBe(true);
  });
});
