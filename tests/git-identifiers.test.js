/**
 * tests/git-identifiers.test.js
 *
 * Unit tests for lib/git-identifiers.js — the boundary validators for the two
 * Slack-controlled git identifiers (REPO: and BRANCH:).
 *
 * LOGIC CHANGE 2026-09-14: New file, added with the command-injection fix. The
 * payloads below are deliberately inert: they carry shell metacharacters (which is
 * what the validators must reject) but name no real command.
 */

'use strict';

const {
  isValidRepo,
  isValidBranch,
  assertValidRepo,
  assertValidBranch,
  describeValue,
  describeCharset,
  OWNER_PATTERN,
  NAME_PATTERN,
  BRANCH_PATTERN,
  OWNER_PUNCTUATION,
  NAME_PUNCTUATION,
  BRANCH_PUNCTUATION,
} = require('../lib/git-identifiers');

// Every printable ASCII character that is neither a letter nor a digit. The
// agreement tests below probe each pattern with ALL of them rather than with a
// hand-picked list, so a pattern that silently starts accepting one is caught.
const ASCII_PUNCTUATION = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter(
  (c) => !/[A-Za-z0-9]/.test(c)
);

describe('isValidRepo', () => {
  test.each([
    'jtpets/slack-agent-bridge',
    'JTPets/slack-agent-bridge',
    'jtpets/SquareDashboardTool',
    'jtpets/repo.js',
    'jtpets/repo_name',
    'a/b',
  ])('accepts the real repo shape %s', (repo) => {
    expect(isValidRepo(repo)).toBe(true);
  });

  test.each([
    ['shell separator', 'jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND'],
    ['command substitution', 'jtpets/repo$(INERT_PAYLOAD_NOT_A_COMMAND)'],
    ['backtick', 'jtpets/repo`INERT_PAYLOAD_NOT_A_COMMAND`'],
    ['pipe', 'jtpets/repo|INERT_PAYLOAD_NOT_A_COMMAND'],
    ['background', 'jtpets/repo&INERT_PAYLOAD_NOT_A_COMMAND'],
    ['redirect', 'jtpets/repo>INERT_PAYLOAD_NOT_A_COMMAND'],
    ['newline', 'jtpets/repo\nINERT_PAYLOAD_NOT_A_COMMAND'],
    ['embedded space', 'jtpets/runWithFallback had'],
    ['path traversal', 'jtpets/../../etc'],
    ['extra segment', 'jtpets/org/repo'],
    ['no owner', 'repo-with-no-owner'],
    ['empty owner', '/repo'],
    ['empty name', 'jtpets/'],
    ['leading hyphen owner', '-jtpets/repo'],
    ['empty string', ''],
  ])('rejects %s', (_label, repo) => {
    expect(isValidRepo(repo)).toBe(false);
  });

  test.each([undefined, null, 42, {}, ['jtpets/repo']])(
    'rejects the non-string value %p',
    (value) => {
      expect(isValidRepo(value)).toBe(false);
    }
  );
});

describe('isValidBranch', () => {
  test.each([
    'main',
    'develop',
    'feature/auth',
    'claude/eager-bardeen-i45uwv',
    'release-1.2.3',
    'fix_123',
  ])('accepts the real branch shape %s', (branch) => {
    expect(isValidBranch(branch)).toBe(true);
  });

  test.each([
    ['shell separator', 'main;INERT_PAYLOAD_NOT_A_COMMAND'],
    ['command substitution', 'main$(INERT_PAYLOAD_NOT_A_COMMAND)'],
    ['backtick', 'main`INERT_PAYLOAD_NOT_A_COMMAND`'],
    ['pipe', 'main|INERT_PAYLOAD_NOT_A_COMMAND'],
    ['newline', 'main\nINERT_PAYLOAD_NOT_A_COMMAND'],
    ['embedded space', 'main INERT_PAYLOAD_NOT_A_COMMAND'],
    ['leading hyphen (git option injection)', '--upload-pack=INERT_PAYLOAD_NOT_A_COMMAND'],
    ['ref traversal', 'feature/../../main'],
    ['double slash', 'feature//x'],
    ['trailing slash', 'feature/'],
    ['trailing dot', 'feature.'],
    ['dot-leading component', 'feature/.hidden'],
    ['.lock suffix', 'feature/x.lock'],
    ['reflog syntax', 'main@{1}'],
    ['tilde', 'main~1'],
    ['caret', 'main^2'],
    ['colon', 'main:refs/heads/other'],
    ['glob', 'main*'],
    ['empty string', ''],
  ])('rejects %s', (_label, branch) => {
    expect(isValidBranch(branch)).toBe(false);
  });

  test.each([undefined, null, 42, {}])('rejects the non-string value %p', (value) => {
    expect(isValidBranch(value)).toBe(false);
  });
});

describe('assertValidRepo / assertValidBranch', () => {
  test('return the value unchanged when valid', () => {
    expect(assertValidRepo('jtpets/slack-agent-bridge')).toBe('jtpets/slack-agent-bridge');
    expect(assertValidBranch('feature/x')).toBe('feature/x');
  });

  test('throw naming the field when invalid', () => {
    expect(() => assertValidRepo('jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND')).toThrow(
      /Rejected REPO value/
    );
    expect(() => assertValidBranch('main;INERT_PAYLOAD_NOT_A_COMMAND')).toThrow(
      /Rejected BRANCH value/
    );
  });

  test('reject rather than sanitise — the valid prefix is never salvaged', () => {
    // "jtpets/repo;X" must not become "jtpets/repo". Cloning a different repo than
    // the operator named, silently, is the defect this avoids.
    expect(() => assertValidRepo('jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND')).toThrow();
    expect(isValidRepo('jtpets/repo;INERT_PAYLOAD_NOT_A_COMMAND')).toBe(false);
  });
});

describe('describeValue', () => {
  test('escapes newlines so a rejected value cannot break the error line', () => {
    expect(describeValue('a\nb')).toBe('"a\\nb"');
  });

  test('caps a long value', () => {
    const described = describeValue('x'.repeat(500));
    expect(described.length).toBeLessThan(100);
    expect(described).toContain('...');
  });

  test('handles non-string values without throwing', () => {
    expect(() => describeValue(undefined)).not.toThrow();
    expect(() => describeValue(null)).not.toThrow();
  });
});

// LOGIC CHANGE 2026-09-14: Anti-drift guard for the rejection MESSAGES. These were
// hand-written prose beside the patterns, and they had drifted: lib/task-parser.js
// told the operator a REPO value could use "." and "_", while OWNER_PATTERN admits
// neither — so "jt.pets/app" was refused by a message asserting it was legal, and
// the only way to discover the real rule was to read the regex. A message that names
// the wrong rule is worse than no message: it sends the operator to retry a value
// that can never pass.
//
// The fix is structural, not editorial. Each message is now GENERATED from a
// declared character list (OWNER_PUNCTUATION / NAME_PUNCTUATION / BRANCH_PUNCTUATION
// and, in task-parser.js, SKILL_PUNCTUATION) via describeCharset(). These tests
// close the remaining gap: they prove the declared list matches what the PATTERN
// actually accepts. Change one without the other and this fails.
describe('rejection messages agree with the patterns they enforce', () => {
  /**
   * Probe a pattern with every ASCII punctuation character and return the set it
   * accepts in a non-leading, non-trailing position (the position every one of
   * these patterns treats uniformly).
   */
  const acceptedPunctuation = (pattern) =>
    ASCII_PUNCTUATION.filter((c) => pattern.test(`a${c}b`));

  test.each([
    ['OWNER_PATTERN', OWNER_PATTERN, OWNER_PUNCTUATION],
    ['NAME_PATTERN', NAME_PATTERN, NAME_PUNCTUATION],
    ['BRANCH_PATTERN', BRANCH_PATTERN, BRANCH_PUNCTUATION],
  ])('%s accepts exactly the characters its declared list names', (_label, pattern, declared) => {
    expect(acceptedPunctuation(pattern).sort()).toEqual([...declared].sort());
  });

  test('the REPO message names the OWNER rule, not the NAME rule, for the owner half', () => {
    // The specific drift that existed: "." and "_" are legal in the NAME half only.
    let message = '';
    try {
      assertValidRepo('jt.pets/app');
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain('Rejected REPO value');
    // The owner clause must NOT promise "." or "_" ...
    const ownerClause = message.slice(message.indexOf('owner is'), message.indexOf('and name is'));
    expect(ownerClause).not.toContain('"."');
    expect(ownerClause).not.toContain('"_"');
    // ... while the name clause still does, because NAME_PATTERN accepts them.
    const nameClause = message.slice(message.indexOf('and name is'));
    expect(nameClause).toContain('"."');
    expect(nameClause).toContain('"_"');
  });

  test('the rejected value in the REPO message really is rejected by the predicate', () => {
    // Guards against the inverse defect: a message that describes a stricter rule
    // than the code enforces, so a legal value looks illegal.
    expect(isValidRepo('jt.pets/app')).toBe(false);
    expect(isValidRepo('jt_pets/app')).toBe(false);
    expect(isValidRepo('jtpets/app.name_x')).toBe(true);
  });

  test('the BRANCH message names every rule isValidBranch enforces beyond the charset', () => {
    let message = '';
    try {
      assertValidBranch('feature/../x');
    } catch (e) {
      message = e.message;
    }
    for (const rule of ['".."', '"//"', '".lock"']) {
      expect(message).toContain(rule);
    }
  });

  test('describeCharset renders a readable list for each arity', () => {
    expect(describeCharset([])).toBe('letters and digits');
    expect(describeCharset(['-'])).toBe('letters, digits and "-"');
    expect(describeCharset(['.', '_', '-'])).toBe('letters, digits, ".", "_" and "-"');
  });
});
