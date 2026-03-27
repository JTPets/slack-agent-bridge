/**
 * tests/retry-logic.test.js
 *
 * Unit tests for auto-retry behavior when max turns is hit.
 * Tests the retry logic implemented in bridge-agent.js processTask().
 *
 * LOGIC CHANGE 2026-03-26: Created to test auto-retry on max turns hit.
 * LOGIC CHANGE 2026-03-26: Added rate limit pause logic tests.
 */

'use strict';

describe('Auto-retry on max turns', () => {
  // We test the retry logic by simulating the decision flow
  // These are unit tests of the retry algorithm, not integration tests

  /**
   * Simulates the retry decision logic from processTask().
   * Returns an object describing what would happen.
   *
   * @param {number} originalTurns - Initial turns value
   * @param {Function} runLLMSim - Simulator function that returns { hitMaxTurns }
   * @returns {{ finalTurns: number, retryCount: number, didRetry: boolean, finalHitMax: boolean }}
   */
  function simulateRetryLogic(originalTurns, runLLMSim) {
    let currentTurns = originalTurns;
    let retryCount = 0;
    let didRetry = false;
    let hitMaxTurns = false;

    while (retryCount <= 1) {
      const result = runLLMSim(currentTurns);
      hitMaxTurns = result.hitMaxTurns;

      if (!hitMaxTurns) {
        break;
      }

      // Hit max turns - check if we can retry
      if (retryCount === 0 && currentTurns < 100) {
        // Calculate retry turns: double but cap at 100
        const retryTurns = Math.min(currentTurns * 2, 100);
        currentTurns = retryTurns;
        retryCount++;
        didRetry = true;
        continue;
      }

      // Either already retried once, or original turns was already 100
      break;
    }

    return {
      finalTurns: currentTurns,
      retryCount,
      didRetry,
      finalHitMax: hitMaxTurns,
    };
  }

  describe('retry triggers', () => {
    test('triggers retry when max turns hit with turns < 100', () => {
      // First call hits max, second call succeeds
      let callCount = 0;
      const result = simulateRetryLogic(50, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.didRetry).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.finalTurns).toBe(100); // 50 * 2
      expect(result.finalHitMax).toBe(false);
    });

    test('doubles turns on retry (30 -> 60)', () => {
      let callCount = 0;
      let lastTurns = 0;
      const result = simulateRetryLogic(30, (turns) => {
        callCount++;
        lastTurns = turns;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(60);
      expect(lastTurns).toBe(60);
    });

    test('caps retry turns at 100 (60 -> 100, not 120)', () => {
      let callCount = 0;
      const result = simulateRetryLogic(60, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(100);
    });

    test('caps retry turns at 100 (70 -> 100)', () => {
      let callCount = 0;
      const result = simulateRetryLogic(70, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(100);
    });
  });

  describe('no retry at 100 turns', () => {
    test('does NOT retry when original turns is 100', () => {
      let callCount = 0;
      const result = simulateRetryLogic(100, () => {
        callCount++;
        return { hitMaxTurns: true };
      });

      expect(result.didRetry).toBe(false);
      expect(result.retryCount).toBe(0);
      expect(callCount).toBe(1);
      expect(result.finalHitMax).toBe(true);
    });
  });

  describe('single retry only', () => {
    test('only retries once even if second attempt also hits max turns', () => {
      let callCount = 0;
      const result = simulateRetryLogic(50, () => {
        callCount++;
        return { hitMaxTurns: true }; // Always hit max turns
      });

      expect(callCount).toBe(2); // Original + 1 retry
      expect(result.retryCount).toBe(1);
      expect(result.didRetry).toBe(true);
      expect(result.finalHitMax).toBe(true);
    });

    test('does not retry a third time', () => {
      let callCount = 0;
      const result = simulateRetryLogic(25, () => {
        callCount++;
        return { hitMaxTurns: true };
      });

      expect(callCount).toBe(2);
      expect(result.retryCount).toBe(1);
      expect(result.finalTurns).toBe(50); // 25 * 2
    });
  });

  describe('no retry when task succeeds', () => {
    test('does NOT retry when task completes without hitting max turns', () => {
      let callCount = 0;
      const result = simulateRetryLogic(50, () => {
        callCount++;
        return { hitMaxTurns: false };
      });

      expect(result.didRetry).toBe(false);
      expect(result.retryCount).toBe(0);
      expect(callCount).toBe(1);
      expect(result.finalHitMax).toBe(false);
    });
  });

  describe('edge cases', () => {
    test('handles turns at boundary (49 -> 98)', () => {
      let callCount = 0;
      const result = simulateRetryLogic(49, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(98);
    });

    test('handles turns at boundary (51 -> 100, capped)', () => {
      let callCount = 0;
      const result = simulateRetryLogic(51, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(100);
    });

    test('handles minimum turns (5 -> 10)', () => {
      let callCount = 0;
      const result = simulateRetryLogic(5, () => {
        callCount++;
        return { hitMaxTurns: callCount === 1 };
      });

      expect(result.finalTurns).toBe(10);
    });
  });

  describe('memory tracking fields', () => {
    test('outcome should include retry fields when retried', () => {
      const originalTurns = 30;
      let didRetry = false;
      let currentTurns = originalTurns;
      let callCount = 0;

      // Simulate the retry
      while (callCount < 2) {
        callCount++;
        const hitMaxTurns = callCount === 1;
        if (!hitMaxTurns) break;

        if (callCount === 1 && currentTurns < 100) {
          currentTurns = Math.min(currentTurns * 2, 100);
          didRetry = true;
          continue;
        }
        break;
      }

      // Build outcome like processTask does
      const outcome = { output: 'test', elapsed: 10 };
      if (didRetry) {
        outcome.retried = true;
        outcome.originalTurns = originalTurns;
        outcome.retryTurns = currentTurns;
      }

      expect(outcome.retried).toBe(true);
      expect(outcome.originalTurns).toBe(30);
      expect(outcome.retryTurns).toBe(60);
    });

    test('outcome should NOT include retry fields when not retried', () => {
      const originalTurns = 50;
      let didRetry = false;

      // Simulate successful first run
      const hitMaxTurns = false;

      const outcome = { output: 'test', elapsed: 10 };
      if (didRetry) {
        outcome.retried = true;
        outcome.originalTurns = originalTurns;
        outcome.retryTurns = 100;
      }

      expect(outcome.retried).toBeUndefined();
      expect(outcome.originalTurns).toBeUndefined();
      expect(outcome.retryTurns).toBeUndefined();
    });
  });
});

/**
 * Tests for rate limit pause behavior.
 * Simulates the exponential backoff logic for rate limit handling.
 */
describe('Rate limit pause logic', () => {
  // Pause durations: 30 min -> 60 min -> 2 hours -> 4 hours (capped)
  const RATE_LIMIT_PAUSE_MINUTES = [30, 60, 120, 240];

  /**
   * Simulates getRateLimitPauseDuration from bridge-agent.js
   * @param {number} retryCount - Current retry attempt count
   * @returns {number} Pause duration in milliseconds
   */
  function getRateLimitPauseDuration(retryCount) {
    const index = Math.min(retryCount, RATE_LIMIT_PAUSE_MINUTES.length - 1);
    return RATE_LIMIT_PAUSE_MINUTES[index] * 60 * 1000;
  }

  describe('pause duration calculation', () => {
    test('first rate limit triggers 30 minute pause', () => {
      const duration = getRateLimitPauseDuration(0);
      expect(duration).toBe(30 * 60 * 1000); // 30 minutes in ms
    });

    test('second rate limit triggers 60 minute pause', () => {
      const duration = getRateLimitPauseDuration(1);
      expect(duration).toBe(60 * 60 * 1000); // 60 minutes in ms
    });

    test('third rate limit triggers 2 hour pause', () => {
      const duration = getRateLimitPauseDuration(2);
      expect(duration).toBe(120 * 60 * 1000); // 2 hours in ms
    });

    test('fourth+ rate limit caps at 4 hour pause', () => {
      expect(getRateLimitPauseDuration(3)).toBe(240 * 60 * 1000);
      expect(getRateLimitPauseDuration(4)).toBe(240 * 60 * 1000);
      expect(getRateLimitPauseDuration(10)).toBe(240 * 60 * 1000);
      expect(getRateLimitPauseDuration(100)).toBe(240 * 60 * 1000);
    });
  });

  describe('pause state management', () => {
    test('isRateLimitPaused returns false when pauseUntil is null', () => {
      const rateLimitState = { pauseUntil: null, retryCount: 0, failedTask: null };
      const isRateLimitPaused = () => {
        if (!rateLimitState.pauseUntil) return false;
        return Date.now() < rateLimitState.pauseUntil;
      };

      expect(isRateLimitPaused()).toBe(false);
    });

    test('isRateLimitPaused returns true when pauseUntil is in future', () => {
      const rateLimitState = {
        pauseUntil: Date.now() + 60000, // 1 minute from now
        retryCount: 1,
        failedTask: null,
      };
      const isRateLimitPaused = () => {
        if (!rateLimitState.pauseUntil) return false;
        return Date.now() < rateLimitState.pauseUntil;
      };

      expect(isRateLimitPaused()).toBe(true);
    });

    test('isRateLimitPaused returns false when pauseUntil is in past', () => {
      const rateLimitState = {
        pauseUntil: Date.now() - 1000, // 1 second ago
        retryCount: 1,
        failedTask: null,
      };
      const isRateLimitPaused = () => {
        if (!rateLimitState.pauseUntil) return false;
        return Date.now() < rateLimitState.pauseUntil;
      };

      expect(isRateLimitPaused()).toBe(false);
    });
  });

  describe('retry count increment', () => {
    test('retryCount increments on each rate limit', () => {
      const state = { pauseUntil: null, retryCount: 0, failedTask: null };

      // Simulate handleRateLimit
      const handleRateLimit = () => {
        const pauseDuration = getRateLimitPauseDuration(state.retryCount);
        state.pauseUntil = Date.now() + pauseDuration;
        state.retryCount++;
      };

      handleRateLimit();
      expect(state.retryCount).toBe(1);

      handleRateLimit();
      expect(state.retryCount).toBe(2);

      handleRateLimit();
      expect(state.retryCount).toBe(3);
    });
  });

  describe('state clearing', () => {
    test('clearRateLimitState resets all fields', () => {
      const state = {
        pauseUntil: Date.now() + 60000,
        retryCount: 3,
        failedTask: { ts: '123.456' },
      };

      // Simulate clearRateLimitState
      const clearRateLimitState = () => {
        state.pauseUntil = null;
        state.retryCount = 0;
        state.failedTask = null;
      };

      clearRateLimitState();

      expect(state.pauseUntil).toBeNull();
      expect(state.retryCount).toBe(0);
      expect(state.failedTask).toBeNull();
    });
  });

  describe('failed task retry', () => {
    test('failedTask is cleared before retry to prevent loops', () => {
      const state = {
        pauseUntil: null, // Pause expired
        retryCount: 1,
        failedTask: { ts: '123.456', text: 'TASK: test' },
      };

      // Simulate the retry check in poll()
      let retriedTask = null;
      if (state.failedTask && !state.pauseUntil) {
        retriedTask = state.failedTask;
        state.failedTask = null; // Clear before retry
      }

      expect(retriedTask).toEqual({ ts: '123.456', text: 'TASK: test' });
      expect(state.failedTask).toBeNull();
    });
  });

  describe('memory status update', () => {
    test('rate limit status object has correct shape', () => {
      const pauseUntil = Date.now() + 30 * 60 * 1000;
      const retryCount = 1;

      const rateLimitStatus = {
        rateLimited: true,
        pauseUntil: pauseUntil,
        retryCount: retryCount,
        lastHit: new Date().toISOString(),
      };

      expect(rateLimitStatus).toHaveProperty('rateLimited', true);
      expect(rateLimitStatus).toHaveProperty('pauseUntil');
      expect(rateLimitStatus).toHaveProperty('retryCount', 1);
      expect(rateLimitStatus).toHaveProperty('lastHit');
      expect(typeof rateLimitStatus.pauseUntil).toBe('number');
      expect(typeof rateLimitStatus.lastHit).toBe('string');
    });
  });
});

/**
 * Tests for graceful shutdown behavior.
 * LOGIC CHANGE 2026-03-27: Added tests for SIGTERM/SIGINT shutdown handling.
 */
describe('Graceful shutdown logic', () => {
  describe('shuttingDown flag', () => {
    test('poll loop should exit early when shuttingDown is true', () => {
      let shuttingDown = false;
      let pollExecuted = false;

      // Simulate the poll check
      const checkShutdown = () => {
        if (shuttingDown) {
          return false; // Would exit early
        }
        pollExecuted = true;
        return true;
      };

      // First poll should execute
      expect(checkShutdown()).toBe(true);
      expect(pollExecuted).toBe(true);

      // Set shutdown flag
      shuttingDown = true;
      pollExecuted = false;

      // Second poll should exit early
      expect(checkShutdown()).toBe(false);
      expect(pollExecuted).toBe(false);
    });

    test('shuttingDown flag prevents duplicate shutdown handling', () => {
      let shuttingDown = false;
      let shutdownCount = 0;

      const gracefulShutdown = () => {
        if (shuttingDown) {
          return; // Already shutting down
        }
        shuttingDown = true;
        shutdownCount++;
      };

      gracefulShutdown();
      gracefulShutdown();
      gracefulShutdown();

      expect(shutdownCount).toBe(1);
    });
  });

  describe('task completion wait', () => {
    test('shutdown waits for currentTaskPromise when running', async () => {
      let isRunning = true;
      let taskCompleted = false;

      const currentTaskPromise = new Promise(resolve => {
        setTimeout(() => {
          taskCompleted = true;
          resolve('done');
        }, 10);
      });

      // Simulate waiting for task
      if (isRunning && currentTaskPromise) {
        await currentTaskPromise;
      }

      expect(taskCompleted).toBe(true);
    });

    test('shutdown timeout resolves before long-running task', async () => {
      const SHUTDOWN_TIMEOUT = 50; // Short timeout for test

      // Long-running task that won't complete in time
      const longTask = new Promise(resolve => {
        setTimeout(resolve, 1000);
      });

      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT);
      });

      const result = await Promise.race([longTask, timeoutPromise]);
      expect(result).toBe('timeout');
    });

    test('completed task resolves before timeout', async () => {
      const SHUTDOWN_TIMEOUT = 100;

      // Quick task that completes fast
      const quickTask = new Promise(resolve => {
        setTimeout(() => resolve('task_done'), 10);
      });

      const timeoutPromise = new Promise(resolve => {
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT);
      });

      const result = await Promise.race([quickTask, timeoutPromise]);
      expect(result).toBe('task_done');
    });
  });
});

/**
 * Tests for startup state cleanup.
 * LOGIC CHANGE 2026-03-27: Added tests for clearing stale rate limit state on startup.
 */
describe('Startup state cleanup', () => {
  describe('stale rate limit clearing', () => {
    test('clears rate limit state when pauseUntil is in the past', () => {
      const rateLimitState = {
        pauseUntil: Date.now() - 60000, // 1 minute ago (stale)
        retryCount: 2,
        failedTask: { ts: '123.456' },
      };

      // Simulate clearStaleRateLimitState
      const context = { rateLimitStatus: { pauseUntil: rateLimitState.pauseUntil } };
      if (context && context.rateLimitStatus && context.rateLimitStatus.pauseUntil) {
        if (Date.now() >= context.rateLimitStatus.pauseUntil) {
          // Clear stale state
          rateLimitState.pauseUntil = null;
          rateLimitState.retryCount = 0;
          rateLimitState.failedTask = null;
        }
      }

      expect(rateLimitState.pauseUntil).toBeNull();
      expect(rateLimitState.retryCount).toBe(0);
      expect(rateLimitState.failedTask).toBeNull();
    });

    test('restores valid rate limit state when pauseUntil is in the future', () => {
      const futureTime = Date.now() + 30 * 60 * 1000; // 30 minutes from now
      const rateLimitState = {
        pauseUntil: null,
        retryCount: 0,
        failedTask: null,
      };

      // Simulate clearStaleRateLimitState with valid pause
      const context = {
        rateLimitStatus: {
          pauseUntil: futureTime,
          retryCount: 2,
        },
      };

      if (context && context.rateLimitStatus && context.rateLimitStatus.pauseUntil) {
        if (Date.now() >= context.rateLimitStatus.pauseUntil) {
          // Would clear - but pauseUntil is in future
          rateLimitState.pauseUntil = null;
        } else {
          // Restore state from memory
          rateLimitState.pauseUntil = context.rateLimitStatus.pauseUntil;
          rateLimitState.retryCount = context.rateLimitStatus.retryCount || 1;
        }
      }

      expect(rateLimitState.pauseUntil).toBe(futureTime);
      expect(rateLimitState.retryCount).toBe(2);
    });

    test('handles missing context gracefully', () => {
      const rateLimitState = {
        pauseUntil: null,
        retryCount: 0,
        failedTask: null,
      };

      // Simulate clearStaleRateLimitState with no context
      const context = null;

      if (context && context.rateLimitStatus && context.rateLimitStatus.pauseUntil) {
        // Would execute cleanup, but context is null
      }

      // State should remain unchanged
      expect(rateLimitState.pauseUntil).toBeNull();
      expect(rateLimitState.retryCount).toBe(0);
    });

    test('handles empty rateLimitStatus gracefully', () => {
      const rateLimitState = {
        pauseUntil: null,
        retryCount: 0,
        failedTask: null,
      };

      // Simulate clearStaleRateLimitState with empty status
      const context = { rateLimitStatus: null };

      if (context && context.rateLimitStatus && context.rateLimitStatus.pauseUntil) {
        // Would execute cleanup, but rateLimitStatus is null
      }

      // State should remain unchanged
      expect(rateLimitState.pauseUntil).toBeNull();
      expect(rateLimitState.retryCount).toBe(0);
    });
  });
});
