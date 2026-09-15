'use strict';

/**
 * tests/dispatch-modal.test.js
 *
 * Part two of the slash-command dispatch form: the modal itself, and the two
 * translations either side of it. Every test here fails without
 * lib/dispatch-modal.js. The handlers are covered in tests/dispatch-command.test.js.
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
} = require('../lib/dispatch-modal');

const { FIELD_KEYS, DISPATCH_DEFAULT_TURNS } = require('../lib/dispatch-message');
const { MIN_TURNS, MAX_TURNS } = require('../lib/task-parser');

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

  // LOGIC CHANGE 2026-09-15: this previously asserted `multiline === false` on every
  // non-instructions input, which quietly assumed every one of them was a
  // plain_text_input. The repo field is a static_select now, and a select has no
  // `multiline` property at all — so the old assertion would have read `undefined`
  // and passed for the wrong reason. Scoped to text inputs, with the select asserted
  // separately below.
  test('only the instructions field is multiline, among the text inputs', () => {
    const textInputs = view.blocks.filter(
      (b) => b.type === 'input' && b.element.type === 'plain_text_input'
    );
    expect(textInputs.length).toBeGreaterThan(0);
    for (const block of textInputs) {
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

  // LOGIC CHANGE 2026-09-15: the form's default is now the CEILING, not the parser's
  // 50. This test previously encoded the old default; it is flipped here in the same
  // change, per docs/EXECUTOR-CONTRACT.md section 5.
  //
  // It asserts the IDENTITY, not the number. Writing `toBe('100')` would let the
  // default and the ceiling drift apart the moment MAX_TURNS moved — which is the
  // exact failure "state what enforces the ceiling" was asking about.
  test('the turn budget defaults to the CEILING, and the default IS the ceiling', () => {
    const block = view.blocks.find((b) => b.block_id === BLOCK_IDS.turns);
    expect(DISPATCH_DEFAULT_TURNS).toBe(MAX_TURNS);
    expect(block.element.initial_value).toBe(String(DISPATCH_DEFAULT_TURNS));
    expect(block.hint.text).toContain(String(MIN_TURNS));
    expect(block.hint.text).toContain(String(MAX_TURNS));
  });

  test('the default the form offers is one the validator would accept', () => {
    const { validateDispatchFields } = require('../lib/dispatch-message');
    const { errors } = validateDispatchFields({
      task: 't', repo: '', branch: 'main',
      turns: String(DISPATCH_DEFAULT_TURNS), instructions: 'do it',
    });
    expect(errors.turns).toBeUndefined();
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

// ---------------------------------------------------------------------------
// LOGIC CHANGE 2026-09-15: the repository field is a select sourced from config,
// and the modal can be opened pre-filled.
// ---------------------------------------------------------------------------

describe('the repository field is sourced from configuration, not hardcoded', () => {
  const { buildInputBlock } = require('../lib/dispatch-modal');
  const { getConfiguredRepos } = require('../lib/config');

  function repoBlock(env) {
    const saved = process.env.REPOS;
    try {
      if (env === undefined) delete process.env.REPOS; else process.env.REPOS = env;
      jest.resetModules();
      const modal = require('../lib/dispatch-modal');
      return modal.buildModalView().blocks.find(b => b.block_id === modal.BLOCK_IDS.repo);
    } finally {
      if (saved === undefined) delete process.env.REPOS; else process.env.REPOS = saved;
      jest.resetModules();
    }
  }

  test('the options are exactly what getConfiguredRepos returns', () => {
    const block = repoBlock('a/one,b/two, c/three ');
    expect(block.element.type).toBe('static_select');
    expect(block.element.options.map(o => o.value)).toEqual(['a/one', 'b/two', 'c/three']);
  });

  test('adding a repository needs no change to this file', () => {
    const before = repoBlock('a/one').element.options.length;
    const after = repoBlock('a/one,b/two').element.options.length;
    expect(after).toBe(before + 1);
  });

  test('with REPOS unset it still offers the two defaults config declares', () => {
    const block = repoBlock(undefined);
    expect(block.element.options.map(o => o.value)).toEqual(getConfiguredRepos({}));
  });

  test('the field stays OPTIONAL — a task with no repository is legitimate', () => {
    expect(repoBlock('a/one').optional).toBe(true);
  });

  test('an empty REPOS falls back to a text input rather than failing the modal open', () => {
    // Slack rejects a static_select with an empty options array, which would make
    // /dispatch stop opening entirely. Degraded field beats no command.
    const block = repoBlock('   ,  ,');
    expect(block.element.type).toBe('plain_text_input');
  });

  test('a select never exceeds Slack\'s 100-option cap', () => {
    const many = Array.from({ length: 150 }, (_, i) => `o/r${i}`).join(',');
    expect(repoBlock(many).element.options.length).toBe(100);
  });

  test('the select does not replace validation — the value is still checked', () => {
    // A select is a convenience in the form; the submitted payload is whatever
    // Slack sends, so the boundary stays where it was.
    const { validateDispatchFields } = require('../lib/dispatch-message');
    expect(validateDispatchFields({
      task: 't', repo: 'jtpets/my;repo', branch: 'main', turns: '100', instructions: 'go',
    }).errors.repo).toMatch(/^Rejected /);
  });

  test('buildInputBlock is exported and callable for one field', () => {
    expect(typeof buildInputBlock).toBe('function');
    expect(buildInputBlock('branch').block_id).toBe(BLOCK_IDS.branch);
  });
});

describe('extractSubmission reads a select as well as a text input', () => {
  test('a static_select value comes back from selected_option', () => {
    const view = {
      state: {
        values: {
          [BLOCK_IDS.task]: { [ACTION_ID]: { value: 'T' } },
          [BLOCK_IDS.repo]: { [ACTION_ID]: { type: 'static_select', selected_option: { value: 'jtpets/x' } } },
          [BLOCK_IDS.branch]: { [ACTION_ID]: { value: 'main' } },
          [BLOCK_IDS.turns]: { [ACTION_ID]: { value: '100' } },
          [BLOCK_IDS.instructions]: { [ACTION_ID]: { value: 'go' } },
        },
      },
    };
    expect(extractSubmission(view).repo).toBe('jtpets/x');
  });

  test('a select the operator left untouched is blank, not undefined', () => {
    const view = { state: { values: { [BLOCK_IDS.repo]: { [ACTION_ID]: { type: 'static_select' } } } } };
    expect(extractSubmission(view).repo).toBe('');
  });
});

describe('the modal CAN be opened pre-filled — the re-run case', () => {
  test('a text field takes the supplied value over its own default', () => {
    const view = buildModalView({ initial: { branch: 'feature/x', task: 'Re-run this' } });
    const branch = view.blocks.find(b => b.block_id === BLOCK_IDS.branch);
    const task = view.blocks.find(b => b.block_id === BLOCK_IDS.task);
    expect(branch.element.initial_value).toBe('feature/x');
    expect(task.element.initial_value).toBe('Re-run this');
  });

  test('a field with no supplied value keeps its default', () => {
    const view = buildModalView({ initial: { task: 'x' } });
    expect(view.blocks.find(b => b.block_id === BLOCK_IDS.branch).element.initial_value).toBe('main');
  });

  test('a long instructions body is truncated to the field\'s own max_length', () => {
    const long = 'x'.repeat(5000);
    const block = buildModalView({ initial: { instructions: long } })
      .blocks.find(b => b.block_id === BLOCK_IDS.instructions);
    expect(block.element.initial_value.length).toBe(block.element.max_length);
  });

  test('the select pre-fills only with an option it actually offers', () => {
    const saved = process.env.REPOS;
    try {
      process.env.REPOS = 'a/one,b/two';
      jest.resetModules();
      const modal = require('../lib/dispatch-modal');
      const good = modal.buildModalView({ initial: { repo: 'b/two' } })
        .blocks.find(b => b.block_id === modal.BLOCK_IDS.repo);
      expect(good.element.initial_option.value).toBe('b/two');

      // A repository that has since been removed from REPOS. Slack rejects an
      // initial_option absent from options, which would fail the modal open — so
      // the pre-fill is dropped rather than the command breaking.
      const stale = modal.buildModalView({ initial: { repo: 'gone/away' } })
        .blocks.find(b => b.block_id === modal.BLOCK_IDS.repo);
      expect(stale.element.initial_option).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.REPOS; else process.env.REPOS = saved;
      jest.resetModules();
    }
  });

  test('no initial context at all still builds the ordinary modal', () => {
    const view = buildModalView();
    expect(view.blocks.length).toBe(FIELD_KEYS.length);
    expect(view.callback_id).toBe(CALLBACK_ID);
  });
});
