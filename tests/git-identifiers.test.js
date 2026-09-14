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
} = require('../lib/git-identifiers');

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
