/**
 * tests/task-parser.test.js
 *
 * Unit tests for parseTask function from lib/task-parser.js
 */

const { parseTask, DEFAULT_TURNS, MIN_TURNS, MAX_TURNS } = require('../lib/task-parser');

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
});
