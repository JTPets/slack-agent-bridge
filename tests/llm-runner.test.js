/**
 * tests/llm-runner.test.js
 *
 * Unit tests for lib/llm-runner.js
 */

const EventEmitter = require('events');

describe('llm-runner module', () => {
  const originalEnv = process.env;
  let mockSpawn;
  let childProcess;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear LLM_PROVIDER to ensure default behavior
    delete process.env.LLM_PROVIDER;

    // Create fresh mock for each test
    mockSpawn = jest.fn();
    jest.doMock('child_process', () => ({
      spawn: mockSpawn,
    }));
  });

  afterEach(() => {
    jest.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  /**
   * Helper to setup spawn mock that auto-resolves
   */
  function setupMockSpawn({ exitCode = 0, stdout = '', stderr = '' } = {}) {
    mockSpawn.mockImplementation(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      setImmediate(() => {
        if (stdout) mockChild.stdout.emit('data', stdout);
        if (stderr) mockChild.stderr.emit('data', stderr);
        mockChild.emit('close', exitCode);
      });

      return mockChild;
    });
  }

  /**
   * Helper to setup spawn mock that emits error
   */
  function setupMockSpawnError(errorMessage) {
    mockSpawn.mockImplementation(() => {
      const mockChild = new EventEmitter();
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      setImmediate(() => {
        mockChild.emit('error', new Error(errorMessage));
      });

      return mockChild;
    });
  }

  describe('runLLM', () => {
    test('uses claude provider by default when LLM_PROVIDER not set', async () => {
      setupMockSpawn({ stdout: 'test output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test prompt', { cwd: '/tmp/test' });

      expect(mockSpawn).toHaveBeenCalled();
      expect(result.output).toBe('test output');
    });

    test('respects LLM_PROVIDER env var', async () => {
      process.env.LLM_PROVIDER = 'openai';

      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
    });

    test('options.provider overrides LLM_PROVIDER env var', async () => {
      process.env.LLM_PROVIDER = 'claude';

      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt', { provider: 'ollama' })).rejects.toThrow('Ollama adapter not yet implemented');
    });

    test('throws error for unknown provider', async () => {
      const { runLLM } = require('../lib/llm-runner');

      await expect(runLLM('test prompt', { provider: 'unknown' })).rejects.toThrow(
        'Unknown LLM provider: unknown. Supported providers: claude, openai, ollama'
      );
    });

    test('handles provider name case-insensitively', async () => {
      setupMockSpawn({ stdout: 'output' });

      const { runLLM } = require('../lib/llm-runner');
      const result = await runLLM('test', { provider: 'CLAUDE' });

      expect(result.output).toBe('output');
    });
  });

  describe('runClaudeAdapter', () => {
    test('spawns claude with correct args', async () => {
      setupMockSpawn({ stdout: 'success' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      await runClaudeAdapter('my prompt', {
        cwd: '/test/dir',
        maxTurns: 20,
        timeout: 120000,
        claudeBin: '/custom/claude',
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        '/custom/claude',
        ['-p', 'my prompt', '--output-format', 'text', '--max-turns', '20', '--dangerously-skip-permissions'],
        expect.objectContaining({
          cwd: '/test/dir',
          timeout: 120000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    test('uses default values when options not provided', async () => {
      setupMockSpawn({ stdout: 'output' });

      // Ensure defaults are used
      delete process.env.CLAUDE_BIN;
      delete process.env.MAX_TURNS;
      delete process.env.TASK_TIMEOUT_MS;

      const { runClaudeAdapter, DEFAULT_MAX_TURNS } = require('../lib/llm-runner');
      await runClaudeAdapter('prompt');

      // Should use default max turns (50)
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--max-turns', '50']),
        expect.any(Object)
      );
    });

    test('detects max turns reached in output', async () => {
      setupMockSpawn({ stdout: 'Partial output\nReached max turns\nMore text' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.hitMaxTurns).toBe(true);
      expect(result.output).toContain('Reached max turns');
    });

    test('hitMaxTurns is false when not in output', async () => {
      setupMockSpawn({ stdout: 'Normal completion output' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.hitMaxTurns).toBe(false);
    });

    test('rejects on non-zero exit code', async () => {
      setupMockSpawn({ exitCode: 1, stderr: 'Error occurred' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Exit code 1');
    });

    test('includes stderr in error message on failure', async () => {
      setupMockSpawn({ exitCode: 2, stderr: 'Some error details' });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Some error details');
    });

    test('rejects on spawn error', async () => {
      setupMockSpawnError('ENOENT');

      const { runClaudeAdapter } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow('Spawn failed: ENOENT');
    });

    test('trims output', async () => {
      setupMockSpawn({ stdout: '  trimmed output  \n' });

      const { runClaudeAdapter } = require('../lib/llm-runner');
      const result = await runClaudeAdapter('prompt');

      expect(result.output).toBe('trimmed output');
    });

    test('accumulates multiple stdout chunks', async () => {
      mockSpawn.mockImplementation(() => {
        const mockChild = new EventEmitter();
        mockChild.stdout = new EventEmitter();
        mockChild.stderr = new EventEmitter();

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

  describe('runOpenAIAdapter', () => {
    test('throws not implemented error', async () => {
      const { runOpenAIAdapter } = require('../lib/llm-runner');

      await expect(runOpenAIAdapter('prompt')).rejects.toThrow('OpenAI adapter not yet implemented');
    });
  });

  describe('runOllamaAdapter', () => {
    test('throws not implemented error', async () => {
      const { runOllamaAdapter } = require('../lib/llm-runner');

      await expect(runOllamaAdapter('prompt')).rejects.toThrow('Ollama adapter not yet implemented');
    });
  });

  describe('exported constants', () => {
    test('exports DEFAULT_PROVIDER as claude', () => {
      const { DEFAULT_PROVIDER } = require('../lib/llm-runner');
      expect(DEFAULT_PROVIDER).toBe('claude');
    });

    test('exports DEFAULT_MAX_TURNS as 50', () => {
      delete process.env.MAX_TURNS;
      const { DEFAULT_MAX_TURNS } = require('../lib/llm-runner');
      expect(DEFAULT_MAX_TURNS).toBe(50);
    });

    test('exports DEFAULT_TIMEOUT as 600000', () => {
      delete process.env.TASK_TIMEOUT_MS;
      const { DEFAULT_TIMEOUT } = require('../lib/llm-runner');
      expect(DEFAULT_TIMEOUT).toBe(600000);
    });
  });

  describe('isRateLimitError', () => {
    test('detects "rate limit" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('Error: rate limit exceeded')).toBe(true);
      expect(isRateLimitError('You hit the Rate Limit')).toBe(true);
    });

    test('detects "too many requests" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('429 Too Many Requests')).toBe(true);
    });

    test('detects "quota exceeded" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('API quota exceeded for this period')).toBe(true);
    });

    test('detects "usage limit" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('Usage limit reached')).toBe(true);
    });

    test('detects "rate_limit_error" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('{"error": {"type": "rate_limit_error"}}')).toBe(true);
    });

    test('detects "overloaded" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('The API is overloaded, please try again')).toBe(true);
    });

    test('detects "capacity" in text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('No capacity available')).toBe(true);
    });

    test('returns false for normal text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError('Task completed successfully')).toBe(false);
      expect(isRateLimitError('Normal error message')).toBe(false);
    });

    test('returns false for null or empty text', () => {
      const { isRateLimitError } = require('../lib/llm-runner');
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError('')).toBe(false);
      expect(isRateLimitError(undefined)).toBe(false);
    });
  });

  describe('RateLimitError', () => {
    test('has isRateLimit property set to true', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('Rate limit hit');
      expect(error.isRateLimit).toBe(true);
    });

    test('has name set to RateLimitError', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('test');
      expect(error.name).toBe('RateLimitError');
    });

    test('is an instance of Error', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('test');
      expect(error instanceof Error).toBe(true);
    });

    test('preserves error message', () => {
      const { RateLimitError } = require('../lib/llm-runner');
      const error = new RateLimitError('custom message');
      expect(error.message).toBe('custom message');
    });
  });

  describe('runClaudeAdapter rate limit detection', () => {
    test('throws RateLimitError when rate limit detected in stdout', async () => {
      setupMockSpawn({ stdout: 'Error: rate limit exceeded', exitCode: 0 });

      const { runClaudeAdapter, RateLimitError } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow(RateLimitError);
    });

    test('throws RateLimitError when rate limit detected in stderr', async () => {
      setupMockSpawn({ stderr: 'Too many requests', exitCode: 1 });

      const { runClaudeAdapter, RateLimitError } = require('../lib/llm-runner');

      await expect(runClaudeAdapter('prompt')).rejects.toThrow(RateLimitError);
    });

    test('thrown RateLimitError has isRateLimit flag', async () => {
      setupMockSpawn({ stdout: 'API quota exceeded', exitCode: 0 });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err.isRateLimit).toBe(true);
      }
    });

    test('normal errors are not rate limit errors', async () => {
      setupMockSpawn({ stderr: 'Some other error', exitCode: 1 });

      const { runClaudeAdapter } = require('../lib/llm-runner');

      try {
        await runClaudeAdapter('prompt');
        fail('Should have thrown');
      } catch (err) {
        expect(err.isRateLimit).toBeUndefined();
        expect(err.message).toContain('Exit code 1');
      }
    });
  });
});
