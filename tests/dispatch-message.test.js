'use strict';

/**
 * tests/dispatch-message.test.js
 *
 * Part three of the slash-command dispatch form: the generator. The property that
 * matters is not "it produces a string" but "parseTask reads the string back as the
 * same five fields" - a generator that drifts from the parser reintroduces the
 * flattening defect from the other direction.
 *
 * Every test here fails without lib/dispatch-message.js.
 */

const {
  FIELD_KEYS,
  DISPATCH_DEFAULT_TURNS,
  matchesFieldLabel,
  validateDispatchFields,
  buildDispatchMessage,
  assertRoundTrip,
  composeDispatchMessage,
} = require('../lib/dispatch-message');

const {
  parseTask,
  FIELD_LABELS,
  MIN_TURNS,
  MAX_TURNS,
} = require('../lib/task-parser');

const wellFormed = {
  task: 'Add the missing regression test',
  repo: 'jtpets/slack-agent-bridge',
  branch: 'main',
  turns: '100',
  instructions: 'Read the contract.\nThen write the test.\nRun npm test.',
};

describe('the five fields are declared once', () => {
  test('FIELD_KEYS is exactly the five inputs the form carries', () => {
    expect(FIELD_KEYS).toEqual(['task', 'repo', 'branch', 'turns', 'instructions']);
  });
});

describe('validateDispatchFields accepts a well-formed submission', () => {
  test('all five values survive, with the declared types', () => {
    const { ok, values, errors } = validateDispatchFields(wellFormed);
    expect(errors).toEqual({});
    expect(ok).toBe(true);
    expect(values.task).toBe('Add the missing regression test');
    expect(values.repo).toBe('jtpets/slack-agent-bridge');
    expect(values.branch).toBe('main');
    expect(values.turns).toBe(100);
    expect(values.instructions).toContain('npm test');
  });

  // LOGIC CHANGE 2026-09-15: a blank budget now means the FORM's default, which is
  // the ceiling (MAX_TURNS), not the parser's DEFAULT_TURNS of 50. This test
  // previously encoded the old default and is flipped in the same change as the
  // behaviour, per docs/EXECUTOR-CONTRACT.md section 5.
  test('an omitted repo is empty, an omitted branch is main, an omitted budget is the CEILING', () => {
    const { ok, values } = validateDispatchFields({
      task: 'A research task',
      repo: '',
      branch: '',
      turns: '',
      instructions: 'Read and report.',
    });
    expect(ok).toBe(true);
    expect(values.repo).toBe('');
    expect(values.branch).toBe('main');
    expect(values.turns).toBe(DISPATCH_DEFAULT_TURNS);
  });

  test('the form default IS the ceiling — asserted as an identity, not as 100', () => {
    // If these two ever stop being the same constant, the form can offer a default
    // its own validator rejects. That is the disagreement this pins shut.
    expect(DISPATCH_DEFAULT_TURNS).toBe(MAX_TURNS);
  });

  test('one above the form default is rejected, so the default is genuinely the top', () => {
    const { ok, errors } = validateDispatchFields({
      task: 't', repo: '', branch: 'main',
      turns: String(DISPATCH_DEFAULT_TURNS + 1), instructions: 'go',
    });
    expect(ok).toBe(false);
    expect(errors.turns).toContain(String(MAX_TURNS));
  });

  test('a repo URL and a bare name normalise exactly as the parser normalises them', () => {
    const asUrl = validateDispatchFields({ ...wellFormed, repo: 'https://github.com/jtpets/slack-agent-bridge.git' });
    expect(asUrl.values.repo).toBe('jtpets/slack-agent-bridge');

    const bare = validateDispatchFields({ ...wellFormed, repo: 'slack-agent-bridge' }, 'jtpets');
    expect(bare.values.repo).toBe('jtpets/slack-agent-bridge');
  });
});

describe('rejected fields name the field and the reason', () => {
  test('a missing task description is refused against the task field', () => {
    const { ok, errors } = validateDispatchFields({ ...wellFormed, task: '   ' });
    expect(ok).toBe(false);
    expect(Object.keys(errors)).toEqual(['task']);
    expect(errors.task).toMatch(/required/i);
  });

  test('missing instructions are refused against the instructions field', () => {
    const { ok, errors } = validateDispatchFields({ ...wellFormed, instructions: '' });
    expect(ok).toBe(false);
    expect(errors.instructions).toMatch(/required/i);
  });

  // The whole point of reusing lib/git-identifiers.js: these are the same payloads
  // tests/git-identifiers.test.js rejects at the message boundary.
  test.each([
    'jtpets/my;repo',
    'jtpets/repo$(whoami)',
    'jt.pets/app',
    'jtpets/../etc',
    '--upload-pack=touch /tmp/pwn',
    'jtpets/repo name',
  ])('a repo value the identifier module refuses is refused here too: %s', (repo) => {
    const { ok, errors } = validateDispatchFields({ ...wellFormed, repo });
    expect(ok).toBe(false);
    expect(errors.repo).toMatch(/^Rejected /);
  });

  test.each([
    'feature/../../etc',
    'main;rm -rf /',
    '-branch',
    'feature//x',
    'feature/x.lock',
  ])('a branch value the identifier module refuses is refused here too: %s', (branch) => {
    const { ok, errors } = validateDispatchFields({ ...wellFormed, branch });
    expect(ok).toBe(false);
    expect(errors.branch).toMatch(/^Rejected /);
  });

  test('a rejection never echoes a raw newline into the message', () => {
    const { errors } = validateDispatchFields({ ...wellFormed, repo: 'jtpets/a\nREPO: evil/thing' });
    expect(errors.repo).toBeDefined();
    expect(errors.repo).not.toContain('\n');
  });

  test('the turn budget is rejected, not clamped, outside the parser floor and ceiling', () => {
    expect(validateDispatchFields({ ...wellFormed, turns: String(MAX_TURNS + 1) }).errors.turns)
      .toContain(`between ${MIN_TURNS} and ${MAX_TURNS}`);
    expect(validateDispatchFields({ ...wellFormed, turns: String(MIN_TURNS - 1) }).errors.turns)
      .toContain(`between ${MIN_TURNS} and ${MAX_TURNS}`);
  });

  test('a non-numeric turn budget is rejected, not silently defaulted', () => {
    const { ok, errors } = validateDispatchFields({ ...wellFormed, turns: 'fifty' });
    expect(ok).toBe(false);
    expect(errors.turns).toMatch(/whole number/);
  });

  test('every invalid field is reported at once, not one per submission', () => {
    const { errors } = validateDispatchFields({
      task: '',
      repo: 'not a repo',
      branch: '..bad',
      turns: 'x',
      instructions: '',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['branch', 'instructions', 'repo', 'task', 'turns']
    );
  });
});

describe('a field label inside the instructions body is refused', () => {
  // This is the defect arriving from the inside: parseTask searches the whole
  // message for each label, so an instructions line beginning "REPO:" becomes the
  // repo field and one beginning "Repo:" refuses the entire task.
  test.each(FIELD_LABELS)('an UPPERCASE %s: line in the instructions is refused', (label) => {
    const { ok, errors } = validateDispatchFields({
      ...wellFormed,
      instructions: `Do the work.\n${label}: something`,
    });
    expect(ok).toBe(false);
    expect(errors.instructions).toContain('Line 2');
  });

  test('a non-canonical spelling is refused too, because the parser refuses the task for it', () => {
    const { ok, errors } = validateDispatchFields({
      ...wellFormed,
      instructions: 'Do the work.\nRepo: the one we discussed',
    });
    expect(ok).toBe(false);
    expect(errors.instructions).toMatch(/field label/i);
  });

  test('the same words mid-sentence are fine - only a line start is a label', () => {
    const { ok } = validateDispatchFields({
      ...wellFormed,
      instructions: 'The repo: runWithFallback had no callers. Check the branch: main.',
    });
    expect(ok).toBe(true);
  });

  test('matchesFieldLabel is built from the parser list, not a restatement', () => {
    for (const label of FIELD_LABELS) {
      expect(matchesFieldLabel(`${label}: x`)).toBe(true);
      expect(matchesFieldLabel(`  ${label.toLowerCase()}: x`)).toBe(true);
    }
    expect(matchesFieldLabel('NOTALABEL: x')).toBe(false);
  });
});

describe('buildDispatchMessage emits what the parser reads', () => {
  test('labels are UPPERCASE and each begins its own line', () => {
    const { values } = validateDispatchFields(wellFormed);
    const message = buildDispatchMessage(values);
    expect(message.split('\n')[0]).toBe('TASK: Add the missing regression test');
    expect(message).toMatch(/^REPO: jtpets\/slack-agent-bridge$/m);
    expect(message).toMatch(/^BRANCH: main$/m);
    expect(message).toMatch(/^TURNS: 100$/m);
    expect(message).toMatch(/^INSTRUCTIONS: /m);
  });

  test('INSTRUCTIONS is last, because its capture is greedy to end of input', () => {
    const { values } = validateDispatchFields(wellFormed);
    const message = buildDispatchMessage(values);
    const afterInstructions = message.slice(message.indexOf('INSTRUCTIONS:'));
    for (const label of FIELD_LABELS.filter((l) => l !== 'INSTRUCTIONS')) {
      expect(afterInstructions).not.toMatch(new RegExp(`^${label}:`, 'm'));
    }
  });

  test('an omitted repo emits NO REPO line - a blank one would refuse the task', () => {
    const { values } = validateDispatchFields({ ...wellFormed, repo: '' });
    const message = buildDispatchMessage(values);
    expect(message).not.toMatch(/^REPO:/m);
    expect(parseTask(message).errors).toEqual([]);
  });
});

describe('the generated message round-trips through parseTask', () => {
  test('every field comes back identical', () => {
    const { message, values, ok } = composeDispatchMessage(wellFormed);
    expect(ok).toBe(true);
    const parsed = parseTask(message);
    expect(parsed.errors).toEqual([]);
    expect(parsed.description).toBe(values.task);
    expect(parsed.repo).toBe(values.repo);
    expect(parsed.branch).toBe(values.branch);
    expect(parsed.turns).toBe(values.turns);
    expect(parsed.instructions).toBe(values.instructions);
  });

  test('a multiline instructions body survives intact', () => {
    const instructions = 'Step one.\n\nStep two, indented:\n    - a bullet\n    - another\n\nDone.';
    const { message, ok } = composeDispatchMessage({ ...wellFormed, instructions });
    expect(ok).toBe(true);
    expect(parseTask(message).instructions).toBe(instructions);
  });

  test('a description containing a colon still round-trips', () => {
    const task = 'Fix: the parser drops a field';
    const { message, ok } = composeDispatchMessage({ ...wellFormed, task });
    expect(ok).toBe(true);
    expect(parseTask(message).description).toBe(task);
  });

  test('assertRoundTrip THROWS when the generator and the parser disagree', () => {
    // The negative control: prove the guard detects what it claims to. A message
    // built by hand with a lowercase label is exactly the drift being guarded.
    const values = validateDispatchFields(wellFormed).values;
    const drifted = `TASK: ${values.task}\nrepo: ${values.repo}\nBRANCH: ${values.branch}\n` +
      `TURNS: ${values.turns}\nINSTRUCTIONS: ${values.instructions}`;
    expect(() => assertRoundTrip(drifted, values)).toThrow(/parser rejected|does not round-trip/);
  });

  test('assertRoundTrip THROWS on a silently changed field', () => {
    const values = validateDispatchFields(wellFormed).values;
    const message = buildDispatchMessage({ ...values, turns: 25 });
    expect(() => assertRoundTrip(message, values)).toThrow(/TURNS changed|does not round-trip/);
  });
});

describe('composeDispatchMessage is the single entry point', () => {
  test('it refuses without a message when a field is bad', () => {
    const result = composeDispatchMessage({ ...wellFormed, repo: 'bad;repo' });
    expect(result.ok).toBe(false);
    expect(result.message).toBeUndefined();
    expect(result.errors.repo).toBeDefined();
  });

  test('CRLF from the transport does not ride into the instructions body', () => {
    const { message, ok } = composeDispatchMessage({
      ...wellFormed,
      instructions: 'Line one.\r\nLine two.\r\n',
    });
    expect(ok).toBe(true);
    expect(message).not.toContain('\r');
    expect(parseTask(message).instructions).toBe('Line one.\nLine two.');
  });
});
