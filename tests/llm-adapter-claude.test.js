/**
 * tests/llm-adapter-claude.test.js
 *
 * Unit tests for lib/llm-adapter-claude.js (the Claude CLI adapter over a mocked spawn).
 *
 * LOGIC CHANGE 2026-11-07 (WORK-TODO #10 Wave T, owner decision #44 of 2026-10-10: one
 * suite per module): moved unchanged out of tests/llm-runner.test.js, which covered all
 * seven parts of the lib/llm-runner.js split. Every test still requires the facade
 * (`../lib/llm-runner`), so the facade's surface stays covered. The shared setup is
 * tests/helpers/llm-runner-harness.js.
 */

'use strict';

const EventEmitter = require('events');
const { useLlmRunnerHarness } = require('./helpers/llm-runner-harness');

const h = useLlmRunnerHarness();

describe('runClaudeAdapter', () => {
  test('spawns claude with correct args', async () => {
    h.setupMockSpawn({ stdout: 'success' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    await runClaudeAdapter('my prompt', {
      cwd: '/test/dir',
      maxTurns: 20,
      timeout: 120000,
      claudeBin: '/custom/claude',
    });

    // LOGIC CHANGE 2026-09-20: This assertion previously encoded the defect - it
    // required the prompt to BE the `-p` argv entry, which is exactly what failed
    // at execve with E2BIG once the prompt passed MAX_ARG_STRLEN (131072 bytes).
    // The prompt is no longer in argv at all; it goes over stdin, so stdio[0] is
    // 'pipe' rather than 'ignore'.
    expect(h.mockSpawn).toHaveBeenCalledWith(
      '/custom/claude',
      // LOGIC CHANGE 2026-11-07: this previously required --dangerously-skip-permissions
      // for a call that names no agent, i.e. every tool for an unidentified caller. That
      // was the defect: default-deny now, so such a call is restricted to no tools.
      ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '20',
        '--restricted', '--strict-mcp-config', '--tools', ''],
      expect.objectContaining({
        cwd: '/test/dir',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    // LOGIC CHANGE 2026-10-04 (WORK-TODO #58): this assertion previously required
    // spawn's `timeout` option, the mechanism that held the event loop for the full
    // timeout after a failed spawn. The adapter owns the deadline now.
    expect(h.mockSpawn.mock.calls[0][2]).not.toHaveProperty('timeout');

    // The prompt must still actually reach the child - over stdin.
    const child = h.mockSpawn.mock.results[0].value;
    expect(child.stdin.end).toHaveBeenCalledWith('my prompt');
  });

  test('uses default values when options not provided', async () => {
    h.setupMockSpawn({ stdout: 'output' });

    // Ensure defaults are used
    delete process.env.CLAUDE_BIN;
    delete process.env.MAX_TURNS;
    delete process.env.TASK_TIMEOUT_MS;

    const { runClaudeAdapter, DEFAULT_MAX_TURNS } = require('../lib/llm-runner');
    await runClaudeAdapter('prompt');

    // Should use default max turns (50)
    expect(h.mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--max-turns', '50']),
      expect.any(Object)
    );
  });

  test('detects max turns reached in output', async () => {
    h.setupMockSpawn({ stdout: 'Partial output\nReached max turns\nMore text' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');

    expect(result.hitMaxTurns).toBe(true);
    expect(result.output).toContain('Reached max turns');
  });

  test('hitMaxTurns is false when not in output', async () => {
    h.setupMockSpawn({ stdout: 'Normal completion output' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');

    expect(result.hitMaxTurns).toBe(false);
  });

  test('rejects on non-zero exit code', async () => {
    h.setupMockSpawn({ exitCode: 1, stderr: 'Error occurred' });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    await expect(runClaudeAdapter('prompt')).rejects.toThrow('Exit code 1');
  });

  test('includes stderr in error message on failure', async () => {
    h.setupMockSpawn({ exitCode: 2, stderr: 'Some error details' });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    await expect(runClaudeAdapter('prompt')).rejects.toThrow('Some error details');
  });

  test('rejects on spawn error', async () => {
    h.setupMockSpawnError('ENOENT');

    const { runClaudeAdapter } = require('../lib/llm-runner');

    await expect(runClaudeAdapter('prompt')).rejects.toThrow('Spawn failed: ENOENT');
  });

  test('trims output', async () => {
    h.setupMockSpawn({ stdout: '  trimmed output  \n' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');

    expect(result.output).toBe('trimmed output');
  });

  test('accumulates multiple stdout chunks', async () => {
    h.mockSpawn.mockImplementation(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      // LOGIC CHANGE 2026-09-20: the prompt now goes over stdin, so a fake child
      // needs a writable stdin or runClaudeAdapter throws on child.stdin.end().
      mockChild.stdin = Object.assign(new EventEmitter(), { end: jest.fn(), write: jest.fn() });

      setImmediate(() => {
        mockChild.stdout.emit('data', 'chunk1 ');
        mockChild.stdout.emit('data', 'chunk2 ');
        mockChild.stdout.emit('data', 'chunk3');
        mockChild.emit('close', 0);
      });

      return mockChild;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');

    expect(result.output).toBe('chunk1 chunk2 chunk3');
  });
});

describe('runClaudeAdapter rate limit detection (RE-ENABLED for fallback)', () => {
  test('rate limit text in stdout with exit code 0 resolves normally', async () => {
    h.setupMockSpawn({ stdout: 'Error: rate limit exceeded', exitCode: 0 });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    // Should resolve normally - only check stderr on non-zero exit
    const result = await runClaudeAdapter('prompt');
    expect(result.output).toContain('rate limit exceeded');
  });

  test('exit code 1 with rate limit text in stderr throws RateLimitError', async () => {
    h.setupMockSpawn({ stderr: 'Too many requests', exitCode: 1 });

    const { runClaudeAdapter, RateLimitError } = require('../lib/llm-runner');

    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.isRateLimit).toBe(true);
      expect(err.message).toContain('Claude rate limit detected');
    }
  });

  test('exit code 1 with non-rate-limit stderr throws regular Error', async () => {
    h.setupMockSpawn({ stderr: 'Some other error', exitCode: 1 });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.isRateLimit).toBeUndefined();
      expect(err.message).toContain('Exit code 1');
    }
  });

  test('exit code null resolves with interrupted flag instead of error', async () => {
    h.setupMockSpawn({ exitCode: null, stdout: 'partial', stderr: '' });

    // Need to override setupMockSpawn to emit null exit code
    h.mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // LOGIC CHANGE 2026-09-20: the prompt now goes over stdin, so a fake child
      // needs a writable stdin or runClaudeAdapter throws on child.stdin.end().
      child.stdin = Object.assign(new EventEmitter(), { end: jest.fn(), write: jest.fn() });
      setImmediate(() => {
        child.stdout.emit('data', 'partial output');
        child.emit('close', null);
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');
    expect(result.interrupted).toBe(true);
    expect(result.output).toBe('partial output');
  });

  // LOGIC CHANGE 2026-09-13: Surface the spawned LLM process's stderr and the
  // signal that killed it, so a failed task reports the cause instead of a bare
  // "Exit code 143".
  test('signal kill (code null, signal set) carries the signal and stderr through the interrupted result', async () => {
    h.mockSpawn.mockImplementation(() => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      // LOGIC CHANGE 2026-09-20: the prompt now goes over stdin, so a fake child
      // needs a writable stdin or runClaudeAdapter throws on child.stdin.end().
      child.stdin = Object.assign(new EventEmitter(), { end: jest.fn(), write: jest.fn() });
      setImmediate(() => {
        child.stderr.emit('data', 'FATAL: out of memory\n');
        child.emit('close', null, 'SIGKILL');
      });
      return child;
    });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');
    expect(result.interrupted).toBe(true);
    expect(result.signal).toBe('SIGKILL');
    expect(result.stderr).toContain('out of memory');
  });

  test('non-zero exit includes stderr and decodes a 128+N code to its signal name', async () => {
    // 143 = 128 + 15 (SIGTERM): the shape a trapped-signal wrapper exits with.
    h.setupMockSpawn({ exitCode: 143, stderr: 'terminated mid-task' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Exit code 143');
      expect(err.message).toContain('SIGTERM');
      expect(err.message).toContain('terminated mid-task');
      expect(err.exitCode).toBe(143);
      expect(err.signal).toBe('SIGTERM');
      expect(err.stderr).toBe('terminated mid-task');
    }
  });

  test('non-zero exit with empty stderr states "(no stderr output)" explicitly', async () => {
    h.setupMockSpawn({ exitCode: 143, stderr: '' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.message).toContain('Exit code 143');
      expect(err.message).toContain('SIGTERM');
      expect(err.message).toContain('(no stderr output)');
    }
  });

  // LOGIC CHANGE 2026-10-10: regression for the 07:00 secretary briefing, which failed
  // as "Exit code 1 (no stderr output)" because the CLI's reason was on stdout.
  test('a failed exit with empty stderr carries the CLI message from stdout', async () => {
    h.setupMockSpawn({ exitCode: 1, stdout: 'Invalid API key · Please run /login\n', stderr: '' });
    const { runClaudeAdapter } = require('../lib/llm-runner');
    await expect(runClaudeAdapter('prompt')).rejects.toThrow(/Exit code 1[\s\S]*stdout \(last 2000 chars\):\nInvalid API key/);
  });

  test('a usage-limit message on stdout is a rate limit, so the fallback chain can run', async () => {
    h.setupMockSpawn({ exitCode: 1, stdout: 'Claude AI usage limit reached|1791630000', stderr: '' });
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const err = await runClaudeAdapter('prompt').catch(e => e);
    expect(err.isRateLimit).toBe(true);
    expect(err.message).toContain('usage limit reached');
  });

  test('long task output that mentions a rate limit is not treated as one', async () => {
    const longOut = 'x'.repeat(600) + ' the API returned rate limit exceeded in our test';
    h.setupMockSpawn({ exitCode: 1, stdout: longOut, stderr: '' });
    const { runClaudeAdapter } = require('../lib/llm-runner');
    const err = await runClaudeAdapter('prompt').catch(e => e);
    expect(err.isRateLimit).toBeUndefined();
    expect(err.message).toContain('Exit code 1');
  });

  test('a secret on stdout is redacted from the exit diagnostic', () => {
    const { describeClaudeExit } = require('../lib/llm-runner');
    // Assembled at runtime so no token-shaped literal is committed (push protection).
    const fake = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnopqrstuvwx'].join('-');
    const msg = describeClaudeExit(1, null, '', `failed with ${fake}`);
    expect(msg).not.toContain(fake.slice(0, 17));
    expect(msg).toContain('(no stderr output)');
  });

  test('a failed exit with no output at all says so', () => {
    const { describeClaudeExit } = require('../lib/llm-runner');
    const msg = describeClaudeExit(1, null, '', '');
    expect(msg).toMatch(/\(no stderr output\)$/);
    expect(msg).not.toContain('stdout');
  });
});

// LOGIC CHANGE 2026-09-13: Exit diagnostics helpers.

describe('runClaudeAdapter bandwidth exhaustion detection (DISABLED)', () => {
  test('exit code 1 + bandwidth keyword in stderr throws regular Error, not BandwidthExhaustedError', async () => {
    h.setupMockSpawn({ exitCode: 1, stdout: '', stderr: 'Error: usage limit exceeded' });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.isBandwidthExhausted).toBeUndefined();
      expect(err.message).toContain('Exit code 1');
    }
  });

  test('exit code 1 with any stderr throws regular Error', async () => {
    h.setupMockSpawn({ exitCode: 1, stdout: '', stderr: 'command not found' });

    const { runClaudeAdapter } = require('../lib/llm-runner');

    try {
      await runClaudeAdapter('prompt');
      fail('Should have thrown');
    } catch (err) {
      expect(err.isBandwidthExhausted).toBeUndefined();
      expect(err.message).toContain('Exit code 1');
    }
  });

  test('rate limit text in stdout with exit code 0 resolves normally (detection disabled)', async () => {
    h.setupMockSpawn({ exitCode: 0, stdout: 'rate limit exceeded', stderr: '' });

    const { runClaudeAdapter } = require('../lib/llm-runner');
    const result = await runClaudeAdapter('prompt');
    expect(result.output).toContain('rate limit exceeded');
  });
});
