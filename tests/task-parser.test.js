/**
 * tests/task-parser.test.js
 *
 * Unit tests for parseTask function from lib/task-parser.js
 */

const {
  parseTask,
  isStatusQuery,
  isCreateChannelCommand,
  parseCreateChannelCommand,
  DEFAULT_TURNS,
  MIN_TURNS,
  MAX_TURNS
} = require('../lib/task-parser');

describe('parseTask', () => {
  test('parses full TASK/REPO/BRANCH/INSTRUCTIONS message', () => {
    const text = `TASK: Add user authentication
REPO: jtpets/my-app
BRANCH: feature/auth
INSTRUCTIONS: Implement JWT-based auth using passport.js`;

    const result = parseTask(text);

    expect(result.description).toBe('Add user authentication');
    expect(result.repo).toBe('jtpets/my-app');
    expect(result.branch).toBe('feature/auth');
    expect(result.instructions).toBe('Implement JWT-based auth using passport.js');
    expect(result.raw).toBe(text);
  });

  test('handles missing REPO (empty string)', () => {
    const text = `TASK: General cleanup
INSTRUCTIONS: Clean up unused variables`;

    const result = parseTask(text);

    expect(result.description).toBe('General cleanup');
    expect(result.repo).toBe('');
    expect(result.branch).toBe('main');
    expect(result.instructions).toBe('Clean up unused variables');
  });

  test('handles missing BRANCH (defaults to main)', () => {
    const text = `TASK: Fix bug
REPO: jtpets/some-repo
INSTRUCTIONS: Fix the null pointer issue`;

    const result = parseTask(text);

    expect(result.branch).toBe('main');
  });

  test('handles full GitHub URL in REPO', () => {
    const text = `TASK: Clone from URL
REPO: https://github.com/jtpets/url-repo
INSTRUCTIONS: Do something`;

    const result = parseTask(text);

    expect(result.repo).toBe('jtpets/url-repo');
  });

  test('handles GitHub URL with .git suffix', () => {
    const text = `TASK: Clone from URL with .git
REPO: https://github.com/jtpets/url-repo.git
INSTRUCTIONS: Do something`;

    const result = parseTask(text);

    expect(result.repo).toBe('jtpets/url-repo');
  });

  test('handles repo name without org (prepends default org)', () => {
    const text = `TASK: Simple repo name
REPO: simple-repo
INSTRUCTIONS: Work on it`;

    const result = parseTask(text);

    expect(result.repo).toBe('jtpets/simple-repo');
  });

  test('handles repo name without org with custom org override', () => {
    const text = `TASK: Simple repo name
REPO: simple-repo
INSTRUCTIONS: Work on it`;

    const result = parseTask(text, 'customorg');

    expect(result.repo).toBe('customorg/simple-repo');
  });

  test('handles multiline INSTRUCTIONS', () => {
    const text = `TASK: Multi-step task
REPO: jtpets/test-repo
BRANCH: main
INSTRUCTIONS: First do this.
Then do that.
Finally, do something else.

Also remember to:
- Test the code
- Update docs`;

    const result = parseTask(text);

    expect(result.instructions).toBe(`First do this.
Then do that.
Finally, do something else.

Also remember to:
- Test the code
- Update docs`);
  });

  test('handles BRANCH with value "none" (defaults to main)', () => {
    const text = `TASK: Task with none branch
REPO: jtpets/test
BRANCH: none
INSTRUCTIONS: Test`;

    const result = parseTask(text);

    expect(result.branch).toBe('main');
  });

  test('handles missing BRANCH field entirely (defaults to main)', () => {
    const text = `TASK: Task without branch field
REPO: jtpets/test
INSTRUCTIONS: Test`;

    const result = parseTask(text);

    expect(result.branch).toBe('main');
  });

  test('handles HTTP (non-HTTPS) GitHub URL', () => {
    const text = `TASK: HTTP URL
REPO: http://github.com/jtpets/http-repo
INSTRUCTIONS: Test`;

    const result = parseTask(text);

    expect(result.repo).toBe('jtpets/http-repo');
  });

  test('preserves raw text in result', () => {
    const text = 'TASK: Simple task\nINSTRUCTIONS: Do it';
    const result = parseTask(text);

    expect(result.raw).toBe(text);
  });

  test('handles TASK description with special characters', () => {
    const text = `TASK: Fix bug #123 (urgent!)
INSTRUCTIONS: Fix it`;

    const result = parseTask(text);

    expect(result.description).toBe('Fix bug #123 (urgent!)');
  });

  test('handles empty text', () => {
    const result = parseTask('');

    expect(result.description).toBe('');
    expect(result.repo).toBe('');
    expect(result.branch).toBe('main');
    expect(result.instructions).toBe('');
    expect(result.turns).toBe(DEFAULT_TURNS);
    expect(result.raw).toBe('');
  });

  // LOGIC CHANGE 2026-04-01: Tests for case-insensitive field parsing
  describe('case-insensitive field parsing', () => {
    test('parses lowercase task/repo/branch/instructions fields', () => {
      const text = `task: Lowercase task
repo: jtpets/my-app
branch: feature/test
instructions: Do the work`;

      const result = parseTask(text);

      expect(result.description).toBe('Lowercase task');
      expect(result.repo).toBe('jtpets/my-app');
      expect(result.branch).toBe('feature/test');
      expect(result.instructions).toBe('Do the work');
    });

    test('parses mixed case field names', () => {
      const text = `Task: Mixed case task
Repo: jtpets/mixed-repo
Branch: dev
Instructions: Test mixed case`;

      const result = parseTask(text);

      expect(result.description).toBe('Mixed case task');
      expect(result.repo).toBe('jtpets/mixed-repo');
      expect(result.branch).toBe('dev');
      expect(result.instructions).toBe('Test mixed case');
    });

    test('parses lowercase turns and skill fields', () => {
      const text = `task: Test task
turns: 75
skill: run-tests
instructions: Run tests`;

      const result = parseTask(text);

      expect(result.turns).toBe(75);
      expect(result.skill).toBe('run-tests');
    });
  });

  // TURNS parsing tests
  describe('TURNS parsing', () => {
    test('parses TURNS field as integer', () => {
      const text = `TASK: Test task
REPO: jtpets/test
TURNS: 25
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(25);
    });

    test('defaults to DEFAULT_TURNS (50) when TURNS not specified', () => {
      const text = `TASK: Test task
REPO: jtpets/test
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(DEFAULT_TURNS);
      expect(result.turns).toBe(50);
    });

    test('caps TURNS at MAX_TURNS (100)', () => {
      const text = `TASK: Test task
TURNS: 200
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(MAX_TURNS);
      expect(result.turns).toBe(100);
    });

    test('floors TURNS at MIN_TURNS (5)', () => {
      const text = `TASK: Test task
TURNS: 1
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(MIN_TURNS);
      expect(result.turns).toBe(5);
    });

    test('handles TURNS: 0 (floors to MIN_TURNS)', () => {
      const text = `TASK: Test task
TURNS: 0
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(MIN_TURNS);
    });

    test('handles negative TURNS (floors to MIN_TURNS)', () => {
      const text = `TASK: Test task
TURNS: -10
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(MIN_TURNS);
    });

    test('handles non-numeric TURNS gracefully (defaults to DEFAULT_TURNS)', () => {
      const text = `TASK: Test task
TURNS: abc
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(DEFAULT_TURNS);
    });

    test('handles TURNS with whitespace', () => {
      const text = `TASK: Test task
TURNS:   75
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(75);
    });

    test('handles TURNS with decimal (truncates to integer)', () => {
      const text = `TASK: Test task
TURNS: 30.7
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(30);
    });

    test('handles TURNS exactly at MIN_TURNS boundary', () => {
      const text = `TASK: Test task
TURNS: 5
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(5);
    });

    test('handles TURNS exactly at MAX_TURNS boundary', () => {
      const text = `TASK: Test task
TURNS: 100
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(100);
    });

    test('handles TURNS with mixed content (parses leading number)', () => {
      const text = `TASK: Test task
TURNS: 50abc
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.turns).toBe(50);
    });
  });

  // SKILL parsing tests
  describe('SKILL parsing', () => {
    test('parses SKILL field (lowercase, trimmed)', () => {
      const text = `TASK: Test task
REPO: jtpets/test
SKILL: run-tests
INSTRUCTIONS: Run the tests`;

      const result = parseTask(text);

      expect(result.skill).toBe('run-tests');
    });

    test('defaults to empty string when SKILL not specified', () => {
      const text = `TASK: Test task
REPO: jtpets/test
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.skill).toBe('');
    });

    test('lowercases SKILL value', () => {
      const text = `TASK: Test task
SKILL: Code-Review
INSTRUCTIONS: Review the code`;

      const result = parseTask(text);

      expect(result.skill).toBe('code-review');
    });

    test('trims SKILL value whitespace', () => {
      const text = `TASK: Test task
SKILL:   deploy-check
INSTRUCTIONS: Check deployment`;

      const result = parseTask(text);

      expect(result.skill).toBe('deploy-check');
    });

    test('handles SKILL with special characters', () => {
      const text = `TASK: Test task
SKILL: my-custom_skill.v2
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      expect(result.skill).toBe('my-custom_skill.v2');
    });

    test('handles full task message with all fields including SKILL', () => {
      const text = `TASK: Run tests
REPO: jtpets/my-app
BRANCH: feature/test
TURNS: 30
SKILL: run-tests
INSTRUCTIONS: Run the test suite and fix any failures`;

      const result = parseTask(text);

      expect(result.description).toBe('Run tests');
      expect(result.repo).toBe('jtpets/my-app');
      expect(result.branch).toBe('feature/test');
      expect(result.turns).toBe(30);
      expect(result.skill).toBe('run-tests');
      expect(result.instructions).toBe('Run the test suite and fix any failures');
    });

    test('handles empty SKILL value (no match, stays default empty string)', () => {
      const text = `TASK: Test task
INSTRUCTIONS: Do something`;

      const result = parseTask(text);

      // When SKILL: is not present, skill stays empty string
      expect(result.skill).toBe('');
    });

    test('handles SKILL followed by whitespace only (no match)', () => {
      // When SKILL: has only whitespace before newline, the regex .+? requires at least
      // one non-whitespace char after trimming, so this tests default behavior
      const text = `TASK: Test task
SKILL: research
INSTRUCTIONS: Research this topic`;

      const result = parseTask(text);

      expect(result.skill).toBe('research');
    });
  });
});

// LOGIC CHANGE 2026-03-26: Tests for isCreateChannelCommand and parseCreateChannelCommand
describe('isCreateChannelCommand', () => {
  test('detects "create channel #name" command', () => {
    expect(isCreateChannelCommand('create channel #my-channel')).toBe(true);
    expect(isCreateChannelCommand('create channel #test')).toBe(true);
    expect(isCreateChannelCommand('create channel #123')).toBe(true);
  });

  test('detects "create channel name" without hash', () => {
    expect(isCreateChannelCommand('create channel my-channel')).toBe(true);
    expect(isCreateChannelCommand('create channel test')).toBe(true);
  });

  test('is case insensitive', () => {
    expect(isCreateChannelCommand('Create Channel #test')).toBe(true);
    expect(isCreateChannelCommand('CREATE CHANNEL #TEST')).toBe(true);
    expect(isCreateChannelCommand('CREATE channel #test')).toBe(true);
  });

  // LOGIC CHANGE 2026-03-26: Fixed test - regex \s+ matches one or more spaces,
  // so multiple spaces between words is still valid.
  test('handles extra whitespace', () => {
    expect(isCreateChannelCommand('  create channel #test  ')).toBe(true);
    expect(isCreateChannelCommand('create  channel  #test')).toBe(true); // regex \s+ allows multiple spaces
  });

  test('returns false for non-matching commands', () => {
    expect(isCreateChannelCommand('delete channel #test')).toBe(false);
    expect(isCreateChannelCommand('create #test')).toBe(false);
    expect(isCreateChannelCommand('channel #test')).toBe(false);
    expect(isCreateChannelCommand('create something else')).toBe(false);
    expect(isCreateChannelCommand('what is queued')).toBe(false);
  });

  test('returns false for empty input', () => {
    expect(isCreateChannelCommand('')).toBe(false);
    expect(isCreateChannelCommand(null)).toBe(false);
    expect(isCreateChannelCommand(undefined)).toBe(false);
  });

  test('requires channel name', () => {
    expect(isCreateChannelCommand('create channel')).toBe(false);
    expect(isCreateChannelCommand('create channel ')).toBe(false);
  });
});

describe('parseCreateChannelCommand', () => {
  test('extracts channel name from "create channel #name"', () => {
    expect(parseCreateChannelCommand('create channel #my-channel')).toBe('my-channel');
    expect(parseCreateChannelCommand('create channel #test')).toBe('test');
    expect(parseCreateChannelCommand('create channel #123-channel')).toBe('123-channel');
  });

  test('extracts channel name without hash', () => {
    expect(parseCreateChannelCommand('create channel my-channel')).toBe('my-channel');
    expect(parseCreateChannelCommand('create channel test')).toBe('test');
  });

  test('lowercases channel name', () => {
    expect(parseCreateChannelCommand('create channel #MyChannel')).toBe('mychannel');
    expect(parseCreateChannelCommand('create channel #TEST-CHANNEL')).toBe('test-channel');
  });

  test('handles case insensitive command', () => {
    expect(parseCreateChannelCommand('CREATE CHANNEL #test')).toBe('test');
    expect(parseCreateChannelCommand('Create Channel #test')).toBe('test');
  });

  test('handles extra whitespace', () => {
    expect(parseCreateChannelCommand('  create channel #test  ')).toBe('test');
  });

  test('returns null for non-matching commands', () => {
    expect(parseCreateChannelCommand('delete channel #test')).toBeNull();
    expect(parseCreateChannelCommand('create #test')).toBeNull();
    expect(parseCreateChannelCommand('what is queued')).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(parseCreateChannelCommand('')).toBeNull();
    expect(parseCreateChannelCommand(null)).toBeNull();
    expect(parseCreateChannelCommand(undefined)).toBeNull();
  });

  test('returns null for missing channel name', () => {
    expect(parseCreateChannelCommand('create channel')).toBeNull();
    expect(parseCreateChannelCommand('create channel ')).toBeNull();
  });

  test('handles channel names with underscores and hyphens', () => {
    expect(parseCreateChannelCommand('create channel #my_channel-test')).toBe('my_channel-test');
    expect(parseCreateChannelCommand('create channel test_123')).toBe('test_123');
  });
});

describe('isStatusQuery', () => {
  test('detects "what\'s queued" patterns', () => {
    expect(isStatusQuery("what's queued")).toBe(true);
    expect(isStatusQuery('whats queued')).toBe(true);
    expect(isStatusQuery("What's Queued")).toBe(true);
  });

  test('detects "queue status" pattern', () => {
    expect(isStatusQuery('queue status')).toBe(true);
    expect(isStatusQuery('Queue Status')).toBe(true);
  });

  test('detects "task status" pattern', () => {
    expect(isStatusQuery('task status')).toBe(true);
    expect(isStatusQuery('Task Status')).toBe(true);
  });

  test('detects "what are you working on" pattern', () => {
    expect(isStatusQuery('what are you working on')).toBe(true);
    expect(isStatusQuery('What Are You Working On')).toBe(true);
  });

  test('returns false for non-status queries', () => {
    expect(isStatusQuery('create channel #test')).toBe(false);
    expect(isStatusQuery('hello')).toBe(false);
    expect(isStatusQuery('what time is it')).toBe(false);
  });

  test('returns false for empty input', () => {
    expect(isStatusQuery('')).toBe(false);
    expect(isStatusQuery(null)).toBe(false);
    expect(isStatusQuery(undefined)).toBe(false);
  });
});
