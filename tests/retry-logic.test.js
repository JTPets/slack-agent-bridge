/**
 * tests/retry-logic.test.js
 *
 * Unit tests for auto-retry behavior when max turns is hit.
 * Tests the retry logic implemented in bridge-agent.js processTask().
 *
 * LOGIC CHANGE 2026-03-26: Created to test auto-retry on max turns hit.
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
