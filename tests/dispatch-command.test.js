'use strict';

/**
 * tests/dispatch-command.test.js
 *
 * Parts one, two and four of the slash-command dispatch form: the modal, the
 * command handler, and the failure paths. Every test here fails without
 * lib/dispatch-command.js.
 */

const {
  COMMAND_NAME,
  CALLBACK_ID,
  ACTION_ID,
  BLOCK_IDS,
  buildModalView,
  readPrivateMetadata,
  extractSubmission,
  toSlackErrors,
} = require('../lib/dispatch-command');

const { FIELD_KEYS } = require('../lib/dispatch-message');
const { DEFAULT_TURNS, MIN_TURNS, MAX_TURNS } = require('../lib/task-parser');

/** Build a view_submission `view` carrying the given raw values. */
function submissionView(values, metadata = { channelId: 'C_CMD', userId: 'U_OWNER' }) {
  const state = { values: {} };
  for (const key of FIELD_KEYS) {
    state.values[BLOCK_IDS[key]] = {
      [ACTION_ID]: { type: 'plain_text_input', value: values[key] === undefined ? null : values[key] },
    };
  }
  return { callback_id: CALLBACK_ID, private_metadata: JSON.stringify(metadata), state };
}

describe('the modal has five separate inputs — the entire point of the form', () => {
  const view = buildModalView({ channelId: 'C_CMD', userId: 'U_OWNER' });

  test('it is a modal carrying our callback_id and a submit button', () => {
    expect(view.type).toBe('modal');
    expect(view.callback_id).toBe(CALLBACK_ID);
    expect(view.submit).toBeDefined();
    expect(view.title.text.length).toBeLessThanOrEqual(24); // Slack's modal title cap
  });

  test('there is exactly one input block per generator field, in order', () => {
    const inputs = view.blocks.filter((b) => b.type === 'input');
    expect(inputs).toHaveLength(FIELD_KEYS.length);
    expect(inputs.map((b) => b.block_id)).toEqual(FIELD_KEYS.map((k) => BLOCK_IDS[k]));
  });

  test('the blocks are built FROM the generator field list, so neither can gain a field alone', () => {
    // A field added to lib/dispatch-message.js but not here (or the reverse) is the
    // drift this asserts against: five inputs that are not the five fields.
    const blockIds = view.blocks.filter((b) => b.type === 'input').map((b) => b.block_id);
    expect(blockIds.sort()).toEqual(FIELD_KEYS.map((k) => BLOCK_IDS[k]).sort());
    expect(new Set(blockIds).size).toBe(FIELD_KEYS.length);
  });

  test('only the instructions field is multiline', () => {
    for (const block of view.blocks.filter((b) => b.type === 'input')) {
      const expected = block.block_id === BLOCK_IDS.instructions;
      expect(block.element.multiline).toBe(expected);
    }
  });

  test('task and instructions are required; repo, branch and turns are optional', () => {
    const optional = {};
    for (const block of view.blocks.filter((b) => b.type === 'input')) {
      optional[block.block_id] = block.optional;
    }
    expect(optional[BLOCK_IDS.task]).toBe(false);
    expect(optional[BLOCK_IDS.instructions]).toBe(false);
    expect(optional[BLOCK_IDS.repo]).toBe(true);
    expect(optional[BLOCK_IDS.branch]).toBe(true);
    expect(optional[BLOCK_IDS.turns]).toBe(true);
  });

  test('the turn budget defaults to the parser default and names the parser range', () => {
    const block = view.blocks.find((b) => b.block_id === BLOCK_IDS.turns);
    expect(block.element.initial_value).toBe(String(DEFAULT_TURNS));
    expect(block.hint.text).toContain(String(MIN_TURNS));
    expect(block.hint.text).toContain(String(MAX_TURNS));
  });

  test('the branch defaults to main', () => {
    const block = view.blocks.find((b) => b.block_id === BLOCK_IDS.branch);
    expect(block.element.initial_value).toBe('main');
  });

  test('private_metadata records where the command came from and carries no typed value', () => {
    expect(readPrivateMetadata(view)).toEqual({ channelId: 'C_CMD', userId: 'U_OWNER' });
    expect(view.private_metadata).not.toContain('token');
  });

  test('unparseable private_metadata degrades to empty rather than throwing', () => {
    expect(readPrivateMetadata({ private_metadata: 'not json' })).toEqual({ channelId: '', userId: '' });
    expect(readPrivateMetadata(undefined)).toEqual({ channelId: '', userId: '' });
  });
});

describe('extractSubmission reads the five inputs back', () => {
  test('a full submission yields every value', () => {
    const values = extractSubmission(submissionView({
      task: 'Do the thing',
      repo: 'jtpets/slack-agent-bridge',
      branch: 'feature/x',
      turns: '100',
      instructions: 'Read then write.',
    }));
    expect(values).toEqual({
      task: 'Do the thing',
      repo: 'jtpets/slack-agent-bridge',
      branch: 'feature/x',
      turns: '100',
      instructions: 'Read then write.',
    });
  });

  test('a blank optional input arrives from Slack as null and is read as an empty string', () => {
    const values = extractSubmission(submissionView({
      task: 'Do the thing',
      repo: undefined,
      branch: undefined,
      turns: undefined,
      instructions: 'Read then write.',
    }));
    expect(values.repo).toBe('');
    expect(values.branch).toBe('');
    expect(values.turns).toBe('');
  });

  test('a malformed or absent view yields empty strings, never a throw', () => {
    expect(() => extractSubmission(undefined)).not.toThrow();
    expect(extractSubmission({}).task).toBe('');
    expect(extractSubmission({ state: {} }).instructions).toBe('');
  });
});

describe('toSlackErrors keys errors by block_id so they land on the right input', () => {
  test('a field error becomes a block_id error', () => {
    expect(toSlackErrors({ repo: 'Rejected "bad;repo" - ...' })).toEqual({
      [BLOCK_IDS.repo]: 'Rejected "bad;repo" - ...',
    });
  });

  test('every field key maps to a distinct block_id', () => {
    const all = {};
    for (const key of FIELD_KEYS) all[key] = `problem with ${key}`;
    const mapped = toSlackErrors(all);
    expect(Object.keys(mapped)).toHaveLength(FIELD_KEYS.length);
    expect(new Set(Object.keys(mapped)).size).toBe(FIELD_KEYS.length);
  });

  test('a long reason is cut to Slack’s 250-character field-error cap', () => {
    const mapped = toSlackErrors({ instructions: 'x'.repeat(400) });
    expect(mapped[BLOCK_IDS.instructions]).toHaveLength(250);
  });

  test('no error means no error map', () => {
    expect(toSlackErrors({})).toEqual({});
  });
});

describe('the command name is declared once', () => {
  test('it is a slash command', () => {
    expect(COMMAND_NAME).toMatch(/^\/[a-z-]+$/);
  });
});
